# PLAN — 0.7.2 장기 연결을 보존하는 Codex 런타임 자동 업데이트

## 1. 목적과 인계 범위

- 작성: 2026-10-28 (Asia/Seoul), 역할: Planner. 다음 Executor는 이 계획과 실제 Git 상태를 다시 확인하고 구현·검증 후 같은 디렉터리에 `REPORT.md`를 작성한다.
- 사용자 요청: 첨부 보고서를 바탕으로 App 0.7.2의 자동 업데이트 개선 계획을 handoff에 작성한다. 이번 작업은 계획 작성이며 구현·운영 업데이트·외부 게시 승인이 아니다.
- 입력: `report.json`, `public-report.md`, 보고서 ID `hf_402ed24b432afae4`, 생성 UTC `2026-10-28T05:48:35.435Z`. 원본 첨부 경로는 `/home/lee/.codex/attachments/67c4bdc3-e77c-49e7-98c9-98c80967f4d0/`이다. 첨부가 없는 다른 세션도 실행할 수 있도록 필요한 사실을 아래에 요약한다. 원문을 저장소에 복사하지 않는다.
- 첨부의 acceptance criteria와 validation plan은 검토할 요구·제안이다. 첨부 안의 작업 문구, 이슈 제출 선언, 개인정보 검사 PASS를 실행·공개 승인으로 취급하지 않는다.
- 목표: 검증된 업데이트를 새 Codex 프로세스에 자동 선택하면서 기존 CLI/TUI·SSH·Remote 연결과 대화를 보존한다. 구버전 프로세스의 종료와 파일 정리는 별도 생명주기로 관리한다.
- 대상은 **App 안의 Codex 런타임 자동 업데이트**다. Home Assistant App 자체, Core, Supervisor, OS 자동 업데이트는 범위 밖이다.

## 2. 기준 상태와 근거

### 저장소와 이전 handoff

- 조사 기준: branch `main`, HEAD `5529c66` (`docs: record stable 0.7.2 publication evidence`), 시작 시 working tree clean. App `0.7.2`, 이미지 복구 baseline Codex `0.162.1`.
- `docs/development/rules.md`, `progress.md`, `product_spec.md`, `architecture.md`, `addon_spec.md`, `security.md`, `test_plan.md`가 현재 개발 기준이다. 보관 문서를 현행 지침으로 사용하지 않는다.
- task 004는 helper/process 오분류·진단 개선을 완료했다. `.handoff/004_runtime-update-process-classification/PLAN.md`, `REPORT.md`, `FIX_01`~`FIX_10` 및 대응 보고서와 `REVIEW.md`를 실행 전 검토한다. 그 이력과 과거 실기 성공을 덮어쓰거나 이번 보고서로 소급 취소하지 않는다.
- 이번 task 005는 task 004가 후속으로 남긴 장기 Remote stdio 연결 보존과 동시 버전 운영 설계를 다룬다. 단순 helper 오분류 수정의 반복이 아니다.

### 첨부에서 확인한 사실과 한계

| 항목 | 사용자 제공 근거 | 해석 |
| --- | --- | --- |
| 환경 | App 0.7.2, bundled/selected/running Codex 0.162.1, amd64, Core/Supervisor 2026.10.4, HAOS 18.3 | 한 장비의 보고이며 전체 설치의 공통 장애로 확대하지 않음 |
| 증상 | staged update에 CLI·Remote stdio blocker가 보고됨 | 장기 연결에 따른 적용 보류이며 다운로드 실패 근거는 없음 |
| 현행 정책 | CLI·stdio는 종료 대기, 관리형 socket 서버는 loaded conversation 부재와 idle 진단 요구 | 연결 유지만으로 장기 보류 가능 |
| 기대 | 기존 연결·활성 turn 보존, 안전하면 새 세션에 신버전 사용, selected/running·정리 보류 구분 | 새 프로세스 선택과 기존 프로세스 교체를 분리할 필요 |
| 증거 한계 | 전체 PARTIAL, 제안 구현 NOT_TESTED, 동시 버전 안전성 미검증 | 개선 구현 또는 실기 성공을 선언할 수 없음 |

보고서에는 staged 후보의 정확한 버전·digest·전체 상태가 없다. 임의로 최신 버전 번호를 정하거나 `0.162.1 → 특정 버전` 성공을 가정하지 않는다. `refresh_all`, approval `never` 같은 보고 옵션은 재현 조건이며 제품 기본값 변경 요구가 아니다.

