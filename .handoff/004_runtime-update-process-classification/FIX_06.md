# FIX_06 — dev.1 자체점검 후속: 관리 CLI 진단·런타임 버전·정상 종료

## 판정과 범위

- Reviewer: Codex, 2026-10-26 (Asia/Seoul).
- **추가 수정 필요 / 정식 배포 승인 보류**. 사용자 확인에 따라 자동 업데이트 정상 동작과 기본 개발목표 달성은 수용한다. task 004의 기존 로컬 구현 인수와 dev.1 배포 증거를 취소하거나 사용자 시험을 NOT RUN으로 되돌리지 않는다.
- 이번 입력은 사용자 제공 「10 — 내부 시스템 및 정식 배포 준비 점검」이다. 관측 시각은 2026-10-25 22:34–22:39 UTC다. 읽기 전용 운영 이미지 검사이며, 모든 설치의 기동 불능이나 보안 취약점 확인으로 일반화하지 않는다.
- 기준: branch `dev`, HEAD `aa76fe8` (`0.7.2-dev.1` 배포 결과 기록), 시작 작업 트리 clean. PLAN/REPORT, FIX_01~05와 대응 REPORT, 현재 소스·테스트 및 progress의 배포/미해결 기록을 대조했다. 기존 handoff는 변경하지 않는다.
- 본 문서는 dev.1 배포 뒤 발견된 수용 문제를 같은 task의 다음 correction으로 인계한다. Reviewer는 제품 수정·버전 상승·운영 HA 변경·외부 발행을 실행하지 않았다. Executor는 아래 수정과 격리 검증 후 **`FIX_06_REPORT.md`를 새로 작성**한다.

## 증거와 판단의 경계

| 항목 | 판단 |
| --- | --- |
| 자동 업데이트 | 사용자 정상 확인 수용. status만 보고 적용 성공을 추론한 것이 아님 |
| 내부 세션의 wrapper exit 78 | 사용자 관측 사실. 독립 Web/SSH 실패는 아직 확인되지 않음 |
| 오류 범주 오표시 | 소스로 확인. 검사 불능과 검출된 unsafe shape가 같은 wrapper/init 메시지가 됨 |
| 피드백 버전의 모호성 | 소스로 확인. 번들 `codex-real --version` 결과 하나를 `Codex`로 렌더링 |
| Supervisor stop exit 137 | 2026-10-17 VM의 기존 미해결 증거. 이번에 재현하지 않음. 75초 Docker stop 성공과 구별 |
| memory warning 9 / PATH alias EROFS | 집계·경고 관측만 있음. 개별 기능 고장이나 인증/무결성 문제는 미확정 |

## F1 — P1: 관리 CLI 검사 실패의 원인 분리와 지원 실행 경계 검증

### 현재 문제와 관련 파일

- `rootfs/usr/local/bin/codex:78`은 `codex_ha_sensitive_paths_validate /config`의 모든 실패를 unsafe link/file type 메시지와 exit 78로 합친다. 버전 처리보다 앞선다.
- `rootfs/usr/local/lib/codex-ha/sensitive-path-policy.sh:19–81`은 root 확인·임시 파일 생성·find 순회·stat 실패를 상세 범주 없이 반환한다. 보호 tree를 검사할 권한이 없는 경우에도 실제 위험한 파일이 발견된 것처럼 안내한다.
- `rootfs/usr/local/bin/codex-ha-init:94`도 같은 종류의 실패에 alias 제거를 권고한다. 검사 불능에서 사용자 파일 삭제를 유도하지 않아야 한다.
- 위 경로의 `rootfs`는 모두 `codex_home_assistant/rootfs`다. 회귀 파일은 `tests/test_sensitive_path_policy.py`, `tests/managed-sandbox-smoke.sh`, 관련 wrapper/runtime 계약이다.

### 요구 수정

