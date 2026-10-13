# FIX_06 — FIX_05 리뷰: GC 검사 실패와 timezone calendar 날짜 경계

## 판정·범위

- Reviewer, 2026-10-13 Asia/Seoul. **CHANGES REQUESTED**, DEV 발행 보류.
- 기준: 002 PLAN/REPORT, FIX_01~05와 각 보고서, 현재 working tree. 기존 handoff를 보존한다. 다음 Executor는 본 문서를 수행하고 `FIX_06_REPORT.md`를 작성한다.
- FIX_05의 부분 drain 복구와 쿨다운 중 policy probe 생략/일일 상한은 개선됐다. 읽을 수 있는 live FD 보존 및 New York DST도 개선됐다. 아래 두 경계 조건은 아직 인수 기준을 충족하지 않는다.
- Reviewer는 구현 수정·commit/push/tag/release·운영 HA 변경을 하지 않았다. 인수 가능한 DEV 발행에 대한 기존 사용자 승인은 유지한다.

## 독립 검증 결과

| 검사 | 결과 |
| --- | --- |
| `.venv/bin/pytest -q` | **191 passed in 61.62s** |
| Wrapper/init/manual/S6와 3개 smoke ShellCheck | PASS |
| 전체 workflow actionlint, Dockerfile Hadolint, `git diff --check` | PASS |
| 이전 live FD + 실제 apply 재현 | 수정 확인: applied true, resourceExists true, readerAlive true |
| 이전 두 old server/두 번째 drain timeout 재현 | 수정 확인: 첫 서버 새 PID로 복구, 총 live 2개, launches 3, 정확한 rollback_incomplete |
| Live resource FD가 있지만 `/proc/<pid>/fd` EACCES | **preserved false, readerAlive true** |
| Pacific/Auckland의 21시 이후·03시 이전 | **다음 예약/budget 날짜 및 slotDate가 하루 틀림** |
| 새 image rebuild/HAOS Docker/native ARM/수정 GitHub CI | 이번 Reviewer **NOT RUN**, FIX_05_REPORT도 재실행하지 않았음을 명시 |

Private temporary directory의 harmless fixture만 사용했다. 실제 credential·session 본문·proc environ은 읽지 않았다. 임시 reader process와 directory를 정리했다. 재현 스크립트 `/tmp/codex-ha-review06-gc.py` 및 이전 `/tmp/codex-ha-review05-repro.py`, `/tmp/codex-ha-review05-drain.py`를 사용했다. 임시 파일이 없어도 아래 절차로 재현 가능하다.

## 1. P1 — 개별 process 참조 검사 실패를 무참조로 취급하는 GC

근거: `codex-runtime-manager.mjs:1998-2046`, 특히 `2013-2022`, 삭제 `2049-2056`.

`/proc` 최상위 readdir 실패에만 return한다. 개별 PID의 exe/cwd/fd/maps/cmdline 실패와 개별 fd readlink 실패는 모두 빈 catch로 무시한다. 따라서 읽을 수 있는 참조는 보존하지만, 참조를 확인할 수 없는 경우에도 release를 삭제한다. FIX_05_REPORT의 'proc 읽기 실패 시 fail closed'는 이 경우에 성립하지 않는다.

재현 절차:

1. Private `runtime/releases/0.160.0-x86_64-unknown-linux-musl/fixture`에 synthetic resource를 만든다.
2. 별도 Python process를 `-c`로 실행하고 resource 경로는 stdin으로 전달한다. Reader는 파일을 open한 뒤 `ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)`으로 PR_SET_DUMPABLE=0을 설정하고 살아 있게 한다. 인자/cwd에는 resource 경로가 없다.
3. Node caller의 `CODEX_RUNTIME_DIR`를 fixture runtime으로 지정한다. `/proc/<reader pid>/fd` 열람 오류를 확인하고 실제 export `cleanupOldReleases('0.163.0', null)`를 호출한다.
4. 결과: `{"inspectionError":"EACCES","preserved":false}`, reader는 계속 살아 있다.

이는 직접 호출한 실제 GC 함수의 음성 시험이다. 이 재현으로 실제 HAOS AppArmor에서 같은 오류가 발생했다고 주장하지 않는다. 다만 apply의 사전 세션 검사와 나중의 GC 사이에서 접근 가능성이 바뀌거나 process 검사가 제한되면 사전 검사만으로 GC 안전성을 대신할 수 없다.

수정:

- 개별 PID/FD 검사에서 permission/error/identity 불확실성을 무참조로 바꾸지 않는다. 삭제 전에 참조 없음이 확인되지 않으면 GC를 보류한다. 사라진 process/FD의 정상 race와 접근 거부를 구분하고, PID/start identity가 바뀌면 보수적으로 처리한다.
- 자동 recursive GC를 비활성화하는 좁은 해결도 이전 FIX_05가 허용한 선택이다. 이 경우 보관/디스크 부족 동작과 상태를 문서화한다. 추가 host capability나 AppArmor 완화로 해결하지 않는다.
- 실제 함수 음성 회귀에 EACCES/EPERM, fd readlink 실패, process 종료 race를 넣는다. 읽을 수 있는 live FD/mmap/cwd와 current/previous/staged 보존 및 안전한 무참조 정리도 확인한다. 비밀 본문/environ은 읽지 않는다.

## 2. P2 — UTC 정오 anchor를 다시 timezone 변환하여 날짜가 하루 밀림

근거: manager `144-158`, `201-205`, `225-231`.

Calendar date를 하루 이동하려고 만든 `Date.UTC(..., 12, 0, 0)`을 다시 대상 timezone으로 format한다. UTC+12 이상에서는 정오 UTC가 현지 다음 날짜이므로 day 이동이 한 번 더 적용된다. UTC−12에서도 반대 방향 경계가 있다. Calendar 산술 결과를 UTC instant처럼 다시 timezone 변환하는 것이 원인이다.

실제 `Pacific/Auckland` 결과:

| 입력 | 현재 결과 | 기대 |
| --- | --- | --- |
| 2026-10-13T22:00:00+13:00, next slot | 2026-10-14T14:00:00Z = 현지 10/15 03시 | 2026-10-13T14:00:00Z = 현지 10/14 03시 |
| 같은 입력, next budget | 현지 10/15 03시 | 현지 10/14 03시 |
| 2026-10-13T01:00:00+13:00, slotDate/key | 2026-10-13 / 10/13T21:00 | 2026-10-12 / 10/12T21:00 |

마지막 행은 아직 오지 않은 21시 슬롯을 현재 슬롯으로 기록한다. 이후 03시의 slotDate도 같은 날짜가 되어 budget rollover가 누락될 수 있다. `getNextDayFirstSlotTime`도 하루 이상 늦은 값을 반환한다. Daemon이 sleep을 한 시간으로 자르는 것은 잘못된 slot key와 budget date를 바로잡지 못한다.

수정:

- Calendar의 year/month/day를 ±1 이동할 때는 calendar 산술로만 처리한다. UTC Date를 산술용으로 사용할 경우 결과의 UTC year/month/day를 읽고, 그 날짜를 다시 timezone format하지 않는다. 실제 목표 지역 날짜/시각의 UTC instant 변환은 마지막 한 번만 수행한다.
- prev slotDate, next slot instant, next budget instant에 같은 calendar 계약을 적용한다. 지원하는 IANA timezone 범위를 임의로 줄이지 않는다.
- 서울/UTC/New York DST 회귀를 유지하고 Pacific/Auckland, Pacific/Kiritimati 및 UTC−12 지역의 03시 이전/21시 이후, month/year rollover를 시험한다. 다음 날짜 첫 슬롯의 동일 candidate budget 초기화도 검증한다.

## 보고서·검증·배포

- 기존 handoff를 고치지 말고 FIX_06_REPORT/progress에 수정 전후 실제 결과·명령·검증 공백을 기록한다. FIX_05의 네 가지 전수 해결 주장은 위 두 경계까지 검증한 것으로 확대하지 않는다.
- FIX_05_REPORT의 `node -c .../*.mjs`는 여러 파일을 모두 검사했다는 증거로 충분하지 않다. Node syntax는 파일마다 호출한다. Daemon 일부 슬롯 계산은 여전히 `new Date()`이므로 `getNow()` 추가만으로 전체 daemon의 clock injection 검증 완료라고 쓰지 않는다. 다음 날짜/재부팅/OFF→ON/쿨다운 만료의 실제 loop 시험 또는 명시적 NOT RUN을 남긴다.
- Full pytest와 관련 lint를 실행한다. Lifecycle 변경이 반영된 후보 image를 rebuild하고 실제 updater/full runtime/0.7.0 persistence 검증 결과 및 image ID를 남긴다. Native ARM/수정 GitHub CI는 실제 run 또는 NOT RUN을 구분한다. FIX_04의 이전 image를 새 image 검증으로 대신하지 않는다.
- 인수 가능하면 기존 승인 범위에서 미사용 `0.7.1-dev.N`의 DEV identity·dev branch/tag·Builder/GHCR 발행을 완료한다. Main/stable은 변경하지 않는다. 운영 HAOS 설치/UI/mobile 수용은 DEV 전달 뒤 사용자가 수행한다.
