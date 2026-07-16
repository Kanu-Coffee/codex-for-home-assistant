#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-codex-for-home-assistant:test}
EXPECTED_GH_VERSION=2.93.0
TARGET_REPOSITORY=Kanu-Coffee/codex-for-home-assistant
TEST_ID="codex-ha-feedback-${RANDOM}-$$"
CONTAINER="${TEST_ID}-container"
DATA_VOLUME="${TEST_ID}-data"
CONFIG_VOLUME="${TEST_ID}-config"
FIXTURE_DIR=/tmp/feedback-fixtures
FAKE_GH_BIN=/tmp/fake-gh
FAKE_GH_STATE=/tmp/ha-feedback-fake-gh
FAKE_GH_LOG="${FAKE_GH_STATE}/calls.log"
WORK_DIR=$(mktemp -d)

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm -f "${DATA_VOLUME}" "${CONFIG_VOLUME}" \
    >/dev/null 2>&1 || true
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

fail() {
  printf 'feedback smoke: %s\n' "$*" >&2
  exit 1
}

feedback() {
  docker exec "${CONTAINER}" /usr/local/bin/ha-feedback "$@"
}

# Supplying all three credential variables tests that the helper constructs a
# clean child environment. The fake gh exits 88 if any of them reaches it.
github_feedback() {
  docker exec \
    --env GH_TOKEN=feedback-smoke-gh-token \
    --env GITHUB_TOKEN=feedback-smoke-github-token \
    --env SUPERVISOR_TOKEN=feedback-smoke-supervisor-token \
    "${CONTAINER}" /usr/local/bin/ha-feedback "$@"
}

assert_json() {
  local description=$1
  local filter=$2
  local payload=$3

  printf '%s\n' "${payload}" \
    | docker exec --interactive "${CONTAINER}" \
      jq --exit-status "${filter}" >/dev/null \
    || fail "${description}"
}

json_value() {
  local filter=$1
  local payload=$2

  printf '%s\n' "${payload}" \
    | docker exec --interactive "${CONTAINER}" \
      jq --exit-status --raw-output "${filter}"
}

expect_failure() {
  local description=$1
  local expected_status=$2
  shift 2
  local status

  if "$@" >/dev/null 2>&1; then
    fail "${description} unexpectedly succeeded"
  else
    status=$?
  fi
  [[ "${status}" -eq "${expected_status}" ]] \
    || fail "${description} exited ${status}, expected ${expected_status}"
}

report_count() {
  docker exec "${CONTAINER}" /bin/sh -c '
    root=/config/codex-workspace/feedback
    if [ ! -d "${root}" ]; then
      printf "0\n"
      exit 0
    fi
    find "${root}" -mindepth 1 -maxdepth 1 -type d | wc -l
  '
}

create_count() {
  docker exec "${CONTAINER}" /bin/sh -c '
    log=$1
    if [ ! -f "${log}" ]; then
      printf "0\n"
      exit 0
    fi
    grep -F "ARG=issue ARG=create" "${log}" | wc -l
  ' sh "${FAKE_GH_LOG}"
}

call_count() {
  docker exec "${CONTAINER}" /bin/sh -c '
    log=$1
    if [ ! -f "${log}" ]; then
      printf "0\n"
      exit 0
    fi
    wc -l < "${log}"
  ' sh "${FAKE_GH_LOG}"
}

assert_body_hash_logged() {
  local label=$1
  local expected_hash=$2

  docker exec "${CONTAINER}" /bin/sh -ceu '
    log=$1
    label=$2
    expected_hash=$3
    grep -F "ARG=issue ARG=create" "${log}" \
      | grep -F "ARG=--body-file ARG=-" \
      | grep -F "ARG=--label ARG=${label}" \
      | grep -F "STDIN_SHA256=${expected_hash}" >/dev/null
  ' sh "${FAKE_GH_LOG}" "${label}" "${expected_hash}" \
    || fail "fake gh did not receive the exact ${label} body on stdin"
}

assert_report_permissions() {
  local report_directory=$1

  docker exec "${CONTAINER}" /bin/sh -ceu '
    report_directory=$1
    test "$(stat -c "%a" "${report_directory}")" = 700
    test "$(stat -c "%a" "${report_directory}/report.json")" = 600
    test "$(stat -c "%a" "${report_directory}/public-report.md")" = 600
    test ! -e "${report_directory}/submission.json"
    test ! -e "${report_directory}/.submission.lock"
  ' sh "${report_directory}" \
    || fail "report bundle permissions are not private"
}

for fixture in \
  tests/fixtures/fake-gh \
  tests/fixtures/ha_feedback_bug.json \
  tests/fixtures/ha_feedback_feature.json \
  tests/fixtures/ha_feedback_malicious.json; do
  [[ -f "${fixture}" ]] || fail "missing fixture: ${fixture}"
done

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
docker volume create "${DATA_VOLUME}" >/dev/null
docker volume create "${CONFIG_VOLUME}" >/dev/null
docker run --detach \
  --platform linux/amd64 \
  --name "${CONTAINER}" \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${CONFIG_VOLUME}:/config" \
  --entrypoint /bin/sh \
  "${IMAGE}" -c 'exec sleep infinity' >/dev/null

GH_VERSION_LINE=$(docker exec "${CONTAINER}" gh --version | head -n 1) \
  || fail 'GitHub CLI is missing from the candidate image'
[[ "${GH_VERSION_LINE}" == "gh version ${EXPECTED_GH_VERSION} "* ]] \
  || fail "unexpected GitHub CLI version: ${GH_VERSION_LINE}"
docker exec "${CONTAINER}" test -f /etc/codex/skills/ha-feedback/SKILL.md \
  || fail 'image-managed feedback Skill is missing'
