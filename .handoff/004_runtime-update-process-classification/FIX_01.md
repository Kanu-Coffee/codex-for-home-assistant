# FIX_01 — 프로세스 분류 누락·상태 영속화·옵션 파싱 수정

## 판정과 검토 범위

- Reviewer: Codex, 2026-10-17 (Asia/Seoul).
- 판정: **수정 필요 / 인수 보류**. 아래 P1 1건과 P2 2건은 현재 소스에서 독립 재현했다.
- 검토 대상: 같은 디렉터리 `PLAN.md`, `REPORT.md`, 현재 working tree의 전체 변경 목록과 관련 코드·테스트·문서 diff. 이전 FIX 파일은 없다. 기준 HEAD는 PLAN과 같은 `11b883996b9bc1694640b25fcc7f24b192973b71`, branch `main`이다.
- Executor 작업 이후 현재 tracked 변경은 12개 파일이며 제품 구현과 사용자/Planner의 progress 변경이 섞여 있다. 기존 PLAN/REPORT 및 사용자 변경을 덮어쓰지 않는다.
- Reviewer는 제품 코드를 수정하지 않았다. 임시 디렉터리의 자체 생성 프로세스와 사용자 volume·인증·네트워크가 없는 일회성 컨테이너만 사용했다. 실제 HAOS·운영 Codex·Remote 연결은 변경하지 않았다.

## F1 — P1: 미지의 패키지 executable이 unknown 보류 없이 사라짐

