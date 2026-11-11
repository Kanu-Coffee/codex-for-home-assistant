# FIX_05 — 시간 역행·시간대 변경에 따른 예산 재충전 방지

- 작성: 2026-11-10 (Asia/Seoul), Reviewer: Codex.
- 대상: HEAD `59da709` 이후 작업 트리와 `FIX_04_REPORT.md`.
- 판정: **FIX_04의 기존 결함 수정 수용 / 추가 P2 1건으로 REQUEST CHANGES.**
- 범위: 아래 예산 기간 처리·검증·기록. 외부 Git·DEV/Stable 게시·운영 HA 변경 지시가 아니다.
- 기존 PLAN/REPORT/FIX_01~04와 보고서는 보존한다. 다음 Executor는 FIX_05를 수행하고 `FIX_05_REPORT.md`를 신규 작성한다.

## 1. 이번 리뷰에서 수용한 사항

- 실제 공식 0.162.1→0.167.0 stdio handover 직후 재조회한 디스크 상태가 **activeCheck=null / status=applied**였다. 성공 commit의 activeCheck 잔류 수정은 수용한다. 기존 독립 probe의 추가 단언도 통과했다.
- 무결성 차단 probe가 **history 1→2 / activeCheck=null**로 바뀌었다. 기존 차단 결과 누락 수정은 수용한다.
- rolloutReady의 RPC error와 thread ID 불일치가 각각 **ready=false**와 구분된 reason을 반환했다. 기존 두 오류 응답의 잘못된 성공 판정은 수정됐다.
- Unreleased를 제외하면서 첫 실제 release heading과 App/Docker/package 버전 일치를 유지하는 계약 수정은 수용한다.
- 양 언어 DOCS가 빠른 5분/12회와 저빈도 60분/4회를 다시 구별하고, 같은 budget date에서 모두 소진되면 대기한다는 정책으로 정정됐다. 데몬 시험의 외부 latest 의존성 제거와 고정 후보 단언도 수용한다.
- 새 CI와 동일한 binary 환경의 전체 pytest를 직접 실행해 **334 passed, 2 skipped, 0 failed / 189.64s**를 확인했다. 계약 파일만이 아닌 전체 suite 결과다. Executor의 337 수치와는 별도로 이번 실행 수치를 기록한다(CODEX_WIRE_PROBE_BINARY 지정에 따른 proxy fixture 매개변수화 차이).

## 2. [P2] 날짜 문자열의 불일치만으로 소진 예산이 반복 초기화됨

대상:

- `codex-runtime-manager.mjs:2710`의 checkUpdate budget reset.
- 같은 파일 `2973` 부근의 applyUpdate budget reset.
- `codex-updater-daemon.mjs:114-129`의 loop budget reset.

세 곳 모두 `state.budgetDate !== currentDate/slotInfo.slotDate`이면 양 예산을 0으로 만든다. 과거 날짜로의 이동도 새 예산 기간으로 처리하고, 시간대 변경으로 계산된 날짜가 달라져도 동일하게 재충전한다. 이는 PLAN §4.D 및 §6의 “timezone 변경·DST·시계 역행에서도 무제한 예산 재생성이나 중복 apply가 생기지 않게 정책을 문서화하고 검증” 요구를 충족하지 못한다.

이번 지적은 사용자 요청의 수동 apply 예외를 제한하거나 세션 작업 보호 실패를 주장하는 것이 아니다. **같은 후보의 자동 예산 12+4 상한이 시간 변화만으로 재생성되는 문제**다. 기존 작업/신원/복원/cooldown gate를 유지한다.

### 독립 재현 A — 날짜 역행과 원래 날짜 복귀

동일한 검증된 fixture 후보 0.163.0, paused_busy, 빠른 12회·저빈도 4회 소진 상태를 사용했다. 실제 `checkUpdate()`를 fixture release로 호출했으며 외부 네트워크·운영 시계·HA는 변경하지 않았다.

| 가상 시각 변화 | 저장 budgetDate | 빠른 예산 사용량 | 저빈도 사용량 |
| --- | --- | --- | --- |
| 11월 10일에서 11월 9일로 역행 후 확인 | 2026-11-09 | 0 | 0 |
| 소진 상태에서 원래 11월 10일로 복귀 후 확인 | 2026-11-10 | 0 | 0 |

새 실제 운영 기간이 지나지 않았는데 budget_reset이 두 번 생성됐다. 재현: Git 제외 `.test-tmp/review008-fix04/budget-clock-probe.mjs`.

### 독립 재현 B — 같은 시각의 timezone 변경

가상 시각을 **2026-11-10T02:30:00Z로 고정**했다. 동일 후보·소진 상태에서 App timezone만 변경하여 실제 checkUpdate를 호출했다.