docker exec "${CONTAINER}" test -f \
  /etc/codex/skills/ha-feedback/references/privacy.md \
  || fail 'feedback Skill references are missing'
docker exec "${CONTAINER}" test -x /usr/local/bin/ha-feedback \
  || fail 'feedback helper is not executable'
docker exec "${CONTAINER}" test -r \
  /usr/local/share/codex-ha/ha-feedback.mjs \
  || fail 'feedback helper implementation is missing'

docker exec "${CONTAINER}" install -d -m 0700 "${FIXTURE_DIR}"
docker cp tests/fixtures/fake-gh \
  "${CONTAINER}:${FAKE_GH_BIN}" >/dev/null
docker cp tests/fixtures/ha_feedback_bug.json \
  "${CONTAINER}:${FIXTURE_DIR}/bug.json" >/dev/null
docker cp tests/fixtures/ha_feedback_feature.json \
  "${CONTAINER}:${FIXTURE_DIR}/feature.json" >/dev/null
docker cp tests/fixtures/ha_feedback_malicious.json \
  "${CONTAINER}:${FIXTURE_DIR}/malicious.json" >/dev/null
docker exec "${CONTAINER}" chown 0:0 \
  "${FAKE_GH_BIN}" \
  "${FIXTURE_DIR}/bug.json" \
  "${FIXTURE_DIR}/feature.json" \
  "${FIXTURE_DIR}/malicious.json"
docker exec "${CONTAINER}" chmod 0755 "${FAKE_GH_BIN}"
docker exec "${CONTAINER}" chmod 0600 \
  "${FIXTURE_DIR}/bug.json" \
  "${FIXTURE_DIR}/feature.json" \
  "${FIXTURE_DIR}/malicious.json"

# Defense in depth: after the version check, every gh path in this disposable
# container is fake. No later command can contact GitHub or create a real issue.
docker exec "${CONTAINER}" install -m 0755 \
  "${FAKE_GH_BIN}" /usr/local/bin/gh

BUG_COLLECT=$(feedback collect bug --input "${FIXTURE_DIR}/bug.json") \
  || fail 'bug fixture collection failed'
assert_json 'bug collection result is incomplete' '
  .kind == "bug"
  and .privacy == "PASS"
  and .security_issue == false
  and (.report_directory | startswith("/config/codex-workspace/feedback/"))
' "${BUG_COLLECT}"
BUG_DIRECTORY=$(json_value '.report_directory' "${BUG_COLLECT}")
assert_report_permissions "${BUG_DIRECTORY}"
[[ $(docker exec "${CONTAINER}" stat -c '%a' \
  /config/codex-workspace/feedback) == 700 ]] \
  || fail 'managed report root is not mode 0700'

BUG_VALIDATE=$(feedback validate "${BUG_DIRECTORY}") \
  || fail 'bug report validation failed'
assert_json 'bug validation did not pass' \
  '.valid == true and .kind == "bug" and .privacy == "PASS"' \
  "${BUG_VALIDATE}"
BUG_RENDER=$(feedback render "${BUG_DIRECTORY}") \
  || fail 'bug report render failed'
assert_json 'bug render did not complete' \
  '.rendered == true and (.public_report | endswith("/public-report.md"))' \
  "${BUG_RENDER}"
feedback validate "${BUG_DIRECTORY}" >/dev/null \
  || fail 'rendered bug report did not validate'

FEATURE_COLLECT=$(feedback collect feature --input \
  "${FIXTURE_DIR}/feature.json") \
  || fail 'feature fixture collection failed'
assert_json 'feature collection result is incomplete' '
  .kind == "feature"
  and .privacy == "PASS"
  and .security_issue == false
  and (.report_directory | startswith("/config/codex-workspace/feedback/"))
' "${FEATURE_COLLECT}"
FEATURE_DIRECTORY=$(json_value '.report_directory' "${FEATURE_COLLECT}")
assert_report_permissions "${FEATURE_DIRECTORY}"
feedback validate "${FEATURE_DIRECTORY}" >/dev/null \
  || fail 'feature report validation failed'
feedback render "${FEATURE_DIRECTORY}" >/dev/null \
  || fail 'feature report render failed'
feedback validate "${FEATURE_DIRECTORY}" >/dev/null \
  || fail 'rendered feature report did not validate'

AUXILIARY_COLLECT=$(feedback collect bug --input "${FIXTURE_DIR}/bug.json") \
  || fail 'auxiliary bug fixture collection failed'
AUXILIARY_DIRECTORY=$(json_value '.report_directory' "${AUXILIARY_COLLECT}")
assert_report_permissions "${AUXILIARY_DIRECTORY}"

AMBIGUOUS_COLLECT=$(feedback collect feature --input \
  "${FIXTURE_DIR}/feature.json") \
  || fail 'ambiguous-result feature fixture collection failed'
AMBIGUOUS_DIRECTORY=$(json_value '.report_directory' "${AMBIGUOUS_COLLECT}")
AMBIGUOUS_REPORT_ID=$(json_value '.report_id' "${AMBIGUOUS_COLLECT}")
assert_report_permissions "${AMBIGUOUS_DIRECTORY}"

REPORTS_BEFORE=$(report_count)
expect_failure 'malicious fixture privacy validation' 65 \
  feedback collect bug --input "${FIXTURE_DIR}/malicious.json"
[[ $(report_count) -eq "${REPORTS_BEFORE}" ]] \
  || fail 'malicious fixture created a report bundle'

docker exec "${CONTAINER}" ln -s \
  "${FIXTURE_DIR}/bug.json" "${FIXTURE_DIR}/bug-link.json"
expect_failure 'symbolic-link input' 65 \
  feedback collect bug --input "${FIXTURE_DIR}/bug-link.json"
