# FIX_15 — 상태표시 정리와 DEV 운영시험 배포

작성: 2026-10-29, Reviewer. 대상: HEAD `5529c66` 위 working tree 및 FIX_14_REPORT.

## 판정

**FIX_14의 제목 thread 차단 결함 해소를 인수한다. DEV 운영시험 배포 단계로 진행한다.** 이번에 새로 재현한 전환·문맥 유실 차단 결함은 없다. 아래 P2 표시 오류와 릴리스 준비를 같은 Executor 단계에서 마친 뒤 DEV를 게시한다. 새로운 lifecycle 재설계나 동일한 보완 라운드를 요구하지 않는다. Stable 승격이나 task 전체 수용 완료 판정은 아니다.

관리형 frontend가 생성한 임시 제목 thread의 명시적 unsubscribe 성공, idle 및 active turn 부재를 함께 확인하는 정리를 검토했다. 사용자 ephemeral 및 진행 작업 보호는 유지된다. 공식 baseline 소스의 temporary structured request가 완료 후 bounded best-effort unsubscribe를 수행하는 계약과 맞는다.

## 독립 검증

- 공식 0.162.1 frontend를 production relay의 `--spawn-client`와 PTY로 실행하고 localhost 합성 모델에 첫 요청을 보냈다. 유휴 전환에서 공식 0.164.0 worker로 PID와 exe가 변경되고 frontend가 살아 있으며, 다음 입력 이후 화면에 새 합성 응답이 나타났다.
- 별도 반복 시험에서 전환 후 다음 모델 요청에 첫 합성 메시지가 포함됨을 확인했다. 정상 사용자 persisted 대화의 문맥 보존을 직접 검사했다. Git 제외 증거: `.test-tmp/review006-fix12/review14-context.py`, `review14-context.log`.
- 없는 후보 executable을 주입하자 `rollbackStatus:restored`이며 같은 TUI의 후속 모델 요청 2건이 도달했다. 응답 완료까지는 해당 rollback probe가 검사하지 않는다. 증거: 같은 디렉터리 `review14-rollback.log`.
- 공식 stdio baseline→candidate 시험은 initialize, 첫 turn, 유휴 전환, 같은 thread read 및 다음 turn 수락을 통과했다. 다음 응답 완료·내용 보존을 모두 증명하는 시험으로 확대하지 않는다. 증거: `review14-stdio.log`.
- Node syntax 3개, wrapper ShellCheck 및 `git diff --check` 통과. 전체 pytest 최종 결과는 progress의 이번 Reviewer 기록을 따른다.

이는 control socket 직접 전환이다. wrapper→manager→scheduler→실제 frontend의 자동 슬롯 전체 경로, HAOS/mobile, native ARM 및 신규 Docker build는 이번 리뷰에서 수행하지 않았다. 이 공백을 숨기지 않고 DEV에서 운영시험한다. 내용 있는 사용자 ephemeral의 안전 보류 및 interrupted journal 자동 복구 미구현은 기존 제한으로 유지한다.

## P2 — 상태표시가 실제 실행 경로와 불일치

`codex-runtime-manager.mjs:2830`은 `sessions.canApply && restartableServers.length`만으로 `liveHandoverBlocked=true`를 만든다. `autoApplyReady`도 같은 서버가 하나라도 있으면 false이며 format 함수는 항상 migration unverified라고 표시한다. 반면 `applyUpdate`의 canAttemptRestart 분기는 해당 서버를 실제 전환한다. daemon은 이 표시 필드를 사용하지 않고 `applyUpdate`를 호출하므로 이번 결함은 자동 실행을 차단하지 않지만, DEV 운영시험에서 정상 유휴 상태를 실패로 오판하게 한다.

Executor는 다음 범위로 정리한다.

