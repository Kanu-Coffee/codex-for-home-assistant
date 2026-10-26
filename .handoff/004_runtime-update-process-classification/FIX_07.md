# FIX_07 — 실제 버전 관측·수집 종료 보장·진단 및 종료 검증 보완

## 판정과 기준

- Reviewer: Codex, 2026-10-26 (Asia/Seoul).
- **P2 4개 항목 수정 필요 / FIX_06 인수 보류**. 자동 업데이트 정상·기본 개발목표 달성에 대한 사용자 확인과 기존 task 004 인수는 유지한다. 이번 보류는 dev.2 후보의 추가 수정·검증에 관한 것이다.
- `PLAN.md`, `REPORT.md`, FIX_01~06과 각 REPORT, 현재 Git diff/status 및 사용 가능한 시험 증거를 대조했다. HEAD `aa76fe8`, branch `fix/runtime-update-dev-0.7.2-2`; tracked 수정 22개와 untracked `FIX_06.md`/`FIX_06_REPORT.md`가 있다. clean 작업 트리가 아니다.
- 기존 메시지 분기, 버전별 렌더링과 legacy 필드 보존, dev.2 버전 동기화 방향은 수용한다. 다만 아래 실제 경계와 검증이 남아 있다. Reviewer는 제품 코드나 기존 handoff를 수정하지 않았다.

## F1 — P2: 피드백이 미관측을 유휴로 표시하며 실제 수집 시간이 제한되지 않음

위치: `codex_home_assistant/rootfs/usr/local/share/codex-ha/ha-feedback.mjs:788–826`, `codex-runtime-manager.mjs:getStatus()`.

### A. 관측과 선택 상태의 신뢰성

`getStatus()`는 `/proc` readdir 실패를 삼키고 빈 `runningVersions`를 반환한다. 선택 버전도 실제 `current` 링크와 대조하지 않은 `state.selectedVersion`이다. 새 collector는 이 상태값을 그대로 채택하므로, 정상적으로 관측한 유휴와 관측 불가가 구별되지 않고 존재하지 않는 선택 버전도 확정 표시된다.

Reviewer는 현재 소스의 모듈을 자체 임시 디렉터리에 복사해 private collector만 export했다. 실제 manager를 사용하되 `/proc` readdir만 EACCES로 주입하고, synthetic state의 selectedVersion은 0.164.0, current 링크는 만들지 않았다. 결과:

```json
{"bundled":"0.162.1","selected":"0.164.0","running":[]}
```

이 값은 보고서에서 선택 0.164.0 / 실행 중 없음으로 렌더링된다. 새 테스트는 normalize/render에 값을 직접 공급하므로 이 수집 결함을 발견하지 못한다.

### B. Promise.race는 진행 중인 I/O를 끝내지 않음

3초 timer가 이겨도 `mgr.getStatus()`는 계속 실행된다. timer 자체도 성공 경로에서 정리하지 않는다. synthetic runtime의 `state.json`만 자체 FIFO로 만들고 collector를 별도 Node 자식에서 실행한 결과, 3초 뒤 `{selected:null,running:null}` 출력이 생겼지만 **7초 안에 프로세스가 종료되지 않았다**. Reviewer가 직접 생성한 자식만 terminate/wait로 회수했다. 실제 사용자 state를 변경하지 않았다.

### 요구 수정과 수용 기준

1. 기존 manager의 신원/버전 판별을 재사용하되, 수집 완료 여부·관측 범위와 버전값을 함께 판정한다. `/proc` 전체/개별 접근 실패·신원 미확인 프로세스를 빈 실행 목록으로 단정하지 않는다. 확인된 버전만 부분 관측한 경우 그 한계도 표시한다.
2. current 링크와 package metadata 등 기존 검증 경로를 통해 selected를 대조한다. missing/invalid link, state 불일치와 metadata 읽기 실패는 미검증으로 표시하고 state 값이나 bundled fallback으로 확정하지 않는다. 진단 목적의 링크 복구·상태 수정은 금지한다.
3. 타임아웃 시 진행 중인 검사도 종료되거나 더 이상 collector 프로세스의 종료를 막지 않아야 한다. 읽기 대상 type/크기 검증과 취소 가능한 I/O 또는 자체 생성한 제한된 read-only 자식의 bounded 종료 등으로 보완한다. 새 특권 서비스나 정책 우회를 도입하지 않는다. timer/worker/자식과 임시 파일은 성공·실패·timeout 모두 회수한다.
4. 실제 `collect → validate → render`를 통과하는 회귀를 추가한다. 정상 유휴와 EACCES/부분 관측, current/state 불일치, 복수 버전, invalid/지연 응답을 대조한다. 위 FIFO/동등한 정체 fixture에서 전체 명령이 정해진 상한 내 종료하고 잔류 자식이 0임을 확인한다.
5. 기존 report/preview 호환·privacy 및 고정 버전 필드 투영은 유지한다. 관측 불가 selected의 표시도 `none / 선택 없음`과 구분한다. 전체 status/argv/PID/cwd/원문 exception은 report에 넣지 않는다.