[[ $(report_count) -eq "${REPORTS_BEFORE}" ]] \
  || fail 'symbolic-link input created a report bundle'

docker exec "${CONTAINER}" cp "${FIXTURE_DIR}/bug.json" \
  "${FIXTURE_DIR}/bug-public.json"
docker exec "${CONTAINER}" chmod 0644 "${FIXTURE_DIR}/bug-public.json"
expect_failure 'group/world-readable input' 65 \
  feedback collect bug --input "${FIXTURE_DIR}/bug-public.json"
docker exec "${CONTAINER}" rm -f "${FIXTURE_DIR}/bug-public.json"

docker exec "${CONTAINER}" ln "${FIXTURE_DIR}/bug.json" \
  "${FIXTURE_DIR}/bug-hardlink.json"
expect_failure 'hard-linked input' 65 \
  feedback collect bug --input "${FIXTURE_DIR}/bug-hardlink.json"
docker exec "${CONTAINER}" rm -f "${FIXTURE_DIR}/bug-hardlink.json"

docker exec "${CONTAINER}" mkfifo "${FIXTURE_DIR}/bug-fifo.json"
expect_failure 'FIFO input' 65 \
  feedback collect bug --input "${FIXTURE_DIR}/bug-fifo.json"
docker exec "${CONTAINER}" rm -f "${FIXTURE_DIR}/bug-fifo.json"
[[ $(report_count) -eq "${REPORTS_BEFORE}" ]] \
  || fail 'unsafe input type or mode created a report bundle'

docker exec "${CONTAINER}" /bin/sh -ceu '
  cp "$1/report.json" /tmp/outside-report.json
  chmod 0600 /tmp/outside-report.json
' sh "${BUG_DIRECTORY}"
expect_failure 'report path outside the managed root' 65 \
  feedback validate /tmp/outside-report.json

UNAUTH_STATUS=$(github_feedback github status) \
  || fail 'unauthenticated GitHub status failed'
assert_json 'unauthenticated status was not reported' \
  '.authenticated == false and .hostname == "github.com"' \
  "${UNAUTH_STATUS}"

UNAUTH_PREVIEW=$(github_feedback github submit "${BUG_DIRECTORY}") \
  || fail 'unauthenticated preview failed'
assert_json 'unauthenticated preview did not return the web fallback' '
  .action == "web_fallback"
  and .reason == "github_cli_not_authenticated"
  and .repository == "Kanu-Coffee/codex-for-home-assistant"
  and .label == "bug"
  and (.title | startswith("[Bug] "))
  and (.body_file | endswith("/public-report.md"))
  and .fallback.template == "bug_report.yml"
  and (.fallback.url | startswith("https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/new?"))
  and (.fallback.url | contains("body=") | not)
  and (.fallback.url | length < 2048)
  and .login_command == "ha-feedback github login"
' "${UNAUTH_PREVIEW}"

BUG_URL=$(github_feedback github url "${BUG_DIRECTORY}") \
  || fail 'bug Issue Form URL fallback failed'
assert_json 'Issue Form fallback embedded the long report body' '
  .template == "bug_report.yml"
  and (.url | startswith("https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/new?"))
  and (.url | contains("body=") | not)
  and (.url | contains("ha-feedback%20schema") | not)
  and (.url | length < 2048)
  and (.copy_report_from | endswith("/public-report.md"))
' "${BUG_URL}"

[[ $(create_count) -eq 0 ]] \
  || fail 'preview created an issue without confirmation'
expect_failure 'login without backup-risk confirmation' 64 \
  github_feedback github login
docker exec "${CONTAINER}" test ! -e /data/github-cli/hosts.yml \
  || fail 'unconfirmed login persisted authentication'

LOGIN_RESULT=$(github_feedback github login --confirm-backup-risk) \
  || fail 'confirmed fake GitHub login failed'
assert_json 'confirmed login did not report authentication' \
  '.authenticated == true and .config_directory == "/data/github-cli"' \
  "${LOGIN_RESULT}"
[[ $(docker exec "${CONTAINER}" stat -c '%a' /data/github-cli) == 700 ]] \
  || fail 'GitHub CLI config directory is not mode 0700'
[[ $(docker exec "${CONTAINER}" stat -c '%a' \
  /data/github-cli/hosts.yml) == 600 ]] \
  || fail 'GitHub CLI credential file is not mode 0600'

docker restart "${CONTAINER}" >/dev/null
PERSISTED_STATUS=$(github_feedback github status) \
  || fail 'persisted authentication was not readable after restart'
assert_json 'authentication did not persist across a container restart' \
  '.authenticated == true and .config_directory == "/data/github-cli"' \
  "${PERSISTED_STATUS}"

AUTH_REPLAY_PREVIEW=$(github_feedback github submit \
  "${AMBIGUOUS_DIRECTORY}") \
  || fail 'authentication replay preview failed'
AUTH_REPLAY_TOKEN=$(json_value '.confirmation_token' \
  "${AUTH_REPLAY_PREVIEW}")
github_feedback github logout --confirm >/dev/null \
  || fail 'fake logout for confirmation replay test failed'
CREATES_BEFORE_AUTH_REPLAY=$(create_count)
AUTH_REPLAY_FALLBACK=$(github_feedback github submit \
  "${AMBIGUOUS_DIRECTORY}" --confirm "${AUTH_REPLAY_TOKEN}") \
  || fail 'unauthenticated confirmation did not return a fallback'
assert_json 'unauthenticated confirmation retained a replayable token' '
  .action == "web_fallback"
  and .reason == "github_cli_not_authenticated"
  and .report_preserved == true
  and .fresh_preview_required == true
