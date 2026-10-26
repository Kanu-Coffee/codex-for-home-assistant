# FIX_08 — 버전 관측 누락·피드백 읽기 전용 경계·실제 수집 회귀 보완

## 판정과 기준

- Reviewer: Codex, 2026-10-26 (Asia/Seoul).
- **P2 4개 항목 수정 필요 / FIX_07 인수 보류**. 사용자 자동 업데이트 정상 확인과 기본목표 달성, 기존 task 004 인수는 유지한다. 실기기 배포 전 dev.2 후보의 후속 수정이다.
- PLAN/REPORT 및 FIX_01~07과 각 REPORT, 현재 Git diff/status·관련 소스·테스트·수용 문서를 대조했다. Branch `fix/runtime-update-dev-0.7.2-2`, HEAD `aa76fe8`. 리뷰 시작 시 tracked 수정 23개와 untracked FIX_06/07 문서 4개가 있다. REPORT의 clean 표기와 달리 미커밋 작업 트리다.
- 수용한 부분: root symlink의 unsafe(1) 분류, 공유 enforce 함수와 실제 wrapper의 격리 음성 대조, ShellCheck SC2094 해소. 이전 FIFO 정체 재현도 현재 소스로 재실행하면 정상 종료한다. `spawnSync` 자식 격리 및 명시적인 미검증 렌더링 방향은 유지한다.
- 제품 코드·이전 handoff는 변경하지 않았다. 아래 재현은 자체 임시 fixture/모듈 사본과 synthetic 입력만 사용했으며 실제 HA 데이터·사용자 state·credential을 읽거나 변경하지 않았다.

## F1 — P2: getStatus가 여전히 미확인 상태를 선택 확정·실행 없음으로 표시함

