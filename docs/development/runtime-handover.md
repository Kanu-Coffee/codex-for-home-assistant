# 작업 기준 런타임 전환 — 로컬 구현 및 검증

기준일: 2026-10-30. DEV `0.7.3-dev.4`는 공개 배포됐다. HAOS 실기 수용은 하지 않았다.

## 현재 구현

새 wrapper로 시작한 대화형 CLI/TUI와 기본 JSONL Remote stdio는 lifecycle host를 거친다. frontend 연결·TUI를 유지하면서 실제 작업 worker만 교체한다. 프로세스·loaded 대화가 있다는 이유만으로 정상 관리형 세션의 적용을 보류하지 않는다.

- `codex-activity.mjs`: 요청·queue·승인·turn gauge, 전체 loaded/thread 상태와 background pagination 관측. 필수 관측 실패·중복/malformed gauge·신원 불일치는 unknown으로 구분한다. lazy gauge의 누락은 sole-client host ledger와 결합한다.
- `codex-session-host.mjs`: 요청/응답·turn·approval·process lifecycle 및 goal 상태 추적, 입력 barrier, 교체·동일 영속 thread 복원·빈 ephemeral 매핑, backpressure. Unix WebSocket은 기존 image-pinned `ws`를 사용한다. 완결 JSONL을 먼저 소비하고 대형 frame 한도 초과·malformed frame은 명시적 오류로 종료한다.
- wrapper: CLI는 공식 `--remote unix://...` frontend, 기본 `app-server`는 JSONL adapter로 실행한다. help/version은 단발 실행한다. admission lock 실패 시 baseline으로 우회 실행하지 않고 기다린 뒤 실패를 명시한다.
- runtime manager/transaction: 관리형 host와 child identity를 검증한다. 모든 대상 barrier 확보→재검사→graceful drain→후보 시작/복원→identity/readiness→commit→입력 재개 순서를 적용한다. 부분 실패와 불확실 복구는 journal을 남긴다.
- 기존 daemon의 `applyUpdate` 호출에 연결되어 자동/수동 적용이 동일 경로를 사용한다. 기존 슬롯·재시도 예산·24시간 cooldown, package integrity·policy gate는 유지한다.

과거 구현 중 검토한 lifecycle/transaction과 회귀를 재사용했다. 롤백 당시 전송부를 그대로 되살리지 않고 pinned `ws`로 교체했으며, 공식 worker를 사용한 후속 요청 시험을 추가했다. 실제 command/exec 완료 응답과 process/exited, serverRequest/resolved 및 goal clear/limit 상태가 해소된 뒤에는 이전 작업 때문에 계속 보류하지 않는다.

## 실행한 검증

| 검증 | 결과와 한계 |
| --- | --- |
| 전체 pytest | **286 passed, 5 skipped**, 113.10초. skipped는 별도 실제 binary opt-in 4사례와 기존 환경 의존 시험 1사례 |
| 공식 pair 통합 | **3 passed**. 0.162.1→0.165.0, stdio·Unix WebSocket·실제 PTY TUI 각각 첫 응답→자동 apply 경로→worker PID/exe 교체→같은 대화 다음 응답과 이전 문맥 포함 검사. stdio/WebSocket은 응답 지연 중 적용 보류도 검사 |
| 전송 wire probe | 공식 baseline/후보 각각 HTTP Upgrade/initialize와 종료 확인. 이전 실패의 원인은 raw proxy에 JSONL을 보낸 규약 오류였음 |
| activity와 실패 복구 회귀 | 전체 suite에 포함. 대형 JSONL·UTF-8·partial frame·WebSocket, 죽은 worker/ID 재사용·barrier·복원 실패·빈 ephemeral·작업 해소를 검사 |
| amd64 Docker build | **PASS**, 로컬 `codex-ha:task007`, App label `0.7.3-dev.4` |
| 이미지 actual wrapper 통합 | `/usr/local/bin/codex`→manager.applyUpdate→신규 공식 worker→동일 대화 후속 응답 **PASS**. 아래 진단 조건에 한정 |
| 정적 검사 | Node syntax, ShellCheck, actionlint, Hadolint, 변경 Markdown 14개, `git diff --check` PASS. 전체 pytest의 repository secret 검사를 포함 |

정확한 테스트 파일은 `tests/test_codex_live_handover.py`, `tests/test_codex_wire_probe.py`, `tests/test_codex_activity.py`, `tests/test_codex_update_fix03.py`, `tests/codex-live-handover.mjs`다. Python pair 시험은 환경변수 `CODEX_HANDOVER_BASELINE`, `CODEX_HANDOVER_CANDIDATE`를 실제 공식 binary 경로로 지정해 실행한다.