' "${AUTH_REPLAY_FALLBACK}"
github_feedback github login --confirm-backup-risk >/dev/null \
  || fail 'fake re-login for confirmation replay test failed'
expect_failure 'confirmation token reused after authentication fallback' 65 \
  github_feedback github submit "${AMBIGUOUS_DIRECTORY}" \
    --confirm "${AUTH_REPLAY_TOKEN}"
[[ $(create_count) -eq "${CREATES_BEFORE_AUTH_REPLAY}" ]] \
  || fail 'authentication fallback token reached issue creation'

for timestamp_mode in expired future; do
  TIMESTAMP_PREVIEW=$(github_feedback github submit \
    "${AMBIGUOUS_DIRECTORY}") \
    || fail "${timestamp_mode} timestamp preview failed"
  TIMESTAMP_TOKEN=$(json_value '.confirmation_token' "${TIMESTAMP_PREVIEW}")
  PREVIEW_STATE="/run/codex-ha/ha-feedback-previews/${AMBIGUOUS_REPORT_ID}.json"
  [[ $(docker exec "${CONTAINER}" stat -c '%a' \
    /run/codex-ha/ha-feedback-previews) == 700 ]] \
    || fail 'preview state directory is not private'
  [[ $(docker exec "${CONTAINER}" stat -c '%a' "${PREVIEW_STATE}") == 600 ]] \
    || fail 'preview state file is not private'
  if [[ "${timestamp_mode}" == expired ]]; then
    created_at=2020-01-01T00:00:00.000Z
    expires_at=2020-01-01T00:10:00.000Z
  else
    created_at=2099-01-01T00:00:00.000Z
    expires_at=2099-01-01T00:10:00.000Z
  fi
  docker exec "${CONTAINER}" /bin/sh -ceu '
    state=$1
    created_at=$2
    expires_at=$3
    temporary="${state}.new"
    jq --arg created_at "${created_at}" --arg expires_at "${expires_at}" \
      ".created_at = \$created_at | .expires_at = \$expires_at" \
      "${state}" > "${temporary}"
    chmod 0600 "${temporary}"
    mv -f "${temporary}" "${state}"
  ' sh "${PREVIEW_STATE}" "${created_at}" "${expires_at}"
  CREATES_BEFORE_BAD_TIMESTAMP=$(create_count)
  expect_failure "${timestamp_mode} confirmation preview" 65 \
    github_feedback github submit "${AMBIGUOUS_DIRECTORY}" \
      --confirm "${TIMESTAMP_TOKEN}"
  [[ $(create_count) -eq "${CREATES_BEFORE_BAD_TIMESTAMP}" ]] \
    || fail "${timestamp_mode} preview reached issue creation"
  docker exec "${CONTAINER}" test ! -e \
    "${AMBIGUOUS_DIRECTORY}/.submission.lock" \
    || fail "${timestamp_mode} preview retained a submission lock"
done

CALLS_BEFORE_DANGLING_RECEIPT=$(call_count)
docker exec "${CONTAINER}" ln -s /tmp/missing-submission-receipt \
  "${AUXILIARY_DIRECTORY}/submission.json"
expect_failure 'dangling submission receipt symbolic link' 65 \
  github_feedback github submit "${AUXILIARY_DIRECTORY}"
[[ $(call_count) -eq "${CALLS_BEFORE_DANGLING_RECEIPT}" ]] \
  || fail 'unsafe submission receipt reached a GitHub side effect'
docker exec "${CONTAINER}" rm "${AUXILIARY_DIRECTORY}/submission.json"

CREATES_BEFORE_CANDIDATE_FAILURE=$(create_count)
for list_mode in fail-list invalid-list; do
  docker exec "${CONTAINER}" touch "${FAKE_GH_STATE}/${list_mode}"
  CANDIDATE_FALLBACK=$(github_feedback github submit \
    "${FEATURE_DIRECTORY}") \
    || fail "${list_mode} candidate lookup was not handled"
  docker exec "${CONTAINER}" rm -f "${FAKE_GH_STATE}/${list_mode}"
  assert_json "${list_mode} candidate lookup did not fail closed" '
    .action == "web_fallback"
    and .reason == "issue_candidate_search_unavailable"
    and .candidates.available == false
    and (.candidates.issues | length == 0)
    and (has("confirmation_token") | not)
  ' "${CANDIDATE_FALLBACK}"
  [[ $(create_count) -eq "${CREATES_BEFORE_CANDIDATE_FAILURE}" ]] \
    || fail "${list_mode} candidate lookup reached issue creation"
done

BUG_PREVIEW_ONE=$(github_feedback github submit "${BUG_DIRECTORY}") \
  || fail 'first authenticated bug preview failed'
assert_json 'first authenticated bug preview contract failed' '
  .action == "confirmation_required"
  and .repository == "Kanu-Coffee/codex-for-home-assistant"
  and .title == "[Bug] Ingress terminal does not recover after a brief connection loss"
  and .label == "bug"
  and (.body_file | endswith("/public-report.md"))
  and .candidates.available == true
  and (.candidates.issues | length == 1)
  and .candidates.issues[0].number == 40
  and (.confirmation_token | test("^hfp_[A-Za-z0-9_-]{43}$"))
  and (.confirmation_expires_at | type == "string" and endswith("Z"))
' "${BUG_PREVIEW_ONE}"
BUG_TOKEN_ONE=$(json_value '.confirmation_token' "${BUG_PREVIEW_ONE}")

expect_failure 'malformed confirmation token' 65 \
  github_feedback github submit "${BUG_DIRECTORY}" \
    --confirm malformed-token
expect_failure 'correct token after malformed confirmation attempt' 65 \
  github_feedback github submit "${BUG_DIRECTORY}" \
    --confirm "${BUG_TOKEN_ONE}"

