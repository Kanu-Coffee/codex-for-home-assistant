# FIX_04 — FIX_03 재리뷰: 검증된 다운로드와 실제 실행 bytes의 연결 보장

## 판정·범위

- Reviewer: 2026-10-13, Asia/Seoul. **CHANGES REQUESTED**. DEV 배포는 수행하지 않는다.
- 기준: 002 PLAN/REPORT 및 FIX_01~03과 각 보고서, 현재 `feat/codex-auto-update` working tree. 기존 handoff는 보존한다. Executor는 `FIX_04_REPORT.md`를 새로 작성한다.
- 사용자 승인 범위는 인수 가능한 후보의 DEV 발행이며, 안정판 main과 운영 HA는 변경하지 않는다. Reviewer는 구현 코드를 수정하지 않았다.
- 개선 확인: 정상 archive staging 경로가 실제로 성공한다. hardlink와 manifest expected-value 검사가 추가됐다. 재시작 테스트가 실제 `applyUpdate()`와 signal을 사용하고 cooldown도 확인한다. 날짜별 busy 재개·24시간 restart cooldown 설계는 유지한다.

## 독립 검증 결과

| 검사 | 결과 |
| --- | --- |
| `.venv/bin/python -m pytest -q` | **134 passed in 13.40s** |
| 변경 wrapper/manual/S6 ShellCheck, manager/daemon Node syntax | PASS |
| Hadolint, 모든 workflow actionlint, `git diff --check` | PASS |
| 정상 archive 첫 staging → bin 변경 → 같은 검증 archive 재다운로드 → apply | **변경된 기존 bytes를 재사용하고 `applied:true`** 재현 |
| 상대 current link → 활성 release bin hardlink로 검증 실패 유도 → 같은 버전 staging | **활성 generation의 inode가 교체됨** 재현 |
| 새 image rebuild/full smoke/HAOS/native ARM | 이번 리뷰 **NOT RUN**. FIX_03_REPORT에도 해당 gap 명시 |

두 재현은 private temporary directory, harmless shell executable과 정확한 SHA-256의 로컬 archive fixture만 사용했다. `downloadAndStagePackage` 및 `applyUpdate` 실제 함수를 호출했고 파일을 정리했다. 실제 token/auth/session 본문·proc environ·운영 HA는 접근하지 않았다.

## 1. P1 — 검증된 archive 대신 변조된 기존 실행 파일을 선택함

근거: `codex-runtime-manager.mjs:1418-1427`, `validateCandidatePackageTree`, `applyUpdate`.

기존 destination의 tree 모양과 manifest version/target만 맞으면 새로 다운로드하여 SHA-256까지 검증한 extract를 버리고 기존 directory를 재사용한다. 기존 파일의 bytes/digest는 비교하지 않는다. 실제로 첫 stage 후 `bin/codex`의 내용을 수정하고 원래 archive를 다시 stage했을 때 수정 내용이 유지됐으며, apply는 이를 적용 완료로 기록했다. `--version` 문구가 맞는 것은 공식 패키지의 bytes임을 보장하지 않는다. 동일 문제가 staging 이후 변경·App 재시작 시 override 재사용에도 적용된다.

수정:

- 검증한 공식 archive와 선택되는 전체 package bytes/resource의 대응을 확인한다. 기존 destination 재사용 시 검증된 extract와 파일 목록·내용 hash·link/type/manifest를 비교하거나 신뢰 가능한 package inventory로 검증한다. 자기 자신의 mutable manifest만으로 무결성을 승인하지 않는다.
- 검증 불일치는 해당 generation을 선택하지 않고 명확한 무결성 오류로 차단한다. 자동으로 기존 directory를 덮어쓰지 않는다.
- apply 직전에도 candidate journal의 version/target/digest와 선택 tree를 대조한다. wrapper/init의 retained override 선택도 같은 검증 계약을 따른다. candidate hash가 없거나 확인할 수 없으면 자동 적용하지 않는다.
- 회귀: 정상 동일 archive 재사용 시 inode 유지, bin/companion/resource 내용 변경·추가/삭제·manifest 변경 시 거부, stage→apply 사이 변경 시 선택 전환 없음, App restart 후 변조 override 거부를 실제 함수로 검증한다.

## 2. P1 — 상대 current 및 실행 참조 release를 삭제할 수 있음

근거: manager `1428-1435`.

검증 실패 destination을 보호할 때 `resolve(currentTarget)`를 사용한다. 상대 link는 link가 있는 runtime root가 아니라 Node의 작업 디렉터리를 기준으로 해석되어 비교가 틀린다. 실제 `current -> releases/0.163.0-x86_64-unknown-linux-musl`에서 해당 destination에 hardlink를 추가해 validation을 실패시키자 active directory가 재귀 삭제·재생성됐다. previous/staged와 실행 process/companion 참조도 이 분기에서 보호하지 않는다.

수정:

- relative link는 `dirname(currentLink)` 기준으로 해석하고 realpath/identity를 검증한다. current/previous/staged/실행 참조 및 불확실한 참조본은 staging 실패 복구에서도 삭제하지 않는다.
- invalid existing generation은 원칙적으로 거부하고 상태를 보고한다. 격리/GC는 실제 참조가 없음을 확인한 별도 안전 경로로 처리한다.
- 회귀: absolute/relative current, previous-only, staged-only, live executable/companion/resource 참조 각각에서 validation 실패를 유도해 inode와 경로가 보존되는지 assertion한다.

## 3. P1 — 재시작 실패의 서비스 복구와 실제 실행 버전 검증 불완전

근거: manager `1785-1848`, `1703-1725`; wrapper `159-161`.

- readiness 성공 조건은 RPC idle 및 `childProc.exe` 존재일 뿐, 선택 generation의 executable identity/version과 대조하지 않는다. 보고서의 실제 실행 버전 검증 완료 주장은 과장이다.
- 실패 시 old server spawn만 시도하고 error를 무시하며 readiness·PID/version을 검증하지 않는다. 이전 binary가 없거나 실행이 실패해도 reason에는 `restored previous service`라고 적는다. restored PID의 새 관리 record도 작성하지 않는다.
- 여러 서버 중 앞선 서버는 새 generation으로 교체하고 record까지 갱신한 다음 후속 서버가 실패하면 symlink만 과거로 되돌린다. 앞선 서버는 신버전으로 남아 transaction 전체 rollback이 성립하지 않는다.
- wrapper 최초 관리 record에는 `exe/args/cwd`가 없지만 테스트는 이를 직접 채운다. 실제 wrapper가 생성한 record로 재시작·복구하는 경로를 검증해야 한다. wrapper의 JSON printf는 socket path의 quote/backslash도 escape하지 않는다.

수정:

- signal 전 package 검증을 완료하고 마지막 PID/start/executable generation·소유권 확인을 수행한다. 실제 tagged Codex에서 graceful semantics를 확인한 증거를 남긴다.
- 새 서버는 실제 executable identity와 선택된 package version/resource가 일치하고 socket readiness가 정상일 때만 완료 처리한다.
- 복구는 old server의 새 PID/start/version/socket과 launch record까지 검증한 뒤 `restored`로 기록한다. 실패하면 `rollback_incomplete` 등 사실에 맞는 상태·복구 방법을 제공한다. 부분 교체된 모든 서버를 추적하고 transaction 전체의 일관성을 복구한다.
- wrapper가 정확한 안전 launch metadata를 JSON encoder로 기록하도록 하고, 실제 그 record를 사용한 성공/실패 시험을 추가한다. 임의 proc environ 복사는 하지 않는다.
- 회귀: launch 실패/readiness 실패/old server 복구 실패/여러 서버 중 두 번째 실패에서 실제 process/version/socket/record를 assertion한다. signal 수와 24시간 cooldown 유지도 확인한다. 현재 테스트는 성공과 즉시 cooldown만 검증하며 rollback 실패 주장은 입증하지 못한다.

## 4. P1 — 적용 전 managed 정책 호환성 검증은 여전히 help-only

근거: manager `1382-1412`, FIX_03의 4번 요구.

승인 값이 `safe`에서 `on-request`로 바뀌었지만 `--help` 호출은 config/requirements/MCP의 실제 parsing과 sandbox 실행을 검증하지 않는다. future stable이 보호 정책이나 companion과 비호환이어도 현재 구현은 apply할 수 있다. 이 요구는 기존 correction에서 계속 미해결이다.

- isolated HOME에서 실제 managed config/requirements/MCP parsing과 새 package 필수 companion/resource를 검증한다. actual image/AppArmor에서 민감 경로 deny·일반 RW와 지원 sandbox 실행을 확인한다. 수행할 수 없으면 자동 apply를 차단하고 정확한 이유를 표시한다.
- 단순 help가 성공하지만 실제 managed config/sandbox 실행은 실패하는 후보 fixture로 음성 회귀를 추가한다. 실제 Codex baseline 및 candidate image의 검증도 별도로 기록한다.

## 보고서·수용 기준

- 기존 handoff를 고치지 말고 FIX_04_REPORT/progress에 위 실제 변경·재현 전후 결과·테스트 범위 및 남은 NOT RUN을 기록한다.
- 보고서의 archive 한도 500개/128MB는 실제 소스의 5000개/250MiB와 다르다. 의도한 값을 정하고 실제 상수·경계 시험·보고서가 일치하게 한다.
- 새 candidate image를 build하고 image ID와 full runtime/updater/0.7.0→candidate persistence smoke의 실제 명령/exit를 기록한다. pytest PASS가 image 검증을 대체하지 않는다. native ARM은 CI 또는 NOT RUN을 구분한다.
- 사용자의 운영 HAOS 설치/UI/mobile 수용은 DEV 발행 후 사용자 수행 항목으로 남길 수 있다. 안전한 코드·실행 증거를 인수하면 기존 승인대로 미사용 `0.7.1-dev.N`의 dev CI/tag builder/GHCR 발행을 진행한다. main/stable은 변경하지 않는다.