1. 실제 검출된 symlink/special file/hardlink 등 **unsafe shape**, 접근/순회/metadata 검사 **미완료**, 임시 파일 등 **검사 준비 실패**를 고정된 비민감 code로 구분한다. EACCES/EPERM과 파일 유형을 구분할 수 없는 불확실한 결과를 unsafe 발견으로 확정하지 않는다. `-e`/`-f`의 false만으로 ENOENT와 접근 거부를 동일시하지 않도록 검토한다.
2. 모든 검사 불능은 계속 fail closed한다. wrapper의 외부 exit 78 계약은 유지해도 되며, init도 명확히 실패해야 한다. stderr/log는 allowlisted code와 짧은 안내만 출력하고 원래 find/stat 오류, 경로·파일명·값을 노출하지 않는다. 기존 boolean 호출을 변경하면 두 caller 및 테스트를 함께 수정한다.
3. 같은 synthetic 정상 tree에서 독립 Web 터미널 셸, SSH 셸, Codex 도구 sandbox 내부 호출을 비교한다. 실제 독립 Web/SSH에서 관리 wrapper의 `--version` 및 최소 CLI/app-server 진입이 정상이어야 한다. 각 경계의 증거를 따로 기록한다.
4. 중첩 sandbox에서 보호 tree를 검증할 수 없는 것이 의도된 제한이라면 명확한 code와 한국어·영어 안내로 문서화할 수 있다. **그 제한의 명시적 실패는 허용**하며 nested 실행을 무조건 성공시키라는 요구가 아니다. 독립 지원 경로의 실패까지 제한 설명으로 덮지 않는다. 원인이 다른 경우 그 원인을 수정하고 기록한다.
5. `CODEX_*`/사용자 환경변수·옵션·argv에 의한 검사 생략, `--version`만 보호 검사를 건너뛰는 우회, 검사 성공 stamp/cache, 특권 validator 서비스·새 credential 경로 도입을 해결책으로 사용하지 않는다. AppArmor와 관리자 requirements의 deny를 유지한다.

### 필수 검증

- 정상 tree, unreadable 일반 하위 directory, 보호 tree의 metadata/순회 거부, missing mount, 임시 파일 실패, symlink/broken symlink·hardlink·FIFO 대조를 분리한다. 실제 거부가 어려운 errno는 좁은 synthetic/mock 대조로 보완하고 실제 sandbox 검사와 혼동하지 않는다.
- 수정 전 오표시와 수정 후 code 구분, 실패 시 실제 Codex 미실행, 임시 목록 회수, 보호 값/경로 비노출을 검증한다.
- managed sandbox에서 일반 `/config` RW와 보호 read/list deny가 유지돼야 한다. 번들 0.162.1과 사용자 보고의 선택 런타임 0.164.0을 구분해 검사한다. 실행 시 선택 버전이 달라졌다면 관측값을 기록하고 운영 런타임을 강제로 낮추거나 업데이트하지 않는다.
- 기존 managed-sandbox smoke는 sandbox 내부 helper/read deny를 검사하지만 그 안에서 wrapper를 다시 실행하지 않는다. 이 비교를 추가한다. Codex sandbox 생성 자체가 실패한 경우 내부 wrapper 재현 PASS/FAIL로 기록하지 않는다.

## F2 — P2: 피드백의 bundled / selected / observed running 버전 분리

### 현재 문제와 관련 파일

`ha-feedback.mjs:694`의 `readCodexVersion()`은 `/usr/local/libexec/codex-real --version`만 실행한다. `collectEnvironment():773`, `normalizeEnvironment()`와 `renderEnvironment():820`은 이 값을 단일 `codex_version` / `Codex`로 처리한다. 번들 0.162.1과 선택·실행 0.164.0을 구별할 수 없다. `codex-runtime-manager.mjs:getStatus()`에는 이미 `bundledVersion`, `selectedVersion`, `runningVersions`가 있으므로 별도의 process substring parser를 만들지 않는다.

### 요구 수정과 수용 기준

1. 환경 schema/allowlist/렌더링에 번들·선택·관측 실행 버전을 구분해 표시한다. 기존 schema 1과 `codex_version`의 번들 의미를 보존할 수 있는 optional 확장을 우선 검토한다. 기존 report validate/render와 제출 preview의 body 결합을 깨뜨리지 않고, 변경된 본문에 과거 preview token을 재사용하지 않는다.
2. 이미지 manifest 및 기존 관리자의 검증된 읽기 경로를 재사용하고 소스·관측 범위를 명시한다. 번들 version을 알아내기 위해 매 collect에서 raw binary를 실행할 필요가 있는지도 검토한다. Manifest의 버전 표시는 공급망 무결성 인증이 아니다.
3. 수집은 로컬·시간 제한·읽기 전용이어야 한다. `check/update/apply/init/recovery`를 호출하거나 네트워크 릴리스 조회, 선택 링크/상태 수정, 프로세스 재시작을 하지 않는다. 현재 wrapper 실패를 raw binary 호출로 우회해 관리 CLI PASS로 처리하지 않는다.
4. 버전만 엄격한 형식과 길이/개수 제한으로 투영한다. 전체 status, PID/argv/cwd, paths/digests, 원문 exception을 report로 복사하지 않는다. `/proc` 또는 state/link를 확인할 수 없으면 미관측을 분명히 표시한다. 번들 값으로 selected/running을 채우거나 불완전 관측을 전역 `none`으로 확정하지 않는다.
5. bundled≠selected=running, 선택 후 기존 버전 프로세스가 남은 경우, 복수 실행 버전, 완전 유휴, 수집 제한/timeout/비정상 JSON, 선택 상태 불일치, 과거 report 호환·privacy·render parity를 검증한다. 여섯 safe App option 이외의 원본 options/credential 수집을 늘리지 않는다.