BUG_PREVIEW_ONE=$(github_feedback github submit "${BUG_DIRECTORY}") \
  || fail 'replacement authenticated bug preview failed'
BUG_TOKEN_ONE=$(json_value '.confirmation_token' "${BUG_PREVIEW_ONE}")

BUG_PREVIEW_TWO=$(github_feedback github submit "${BUG_DIRECTORY}") \
  || fail 'second authenticated bug preview failed'
assert_json 'second preview did not produce an opaque token' \
  '.action == "confirmation_required" and (.confirmation_token | test("^hfp_[A-Za-z0-9_-]{43}$"))' \
  "${BUG_PREVIEW_TWO}"
BUG_TOKEN_TWO=$(json_value '.confirmation_token' "${BUG_PREVIEW_TWO}")
[[ "${BUG_TOKEN_ONE}" != "${BUG_TOKEN_TWO}" ]] \
  || fail 'two bug previews returned the same confirmation token'

# The older valid-shaped token is wrong for the latest state. Its failed use
# atomically consumes that state, so even the latest token then becomes stale.
expect_failure 'older confirmation token' 65 \
  github_feedback github submit "${BUG_DIRECTORY}" \
    --confirm "${BUG_TOKEN_ONE}"
expect_failure 'token from a consumed preview' 65 \
  github_feedback github submit "${BUG_DIRECTORY}" \
    --confirm "${BUG_TOKEN_TWO}"
[[ $(create_count) -eq "${CREATES_BEFORE_CANDIDATE_FAILURE}" ]] \
  || fail 'rejected preview tokens reached issue creation'

BUG_PREVIEW=$(github_feedback github submit "${BUG_DIRECTORY}") \
  || fail 'fresh bug preview after token consumption failed'
BUG_TOKEN=$(json_value '.confirmation_token' "${BUG_PREVIEW}")
assert_json 'fresh bug preview did not replace consumed state' \
  '.action == "confirmation_required" and (.confirmation_token | test("^hfp_[A-Za-z0-9_-]{43}$"))' \
  "${BUG_PREVIEW}"

FEATURE_DUPLICATE_PREVIEW=$(github_feedback github submit \
  "${FEATURE_DIRECTORY}") \
  || fail 'feature preview for duplicate lookup failure failed'
FEATURE_DUPLICATE_TOKEN=$(json_value '.confirmation_token' \
  "${FEATURE_DUPLICATE_PREVIEW}")
docker exec "${CONTAINER}" touch "${FAKE_GH_STATE}/fail-list"
CREATES_BEFORE_DUPLICATE_FAILURE=$(create_count)
DUPLICATE_FAILURE_FALLBACK=$(github_feedback github submit \
  "${FEATURE_DIRECTORY}" --confirm "${FEATURE_DUPLICATE_TOKEN}") \
  || fail 'failed duplicate lookup did not return a controlled fallback'
docker exec "${CONTAINER}" rm -f "${FAKE_GH_STATE}/fail-list"
assert_json 'failed duplicate lookup did not fail closed' '
  .action == "web_fallback"
  and .reason == "duplicate_check_unavailable_no_create"
  and .report_preserved == true
  and .fresh_preview_required == true
' "${DUPLICATE_FAILURE_FALLBACK}"
[[ $(create_count) -eq "${CREATES_BEFORE_DUPLICATE_FAILURE}" ]] \
  || fail 'failed duplicate lookup reached issue creation'
docker exec "${CONTAINER}" test ! -e \
  "${FEATURE_DIRECTORY}/.submission.lock" \
  || fail 'failed duplicate lookup retained a submission lock'
expect_failure 'token consumed by failed duplicate lookup' 65 \
  github_feedback github submit "${FEATURE_DIRECTORY}" \
    --confirm "${FEATURE_DUPLICATE_TOKEN}"

FEATURE_INVALID_PREVIEW=$(github_feedback github submit \
  "${FEATURE_DIRECTORY}") \
  || fail 'feature preview for invalid duplicate result failed'
FEATURE_INVALID_TOKEN=$(json_value '.confirmation_token' \
  "${FEATURE_INVALID_PREVIEW}")
docker exec "${CONTAINER}" touch "${FAKE_GH_STATE}/invalid-list"
INVALID_DUPLICATE_FALLBACK=$(github_feedback github submit \
  "${FEATURE_DIRECTORY}" --confirm "${FEATURE_INVALID_TOKEN}") \
  || fail 'invalid duplicate lookup did not return a controlled fallback'
docker exec "${CONTAINER}" rm -f "${FAKE_GH_STATE}/invalid-list"
assert_json 'invalid duplicate lookup did not fail closed' '
  .action == "web_fallback"
  and .reason == "duplicate_check_unavailable_no_create"
  and .fresh_preview_required == true
' "${INVALID_DUPLICATE_FALLBACK}"
[[ $(create_count) -eq "${CREATES_BEFORE_DUPLICATE_FAILURE}" ]] \
  || fail 'invalid duplicate lookup reached issue creation'
docker exec "${CONTAINER}" test ! -e \
  "${FEATURE_DIRECTORY}/.submission.lock" \
  || fail 'invalid duplicate lookup retained a submission lock'

FEATURE_REMOTE_DUPLICATE_PREVIEW=$(github_feedback github submit \
  "${FEATURE_DIRECTORY}") \
  || fail 'feature preview for an existing remote report failed'
FEATURE_REMOTE_DUPLICATE_TOKEN=$(json_value '.confirmation_token' \
  "${FEATURE_REMOTE_DUPLICATE_PREVIEW}")