## F2 — P2: 실제 root symlink도 접근 제한으로 오분류하고 caller 테스트는 복제 코드만 검사함

위치: `rootfs/usr/local/lib/codex-ha/sensitive-path-policy.sh:24`, `tests/test_sensitive_path_policy.py:389–438` (`rootfs`는 `codex_home_assistant/rootfs`).

- root 검사에서 `-L config_root`와 missing/inaccessible root를 묶어 모두 78로 반환한다. Reviewer가 자체 정상 directory에 대한 root symlink를 전달했을 때 **78**이었다. 분류 계약에 따르면 확인된 symlink는 unsafe(1)이어야 하지만 현재 caller는 restricted 안내를 한다. fail closed 자체는 유지됐다.
- 새 wrapper 메시지 테스트의 실제 wrapper subprocess 결과 `res_symlink`는 검사하지 않는다. 대신 production case 문을 별도 문자열로 복사해 실행한다. production caller를 잘못 바꿔도 복제 코드의 테스트가 통과할 수 있다. init caller 및 preparation/metadata 실패의 실행 검증도 부족하다.

### 요구 수정과 수용 기준

1. 확인된 root symlink/broken symlink와 검사 불능 root를 구분한다. missing mount는 계속 inspection incomplete로 처리하고, 권한 문제를 unsafe 발견으로 추론하지 않는다. 기존 보호 deny와 모든 실패의 기동 차단을 유지한다.
2. production wrapper/init caller 자체를 격리 rootfs 또는 기존 컨테이너 harness에서 실행해 메시지·외부 exit·Codex 미실행을 검증한다. 함수를 공유하도록 정리한 경우 실제 caller가 그 함수를 호출하는 경로까지 검증한다. 테스트에 case 문을 다시 구현하거나 host의 실제 `/config`를 참조하는 무의미한 실행을 하지 않는다.
3. 정상·unsafe·검사 불능·준비 실패/metadata 실패를 대조하고, 준비 실패 시 비민감 안내·임시 파일 정리를 확인한다. 문법/문자열 포함 검사를 실제 caller 동작 검증으로 표현하지 않는다. 독립 Web/SSH와 nested sandbox의 실측 공백은 계속 명시한다.

## F3 — P2: 변경 셸 코드가 필수 ShellCheck를 통과하지 못함

Reviewer 명령:

```sh
shellcheck -x codex_home_assistant/rootfs/usr/local/bin/codex \
  codex_home_assistant/rootfs/usr/local/bin/codex-ha-init \
  codex_home_assistant/rootfs/usr/local/lib/codex-ha/sensitive-path-policy.sh
```

결과: **exit 1**, sensitive-path-policy.sh의 목록을 읽는 loop 내부 `rm` 및 입력 redirection에 `SC2094`. 이것을 실제 파일 손상이나 보호 우회로 확정하는 것은 아니지만, 저장소 필수 검사 및 CI 수용은 실패다. `bash -n` 통과는 ShellCheck 통과가 아니다.

- 정리 경로를 적절히 구조화해 검사 종료 뒤 임시 파일을 회수하거나, 동작이 안전함을 설명할 수 있는 정확한 범위의 예외만 근거 주석과 함께 사용한다. 전역 disable이나 CI gate 제거를 하지 않는다.
- 임시 파일 정리·분기별 exit·값/경로 비노출 회귀를 유지하고 위 명령 exit 0을 기록한다.

## F4 — P2: 종료 해결·지원 경로 정상에 대한 완료 주장이 검증 범위를 초과함

위치: `config.yaml:8`, `CHANGELOG.md` dev.2 절, `docs/development/addon_spec.md:348–351`, progress의 FIX_06 Executor 기록 및 `FIX_06_REPORT.md`.