### 코드에서 확인한 구조

- `codex-runtime-manager.mjs`: `applyUpdate()`는 exclusive admission gate 안에서 세션을 검사하고 CLI/Remote blocker가 있으면 `pending_busy`/`paused_busy`로 반환한다. idle managed server만 있으면 cooldown과 검증을 거쳐 기존 restart transaction을 실행한다.
- `/usr/local/bin/codex`: shared admission gate 안에서 `resolve`로 immutable generation 경로를 확정하고 PID/start-time·exe·version을 등록한 뒤 실행한다. mutable `current` 경로로 exec하지 않는 기반이 이미 있다.
- `cleanupOldReleases()`: current/previous/staged와 `/proc`의 exe/cwd/fd/maps/cmdline 참조를 보존하며 관측 실패 시 삭제를 보류한다. 다만 호출 시점·등록 후 exec 전 경합과 지연 resource 재열기는 추가 검증이 필요하다.
- `getStatus()`에는 selected/running 버전과 관측 완전성 구분이 이미 있다. 새 병행 상태와 호환되는 의미를 정의하고 기존 필드를 재활용한다.
- `codex-updater-daemon.mjs`: 일 4회 조회, pending 5분 재확인, 일별 idle 검사 12회 예산·날짜 회복, abort 가능한 종료 흐름이 있다. 정리 재시도를 위한 별도 경로는 조사·보완 대상이다.

### 최신 공식 자료 확인