docker exec "${CONTAINER}" touch "${FAKE_GH_STATE}/duplicate"
CREATES_BEFORE_REMOTE_DUPLICATE=$(create_count)
expect_failure 'existing remote report ID' 73 \
  github_feedback github submit "${FEATURE_DIRECTORY}" \
    --confirm "${FEATURE_REMOTE_DUPLICATE_TOKEN}"
docker exec "${CONTAINER}" rm -f "${FAKE_GH_STATE}/duplicate"
[[ $(create_count) -eq "${CREATES_BEFORE_REMOTE_DUPLICATE}" ]] \
  || fail 'existing remote report ID reached issue creation'
docker exec "${CONTAINER}" test ! -e \
  "${FEATURE_DIRECTORY}/submission.json" \
  || fail 'existing remote report ID wrote a local receipt'
docker exec "${CONTAINER}" test ! -e \
  "${FEATURE_DIRECTORY}/.submission.lock" \
  || fail 'existing remote report ID retained a submission lock'

FEATURE_PREVIEW=$(github_feedback github submit "${FEATURE_DIRECTORY}") \
  || fail 'fresh authenticated feature preview failed'
assert_json 'fresh authenticated feature preview contract failed' '
  .action == "confirmation_required"
  and .repository == "Kanu-Coffee/codex-for-home-assistant"
  and .title == "[Feature] Provide a guided workflow for verified App feedback"
  and .label == "enhancement"
  and (.body_file | endswith("/public-report.md"))
  and .candidates.available == true
  and (.confirmation_token | test("^hfp_[A-Za-z0-9_-]{43}$"))
' "${FEATURE_PREVIEW}"
FEATURE_TOKEN=$(json_value '.confirmation_token' "${FEATURE_PREVIEW}")

[[ $(create_count) -eq "${CREATES_BEFORE_CANDIDATE_FAILURE}" ]] \
  || fail 'authenticated preview created an issue without confirmation'
expect_failure 'arbitrary repository argument' 64 \
  github_feedback github submit "${FEATURE_DIRECTORY}" \
    --repo attacker/alternate-repository

BUG_BODY_SHA256=$(docker exec "${CONTAINER}" sha256sum \
  "${BUG_DIRECTORY}/public-report.md" | awk '{print $1}')

BUG_SUBMIT=$(github_feedback github submit "${BUG_DIRECTORY}" \
  --confirm "${BUG_TOKEN}") \
  || fail 'confirmed fake issue submission failed'
assert_json 'successful submission receipt is incomplete' '
  .action == "submitted"
  and .issue_number == 42
  and .issue_url == "https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/42"
  and (.submission_receipt | endswith("/submission.json"))
' "${BUG_SUBMIT}"
docker exec "${CONTAINER}" jq --exit-status '
  (keys | sort) == ["issue_number", "issue_url", "submitted_at"]
  and .issue_number == 42
  and .issue_url == "https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/42"
  and (.submitted_at | type == "string" and endswith("Z"))
' "${BUG_DIRECTORY}/submission.json" >/dev/null \
  || fail 'submission.json contains unexpected or missing fields'
[[ $(docker exec "${CONTAINER}" stat -c '%a' \
  "${BUG_DIRECTORY}/submission.json") == 600 ]] \
  || fail 'submission.json is not mode 0600'
docker exec "${CONTAINER}" test ! -e \
  "${BUG_DIRECTORY}/.submission.lock" \
  || fail 'successful submission retained its submission lock'
assert_body_hash_logged bug "${BUG_BODY_SHA256}"

CREATES_AFTER_SUCCESS=$(create_count)
[[ "${CREATES_AFTER_SUCCESS}" -eq 1 ]] \
  || fail 'successful submission did not create exactly once'
expect_failure 'duplicate report submission' 73 \
  github_feedback github submit "${BUG_DIRECTORY}" \
    --confirm "${BUG_TOKEN}"
[[ $(create_count) -eq "${CREATES_AFTER_SUCCESS}" ]] \
  || fail 'duplicate report submission retried issue creation'

FEATURE_BODY_SHA256=$(docker exec "${CONTAINER}" sha256sum \
  "${FEATURE_DIRECTORY}/public-report.md" | awk '{print $1}')
docker exec "${CONTAINER}" touch "${FAKE_GH_STATE}/fail-create"
CREATES_BEFORE_FAILURE=$(create_count)
FEATURE_FALLBACK=$(github_feedback github submit "${FEATURE_DIRECTORY}" \
  --confirm "${FEATURE_TOKEN}") \
  || fail 'simulated create failure did not return a controlled fallback'
assert_json 'create failure fallback contract failed' '
  .action == "web_fallback"
  and .reason == "github_issue_create_failed_no_retry"
  and .report_preserved == true
  and .submission_locked_as_uncertain == true
  and .fallback.template == "feature_request.yml"
  and (.fallback.url | startswith("https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/new?"))
  and (.fallback.url | contains("body=") | not)
' "${FEATURE_FALLBACK}"
[[ $(create_count) -eq $((CREATES_BEFORE_FAILURE + 1)) ]] \
  || fail 'simulated create failure was retried'
docker exec "${CONTAINER}" test ! -e \
  "${FEATURE_DIRECTORY}/submission.json" \
  || fail 'failed issue creation wrote a submission receipt'
[[ $(docker exec "${CONTAINER}" stat -c '%a' \
  "${FEATURE_DIRECTORY}/.submission.lock") == 600 ]] \
  || fail 'failed issue creation did not retain a private submission lock'
CREATES_AFTER_FAILURE=$(create_count)
expect_failure 'direct retry after uncertain create result' 73 \
  github_feedback github submit "${FEATURE_DIRECTORY}" \
    --confirm "${FEATURE_TOKEN}"
[[ $(create_count) -eq "${CREATES_AFTER_FAILURE}" ]] \
  || fail 'locked direct retry reached issue creation'