관련 수정 후보: `ha-feedback.mjs`, 필요시 기존 manager의 제한된 read-only 버전 snapshot, `tests/test_feedback_contract.py` 및 fixtures, `docs/development/addon_spec.md`의 환경 계약, image-managed ha-feedback 참고 문서와 한국어·영어 사용 문서.

## F3 — P2: Supervisor 일반 stop/restart의 exit 137 미해결

- 이번 보고서에 재시작 결과가 없다고 이전 문제를 완료 처리하지 않는다. progress에는 dev.1의 Supervisor 기본 10초 stop → exit 137, 75초 Docker stop → exit 0이 남아 있다.
- `config.yaml`에는 `timeout`이 없다. 공식 App 설정의 기본값은 10초다. `tests/apparmor-boot-smoke.sh`는 75초 Docker stop과 auto-update OFF를 사용하므로 정상 Supervisor stop 및 auto-update ON 종료의 대체 증거가 아니다.
- 격리 환경에서 S6/서비스 종료 시간, updater의 idle 및 네트워크 대기, memory/browser 활성 상태를 나누어 원인을 확인하고 bounded graceful shutdown을 보장한다. 필요하면 공식 `timeout` 설정을 실제 종료 시간·상한 근거와 함께 조정할 수 있다. 긴 timeout만 붙이고 원인이나 일반 정지 수용을 확인하지 않는 것은 완료가 아니다.
- 선정한 설정 아래 **Supervisor 일반 stop/restart**가 정상 종료하고 Ingress·서비스·인증/설정·메모리 영속성이 복구돼야 한다. updater 진행 중 중단의 lock/부분 archive/선택 링크 일관성도 확인한다. 오류 주입은 synthetic 자료에서만 수행하며, 프로세스 소유권·PID start-time·bounded cleanup 규칙을 유지한다.
- API 요청 timeout은 backend 실패와 구분하고 상태를 재조회한다. 종료 확인 없이 중복 update/restart하거나 정상 중첩 Remote 세션을 임의로 종료하지 않는다. `codex-updater-daemon.mjs`, S6 run/finish, manifest와 종료 smoke 중 실제 원인에 해당하는 작은 범위만 바꾼다.

## 추가 점검 항목 — 결함으로 확정하지 않음

- memory warning 9개는 기존 bounded code/상태로 원인별 영향을 분류한다. DB·HA 사용자 데이터·식별자 원문을 수집하지 않는다. 정상적인 enrichment 경고면 설명과 수용 결과를 남기고, 재현 가능한 기능 손실이 발견되면 REPORT에 후속 결함을 분리한다. 단순 warning 수 0 만들기를 목표로 하지 않는다.
- PATH alias EROFS의 발생 단계·사용자 기능 영향을 synthetic 실행으로 구분한다. 선택 런타임이 요구하는 writable alias 경로와 image 읽기 전용 영역의 관계를 확인하되 rootfs writable화나 보호 경로 완화로 해소하지 않는다. 임의의 최신 버전으로 올려 검증을 대체하지 않는다.
- 사용자 보고의 npm/shellcheck 미설치는 운영 이미지 결함의 증거가 아니다. 개발/CI 검사로 수행하고 진단 편의만을 위해 제품 dependency를 추가하지 않는다.
- 보고서·사진·private feedback 원문을 저장소나 외부 Issue로 복사하지 않는다. 사용자 보고의 `security_issue=true` 및 공개 차단을 유지한다. 이 FIX 자체는 취약점 확인 선언이 아니다.

## Executor 작업 및 dev.2 / 실기기 인계 순서