1. 서버 존재만으로 migration 차단을 표시하지 않는다. 실제 알려진 blocker·budget·cooldown·옵션·staged 상태에 맞춰 다음 자동 검사 자격을 표시한다. 사전검사 자격과 복원 성공 보장을 구분하며, 특정 thread의 복원 제한을 검증 없이 지원 완료로 표시하지 않는다.
2. 관리형 idle 서버가 있고 나머지 사전조건이 충족된 경우, busy/unknown, cooldown, budget 소진, journal 잔존을 대비하는 상태표시 회귀를 추가·갱신한다. 실제 전환 안전 gate를 삭제해 표시를 맞추지 않는다.
3. `rules.md` R-403, `architecture.md` §13, `security.md` 말미의 일괄 compatibility 보류·CLI 미구현 설명 및 `product_spec.md` FR-021의 CLI 정상 종료 필수 설명을 현재 개발 구현·검증 범위와 맞춘다. 과거 handoff는 보존한다. 양언어 설치 안내와 changelog도 릴리스 준비에 맞춰 검토한다.

## DEV 배포 지시

사용자가 허용한 DEV 실기 시험 범위에서 다음을 수행한다. 위 표시 수정 후 새로운 차단 실패가 없으면 별도의 반복 Reviewer 승인을 기다리지 않고 기존 배포 workflow로 진행한다. CI나 빌드 실패는 해결하고, 무관한 테스트 생략으로 통과시키지 않는다.

1. 현재 변경 전체와 untracked session host·회귀 테스트를 빠뜨리지 않고 릴리스 diff를 검토한다. `docs/development/releasing.md`의 DEV 절차를 따른다. Stable main metadata·기존 tag/image는 유지하고 DEV 채널로 게시한다.
2. 이 리뷰의 `git ls-remote --tags origin '0.7.*'`에서 stable 최대 `0.7.2`, DEV 최대 `0.7.2-dev.2`, `0.7.3-dev.1` 미사용을 확인했다. 기본 후보는 **0.7.3-dev.1**로 한다. 게시 직전 remote DEV metadata/tag를 재확인하고 더 높은 버전이 생겼으면 그보다 높은 미사용 번호를 택한다. 사용자의 설치 버전이 더 높다고 알려지면 그것도 넘겨야 한다. 같은 버전 재게시로 HAOS update 인식을 기대하지 않는다.
3. manifest, Docker BUILD_VERSION, Playwright package/lock, changelog, tag를 일치시키고 repository/App/panel/description/OCI/MOTD의 DEV 표식 및 `stage: experimental`을 맞춘다.
4. 로컬 전체 pytest·형식·ShellCheck·secret 검사 후 DEV 대상 PR/CI, native amd64/aarch64 build 및 기존 필수 smoke, tag Builder를 통과시킨다. 기존 서명·provenance·SBOM·공개 multiarch image 검증을 우회하지 않는다. PR 생성 시 task에 첨부한다. 운영 장치 변경이나 stable 승격은 하지 않는다.
5. DEV prerelease를 게시하고 `#dev` repository metadata, 정확한 version image·공개 접근·서명을 확인한다. 실제 HAOS Store 표시·설치는 사용자의 시험 전까지 NOT RUN이다. main 설치를 삭제하거나 #dev로 전환하라고 강제하지 않는다. source identity가 다르면 데이터 보존 전환은 별도 확인 대상이다.
6. `FIX_15_REPORT.md`에 source commit, 정확한 DEV version, PR/CI/Builder/Release URL, digest·검사 결과·미검증 항목 및 설치 절차를 기록한다. 배포 준비만 하고 게시 완료라고 쓰지 않는다.

## 사용자 운영시험 인수 항목

- DEV 설치 후 관리형으로 새 CLI/TUI와 mobile Remote stdio를 시작한다. 이전 image의 legacy 세션을 live 전환 지원 세션으로 간주하지 않는다.
- 연결·대화를 열어둔 채 실제 작업 없는 상태에서 허용된 자동 슬롯 또는 pending 재검사 후 기존 backend의 running exe/version 변경을 확인한다. selected만 변경된 결과는 성공이 아니다.
- 같은 대화에서 다음 응답과 이전 문맥 보존을 확인한다. 열린 창 자체는 보류 사유가 아니다.
- 응답 생성·tool·승인 대기·queued 작업 중에는 기존 worker를 유지하고, 완료 후 다음 허용 검사에서 적용되는지 확인한다. 24시간 cooldown과 일별 예산은 유지한다.
- 인증/SSH·Ingress 재접속, App 일반 restart 후 데이터 보존을 확인한다. 사용자 실제 장치의 기기 제어나 임의 재시작은 이 배포 지시에 포함하지 않는다.
