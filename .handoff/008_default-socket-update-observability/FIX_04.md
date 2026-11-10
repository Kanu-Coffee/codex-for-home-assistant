# FIX_04 — 검사 완료의 디스크 상태, rollout 판정과 CI 계약

- 작성: 2026-11-10 (Asia/Seoul), Reviewer: Codex.
- 대상: HEAD `59da709` 이후 미커밋 구현, `FIX_03_REPORT.md`.
- 판정: **REQUEST CHANGES — 실제 loop·일부 실패 이력 수정은 수용, 아래 결함 수정 후 재인수 필요.**
- 범위: 로컬 수정·검증·문서. 외부 push/PR/merge/tag/release 및 운영 HA 변경을 지시하지 않는다.
- 기존 handoff는 보존한다. 다음 Executor는 FIX_04를 수행하고 새 `FIX_04_REPORT.md`를 작성한다.

## 1. 수용한 수정과 이번 전체 검증

- 새 daemon 시험이 실제 `loop()`를 호출하고 살아 있는 fixture를 사용해 저빈도 네 번·소진·날짜 전환을 통과하는 것은 이전의 loop=0 상태와 구분해 수용한다. sleep/policy 주입이 있는 로컬 검증이며 실제 HAOS signal/정책 수용으로 확대하지 않는다.
- invalid-tag version check의 회차와 실패 이력을 durable state에 남기는 수정 및 unclean_shutdown 복구 분기 추가는 개선이다. 모든 종료 경로가 완성됐다는 결론은 아래 결함 때문에 수용하지 않는다.
- 이번 CI와 동일 binary 환경의 전체 pytest: **333 passed, 1 failed, 2 skipped / 209.13s**. 기존에 실패했던 TUI를 포함해 handover 네 종류는 이번 전체 실행에서 PASS했다. 남은 실패는 §4다.
- 기존 기본 소켓/프록시·권한 보호·시간대·migration 개선의 수용은 유지한다. 제품 보호 검사를 완화해서 문제를 해결하지 않는다.

## 2. [P2] 관리 세션 적용 성공 뒤에도 디스크에 activeCheck가 남음

대상: `codex-runtime-manager.mjs`의 `finishSelection` callback(약 3287~3315행), 성공 반환 직전 3333행.

finishSelection은 status=applied와 성공 이력을 saveState하지만 activeCheck를 지우지 않는다. 이후 `state.activeCheck=null`은 메모리에서만 실행되고 saveState 없이 반환한다. cleanupOldReleases도 이 변경을 저장하지 않는다.

Reviewer는 기존 real worker handover stdio 시험에 **실제 apply 성공 직후 loadState 단언만** 추가하여 독립 실행했다. 결과:

```json
{"activeCheck":{"checkNumber":2,"type":"idle_check","startedAt":"..."},"status":"applied"}
```

즉 applied=true인데 저장 파일은 검사 중이다. 다음 initRuntime은 이 activeCheck를 unclean_shutdown 실패로 기록하므로 정상 적용과 비정상 종료가 같은 회차에 잘못 누적된다.

재현 파일: Git 제외 `.test-tmp/review008-fix03/managed-active-check-probe.py`. 공식 0.162.1→0.167.0 실제 relay/worker 전환을 사용했고 product source는 수정하지 않았다. 기존 시험에 추가한 “성공 뒤 disk activeCheck is None” 단언이 실패했다.

### 수정·수용 조건

- 관리 세션 성공 commit의 같은 durable write에서 activeCheck를 닫고 성공 결과를 저장한다. 반환 객체만 고치거나 다음 시작에서 무조건 activeCheck를 폐기하는 방식은 불충분하다.
- 실제 managed apply 성공 직후 새 loadState/별도 process에서 activeCheck=null, 올바른 선택 버전/회차 성공 이력을 확인한다. 정상 init/restart 후 같은 회차에 unclean_shutdown이 추가되지 않아야 한다.
- 실제 미완료 검사와 interrupted transaction의 journal/복구 보호는 유지하고 해당 음성 회귀도 확인한다.

### 같은 종료 계약의 미완료 분기