UNCERTAIN_PREVIEW=$(github_feedback github submit "${FEATURE_DIRECTORY}") \
  || fail 'uncertain create result did not expose its safe fallback'
assert_json 'uncertain create result allowed a direct retry' '
  .action == "web_fallback"
  and .reason == "submission_result_uncertain_no_retry"
  and .report_preserved == true
  and (has("confirmation_token") | not)
' "${UNCERTAIN_PREVIEW}"
feedback validate "${FEATURE_DIRECTORY}" >/dev/null \
  || fail 'failed issue creation did not preserve the report'
assert_body_hash_logged enhancement "${FEATURE_BODY_SHA256}"
docker exec "${CONTAINER}" rm -f "${FAKE_GH_STATE}/fail-create"

CONCURRENT_PREVIEW=$(github_feedback github submit \
  "${AUXILIARY_DIRECTORY}") \
  || fail 'concurrency preview failed'
CONCURRENT_TOKEN=$(json_value '.confirmation_token' "${CONCURRENT_PREVIEW}")
CONCURRENT_BODY_SHA256=$(docker exec "${CONTAINER}" sha256sum \
  "${AUXILIARY_DIRECTORY}/public-report.md" | awk '{print $1}')
docker exec "${CONTAINER}" touch "${FAKE_GH_STATE}/slow-create"
CREATES_BEFORE_CONCURRENCY=$(create_count)
CONCURRENT_ONE_OUTPUT="${WORK_DIR}/concurrent-one.out"
CONCURRENT_TWO_OUTPUT="${WORK_DIR}/concurrent-two.out"

github_feedback github submit "${AUXILIARY_DIRECTORY}" \
  --confirm "${CONCURRENT_TOKEN}" \
  > "${CONCURRENT_ONE_OUTPUT}" 2>&1 &
CONCURRENT_ONE_PID=$!
github_feedback github submit "${AUXILIARY_DIRECTORY}" \
  --confirm "${CONCURRENT_TOKEN}" \
  > "${CONCURRENT_TWO_OUTPUT}" 2>&1 &
CONCURRENT_TWO_PID=$!
if wait "${CONCURRENT_ONE_PID}"; then
  CONCURRENT_ONE_STATUS=0
else
  CONCURRENT_ONE_STATUS=$?
fi
if wait "${CONCURRENT_TWO_PID}"; then
  CONCURRENT_TWO_STATUS=0
else
  CONCURRENT_TWO_STATUS=$?
fi
docker exec "${CONTAINER}" rm -f "${FAKE_GH_STATE}/slow-create"

if [[ "${CONCURRENT_ONE_STATUS}" -eq 0 \
  && ( "${CONCURRENT_TWO_STATUS}" -eq 65 \
    || "${CONCURRENT_TWO_STATUS}" -eq 73 ) ]]; then
  CONCURRENT_SUCCESS_OUTPUT=${CONCURRENT_ONE_OUTPUT}
elif [[ ( "${CONCURRENT_ONE_STATUS}" -eq 65 \
    || "${CONCURRENT_ONE_STATUS}" -eq 73 ) \
  && "${CONCURRENT_TWO_STATUS}" -eq 0 ]]; then
  CONCURRENT_SUCCESS_OUTPUT=${CONCURRENT_TWO_OUTPUT}
else
  fail "concurrent submit statuses were ${CONCURRENT_ONE_STATUS} and ${CONCURRENT_TWO_STATUS}, expected one 0 and one 65/73"
fi
[[ $(create_count) -eq $((CREATES_BEFORE_CONCURRENCY + 1)) ]] \
  || fail 'concurrent confirmation reached issue creation more than once'
CONCURRENT_RESULT=$(< "${CONCURRENT_SUCCESS_OUTPUT}")
assert_json 'concurrent winning submission did not complete' \
  '.action == "submitted" and .issue_number == 42' \
  "${CONCURRENT_RESULT}"
[[ $(docker exec "${CONTAINER}" stat -c '%a' \
  "${AUXILIARY_DIRECTORY}/submission.json") == 600 ]] \
  || fail 'concurrent winner did not write a private receipt'
docker exec "${CONTAINER}" test ! -e \
  "${AUXILIARY_DIRECTORY}/.submission.lock" \
  || fail 'concurrent successful submission retained its lock'
assert_body_hash_logged bug "${CONCURRENT_BODY_SHA256}"

CREATES_BEFORE_CORRUPT_RECEIPT=$(create_count)
docker exec "${CONTAINER}" /bin/sh -ceu '
  printf "{}\n" > "$1/submission.json"
  chmod 0600 "$1/submission.json"
' sh "${AUXILIARY_DIRECTORY}"
expect_failure 'corrupt successful submission receipt' 65 \
  github_feedback github submit "${AUXILIARY_DIRECTORY}"
[[ $(create_count) -eq "${CREATES_BEFORE_CORRUPT_RECEIPT}" ]] \
  || fail 'corrupt receipt allowed another issue creation'

AMBIGUOUS_PREVIEW=$(github_feedback github submit \
  "${AMBIGUOUS_DIRECTORY}") \
  || fail 'ambiguous-result preview failed'
AMBIGUOUS_TOKEN=$(json_value '.confirmation_token' "${AMBIGUOUS_PREVIEW}")
AMBIGUOUS_BODY_SHA256=$(docker exec "${CONTAINER}" sha256sum \
  "${AMBIGUOUS_DIRECTORY}/public-report.md" | awk '{print $1}')
docker exec "${CONTAINER}" touch "${FAKE_GH_STATE}/unexpected-create"
CREATES_BEFORE_AMBIGUOUS=$(create_count)
expect_failure 'successful create with an unexpected issue location' 69 \
  github_feedback github submit "${AMBIGUOUS_DIRECTORY}" \
    --confirm "${AMBIGUOUS_TOKEN}"