| 옵션 시간대 | 계산·저장 budgetDate | 빠른 사용량 | 저빈도 사용량 |
| --- | --- | --- | --- |
| UTC | 2026-11-09 (03:00 이전) | 0 | 0 |
| Asia/Seoul | 2026-11-10 | 0 | 0 |

같은 시각에 시간대만 오가도 예산을 재생성할 수 있다. 재현: `.test-tmp/review008-fix04/budget-timezone-probe.mjs`.

## 3. 수정과 수용 조건

1. **날짜 변경과 새 예산 기간 시작을 구별한다.** 과거 날짜로 이동했거나 timezone 변경으로 날짜가 달라졌다는 이유만으로 소진 예산을 재충전하지 않는다. 마지막으로 수용한 기간/초기화 시각·다음 경계 등 필요한 최소 상태를 durable하게 보존하여 재시작 후에도 기준이 유지되게 한다.
2. **시간대 변경 정책을 명시한다.** 현재 소비량을 보존하면서 향후 정상 경계를 어떻게 계산하는지 정의한다. timezone을 반복 변경해도 매번 새 예산을 받지 않게 한다. 정상 03:00 전환, 00:00~02:59의 전 budget date 의미, DST의 23/25시간 날짜를 깨뜨리지 않는다.
3. **세 reset 경로에 같은 정책을 적용한다.** daemon의 오래된 local state와 CLI 경합 때문에 한 기간을 두 번 초기화하지 않도록 lock 안의 최신 상태에서 판단한다. 공통 helper 등 저장소 관례에 맞는 작은 구현을 사용한다.
4. **기존 state 호환을 유지한다.** 기존 0.7.3/이번 후보의 budgetDate·소진 카운터를 새 필드 부재만으로 초기화하지 않는다. 보수적 migration과 다음 기회를 설명한다. 수동 apply의 명시 요청 의미와 후보 변경의 기존 정책은 별도이며 불필요하게 바꾸지 않는다.
5. **실제 동작을 자동 검증한다.** 같은 후보의 소진 상태에서 날짜 역행→원래 날짜 복귀, 같은 instant UTC↔Asia/Seoul 반복, daemon 재시작, daemon/CLI 경합, 정상 다음 03:00, DST 및 미래 시각 점프 후 역행을 포함한다. 실제 loop/durable state 및 호출 횟수로 예산 재충전·중복 적용이 없음을 단언한다. 날짜 함수 값만 검사해서 대체하지 않는다.
6. **status/이력·문서를 맞춘다.** 설정 시간대, 현재 예산 기간, reset이 보류된 사유와 실제 다음 기회를 모호하지 않게 설명한다. 새 기록은 allowlist·크기/보존 상한·비밀 비노출을 유지한다. 기능 인수 전에 정책과 시험 결과를 FIX_05_REPORT에 남긴다.

## 4. 이번 독립 검증과 남은 배포 gate

- 전체 pytest: **334 passed / 2 skipped / 189.64s**. CODEX_WIRE_PROBE_BINARY=0.167.0, CODEX_HANDOVER_BASELINE=0.162.1, CODEX_HANDOVER_CANDIDATE=0.167.0을 지정했다. 직접 만든 짧은 `/home/lee/r85-*` basetemp는 종료 후 정리했다.
- 전체 로그: `.test-tmp/review008-fix04/ci-env-full-pytest.log`. skip 조건은 로컬 AppArmor parser와 Grype/cache 가용성에 따른 선택 시험이며 실제 보호 profile·취약점 scan 수용을 대신하지 않는다.
- 기존 실제 managed apply 디스크 단언, 무결성 차단 이력 probe, rollout 두 오류 응답 probe: PASS. 시간 역행·timezone 변경 문제만 별도로 재현했다.
- ShellCheck, actionlint, Node syntax, `git diff --check`: PASS.
- 새 image build/실제 AppArmor·제품 wrapper/SSH/S6, native ARM, HAOS/mobile, 공개 CI/DEV·Stable 배포는 이번 Reviewer 작업에서 NOT RUN이다. 이 상태로 전체 제품·배포 수용 완료라고 쓰지 않는다. 실제 image·채널·운영 검증은 원 PLAN의 후속 gate로 유지한다.
- CHANGELOG의 “all conversation files are completely flushed”는 lstat/파일 크기 검사보다 강한 표현이다. 후속 문서 정리에서 실제로 보장하는 파일 준비 상태·별도 switch preflight 검사 범위로 좁힌다. 이 문구 자체를 새로운 기능 차단 결함으로 확대하지 않는다.
- Reviewer는 제품 코드·버전·기존 handoff·외부 Git·운영 HA를 변경하지 않았다. FIX_04에서 해결한 결함을 다시 미해결로 취급하지 않으며, 다음 실행 범위는 위 추가 P2와 필요한 검증이다.
