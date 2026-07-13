import os
import shutil
import subprocess
from pathlib import Path

import pytest


TOKEN = "unit-test-supervisor-token"


def _bash_path() -> str | None:
    if os.name == "nt":
        candidates = (
            Path(r"C:\Program Files\Git\bin\bash.exe"),
            Path(r"C:\Program Files\Git\usr\bin\bash.exe"),
        )
        return next((str(path) for path in candidates if path.exists()), None)
    return shutil.which("bash")


@pytest.fixture()
def api_harness(tmp_path: Path, rootfs: Path) -> tuple[str, Path, Path]:
    bash = _bash_path()
    if bash is None:
        pytest.skip("bash is required for API helper unit tests")

    jq_check = subprocess.run(
        [bash, "-lc", "command -v jq"], capture_output=True, text=True, check=False
    )
    if jq_check.returncode != 0:
        pytest.skip("jq is required for API helper unit tests")

    harness = tmp_path / "api-harness.sh"
    harness.write_text(
        """#!/usr/bin/env bash
set -Eeuo pipefail
API_PROGRAM_NAME=${TEST_API_PROGRAM_NAME:-test-api}
API_BASE_URL=http://example.invalid
API_CHECK_RESULT=${TEST_API_CHECK_RESULT:-false}
library=$1
shift
# shellcheck source=/dev/null
. "${library}"
api_main "$@"
""",
        encoding="utf-8",
    )

    mock_curl = tmp_path / "mock-curl"
    mock_curl.write_text(
        """#!/usr/bin/env bash
set -Eeuo pipefail
output=''
authorization_file=''
accept_header=''
response_body=${MOCK_BODY-}
if [[ -z "${response_body}" ]]; then
  response_body='{}'
fi
while (( $# > 0 )); do
  case "$1" in
    --output)
      output=$2
      shift 2
      ;;
    --header)
      if [[ "$2" == @* ]]; then
        authorization_file=${2#@}
      elif [[ "$2" == 'Accept: '* ]]; then
        accept_header=$2
      fi
      shift 2
      ;;
    --request|--write-out|--connect-timeout|--max-time|--data)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -z "${authorization_file}" ]] \
  || ! grep -Fqx "Authorization: Bearer ${SUPERVISOR_TOKEN}" "${authorization_file}"; then
  exit 90
fi
if [[ "${accept_header}" != "Accept: ${MOCK_EXPECT_ACCEPT}" ]]; then
  exit 91
fi
if [[ -n "${output}" ]]; then
  printf '%s' "${response_body}" > "${output}"
fi
printf '%s' "${MOCK_STATUS:-200}"
exit "${MOCK_CURL_EXIT:-0}"
""",
        encoding="utf-8",
    )
    mock_curl.chmod(0o755)

    library = rootfs / "usr/local/lib/codex-ha/api-client.sh"
    return bash, harness, library


def run_api(
    api_harness: tuple[str, Path, Path],
    *arguments: str,
    body: str = "{}",
    status: str = "200",
    check_result: bool = False,
    token: str | None = TOKEN,
    curl_exit: str = "0",
    expected_accept: str = "application/json",
) -> subprocess.CompletedProcess[str]:
    bash, harness, library = api_harness
    env = os.environ.copy()
    env.update(
        {
            "CURL_BIN": str(harness.parent / "mock-curl"),
            "MOCK_BODY": body,
            "MOCK_STATUS": status,
            "MOCK_CURL_EXIT": curl_exit,
            "MOCK_EXPECT_ACCEPT": expected_accept,
            "TEST_API_CHECK_RESULT": "true" if check_result else "false",
        }
    )
    if token is None:
        env.pop("SUPERVISOR_TOKEN", None)
    else:
        env["SUPERVISOR_TOKEN"] = token

    return subprocess.run(
        [bash, str(harness), str(library), *arguments],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def test_mock_success_returns_pretty_json(api_harness: tuple[str, Path, Path]) -> None:
    result = run_api(api_harness, "GET", "/states", body='{"value":1}')

    assert result.returncode == 0
    assert '"value": 1' in result.stdout
    assert result.stderr == ""
    assert TOKEN not in result.stdout + result.stderr


def test_mock_http_error_is_nonzero_and_redacted(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "POST",
        "/services/light/turn_on",
        "{}",
        body=f'{{"message":"request rejected for {TOKEN}"}}',
        status="403",
    )

    assert result.returncode != 0
    assert "HTTP 403" in result.stderr
    assert "[REDACTED]" in result.stderr
    assert TOKEN not in result.stdout + result.stderr


def test_supervisor_result_error_is_nonzero_and_redacted(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "POST",
        "/core/check",
        "{}",
        body=f'{{"result":"error","message":"failure {TOKEN}"}}',
        check_result=True,
    )

    assert result.returncode != 0
    assert "Supervisor result was not ok" in result.stderr
    assert "[REDACTED]" in result.stderr
    assert TOKEN not in result.stdout + result.stderr


def test_supervisor_json_without_result_is_nonzero(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "GET",
        "/core/info",
        body='{"data":{}}',
        check_result=True,
    )

    assert result.returncode != 0
    assert "missing the result field" in result.stderr


def test_supervisor_raw_response_may_omit_result(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "--raw",
        "--accept",
        "text/x-log",
        "GET",
        "/core/logs",
        body="plain log line",
        check_result=True,
        expected_accept="text/x-log",
    )

    assert result.returncode == 0
    assert result.stdout == "plain log line\n"


def test_accept_option_rejects_header_injection_without_request(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(
        api_harness,
        "--accept",
        "text/x-log\r\nX-Injected: true",
        "GET",
        "/core/logs",
    )

    assert result.returncode == 64
    assert "unsupported Accept media type" in result.stderr


def test_missing_token_fails_without_invoking_request(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(api_harness, "GET", "/config", token=None)

    assert result.returncode == 78
    assert "SUPERVISOR_TOKEN is unavailable" in result.stderr


def test_transport_error_does_not_disclose_token(
    api_harness: tuple[str, Path, Path]
) -> None:
    result = run_api(api_harness, "GET", "/config", curl_exit="7")

    assert result.returncode == 69
    assert "transport failed" in result.stderr
    assert TOKEN not in result.stdout + result.stderr


def test_api_helper_wrappers_select_expected_result_policy(rootfs: Path) -> None:
    ha_api = (rootfs / "usr/local/bin/ha-api").read_text(encoding="utf-8")
    supervisor_api = (rootfs / "usr/local/bin/supervisor-api").read_text(
        encoding="utf-8"
    )

    assert "API_CHECK_RESULT=false" in ha_api
    assert "API_CHECK_RESULT=true" in supervisor_api
    assert "api_main \"$@\"" in ha_api
    assert "api_main \"$@\"" in supervisor_api


def test_log_helpers_request_supported_log_media_type(rootfs: Path) -> None:
    core_logs = (rootfs / "usr/local/bin/ha-core-logs").read_text(encoding="utf-8")
    addon_logs = (rootfs / "usr/local/bin/ha-addon-logs").read_text(
        encoding="utf-8"
    )

    expected_options = "supervisor-api --raw --accept text/x-log"
    assert f"{expected_options} GET /core/logs" in core_logs
    assert f'{expected_options} GET "/addons/$1/logs"' in addon_logs