1. 최신 Git·적용 지침·이전 문서를 다시 확인하고 기능 브랜치에서 F1~F3을 작은 변경으로 수행한다. 보고된 사용자 자동 업데이트 성공은 progress에 사용자 증거로 보존한다. 자동 업데이트 분류·budget/cooldown·policy/rollback 계약을 불필요하게 재설계하지 않는다.
2. 수정 전 실패 재현, 변경별 회귀, 관련 sensitive-path/feedback/runtime/update 테스트, 전체 pytest와 위험에 맞는 image smoke를 수행한다. ShellCheck/Bash·Node 문법, AppArmor parse·보호 deny, Markdown/YAML/release 계약과 비밀 검사를 포함한다. 기존 skip과 환경 제약을 기록한다.
3. `FIX_06_REPORT.md`에 변경 파일·명령·실제 결과·기존 증거와의 차이·F1~F3별 수용 여부·남은 위험을 기록한다. `progress.md` 및 `test_plan.md`의 수용 행렬, 한국어·영어 README/DOCS/changelog와 관련 개발 문서를 실제 결과에 맞춘다. 이 FIX나 과거 REPORT는 덮어쓰지 않는다.
4. **수정 소스로 실기기 시험에 진입할 때는 `0.7.2-dev.2`로 배포한다.** `dev.1` Git tag/GHCR digest/release를 덮어쓰거나 새 수정을 기존 dev.1의 시험 결과로 표현하지 않는다. 실기기에 로컬 image를 덮어씌워 dev.2 게시를 대체하지 않는다. 태그 충돌이 발견되면 재사용하지 말고 현재 배포 상태를 먼저 보고한다.
5. 실기기 인계 전 config/Docker BUILD_VERSION/npm package·lock/changelog/fallback의 버전 계약과 DEV 표시를 일치시킨다. amd64/native aarch64 CI, SBOM/Critical gate, signature·provenance/SPDX, exact manifest/architecture digest와 익명 공개 조회를 확인한다. 기존 보안 예외의 검토 범위를 늘려 CI를 통과시키지 않는다.
6. 수정·로컬/격리 검증·검토 및 dev.2 게시를 거친 뒤 사용자 실기기 시험으로 넘긴다. 이 요청은 실기기 시험용 dev.2가 필요하다는 지시이며 **현재 운영 세션의 즉시 업데이트/재시작이나 stable 승격 승인은 아니다**. 운영 세션을 그대로 유지하고 이후 명시된 실기기 시험 범위에서 진행한다. 새 HAOS/ARM 하드웨어·독립 Web/SSH/Remote·Telegram·승인/거부·재연결·인증 복구는 각각 PASS/FAIL/NOT RUN으로 관리한다.
7. 정식 배포 판단은 후속 Reviewer가 F1~F3 결과와 필요한 실제 수용 증거를 보고 내린다. 사용자 기본목표 달성, 로컬/CI PASS, DEV 게시 성공을 정식 배포 승인과 혼동하지 않는다.

## 이번 Reviewer가 실행한 검증과 한계

- `.venv/bin/pytest -q tests/test_sensitive_path_policy.py tests/test_feedback_contract.py`: **28 passed in 2.61s**. 이는 기존 계약 결과이며 새 수정의 검증 결과가 아니다.
- 자체 chmod-000 일반 하위 directory fixture에서 validator 반환 78/무출력을 확인했다. wrapper는 이를 unsafe 메시지로 매핑한다. 실제 unsafe 파일 발견 없이 검사 불능이 동일 안내로 표현되는 경로의 독립 대조다. fixture를 정상 정리했다.
- 기존 local `codex-ha:0.7.2-dev.1-test`의 synthetic 정상 tree에서 독립 wrapper `--version`은 exit 0 / `codex-cli 0.162.1`이었다. 이것은 게시 이미지 exact digest나 사용자 0.164.0의 검증이 아니다.
- 같은 임시 컨테이너의 실제 Codex sandbox 생성은 호스트 user/network namespace 제약으로 bwrap 단계에서 실패했다(`RTM_NEWADDR` 및 uid map). 내부 wrapper까지 도달하지 않았으므로 사용자 exit 78을 여기서 재현했다고 주장하지 않는다. 운영 정책을 변경하지 않았고 자체 컨테이너는 제거했다.
- 전체 pytest·새 image build·enforced AppArmor·HAOS/VM·독립 실기 Web/SSH·0.164.0 실행·업데이트/rollback·stop/restart 재시험·외부 Git/배포는 이번 리뷰에서 NOT RUN이다.

## 공식 참고 자료 (2026-10-26 조회)

- [OpenAI 관리 설정 — deny-read requirements](https://learn.chatgpt.com/docs/enterprise/managed-configuration#enforce-deny-read-requirements): requirements를 로컬 사용자 설정으로 완화할 수 없다는 경계 확인용이다. 이 문서만으로 사용자 App의 exit 78 원인을 확정하지 않는다.
- [Home Assistant App 설정](https://contributors.home-assistant.io/apps/reference/configuration/): `timeout` 기본 10초 및 허용 범위 10–300초. 실제 적용·종료 수용은 해당 Supervisor에서 별도로 검증한다.
