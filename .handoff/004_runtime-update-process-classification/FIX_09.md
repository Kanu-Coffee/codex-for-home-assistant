# FIX_09 — 부분 관측의 피드백 전달과 활성 I/O 종료 보완·HAOS VM 검증

## 판정과 범위

- Reviewer: Codex, 2026-10-26 (Asia/Seoul).
- **P2 2개 항목 수정 필요 / FIX_08 인수 보류**. 기본 개발목표 달성과 자동 업데이트 정상에 대한 사용자 확인은 유지한다. 검토 대상은 dev.2 후보의 추가 수정과 배포 전 검증이다.
- Branch `fix/runtime-update-dev-0.7.2-2`, HEAD `aa76fe8`. 시작 시 tracked 수정 23개와 untracked FIX_06~08 문서 6개를 확인했다. PLAN/REPORT, 이전 FIX/REPORT, 현재 diff·소스·시험과 수용 기록을 대조했다. 이전 handoff와 제품 코드는 수정하지 않았다.
- 수용한 부분: 이전 독립 재현에서 current/baseline 누락은 selected null, unknown-only는 running null/unobserved, 피드백의 stale record 보존 및 합성 Supervisor token 비상속이 확인됐다. 기존 FIFO 정체도 해소됐다. root symlink 분류·공용 enforce·ShellCheck 수정은 유지한다.
- 사용자 요청에 따라 VM 필요성을 검토했다. **F1은 로컬 회귀로 확인 가능하다. F2의 최종 S6/AppArmor/Supervisor 종료 경계는 개발용 HAOS VM에서 검증하도록 지시한다.** 이번 Reviewer는 VM을 기동하거나 운영 기기를 변경하지 않았다.

## F1 — P2: manager의 partial 관측 표시가 feedback 수집에서 유실됨