- 현재 F3 구현은 `timeout: 30`과 그 숫자를 검사하는 계약 테스트뿐이다. 서비스 종료 원인·시간·updater ON/네트워크 대기 상태의 시험, 새 image의 실제 shutdown 증거는 없다. 30초는 FIX_06이 지정한 값도 아니며, manifest 값이 적법하다는 것만으로 exit 137 방지를 입증하지 못한다.
- 그런데 changelog/spec/progress는 정상 종료 보장·SIGKILL 방지, 독립 Web/SSH 정상 동작을 단정한다. REPORT의 미검증 목록과도 모순된다. REPORT의 “편차 없음”, “F1~F3 전원 구현”, “clean” 역시 실제 검증 범위·Git 상태와 맞지 않는다.

### 요구 수정과 수용 기준

1. 격리된 새 image에서 서비스별 종료·총 소요 시간, updater idle과 지연된 network/check, memory/browser 활성 상태를 나눠 측정한다. 실제 원인에 따라 필요한 bounded shutdown 수정 또는 timeout 근거를 제시한다. 자동 업데이트를 OFF한 긴 Docker stop 성공만으로 대체하지 않는다.
2. 격리 종료 시험을 먼저 수행하고, 이후 dev.2를 게시해 실제 Supervisor의 일반 stop/restart를 수용하는 FIX_06 순서를 유지한다. 그 전에는 실제 Supervisor 해결 여부를 NOT RUN/미해결로 남긴다. 이번 리뷰가 운영 기기 재시작을 요청하는 것은 아니다.
3. 현재 문서의 보장 표현은 관측 증거 수준으로 바로잡는다. `test_plan.md`에 독립 Web/SSH/nested 실행 경계, 버전 관측 불가/불일치, 일반 종료의 명시적인 수용 행렬을 추가하고, 수행하지 않은 항목과 memory/PATH 경고 영향 분류의 공백을 남긴다.
4. 기존 FIX_06_REPORT는 보존하고 **`FIX_07_REPORT.md`에서 정정·편차·미검증 범위를 명시**한다. 코드상 baseline manifest 경로, 실제 branch·dirty 상태, 완료된 로컬 검사와 아직 준비되지 않은 build/runtime 검사를 정확히 구분한다. progress의 새 기록으로 과거 완료 주장을 정정한다.

## 이번 리뷰의 실제 검증

- `.venv/bin/pytest -q tests/test_sensitive_path_policy.py tests/test_feedback_contract.py tests/test_addon_contract.py`: **50 passed in 21.21s**. 기존/신규 테스트는 통과하지만 위 미관측·timeout·root symlink와 실제 caller 공백을 잡지 못한다.
- 두 변경 Node 모듈 `node --check`, `git diff --check` PASS. ShellCheck는 위와 같이 FAIL이다.
- 실제 collector+manager의 `/proc` 접근 거부/선택 링크 누락 대조, FIFO 정체 후 7초 프로세스 생존, validator root symlink 대조를 자체 임시 자료로 수행했다. 제품 코드·실제 `/config`·사용자 runtime state와 세션은 변경하지 않았다. 자체 자식/fixture를 회수했다.
- 전체 pytest, 새 image build/full smoke/enforced AppArmor, HAOS/VM, 독립 실기 Web/SSH, 선택 0.164.0 실제 실행, Supervisor stop/restart, ARM 실행, 외부 Git/배포는 이번 리뷰에서 NOT RUN이다.

## 인계와 배포 경계

- 후속 Executor는 이 FIX_07을 수행하고 matching REPORT를 새로 작성한다. 기존 사용자 변경·handoff와 자동 업데이트의 사용자 수용 증거를 보존한다. 위 재현을 수정 전 실패/수정 후 통과로 기록하고 관련 회귀·필수 정적 검사와 격리 runtime 검사를 수행한다.
- 아직 게시하지 않은 `0.7.2-dev.2` 후보는 유지할 수 있다. 인수되지 않은 현재 후보를 실기기에 배포하지 않는다. 수정·검토 후 실기기 검증으로 넘어갈 때는 **dev.2의 exact immutable 배포 및 CI/서명/digest 절차**를 따른다. 이미 발행된 tag/image는 덮어쓰지 않으며 충돌이 있으면 먼저 상태를 보고한다.
- 이번 Reviewer는 commit/push/PR/release나 운영 HA 변경을 수행하지 않았다. Stable 승격 승인은 없으며 실제 기기의 현재 Codex 세션을 유지한다.