docker exec "${CONTAINER}" rm -f "${FAKE_GH_STATE}/unexpected-create"
[[ $(create_count) -eq $((CREATES_BEFORE_AMBIGUOUS + 1)) ]] \
  || fail 'ambiguous external result did not make exactly one create call'
docker exec "${CONTAINER}" test ! -e \
  "${AMBIGUOUS_DIRECTORY}/submission.json" \
  || fail 'ambiguous external result wrote an unverified receipt'
[[ $(docker exec "${CONTAINER}" stat -c '%a' \
  "${AMBIGUOUS_DIRECTORY}/.submission.lock") == 600 ]] \
  || fail 'ambiguous external result did not retain a private lock'
CREATES_AFTER_AMBIGUOUS=$(create_count)
expect_failure 'direct retry after ambiguous external result' 73 \
  github_feedback github submit "${AMBIGUOUS_DIRECTORY}" \
    --confirm "${AMBIGUOUS_TOKEN}"
[[ $(create_count) -eq "${CREATES_AFTER_AMBIGUOUS}" ]] \
  || fail 'ambiguous-result retry reached issue creation'
assert_body_hash_logged enhancement "${AMBIGUOUS_BODY_SHA256}"

docker exec "${CONTAINER}" /bin/sh -ceu '
  log=$1
  repository=$2
  grep -F "ARG=issue ARG=create" "${log}" \
    | grep -F "ARG=--repo ARG=${repository}" \
    | grep -F "ARG=--label ARG=bug" >/dev/null
  grep -F "ARG=issue ARG=create" "${log}" \
    | grep -F "ARG=--repo ARG=${repository}" \
    | grep -F "ARG=--label ARG=enhancement" >/dev/null
  if grep -F "ARG=--repo" "${log}" \
      | grep -Fv "ARG=--repo ARG=${repository}" \
      | grep -q .; then
    exit 1
  fi
  if grep -F "ARG=issue ARG=create" "${log}" \
      | grep -Fv "ARG=--body-file ARG=-" \
      | grep -q .; then
    exit 1
  fi
  if grep -F "ARG=issue ARG=create" "${log}" \
      | grep -Ev " STDIN_SHA256=[a-f0-9]{64}$" \
      | grep -q .; then
    exit 1
  fi
  if grep -Fq "The existing terminal session should become usable again" \
      "${log}" \
    || grep -Fq "<!-- ha-feedback schema=" "${log}" \
    || grep -Fq "hfp_" "${log}"; then
    exit 1
  fi
' sh "${FAKE_GH_LOG}" "${TARGET_REPOSITORY}" \
  || fail 'fake gh log exposed body/token data or mutable submission metadata'

docker exec "${CONTAINER}" /bin/sh -ceu '
  umask 077
  jq ".security_issue = true" "$1" > "$2"
  chmod 0600 "$2"
' sh "${FIXTURE_DIR}/bug.json" "${FIXTURE_DIR}/security.json"
SECURITY_COLLECT=$(feedback collect bug --input \
  "${FIXTURE_DIR}/security.json") \
  || fail 'security fixture collection failed'
SECURITY_DIRECTORY=$(json_value '.report_directory' "${SECURITY_COLLECT}")
assert_report_permissions "${SECURITY_DIRECTORY}"
CREATES_BEFORE_SECURITY=$(create_count)

SECURITY_URL=$(github_feedback github url "${SECURITY_DIRECTORY}") \
  || fail 'security private-reporting route failed'
assert_json 'security URL was not kept on the private route' '
  .blocked == true
  and .reason == "possible_security_vulnerability"
  and .private_reporting_url == "https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new"
  and (has("url") | not)
' "${SECURITY_URL}"
SECURITY_PREVIEW=$(github_feedback github submit "${SECURITY_DIRECTORY}") \
  || fail 'security preview did not return its private route'
assert_json 'security preview exposed a public submission route' '
  .blocked == true
  and .reason == "possible_security_vulnerability"
  and (has("confirmation_token") | not)
' "${SECURITY_PREVIEW}"
expect_failure 'confirmed public submission of a security report' 65 \
  github_feedback github submit "${SECURITY_DIRECTORY}" \
    --confirm blocked-security-report
[[ $(create_count) -eq "${CREATES_BEFORE_SECURITY}" ]] \
  || fail 'security report reached issue creation'
docker exec "${CONTAINER}" test ! -e \
  "${SECURITY_DIRECTORY}/submission.json" \
  || fail 'security report wrote a public submission receipt'

expect_failure 'logout without explicit confirmation' 64 \
  github_feedback github logout
LOGOUT_RESULT=$(github_feedback github logout --confirm) \
  || fail 'confirmed fake GitHub logout failed'
assert_json 'logout did not clear authentication' \
  '.authenticated == false and .config_directory == "/data/github-cli"' \
  "${LOGOUT_RESULT}"
docker exec "${CONTAINER}" test ! -e /data/github-cli/hosts.yml \
  || fail 'logout preserved the fake credential file'
[[ $(docker exec "${CONTAINER}" stat -c '%a' /data/github-cli) == 700 ]] \
  || fail 'GitHub CLI config directory permissions changed after logout'

docker exec "${CONTAINER}" /bin/sh -ceu '
  install -d -m 0700 /tmp/unsafe-github-cli-target
  rmdir /data/github-cli
  ln -s /tmp/unsafe-github-cli-target /data/github-cli
'
expect_failure 'symbolic-link GitHub CLI config directory' 65 \
  github_feedback github status

printf 'Feedback smoke passed: %s (gh %s, no external writes)\n' \
  "${IMAGE}" "${EXPECTED_GH_VERSION}"