무결성 차단·정책 차단·일부 pre-verification 반환은 activeCheck만 지우고 terminal history를 추가하지 않는다. Reviewer의 sealed fixture를 변조한 실제 apply 호출은 **reason=blocked_integrity, history 1→1, activeCheck=null**이었다. 검사 번호는 증가했지만 해당 결과가 이력에서 사라진다. 재현: `.test-tmp/review008-fix03/integrity-history-probe.mjs`.

모든 실제 검사 종료를 점검해 적용/보류/차단/실패가 같은 회차에 한 번 기록되게 한다. 검사 전 budget skip은 실제 inspection과 구별한다. throw를 잡는 catch만으로 정상 반환 차단 경로를 대신하지 않는다. 신뢰할 수 있는 allowlist reason을 사용한다.

## 3. [P2] rolloutReady가 오류 응답과 thread 불일치를 성공으로 처리함

대상: `codex-session-host.mjs:_checkRolloutReady()` 328~355행.

thread/read가 JSON-RPC error를 반환하거나 thread가 없거나 다른 ID이면 두 조건문을 모두 건너뛰고 최종 ready=true가 된다. Reviewer가 메서드에 synthetic 응답을 주입해 확인했다.

| thread/read 응답 | 실제 결과 |
| --- | --- |
| `{error:{code:-32000,...}}` | `ready:true` |
| `{result:{thread:{id:"different-thread"}}}` | `ready:true` |

재현: `.test-tmp/review008-fix03/rollout-ready-probe.mjs`.

실제 switchWorker의 별도 복원 보호는 남아 있으므로 이 증거만으로 대화 유실이나 unsafe 종료를 주장하지 않는다. 하지만 TUI 시험의 준비 대기가 바로 이 필드에 의존하므로 미확인 상태를 준비 완료로 해석하면 실패 경합을 다시 허용한다.

### 수정·수용 조건

- RPC error/잘못된 schema·ID·path·ephemeral 상태를 명시적으로 검증하고, 준비를 증명할 수 없으면 ready=false와 제한된 reason으로 반환한다.
- 일반 파일 여부/허용 root/link 등의 의미를 실제 switch preflight와 맞추거나 이 필드가 보장하는 범위를 좁혀 정확히 표시한다. size>0만으로 “파일 전체 디스크 flush 완료”를 주장하지 않는다.
- 오류/잘못된 ID/누락 metadata/파일 생성 중/정상 영속 대화/내용 있는 ephemeral을 시험한다. TUI 시험도 필요한 rolloutReady가 없으면 true로 간주하지 않게 한다.
- 기존 실제 적용 전 barrier·thread 복원/ephemeral 보호를 유지하고, 새 CI 환경의 전체 suite 및 인계 후 후속 turn을 검증한다.

## 4. [P2] Unreleased changelog 추가로 새 CI의 버전 계약이 실패함

대상: `CHANGELOG.md`의 첫 heading과 `tests/test_addon_contract.py:572`.

이번 전체 pytest의 유일한 실패:

```text
test_app_and_dockerfile_versions_match
assert 'Unreleased' == '0.7.3'
```

새 문서 변경과 기존 버전 계약이 충돌한다. FIX_03_REPORT의 “전체 테스트 PASS”는 전체 suite 결과가 아니라 계약 파일 141개 등 부분 시험 결과로 구분해야 한다.

### 수정·수용 조건

- 미배포 기록과 첫 실제 release heading의 의미를 저장소 계약에 맞게 정리한다. Unreleased를 지원하는 방식이면 계약 테스트가 첫 유효한 버전 heading과 실제 App/Docker/package 버전의 일치를 계속 검사해야 한다.
- 검사를 삭제하거나 이 실패만 skip하지 않는다. green을 만들기 위해 Stable 0.7.3에 미배포 기능을 이미 배포한 것처럼 기록하지 않는다. 버전/채널 변경은 실제 후보 준비 범위에서 일관되게 처리한다.
- 새 CI 환경 변수로 전체 pytest를 통과시키고 lint/실제 변경 문서를 확인한다.

## 5. [P2] 사용자 예산 안내가 실제 두 단계 정책과 다름