baseline archive는 GitHub release의 SHA-256 `a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3`을 검증했다. 후보는 기존 로컬 공식 0.165.0 package를 사용했고 binary SHA-256은 `c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5`이다. 이번에 후보 archive 전체의 공식 checksum 재검증을 수행한 것은 아니다.

## 시험 중 문제와 해결

1. 기존 relay의 직접 WebSocket framing을 pinned `ws`로 교체했다. JSONL과 WebSocket 규약을 구분하는 실제 binary probe를 유지했다.
2. 후보 resume 직후 잠깐 진행되는 bootstrap 작업을 spawn 성공으로 혼동하지 않도록 admission을 유지한 readiness 대기를 추가했다.
3. `/tmp` quota 초과는 직접 만든 이전 pair fixture 패키지 복사본만 정리하고 pair 시험을 저장소 시험 디렉터리로 옮겨 해결했다.
4. 긴 pytest fixture 경로가 Unix socket 길이 제한을 넘는 문제는 짧은 `/tmp/ha007-check` basetemp로 검증했다. 제품의 private `/run/codex-ha/...` 경로에는 해당하지 않는다.
5. 테스트 YAML scan이 이전 보안 fixture의 FIFO를 열어 멈추는 문제를 수정했다. Git 제외 시험 산출물·환경·node_modules를 scan에서 제외하고 일반 파일만 읽는다. 제품 소스의 secret 검사는 유지한다.
6. 컨테이너 fixture의 package copy가 권한과 symlink target을 변경하는 문제를 수정했다. 이미지 내 복사본만 owner/mode를 맞추고 상대 symlink를 보존한다. 실제 integrity gate를 완화하지 않았다.

## 실기 검증 공백과 지원 경계

현재 호스트에서는 기본 Docker sandbox 실행이 namespace 권한 및 `RTM_NEWADDR` 제한에 걸렸다. 실제 wrapper 컨테이너 통합은 **진단용** `NET_ADMIN`/`SYS_ADMIN`, seccomp/AppArmor unconfined 조건에서 수행했다. 이는 제품 권한 변경이나 HAOS 보안 수용 증거가 아니다. App manifest에는 이 권한이나 금지 옵션을 추가하지 않았다. 호스트 정책에 필요한 profile이 없어 `tests/codex-update-smoke.sh`도 시작에 실패했으며 PASS로 기록하지 않는다.

호스트 pair 시험과 이미지 fixture는 handover를 분리하기 위해 기존 `policyProbe` 주입 지점에 성공 stub을 사용한다. 제품 실행의 실제 AppArmor/requirements policy probe는 그대로 유지한다. 따라서 실제 정책 gate를 통과한 scheduler 전체 슬롯 E2E, HAOS/Supervisor, 물리 mobile Remote와 native ARM 수용은 **NOT RUN**이다. HAOS VM은 이번에 설치하지 않았다. 공개 DEV 배포와 실기 수용은 구분한다.

- 구형 wrapper로 직접 실행한 세션과 외부 `--remote`는 자동 교체 대상이 아니다. 새 관리형 세션으로 옮길 때 한 번 정상 종료해야 한다.
- 내용 있는 비영속 ephemeral은 임의 빈 대화로 바꾸지 않고 복원 미지원 이유로 전환을 보류한다. 일반 영속 대화와 검증된 빈 ephemeral은 복원한다.
- 오래된 frontend와 모든 미래 backend 조합, 새로운 미지원 lifecycle/schema, 비가역 DB migration까지 호환을 보장하지 않는다. 관측·복원 불가 상태는 명시적으로 보류한다.
- crash로 남은 불완전 transaction journal은 자동으로 삭제하거나 입력을 재실행하지 않는다. 자동 crash recovery는 아직 구현하지 않았고 복구 확인이 필요하다.
- 사용자 작업 자체가 계속 이어지거나 예산/cooldown이 남으면 다음 허용 검사까지 기다린다. 업데이트를 위해 작업을 강제 중단하지 않는다.

## 다음 운영 수용

격리 HAOS에 후보를 설치한 뒤 AppArmor·requirements 유지 상태에서 실제 CLI/Remote 유휴 연결의 교체, tool/approval/queue 중 보류, 다음 동일 대화 요청, App restart 후 인증·SSH key·browser·memory 보존을 검사한다. 실제 운영 HA는 변경하지 않았다.