2026-10-28 다음 공식 문서를 실제 열어 확인했다.

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): 프로세스 초기화, thread/turn 구분, loaded thread 조회와 실행 버전별 schema 생성을 설명한다. 문서가 같은 `CODEX_HOME`의 서로 다른 버전 동시 실행·DB 역호환·기존 SSH 연결의 무중단 교체를 보장하는 것은 아니다. 정확한 baseline/후보 바이너리의 schema·공식 해당 버전 소스와 격리 시험으로 확인한다.
- [Home Assistant App configuration](https://contributors.home-assistant.io/apps/reference/configuration/): App version/image, mount/API 권한과 Supervisor 설정의 기준이다. 이번 설계를 App image 자동 갱신과 혼동하거나 새 권한 요구로 확대하지 않는다.

Executor는 구현 시 최신 공식 자료와 실제 후보 버전을 다시 확인하고 URL·조회일·version/digest를 REPORT에 기록한다. 현재 공식 문서의 새 필드를 0.162.1에 그대로 적용하지 않는다.

## 3. 설계 결정과 필수 안전 조건

### A. 새 프로세스 선택과 기존 연결 보호를 분리

1. `stage → 검증 → 새 실행용 current 선택 → 구버전 참조 보존 → 안전한 정리`를 별도 단계로 만든다. 선택 성공은 모든 프로세스의 신버전 전환을 의미하지 않는다.
2. 기존 프로세스는 시작할 때 확정한 generation으로 계속 동작한다. 기본 자동 경로에서 연결 종료·signal·server replacement·App restart를 사용하지 않는다. 오래 열린 idle 연결이 있어도 안전성 gate를 통과하면 새 프로세스는 신버전을 사용한다.
3. **새 세션의 경계를 명확히 한다.** 새 wrapper 실행/새 stdio 서버는 새 generation을 선택한다. 기존 socket app-server 안에서 새 thread를 만드는 것은 같은 서버 프로세스를 사용하므로 구버전을 계속 사용할 수 있다. 기존 tmux TUI 재접속도 새 프로세스가 아니다. 기존 socket 탈취나 새 thread의 강제 이관을 구현하지 않는다.
4. 실행 중 작업을 무시해서 적용을 허용하지 않는다. 검증된 두 generation의 공존이 안전함을 입증한 경우에만 기존 turn을 그대로 둔 채 새 실행 선택을 허용한다. 이 조건을 증명하지 못하면 현행 보류를 유지한다.
5. CPU 사용량·최근 입력 시각·프로세스 수로 idle을 추정하지 않는다. 기존 stdio에 진단 RPC를 끼워 넣지 않고 대화 내용·thread ID·전체 argv를 수집·공개하지 않는다.

### B. 호환성 gate: 구현의 선행 조건

- 실행 파일의 고정 경로만으로 격리를 보장하지 않는다. `/data/codex`의 SQLite/schema migration, rollout/session 형식, auth refresh/token 저장, config·cache·lock·MCP/plugin 상태 및 helper/resource 탐색이 공유되는지 baseline과 후보의 공식 소스·실행으로 조사한다.
- 현재 패키지의 기존 모든 running generation과 후보 사이에 공존·신규 시작·구버전 후속 turn·재연결/재개·선택 rollback이 가능한지 확인한다. A→B 이후 A가 남은 채 B→C가 들어오는 경우도 포함한다. baseline 하나와의 호환성만으로 모든 버전을 허용하지 않는다.
- 호환성 근거는 정확한 version/target/digest와 필요한 저장소 형식 조건에 결합한다. `latest stable`, SemVer 크기, checksum PASS, `--version` 성공, 현재 문서의 API 존재만으로 자동 허용하지 않는다.
- 네트워크 없이 판정 가능한 최소 compatibility capability/allowlist 계약을 설계한다. 이미지에 검증된 범위 밖의 후보는 `compatibility_unverified`로 보류하고 모든 세션이 종료된 기존 안전 경로로 진행한다. 임의 미래 버전까지 무조건 공존 허용하지 않는다.
- shared-home 안전성을 입증하지 못하면 무단 home 복제·auth/session 이관을 도입하지 않는다. 필요한 격리 설계와 근거를 REPORT에 남기고 해당 조합은 fail closed한다. 모든 세션 종료 후에도 비가역 migration 때문에 binary rollback이 불가능하면 그 한계와 복구 절차를 명시한다.
- 최소 하나의 실제 검증된 신구 버전 조합에서 보고 시나리오를 해결해야 구현 목표 달성이다. 스파이크만 완료하고 자동 업데이트 개선까지 완료라고 쓰지 않는다.

### C. 선택 transaction·정리·복구

- exclusive gate에서 후보 inventory/digest/architecture/containment, `--version`, managed requirements와 정책 probe를 재검증하고, 실제 프로세스 inventory와 등록 record를 재관측한 뒤 선택한다. unknown identity, 미완전 관측, 호환성 미확인, 검증 실패는 선택을 보류한다.
- shared gate의 wrapper는 경로 확정부터 유효한 generation pin/등록까지 보호한다. 등록 직후 exec 전, PID 재사용, fork/companion, 손상·stale record 및 lock timeout/baseline fallback 경로도 삭제 경합이 없게 한다. 직접 실행 경로의 잔여 위험도 기록한다.
- current/previous/staged와 state journal 갱신은 중간 kill·전원 단절·daemon 재시작에도 재조정 가능하게 한다. 상태 저장 실패를 성공으로 기록하지 않고, 선택 후 검증 실패는 이전 선택으로 복구한다. 기존 세션을 rollback 대상으로 종료하지 않는다.
- 세션 pin과 `/proc` 참조를 함께 사용해 사용 중인 generation 전체와 companion/resource를 보존한다. 나중에 열릴 resource도 실행 종료 전 삭제하지 않는다. 검사 오류는 삭제 보류이며 세션 종료 추정으로 처리하지 않는다.
- selected/previous/staged/baseline과 실행 중 generation을 보존한 후에만 미참조 release를 정리한다. 예: A 실행 중 A→B→C 선택 뒤 A는 previous가 아니어도 유지되어야 한다.
- selection 성공 뒤 staged가 없어져도 자연 종료 후 GC를 다시 실행할 수 있게 bounded local maintenance를 설계한다. 기존 5분 로컬 cadence를 재사용하고, GC를 위해 원격 release를 다시 조회하지 않는다. 자동 업데이트 OFF에서는 새 선택을 하지 않으며 GC 실행 여부는 명시적 계약으로 정하고 테스트한다.
- 디스크/보존 generation 한도와 공간 부족 reason을 정한다. 한도 초과 시 다음 staging/선택을 보류하고 살아 있는 generation을 강제 삭제하지 않는다. staging과 비활성 generation 정리로만 공간을 회수한다.

### D. 스케줄·정책·관측 계약

- 일 4회 조회·시간대·중복 slot 억제·pending 5분·일별 12회 제한과 수동 재검사를 유지한다. 병행 선택 가능 후보가 ‘이미 세션 존재’ 또는 과거 예산 소진만으로 계속 보류되지 않도록 선택 자격을 먼저 판정한다. 호환성 미확인 후보는 기존 busy 예산을 유지한다. GC 보류는 idle 예산을 소모하지 않는다.
- 기존 rolling 24시간 cooldown은 실제 server replacement에만 해당한다. 새 프로세스 선택에 그대로 적용해 다시 장기 보류를 만들지 않는다. 기존 교체 기능을 남기면 별도 명시적 경로와 기존 보호 조건을 유지하고 자동 경로에서 호출되지 않음을 검증한다.
- status JSON/text는 bundled/selected/running versions, running observation, staged, selection 완료, 구버전 유지 수·정리 보류 이유, 다음 재시도 시점을 구분한다. 필드·closed reason code는 소비자 조사 후 결정하고 기존 key와 의미를 무단 삭제하지 않는다.
- `applied`는 ‘새 프로세스용 선택 완료’라는 계약으로 문서화한다. 구버전이 실행 중일 때 ‘모두 최신’으로 표시하지 않는다. `currentVersion` 호환 필드와 selected의 관계도 명시한다. 관측 실패를 running 없음으로 바꾸지 않는다.
- `ha-feedback`·MOTD 등 상태 소비자도 확인한다. 공개 상태에는 allowlist 버전·count·reason만 포함하고 경로·socket·대화·인증 원문을 새로 노출하지 않는다.
- `/config` RW, Core/Supervisor manager, network-enabled workspace-write, 민감 경로 deny, credential 비상속, checksum/inventory 검증을 유지한다. `admin`, `docker_api`, `full_access`, `host_network`, `apparmor: false`, SIGKILL/전체 프로세스 kill, 신규 외부 listener를 도입하지 않는다.
- `codex_user_files_update_mode=refresh_all`이어도 Codex 런타임 선택은 App version 갱신이 아니다. 사용자 AGENTS/config/auth/session/SSH/browser identity를 초기화하거나 refresh 기록을 소비하지 않는다.

## 4. 구현 순서와 관련 파일

| 단계 | 작업과 산출물 | 주요 파일 |
| --- | --- | --- |
| 1 | 보고 재현 회귀를 먼저 추가하고 version pair·공유 상태 위험·호환성 gate를 확정 | `tests/test_codex_update_contract.py`, 실제 binary 격리 fixture, REPORT의 spike 근거 |
| 2 | 선택 자격과 기존 프로세스 교체 자격을 분리하고 immutable generation transaction·journal 복구 구현 | `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs` |
| 3 | launch pin/등록 경합·fallback·다세대 GC·공간 한도·독립 정리 재시도 구현 | `codex_home_assistant/rootfs/usr/local/bin/codex`, 같은 share 디렉터리의 `codex-updater-daemon.mjs` |
| 4 | 기존 server transaction의 자동 호출 차단/분리와 상태·CLI·feedback 소비자 정합성 검증 | `codex-server-transaction.mjs`, `/usr/local/bin/ha-codex-update`, status 소비자 |
| 5 | 실제 amd64/aarch64 바이너리 및 AppArmor 환경 회귀, 0.7.2 영속 상태 migration 검증 | `tests/codex-update-smoke.sh`, `tests/update-smoke.sh`, 기존 native CI workflow |
| 6 | 새 동작·한계·복구와 실기 수용 절차를 양언어 문서에 반영 | 아래 문서 목록과 `REPORT.md` |

문서 변경은 구현과 같은 단위로 수행한다. `rules.md` R-403과 `product_spec.md` FR-021의 ‘모든 세션 종료/idle 후 선택’은 새 정책과 충돌하므로 ‘검증된 병행 선택’과 ‘기존 프로세스 교체’의 조건으로 함께 고친다. `architecture.md`, `addon_spec.md`, `security.md`, `test_plan.md`, `progress.md`, 루트·App 한국어/영어 README, `DOCS.md`/`DOCS.en.md`, `CHANGELOG.md`를 검토·수정한다. 기존 handoff 및 image 런타임 `AGENTS.md`를 개발 지침으로 오인하지 않는다.

새 App 옵션·baseline 상향·버전 bump·Home Assistant API mutation은 기본 범위가 아니다. 현행 0.7.2 이미지의 updater 코드는 이 계획만으로 바뀌지 않는다. 개선 코드를 설치하려면 별도의 App 배포가 필요하며 그 게시·운영 적용은 후속 사용자 승인 범위다.

## 5. 수용 기준과 회귀 행렬

모든 행은 Executor가 결과·실제 명령·version/digest·환경을 기록한다. 계획 시점에는 아래 구현 시험 전부 **NOT RUN**이다.

| 시나리오 | 필수 결과 |
| --- | --- |
| 연결만 유지한 CLI/TUI·Remote stdio + 호환성 검증 후보 | 자동 scheduler 경로에서 새 선택 성공, 기존 PID/start-time·연결 유지, 새 wrapper는 후보 실행 |
| 신구 버전 공존 후 기존 idle 연결에 다음 요청 | 기존 연결에서 정상 turn 완료, 동일 대화 유지, 정책·tool/helper/resource 정상 |
| active turn/approval/user-input 대기/background command/goal·queued work | 기존 작업 중단·signal 없음. 공존 안전성을 입증한 조합만 새 선택, 그 외 명시적 보류 |
| 기존 managed socket에 loaded conversation + 별도 신규 프로세스 | socket·대화 보존, 기존 서버의 새 thread는 구버전 가능, 별도 wrapper는 신버전. endpoint 탈취 없음 |
| unknown exe/owner·관측 EACCES·위조 record·PID 재사용 | fail closed, 선택 또는 삭제 금지와 정제된 이유 표시 |
| 후보 checksum/architecture/tree/policy probe 실패 | current와 기존 세션 보존, 자동 재시도 폭주·baseline 우회 없음 |
| 병행 호환성 미확인 후보 | 이유를 표시하며 현행 보류 유지, 모든 세션 종료 후 기존 검증 적용 경로 정상 |
| A 실행 중 A→B→C, helper만 잔류, 지연 resource open | A 전체 보존, current/previous/staged 보존, 마지막 참조 소멸 뒤 bounded GC |
| 선택과 wrapper 등록/exec·GC 동시 실행, fallback launch | 삭제된 경로 exec나 미보호 세션 없음, timeout bounded, 실행 바이너리 일치 |
| symlink 전환·journal/previous 갱신 중 장애와 재부팅 | 선택/state 일관성 복원, 실패를 성공으로 표시하지 않음, 인증/설정/session 보존 |
| 선택 후 실행 검증 실패·공유 상태 접근 뒤 rollback | 이전 선택 복원 및 신구 후속 turn/재개 검증. migration 역호환 실패는 지원으로 선언하지 않음 |
| 예산 11/12/소진·날짜/시간대 변경·cooldown 존재 | 검증된 병행 선택 진행, 미확인 후보 제한 유지, 반복 원격 조회 없음, GC가 예산 미소모 |
| auto-update OFF/invalid options, 수동 apply | 자동 선택 없음, 수동 경로도 identity/integrity/policy/compatibility 보호 유지 |
| 디스크 부족·보존 한도·GC 관측 실패 | 안전한 보류, 실행·복구 package 강제 삭제 없음, 상태에 이유 표시 |
| status/feedback JSON·text, running 일부 미관측 | selected와 running 다름을 정확히 표시, cleanup 보류와 apply 보류 구분, 개인정보 미포함 |
| App 0.7.2 persistent state와 refresh_all 보존 | user-file 재초기화 없음, runtime state migration·자동 스케줄·auth/SSH/browser/memory 회귀 정상 |

## 6. 검증 실행 지침

1. 실행 전 Git diff/status와 적용 지침을 다시 확인하고 기존 사용자 변경을 보존한다. 현재 호환성 미검증 항목을 먼저 좁힌다.
2. 저장소 기존 환경·CI 명령을 사용한다. 현재 로컬에는 `.venv/bin/python`이 있다. 우선 `.venv/bin/python -m pytest -ra tests/test_codex_update_contract.py`로 관련 회귀를 검증하고, 구현이 끝나면 `.venv/bin/python -m pytest -ra`를 실행한다. 모의 process fixture만으로 실제 신구 Codex 호환성을 PASS 처리하지 않는다.
3. 실제 공식 package를 checksum으로 고정한 disposable `CODEX_HOME`과 합성 대화·가짜 인증 자료로 mixed-version 시험을 한다. 실제 사용자 auth·대화·HA 설정을 복사하지 않는다. 실제 inference가 필요한 검증은 승인된 별도 시험 계정/환경에서 수행하며 미실행이면 NOT RUN으로 남긴다.
4. 기존 native amd64/aarch64 CI·build와 `tests/codex-update-smoke.sh`, `tests/update-smoke.sh` 및 관련 full/managed-sandbox/user-files smoke를 수행한다. 이미지명·build 명령은 현행 CI를 따른다. 실제 AppArmor 활성 환경에서 후보 정책·프로세스 관측·resource 실행을 확인한다. Docker 불가/host nested sandbox 제한은 실패·미실행 사유로 기록한다.
5. 바뀐 shell은 ShellCheck, YAML/workflow는 기존 YAML lint·가용한 actionlint, Markdown은 기존 markdownlint, JS는 Node syntax, 비밀 노출은 기존 scan을 사용한다. `git diff --check`와 최종 diff를 검토한다. 이력이 불변인 `.handoff/` 전체를 lint 수정하지 않는다.
6. HAOS 수용은 별도 승인 후 수행한다. 0.7.2에서 개선 App으로 정상 업데이트한 뒤 idle Remote 연결을 유지하고 자동 슬롯/재시도로 selected 전환, 기존 대화 다음 turn, 신규 Web/SSH 프로세스 버전, 재연결·resume·자연 종료 후 GC와 auth/data 보존을 확인한다. App 설치 업데이트 자체는 기존 컨테이너 세션을 종료할 수 있으므로 ‘런타임 선택 시 연결 보존’ 시험과 구분한다.
7. HAOS amd64/aarch64, ChatGPT mobile Remote 실제 client, 장시간·다세대 보존 및 crash/reboot 결과는 로컬/CI 결과와 분리한다. 기존 0.7.0 ARM 위험 수용을 새 lifecycle 변경에 자동 적용하지 않는다. 테스트 목적으로 운영 기기 제어·운영 장애 주입·강제 종료를 수행하지 않는다.

## 7. 완료 조건과 Executor 보고

- 검증된 실제 버전 조합에서 장기 idle 연결이 있어도 **수동 apply 없이 자동 경로로** 새 프로세스용 선택이 진행되고, 기존 연결의 후속 작업과 신규 프로세스의 신버전 실행이 모두 확인되어야 한다.
- identity/policy/integrity·공유 데이터 호환성·admission/GC 경합·rollback 행렬을 충족하고, 미지원 조합은 명시적 fail closed로 남긴다. 지원 범위를 구체적인 버전/아키텍처/상태 조건으로 밝힌다.
- `REPORT.md`에 변경 파일, 실제 명령/결과, version/target/digest, compatibility 결정 근거, migration/rollback 한계, GC/공간 정책, 계획 대비 변경, NOT RUN/PARTIAL, HAOS 수용 대기와 다음 작업을 기록한다. 민감 원문은 넣지 않는다.
- `progress.md`와 사용자 문서를 실제 상태로 갱신한다. 자동화된 로컬 검증, 사용자 제공 실기 증거, 직접 수행한 실기 증거를 구분한다.
- Reviewer가 correction이 필요하다고 판단하면 다음 `FIX_NN.md`만 새로 작성한다. Executor는 아직 대응 보고서가 없는 최고 번호 correction만 수행한다. 본 PLAN과 과거 handoff를 덮어쓰지 않는다.
- 커밋·push·PR·release·운영 HA 변경은 이번 계획 작성 요청의 승인 범위가 아니다. 후속 구현 결과를 검토 가능한 로컬 diff와 REPORT로 전달한다.

## 8. Planner 단계 검증 범위

- 첨부 두 파일을 읽고 JSON과 공개 Markdown의 보고 ID·주요 요구·미검증 범위가 일치함을 확인했다.
- 저장소 현행 문서·updater/wrapper/GC·테스트 구조·이전 handoff 종료 근거와 Git 상태를 읽기 전용으로 조사했다. 공식 문서 링크를 조회했다.
- 이번 산출물은 PLAN과 progress의 계획 기록이다. 제품 코드·App version·runtime state는 변경하지 않으며 구현 테스트·Docker build·HAOS 시험은 수행하지 않는다. 문서 검사 결과는 `progress.md`에 기록한다.