대상: `DOCS.md:458-459`, `DOCS.en.md`의 대응 문단, CHANGELOG 및 관련 개발 계약.

수정 문서는 기존 5분·12회 설명을 삭제하고 “당일 재확인은 1시간 간격 최대 4회”로 안내한다. 하지만 구현은 빠른 5분/12회를 유지하고 소진 뒤 별도 60분/4회를 사용한다. 또한 네 번 소진 뒤 같은 후보를 09:00/15:00/21:00의 다음 정기 슬롯에서 자동 재개한다고 안내하지만 같은 budget date의 paused 후보는 checkUpdate에서 계속 paused로 반환된다. budget date의 03:00 전환과 수동 apply를 구분해야 한다.

### 수정·수용 조건

- 양 언어에 빠른 12회와 저빈도 4회, 각 최소 간격, 같은 budget date에서의 소진 상태, 03:00 초기화, 수동 요청 의미를 정확히 설명한다. 미래 정책 변경을 현재 코드 동작처럼 쓰지 않는다.
- “완전 flush”, `ss -x` fallback, `/proc/net/unix`만으로 kernel peer 검증 등의 표현은 실제 구현·검증 범위에 맞춘다. 현재 주요 peer 근거는 UNIX_DIAG Netlink다.
- product_spec/architecture/test_plan 등 실제로 달라진 개발 계약을 검토하고 필요한 부분을 갱신한다. 관련 없는 README를 기계적으로 바꿀 필요는 없지만 검토 결과·남은 공백을 보고한다.

## 6. 시험 재현성과 실제 image 검증의 남은 경계

- 새 daemon 시험은 loop를 실행하지만 날짜 전환에서 production checkUpdate가 공식 GitHub latest를 조회할 수 있으며 최종 버전을 0.163.0 또는 0.167.0으로 허용한다. 미래 latest가 바뀌면 시험이 바뀐다. 실제 loop/durable state를 유지하면서 release 조회/다운로드는 checksum이 있는 고정된 로컬 fixture나 검증된 package로 제어하고 결과 버전을 단일하게 단언한다.
- AppArmor deny 시험은 inspectProcess 결과의 env를 비우는 fault injection이다. 실제 profile enforce/image/SSH/S6 수용은 아니다. 새 image build·실제 보호 profile default proxy/update/full smoke를 수행하거나 구체적인 NOT RUN 사유와 gate를 남긴다. 보호 profile을 풀어 검증을 통과시키지 않는다.
- 실제 HAOS/mobile·native ARM·일반 App update 보존과 공개 DEV/Stable 산출물은 실행 여부와 승인 범위에 따라 별도로 남긴다. 로컬 인수와 배포 완료를 구별한다.

## 7. 이번 Reviewer 직접 검증 및 다음 보고

- 새 CI binary 환경, 짧은 전용 `/home/lee/r84-*` basetemp의 전체 pytest: **333 passed / 1 failed / 2 skipped, 209.13s**. 로그: `.test-tmp/review008-fix03/ci-env-full-pytest.log`. 임시 basetemp는 종료 후 정리했다.
- 실제 stdio worker 적용 성공 후 activeCheck 디스크 잔류를 추가 단언으로 재현했다. 무결성 차단 결과 이력 누락과 rolloutReady 두 오류 응답의 잘못된 성공도 독립 재현했다.
- ShellCheck, actionlint, 세 Node 모듈 syntax, `git diff --check`: PASS.
- 새 image build/실제 AppArmor·제품 wrapper/SSH/S6, native ARM, HAOS/mobile, 공개 CI/배포는 이번 Reviewer 작업에서 NOT RUN이다.
- 제품 코드·버전·기존 handoff·외부 Git·운영 HA는 변경하지 않았다. Reviewer 산출물은 FIX_04와 progress다.
- FIX_04_REPORT에는 위 종료 경로별 디스크/이력 단언, 준비 상태 음성 행렬, 새 CI 환경 전체 결과, 정확한 문서 정책, 미검증 gate를 기록한다. 기존 개선은 수용을 유지하며 미해결 조건을 완료로 바꾸지 않는다.