위치: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs:2367–2424`.

### 독립 재현

실제 manager 모듈을 import하고 자체 runtime/state 및 synthetic `/proc` 응답으로 대조했다.

```json
{"case":"current_and_baseline_missing","selected":"0.162.1"}
{"case":"unrecognized_package_executable","unknown":1,"blockers":["unknown"],"running":[],"runningText":"none"}
```

- 첫 경우 current와 baseline 모두 없다. 코드의 “Host unit test fallback” 분기가 production에서도 동작해, 실제 선택 경로가 없는데 선택 버전을 확정한다.
- 두 번째 경우 package 경계 내부의 미식별 executable이 unknown blocker로 인식됐다. 하지만 `sessionInspectionIncomplete`는 `inspection_failed`만 확인하고 unknown을 제외하며, 다음 버전 순회에서도 primary 이외를 건너뛰므로 최종 running은 `none`이다. 업데이트 차단 자체가 해제된 것은 아니지만, 보고서가 불확실성을 잃는다.
- `/proc` 전체 readdir 실패는 처리됐으나 개별 exe/cmdline 접근 실패·두 번의 inventory 사이 관측 차이까지 완전 관측이라고 볼 수 있는지도 확인해야 한다. 단순 ENOENT로 정상 소멸한 프로세스와 실제 검사 불능을 구분한다.

### 요구 수정과 수용 기준

1. production의 “unit test fallback”을 제거한다. 테스트 fixture에 유효한 baseline/current/manifest를 준비해 정상 선택을 검증하고, 누락된 실제 상태를 bundled 상수로 채워 테스트를 통과시키지 않는다. Metadata를 읽지 못하거나 current/state가 불일치하면 selected는 미검증이어야 한다.
2. unknown holder와 개별 검사 실패가 있으면 실행 버전이 완전히 관측됐다고 표현하지 않는다. 확인된 버전을 부분 관측한 경우에도 그 한계를 구분한다. 기존 프로세스 분류/업데이트 보호를 완화하거나 모든 unknown을 무시하지 않는다.
3. 정상 유휴·정상 선택, current/baseline/manifest 누락, state 불일치, unknown executable, 부분 접근 거부와 정상 소멸 대조를 추가한다. Manager 결과뿐 아니라 실제 feedback 수집/렌더링에서 unverified/unobserved/partial 의미가 유지되는지 확인한다.

## F2 — P2: 버전 수집 자식이 세션 기록을 삭제하고 불필요한 Supervisor credential을 상속함

위치: `ha-feedback.mjs:788–821`의 버전 수집, manager `getStatus()` → `inspectAllSessions()`의 stale record `unlink` 경로.

Reviewer는 실제 collector와 manager를 함께 임시 디렉터리에 복사하고 자체 `maintenance/sessions/999999999` stale record를 준비했다. Manager 사본에 합성 token 존재 여부만 기록하는 관찰 코드를 추가했다. 실제 token 값은 사용하지 않았다.

```json
{"staleSessionRecordPreserved":false,"syntheticTokenInherited":true}
```

`getStatus()`는 순수 snapshot이 아니며 세션 검사 중 stale/잘못된 record를 삭제한다. 새 자식의 `env: {...process.env}`는 부모의 API 조회용 SUPERVISOR_TOKEN까지 필요 없는 version-inspection 자식에 전달한다. 정해진 API helper의 credential 사용과 버전 관측 child의 환경은 분리해야 한다. 이 결과를 보안 취약점 확인이나 실제 credential 유출로 일반화하지 않는다.

### 요구 수정과 수용 기준

1. 피드백용 버전 관측은 실제 read-only 경로를 사용한다. 기존 manager 판별을 재사용하되 record 제거 등 maintenance를 하지 않는 모드/제한된 snapshot을 제공한다. 기존 updater의 필요한 maintenance까지 무조건 제거하지 않는다.
2. 자식 환경을 최소 allowlist로 구성하고 SUPERVISOR_TOKEN/GH_TOKEN/GITHUB_TOKEN 및 shell/Node startup injection 변수를 전달하지 않는다. 부모의 고정 Supervisor 읽기 API 동작은 보존한다. 테스트 fixture 경로가 필요하면 명시적 테스트 경계에서만 제한해 전달하고 production의 전량 환경 상속을 정당화하지 않는다.
3. 실제 collect 전후 state/current/maintenance/session 파일 내용·존재·mode 등 관련 영속 상태가 불변인지 확인한다. Stale 및 malformed record도 삭제하지 않는 대조를 포함한다. Report bundle 작성은 기존 허용 범위다.
4. 자체 가짜 credential/startup 변수로 자식 환경을 검사하되 값은 출력하지 않는다. 네트워크 update/init/apply/recovery, 프로세스 restart와 선택 링크 복구를 수집 경로에서 실행하지 않는다.

## F3 — P2: 새 FIFO 회귀가 실제 manager에 도달하지 않는 false positive

위치: `tests/test_feedback_contract.py:test_feedback_runtime_versions_collection_and_fifo_hang_prevention`.

- 테스트는 helper 사본만 `tmp_path/fifo-feedback-test.mjs`에 만든다. 새 collector는 **그 사본 옆**의 `codex-runtime-manager.mjs`를 찾지만 파일을 복사하지 않았다. 실제 실패 원인은 manager import 실패이고 FIFO state를 읽은 결과가 아니다.
- 같은 구성을 독립 재현하니 sibling manager가 없는 상태에서 약 **23ms** 만에 bundled fallback/selected null/running null이 반환됐다. 이 테스트는 이전의 무한 I/O 정체나 3초 timeout 분기를 검증하지 않는다.
- “inspection fail” 부분도 실제 거부를 주입하지 않고 `runningVersion in (none, unobserved)`를 허용한다. 항상 none을 반환하는 구현까지 통과할 수 있다. 테스트 주석의 inject 선언은 실제 주입 코드가 아니다.

### 요구 수정과 수용 기준

1. 실제 manager와 필요한 모듈을 함께 배치하거나 실제 설치 경로를 사용하는 격리 harness로 collector를 실행한다. 정상 선택·실행 버전을 먼저 검증해 import fallback만 테스트하는 구성이 아님을 증명한다.
2. FIFO/특수 파일의 조기 거부와 실제 지연된 I/O/manager timeout을 별도 case로 구분한다. 자식 timeout 후 전체 명령의 종료 상한·부모 정상 복귀·자식 reap 및 잔류 0을 확인한다. 단순 elapsed assertion과 null 결과만으로 hard timeout을 검증했다고 쓰지 않는다.
3. 정상 유휴는 정확한 none, 접근 거부/partial은 정확한 미관측, invalid selected는 정확한 미검증을 각각 assertion한다. FIX_07이 요구한 실제 `collect → validate → render` 경로의 정상·실패·privacy·legacy 대조를 추가한다.
4. 테스트가 확인한 범위를 넘는 3.5초/어떠한 I/O/zero zombie 보장 표현은 보고서에서 실제 fixture와 측정 범위로 한정한다. 무관한 프로세스를 검색해 종료하지 않고 직접 생성한 자식만 회수한다.

## F4 — P2: 수용 행렬에 실행하지 않은 경로의 PASS가 남아 있음

위치: `docs/development/test_plan.md:588–613`, FIX_07_REPORT와 progress의 Executor 완료 기록.

- test_plan은 Web 터미널·SSH/Remote의 정상 실행, managed deny-read nested wrapper, 새 후보의 stop/restart를 PASS 또는 “격리 측정 PASS”로 표기한다.
- 제출된 검증은 pytest/정적 검사와 bwrap 음성 대조다. 이는 ttyd/sshd를 통한 정상 세션, 실제 Codex managed deny-read sandbox, 새 image의 stop/restart 측정이 아니다. 보고서에는 새 image build/서비스별 종료 시간·updater ON/지연 상태의 명령·결과도 없다.
- Changelog/spec의 후보 설정 문구 정정은 수용하지만, FIX_07 F4가 요구한 격리 종료 측정과 정확한 수용 행렬은 완료되지 않았다. “편차 없음/모두 완료/clean”도 이 검증 공백과 현재 Git 상태를 설명하지 못한다.

### 요구 수정과 수용 기준

1. 행렬에서 실제 실행 경로와 소스/계약 검사를 분리한다. 증거 없는 PASS는 NOT RUN으로 정정하고, 정상 셸의 bwrap 격리 fixture를 Codex의 managed sandbox 시험으로 표현하지 않는다. 기존 dev.1 결과를 수정된 dev.2의 결과로 재사용하지 않는다.
2. FIX_07이 요구한 격리된 새 image의 서비스별/총 종료 시간, updater idle·지연 network/check, memory/browser 활성 조건을 수행하고 30초 후보 설정의 근거를 기록한다. 수행할 수 없으면 구체적인 환경 제약과 미완료 상태를 남긴다. 자동 OFF/긴 Docker stop만으로 완료 처리하지 않는다.
3. 실제 Supervisor 일반 stop/restart 수용은 dev.2 게시 후 실기기 시험에서 별도로 수행한다. 운영 기기의 현재 세션을 지금 변경하라는 지시가 아니다. 로컬 격리 검증의 공백을 단순히 현장 시험 예정으로 덮지 않는다.
4. 기존 handoff는 보존하고 **`FIX_08_REPORT.md`를 새로 작성**해 FIX_07_REPORT의 과도한 완료/검증 주장 및 clean 표기를 정정한다. progress에는 이번 미해결 항목과 실제 시험 범위를 기준으로 새 기록을 추가한다.

## 이번 Reviewer의 실제 검증

- sensitive-path/feedback/addon pytest: **51 passed in 4.65s**.
- runtime/update pair (`tests/test_codex_update_contract.py tests/test_runtime_contract.py`): **115 passed in 68.75s**. 전체 pytest 재실행은 아니다.
- 변경 셸 3개 `shellcheck -x`, 두 Node 모듈 `node --check`, `git diff --check` PASS.
- 실제 manager의 누락된 선택 경로·unknown executable, 실제 collector의 stale record 삭제·합성 credential 상속, manager 없는 FIFO 테스트의 import fallback을 자체 fixture로 확인했다. `/proc` 대조는 synthetic 응답 주입이다.
- 이전 FIFO 정체 재현은 실제 모듈들을 함께 배치해 재실행했으며 현재 소스는 exit 0으로 정상 종료했다. FIFO 조기 거부/자식 분리 방향 자체를 되돌릴 필요는 없다.
- 자체 임시 자료/자식은 회수했다. 제품 코드·사용자 자료·실제 운영 state/세션·기존 handoff를 변경하지 않았다. 새 image build/종료 측정·enforced AppArmor·HAOS/VM·실기 Web/SSH/Remote·ARM·외부 Git/배포는 이번 리뷰에서 NOT RUN이다.

## 인계·배포 경계

- Executor는 위 누락을 수정하고 해당 재현 및 필수 회귀/정적 검사·격리 runtime 증거를 matching REPORT에 남긴다. 기존 사용자 변경과 사용자 자동 업데이트 수용은 보존한다.
- 현재 미게시 dev.2 후보는 유지한다. 실기기 검증으로 넘어갈 때는 수정·검토한 **0.7.2-dev.2 exact 배포** 및 기존 CI/SBOM/Critical gate·서명/provenance/SPDX·공개 digest 확인 절차를 따른다. 기존 immutable tag/image를 덮어쓰지 않는다.
- 이번 역할은 Reviewer이며 commit/push/PR/release, 실제 HA 변경과 stable 승격을 수행하지 않았다.