위치: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs:711`의 `canonicalPackageRole()`과 같은 파일 `:1205`의 inventory 삽입 조건.

`canonicalPackageRole()`는 실제 executable이 정확한 baseline/release 내부여도 `PACKAGE_EXECUTABLE_ROLES`에 없으면 null을 반환한다. `inspectAllSessions()`는 이를 `if (!identity) continue`로 제외한다. 따라서 미지의 companion은 REPORT §2-4의 주장과 달리 unknown blocker가 되지 않는다. 자동 업데이트는 향후 버전의 package를 수용하므로 baseline에서 열거한 실행파일 이름만으로 이 경로를 안전하다고 볼 수 없다. 원래 runtime 경계의 미지 프로세스까지 감지하던 동작에서 보호가 줄어든다.

### 재현과 영향

임시 `CODEX_RUNTIME_DIR`의 `releases/0.163.0-target/bin/codex-new-helper`에 `/bin/bash`의 실행파일을 복사하고, 해당 파일을 `-c 'read -t 30'` 및 열린 stdin pipe로 실행했다. `/proc/<pid>/exe`가 그 패키지 경로이고 프로세스가 살아 있음을 별도 확인한 뒤 `inspectAllSessions()`를 호출했다.

```json
{"processAlive":true,"isIdle":true,"canApply":true,"counts":{"detectedProcesses":0,"unknown":0},"blockers":[]}
```

알 수 없는 패키지 프로세스가 실행 중이어도 적용 가능 상태가 된다. 이는 PLAN §4-2, §5A/B, §7의 unknown 보수 보류 조건 위반이다. 실제 업데이트를 실행한 재현은 아니며, 잘못된 적용 허용 판정까지 확인했다.

### 요구 수정

- 정확한 package 경계 판정과 역할 allowlist 판정을 분리한다. 실제 `/proc/exe`가 baseline 또는 canonical release generation 내부인데 역할을 알 수 없으면 inventory에 남겨 unknown blocker로 처리한다.
- 실제 역할을 확인한 companion만 소유자 귀속으로 독립 blocker에서 제외한다. 미지 executable을 무조건 helper로 취급하지 않는다.
- argv의 경로 데이터만 존재하는 무관 프로세스는 계속 제외한다. broad substring 매칭으로 되돌리지 않는다.
- baseline/release의 미지 native executable, `(deleted)` 경로와 package 형제 경로를 대조하는 회귀를 추가한다. 정상 종료 뒤 blocker 해소도 검증한다. 알려진 owner가 없는 새 companion의 테스트를 allowlist에 이미 있는 orphan 테스트로 대신하지 않는다.

## F2 — P2: lastBlocker가 상태 저장·읽기에서 유실됨

위치: 같은 manager의 `loadState():541`, `saveState():595`, `getStatus():2344`.

`applyUpdate()`는 `state.lastBlocker`를 설정하지만 `saveState()`의 sanitized object와 `loadState()`의 반환/default에 해당 필드가 없다. 새 status 명령은 저장된 값을 읽으므로 항상 null이 된다. “마지막 적용 시도의 보류 원인과 현재 blocker 구분” 기능이 실제 명령 간에는 작동하지 않는다.

### 재현

임시 runtime에서 다음과 동등한 호출을 수행했다.

```javascript
await mgr.saveState({ status: "pending_busy", lastBlocker: "remote_stdio" });
// state.json의 lastBlocker: 없음
// (await mgr.loadState()).lastBlocker: undefined
```

### 요구 수정

- load/default/save와 status를 연결하고 허용된 reason code만 영속화한다. 구버전 state에 필드가 없으면 null로 처리한다. 임의 원문이나 경로를 reason code로 저장하지 않는다.
- 12번째 busy 검사에서 paused_busy로 전환할 때 `daily_budget_exhausted`와 실제 process blocker의 의미를 명확히 정한다. 현재 busy 분기 마지막 대입은 process type으로 덮어쓴다. 현재 blocker 배열, 마지막 검사 blocker, 예산 소진 상태 중 각 필드가 무엇을 뜻하는지 문서·출력·테스트를 일치시킨다.
- save/load 단위 호출뿐 아니라 별도 Node 프로세스의 `status --json` round trip을 검증한다. Remote/unknown/budget/cooldown 상태와 성공 후 null 초기화를 포함한다. 현재 blocker가 사라져도 마지막 검사 기록과 혼동하지 않아야 한다.

## F3 — P2: 유효한 전역 옵션 값이 subcommand로 오인됨

위치: 같은 manager의 `parseCodexInvocation():763`, wrapper `codex_home_assistant/rootfs/usr/local/bin/codex:164`의 value-option case.

두 parser 모두 `-p`를 값이 있는 옵션으로 다루지 않는다. 따라서 `codex -p home app-server --listen unix:///tmp/review.sock`에서 subcommand가 `home`이 된다. wrapper는 실제 app-server를 CLI record로 등록하고 runtime도 CLI busy로 분류해 유휴 교체가 계속 보류된다. 원래 wrapper의 단순 app-server 검색에서는 이 호출을 서버로 인식했으므로 이번 변경의 회귀다.

### 재현

- Reviewer가 `docker run --rm --network none --entrypoint /usr/local/libexec/codex-real codex-ha:004-test -p home app-server --help`를 실행했고 **exit 0**으로 app-server help를 확인했다. 실제 baseline 바이너리의 전역 help에도 `-p, --profile <CONFIG_PROFILE_V2>`가 있다.
- 현재 `parseCodexInvocation(['codex', '-p', 'home', 'app-server', '--listen', 'unix:///tmp/review.sock'])`는 `subcommand: 'home'`을 반환한다.
- `-a never`도 새 parser에서는 subcommand를 `never`로 반환한다. 실제 baseline help는 `-a, --ask-for-approval` 옵션을 명시한다. 허용 값과 각 호출의 유효성은 수정 시 실행 버전 기준으로 확인한다.

### 요구 수정