위치: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs:getStatus()`, `ha-feedback.mjs:797–805` 및 버전 환경 normalization/rendering.

Manager는 unknown holder와 확인된 주 버전이 함께 있으면 `runningVersion` 문자열에 `(partial)`을 붙인다. 그러나 수집 자식은 `runningVersions` 배열만 투영해 completeness 정보를 버리고, renderer는 그 배열을 완전 관측한 실행 목록처럼 표시한다. unknown-only 수정은 됐지만 혼합 상태에서는 같은 정보 손실이 남아 있다.

### 독립 재현

실제 모듈들을 자체 임시 디렉터리에 복사하고, 실제 collector 및 manager를 함께 실행했다. `/proc` 응답만 synthetic으로 주입해 baseline primary 1개와 package 내부 unknown executable 1개를 만들었다. 사용자 프로세스를 만들거나 검사 대상으로 신호를 보내지 않았다.

```json
{
  "manager": {"running":"0.162.1 (partial)","unknown":1},
  "collector": {"bundled":"0.162.1","selected":"0.162.1","running":["0.162.1"]}
}
```

이 수집 결과에는 부분 관측을 구분할 값이 없고 보고서 행에도 부분 관측 표지가 없다. 현재 unknown 테스트의 `status_with_unknown`은 실제 manager/collector 입력으로 사용되지 않으며, renderer에 null을 직접 넣는 검증으로 혼합 상태를 입증할 수 없다.

### 요구 수정과 수용 기준

1. Manager가 관측 완전성을 구조화한 고정 boolean/enum 등으로 제공하고 collector → report schema/allowlist → renderer까지 전달한다. 표시 문자열의 `(partial)`을 파싱하는 임시 해결보다 명시적인 상태를 사용한다. 기존 schema 1/legacy report·preview body 결합과 개인정보 allowlist를 유지한다.
2. 확인된 버전과 unknown holder가 함께 있으면 알려진 버전은 보존하되 **부분 관측**임을 명확히 표시한다. 완전 유휴, 완전 관측 목록, 미관측도 각각 구분한다. PID/argv/cwd/원문 status를 report로 옮기지 않는다.
3. 실제 `collect → validate → render`에서 정상 유휴, known-only, unknown-only, known+unknown, `/proc` 부분 거부를 대조한다. manager와 collector에 실제 해당 fixture가 들어갔는지 확인하고 만들어 놓고 사용하지 않는 fake status나 렌더링 상수만으로 검증하지 않는다.
4. Credential 비상속·stale/malformed 세션 기록 불변·타임아웃 및 legacy/privacy 회귀를 유지한다. Credential 검사는 단순 stdout 부재가 아닌 자식 환경의 합성 값 **존재 여부**로 확인하고 값은 출력하지 않는다. 테스트용 manager/path override는 명시적인 테스트 경계로 제한하거나 sibling 모듈 fixture를 완전하게 배치한다.

## F2 — P2: 진행 중인 네트워크 요청은 SIGTERM으로 중단되지 않아 30초 정지 한도를 넘음

위치: `codex-updater-daemon.mjs:160–163`, manager `fetchJson():1435–1474` 및 download/staging 흐름, `config.yaml`의 후보 `timeout: 30`, `test_plan.md` §6.3과 FIX_08_REPORT의 종료 근거.

`stopOnSignal()`은 loop flag와 sleep만 바꾼다. 진행 중인 `checkUpdate()`/HTTP 요청을 취소하거나 회수하지 않는다. `req.setTimeout(30000)`은 socket timeout 설정이며 전체 작업의 30초 벽시계 상한이 아니다. 응답이 조금씩 진행되면 이 값으로 전체 종료 시간을 제한할 수 없다. 다운로드에는 별도의 더 긴 한도도 있으므로 idle 종료의 몇 ms 측정만으로 App 전체 종료를 보장할 수 없다.

### 실제 daemon 로컬 재현

- 실제 `codex-updater-daemon.mjs`와 manager를 사용했다. 자체 임시 runtime/baseline/options에 auto-update ON을 설정하고, 테스트 프로세스 안에서만 HTTPS transport를 자체 loopback HTTP fixture로 대체했다. 외부 GitHub 요청과 운영 state 변경은 하지 않았다.
- Fixture는 HTTP 200 응답에서 200ms마다 소량의 body를 보내며 종료하지 않았다. daemon이 실제 요청에 진입한 뒤 SIGTERM을 보냈다.
- 결과: **SIGTERM 후 32초 안에 종료되지 않았다.** Reviewer가 직접 생성한 process group만 종료하고 부모를 wait/reap했으며 서버·임시 자료를 정리했다.
- 이는 실제 daemon의 활성 I/O 종료 결함을 재현한 것으로, S6/AppArmor가 적용된 VM의 exit 137을 이번에 재현했다는 주장은 아니다. 기존 VM의 exit 137은 별도 이전 증거다.

### 요구 수정

1. SIGTERM/INT에서 진행 중인 네트워크 확인·다운로드 및 안전하게 중단 가능한 staging 작업을 취소하고, 요청/응답/stream/timer를 회수한다. Promise만 reject하거나 flag만 바꾸고 I/O handle을 남기지 않는다. 신규 검사·재시도를 더 시작하지 않으며 lock과 자체 child도 정리한다.
2. 적용 transaction 중에는 기존 선택 링크·이전 generation·rollback 불변조건을 지키며 완료 또는 안전한 rollback으로 수렴시킨다. 임의의 즉시 `process.exit(0)`, 무관한 프로세스 종료 또는 무조건 긴 stop timeout으로 증거를 만들지 않는다. 실제 사용자 세션 보호·budget/cooldown 정책은 유지한다.
3. 네트워크 idle timeout과 전체 작업 deadline/종료 deadline을 구분한다. `timeout: 30`을 유지하거나 조정할 때는 **전체 컨테이너의 실제 종료 측정과 cleanup 여유**를 근거로 삼는다. 숫자 30끼리 같다는 것이 근거는 아니다.
4. 위 trickle 응답·응답 없는 요청·느린 다운로드·이미 유휴인 상태를 로컬에서 재현하고, 신호 후 한도 내 종료·lock 해제·부분 archive/staging 정리·선택 상태 일관성·재시작 시 정상 동작을 검증한다. 외부 network/credential이 필요 없는 synthetic fixture를 사용한다.

### 개발용 HAOS VM 검증 — 이번 후속 작업에 필요

로컬 재현만으로 취소 로직을 고친 뒤, **개발 HAOS VM에서 새 후보 image의 실제 `/init` + S6 + enforced AppArmor + Supervisor 경계**를 검증한다. 이유는 기존 문제가 Supervisor stop에서 관측됐고, 지금까지의 유휴 단일 프로세스 종료 측정은 foreground memory refresh·service process group·컨테이너 전체 종료를 포함하지 않기 때문이다.

1. 기존 개발 VM 도구/절차와 해당 지침을 사용한다. 시작 전 VM 전원·설치·App 상태를 기록하고 자체 test installation/container·합성 `/config`/`/data`로 범위를 분리한다. VM 안의 기존 stable App과 사용자 운영 장치를 변경하지 않는다. 제품의 manager 권한·고정 민감 경로 deny·AppArmor 정책을 완화하지 않는다.
2. 검토 중인 정확한 소스로 image를 빌드하고 source/version/image ID 또는 digest를 기록한다. 기존 dev.1 image의 PASS를 새 소스의 PASS로 사용하지 않는다. 개발 VM의 격리 image 시험은 사용자 실기기 배포의 대체가 아니다.
3. auto-update ON, updater 유휴, 진행 중인 지연 network/check/download, memory refresh 및 browser 활성 조건을 구분해 수행한다. 지연/장애 주입은 테스트 대상과 자체 서버에만 적용하며 운영 네트워크나 실제 HA 보호 자료를 변조하지 않는다. 테스트용 transport/fixture가 release image와 다르면 그 차이를 기록하고 실제 후보의 정상 실행/종료 시험도 별도로 수행한다.
4. Supervisor 일반 stop/restart에 대해 요청 시점·신호 수신/서비스 종료·총 소요 시간·설정 유예·컨테이너 exit code·최종 App 상태를 기록한다. CLI 요청 timeout이면 backend를 재조회하고 중복 요청하지 않는다. Ingress 200, 서비스 정상화, 합성 데이터/설정 보존, managed policy·선택 버전·staging/lock 불변을 함께 확인한다.
5. 기존 developer harness의 긴 Docker stop, auto-update OFF, host 단일 daemon 종료만으로 이 수용을 대신하지 않는다. 실행 경계상 불가한 시험은 정확한 이유와 NOT RUN을 남기되 완료/PASS라고 쓰지 않는다.
6. 자체 생성한 marker/프로세스/볼륨/profile 등만 정리하고 App·VM의 시작 전 상태로 복원한다. PID 숫자/argv substring으로 무관한 프로세스를 일괄 종료하지 않는다. actual token/auth.json/SSH key/HA 원문 자료를 결과에 포함하지 않는다.

## 검증 기록·인계

- Reviewer 독립 pytest: sensitive-path/feedback/addon **51 passed in 8.47s**, runtime/update pair **115 passed in 67.88s**. 전체 pytest 재실행은 아니다. 변경 셸 3개의 ShellCheck, Node syntax 2개, `git diff --check` PASS다.
- 이전 누락 선택/unknown-only/read-only/token 대조는 현재 소스에서 해소됐고, 새 혼합 partial 및 활성 I/O 종료 문제를 위와 같이 확인했다. 부분 관측은 synthetic `/proc`, 종료는 실제 daemon+로컬 transport fixture다.
- 이번 Reviewer는 제품 코드·과거 handoff·실제 HA를 변경하지 않았고 VM/image build/실제 Supervisor·ARM/외부 Git/배포는 NOT RUN이다.
- Executor는 **`FIX_09_REPORT.md`를 새로 작성**하고 실제 명령·fixture·측정 결과·잔류 회수·변경 파일·미검증 경계를 기록한다. 기존 REPORT는 보존하며 FIX_08_REPORT의 “모든 요구 완전 충족/30초 종료 보장” 및 행렬의 실제보다 강한 PASS는 새 보고서와 현재 문서에서 정정한다. memory/PATH 경고 영향 분류 공백도 유지한다.
- 새 후보는 미게시 `0.7.2-dev.2`를 유지할 수 있다. 수정·VM 검증·재리뷰 후 사용자 실기기 시험으로 넘어갈 때는 **0.7.2-dev.2 exact 배포**와 CI/SBOM/Critical gate·서명/provenance/SPDX·익명 digest 검증을 수행한다. 기존 tag/image를 덮어쓰지 않으며 stable 승격이나 운영 세션의 즉시 변경 승인은 아니다.

## 공식 참고 자료 (2026-10-26 조회)

- [Node.js 24 HTTP request.setTimeout](https://nodejs.org/docs/latest-v24.x/api/http.html#requestsettimeouttimeout-callback): socket timeout 동작 확인. 전체 작업/종료 상한은 별도 설계와 측정이 필요하다.
- [Home Assistant App 설정](https://contributors.home-assistant.io/apps/reference/configuration/): `timeout`은 Supervisor가 컨테이너를 강제 종료하기 전 기다리는 시간이다(기본 10초, 10–300초 범위). 선언값 자체는 정상 종료 성공 증거가 아니다.