- 실제 baseline의 help/schema로 값이 있는 전역 옵션을 조사하고 wrapper/manager를 일치시킨다. `-p`, `-a` 외 `--enable`, `--disable`, remote 관련 옵션 등도 허용 호출을 기준으로 대조한다. 거대한 CLI parser를 새로 만드는 대신 해당 런타임에서 필요한 구문을 작게 정리하고 불명확한 구문은 보수적으로 보류한다.
- wrapper/runtime 간 일치 테스트만으로 충분하지 않다. 두 구현이 같은 오류를 갖는 경우를 검출하도록 실제 Codex가 허용하는 옵션 벡터를 기준으로 검증한다.
- 최소 `-p home app-server --listen unix://...`가 실제 wrapper에서 type app-server/managed true로 기록되고, runtime에서 idle 관리형 서버로 판정되는 통합 회귀를 추가한다. 옵션 값에 `app-server`가 포함된 CLI/prompt와 `--` 경계 음성 대조도 유지한다.
- update 라우팅 parser와 session parser의 차이도 검토한다. 테스트가 기존 case-list 문자열을 고정한다는 이유만으로 유효한 호출의 오동작을 유지하지 말고, 실제 동작 중심의 회귀로 수정한다.

## 검증 증거와 보완 요구

Reviewer가 실행한 검사:

- `.venv/bin/pytest -q tests/test_codex_update_contract.py tests/test_runtime_contract.py`: **102 passed in 62.00s**. 기존 테스트의 성공과 위 신규 재현 실패는 양립한다.
- 변경 manager의 `node --check`, wrapper `bash -n`, `git diff --check`: PASS.
- F1의 실제 ELF 임시 프로세스 관측, F2 state round trip, F3 parser 호출 및 실제 image의 help 호출: 위 결과 확인.
- 전체 pytest 재실행, 새 image build, 실제 업데이트/replacement transaction, enforced AppArmor smoke, HAOS·ARM 실기: 이번 리뷰에서 NOT RUN.

Executor는 세 결함의 수정 전 실패/수정 후 성공을 남기고, 관련 pytest 및 Node/Bash/ShellCheck·변경 문서 lint·diff 검사를 수행한다. helper가 붙은 관리형 서버에 대해 현재 새 테스트는 `inspectAllSessions()`의 restartable 판정까지만 확인하므로, 가능하면 같은 fixture에서 `applyUpdate()`를 통한 실제 subprocess 교체·새 executable 확인·실패 시 rollback까지 연결한다. old helper가 남을 때 generation 참조 보존과 unknown 보류도 확인한다. enforced 정책 실환경 공백을 없애려고 production policy probe를 약화하지 않는다.

REPORT는 불변 이력으로 보존하고 새 `FIX_01_REPORT.md`에서 기존 주장과 다른 점을 정정한다. 특히 REPORT의 “미지 executable은 unknown”, lastBlocker 구현 완료, helper-only 교체 경로 검증과 실제 교체 실행을 구분한다. 테스트 수는 REPORT 226/2, progress 225/2, focused 110 영역이라는 기존 기록과 이번 재실행 102 PASS가 다르므로 명령·대상·소스 시점별 근거를 명시하고 증거 없는 수치를 완료 사실로 승계하지 않는다. 실제 helper 수명·소유 구조, enforced AppArmor, HAOS·ARM 검증 공백은 계속 공개한다.

## 인계와 완료 조건

- Executor는 이 FIX_01의 요구를 수행하고 `FIX_01_REPORT.md`를 새로 작성한다. `PLAN.md`, `REPORT.md`와 본 문서를 덮어쓰지 않는다.
- 제품 변경의 의미를 알 수 있도록 미발행 changelog 항목을 추가하거나 기존 changelog를 이번에 변경하지 않는 근거를 명확히 기록한다. App/baseline 버전 상승과 배포는 요구하지 않는다.
- `progress.md`를 실제 검증 상태와 일치시킨다. 기존 사용자·Planner·Executor 기록을 임의 삭제하지 않는다.
- 위 세 결함과 회귀 증거가 해결되기 전에는 인수/배포 가능으로 판정하지 않는다. commit/push/PR/release, 실제 HAOS/Remote 변경과 프로세스 강제 종료는 이 수정 지시의 범위가 아니다.
