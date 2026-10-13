# FIX_04_REPORT — Executor 구현과 검증

- 날짜: 2026-10-13, Asia/Seoul.
- 대상: `.handoff/002_codex-auto-update/FIX_04.md`. PLAN/REPORT와 FIX_01~04 및 기존 보고서, 개발 규칙·관련 명세·현재 Git state를 확인했다. 기존 handoff는 수정하지 않았다.
- Git: `feat/codex-auto-update`, HEAD `a32698851e3c3539f5d4b823e60d4f0d29038df1`. 기존 미커밋 구현 위에서 수정했으며 commit/push/tag/release는 하지 않았다. main/stable·운영 HA는 변경하지 않았다.
- 상태: 구현·아래 로컬 검증 완료, 독립 Reviewer 인수 대기. DEV 발행은 인수 후 기존 사용자 승인 범위에서 진행할 다음 단계다.

## 구현 결과

1. `codex-package-integrity.mjs`: 검증 archive의 전체 파일 inventory(SHA-256, 목록, mode/type/link)를 executable tree 밖의 private `receipts`에 저장한다. Receipt/state는 file와 parent directory fsync를 수행한다. 기존 destination을 검증 extract와 비교하고, apply의 candidate digest 및 wrapper/init의 retained selection을 확인한다. 변조·누락·추가·manifest 변경·hardlink를 거부한다. Baseline은 고정 checksum의 image 자체를 신뢰한다. Root가 receipt와 package를 의도적으로 함께 변조하는 공격까지 격리하지는 않는다.
2. 손상된 동일 generation의 recursive 삭제·재생성을 제거했다. Relative current를 working directory 기준으로 해석해 잘못 삭제하던 경로도 없어졌다. 현재·이전·staged·실행 참조와 관계없이 invalid existing generation은 보존하고 staging을 거부한다.
3. Wrapper는 shared admission gate 안에서 검증된 immutable executable을 resolve한다. PID/start, version, executable, args, cwd, socket을 실제 JSON encoder로 기록한다. Quote/backslash가 들어간 socket을 실제 wrapper로 검증했다. FD 정리의 `exec` redirection이 Codex stderr까지 영구 폐기하던 문제도 수정했다.
4. `codex-server-transaction.mjs`: 마지막 process identity·version·idle 확인, 영속 cooldown 기록, SIGHUP drain, 실제 executable inode/version·RPC readiness 확인, 관리 record 갱신을 한 transaction으로 수행한다. 여러 replacement를 추적하고 실패하면 모두 drain한 뒤 이전 서비스의 실제 복구를 검증한다. Launch/readiness/restore/두 번째 서버 실패와 drain timeout을 검사했다. 미완료 drain이나 복구 실패는 `rollback_incomplete`이며 강제 종료나 반복 signal은 하지 않는다. Proc environ 복사는 없다.
5. `codex-policy-probe.mjs`: isolated HOME/CODEX_HOME에서 실제 image-managed config·requirements·MCP parsing, package companion, 일반 파일 RW, 보호 경로 open 거부, loopback HTTP와 app-server RPC/graceful 종료를 검사한다. 보호 content를 read()하지 않는다. 실제 enforce AppArmor·보호 target·sandbox·RPC를 확인할 수 없으면 `blocked_policy`로 차단한다. Socket 생성만으로 준비 완료를 판단하지 않고 RPC 초기화를 완료한 뒤 종료 신호를 보낸다.
6. HAOS Docker에서 APK system bubblewrap 0.12가 proc 초기화에 실패함을 재현했다. Chromium이 transitive dependency로 설치하는 `/usr/bin/bwrap`도 제거하여 검증 package의 bundled helper를 사용한다. 정확한 baseline/release/staging resource 실행에만 AppArmor child transition을 적용했다. Parent의 implicit 전체 execute는 기존 runtime 경로의 명시적 execute 규칙으로 바꿔 wildcard Cx 충돌을 해결했다. Parent mount 권한이나 추가 host privilege는 도입하지 않았다.
7. CI의 namespace profile 준비를 실제 Codex 호출 전에 배치하고 bundled helper attachment를 추가했다. Native amd64/aarch64 job 모두 실제 AppArmor updater smoke를 실행하도록 했다. CI 실행 자체는 이번 로컬 검증과 구분한다.
8. App 버전 `0.7.1`, bundled Codex `0.162.1`을 유지한다. Auto-update checkbox/timezone, 상태의 selected/bundled version 안내를 유지하고 한국어·영어 사용자 문서, changelog와 개발 명세/ADR/참조를 보완했다. Historical 버전 기록을 임의로 바꾸지는 않았다.

## 재확인·재시작 한도와 protocol 보정

- 예약 확인: 설정 시간대의 03/09/15/21시, 하루 4회.
- Busy 재확인: calendar date별 최대 12회. 상태 표시가 바뀌어도 같은 날짜의 한도를 넘지 않는다. 다음 날짜의 첫 예약 슬롯에서 budget을 초기화하고 동일 후보를 재개한다. Turn별·평생 카운터가 아니다.
- 서버 재시작: 최초 signal 전에 `nextRestartAllowedAt`을 영속 기록하는 rolling 24시간 cooldown. 실패·새 후보·container 재시작·수동 apply로 초기화하지 않는다. 수동 apply는 일일 idle budget은 재설정할 수 있다.
- 무결성·정책·복구 오류의 block은 blind retry 방지다. 원인을 해결한 후 수동 apply/update로 다시 검사한다. `rollback_incomplete`면 상태와 살아 있는 서버를 확인해 복구해야 하며 자동 강제 재시작 루프를 만들지 않는다.
- 공식 tagged source는 SIGHUP을 GracefulOnly로 처리한다. 반복 HUP으로 강제 drain하지 않는다: [app-server source](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/lib.rs).
- 실제 진단 요청 자체가 in-flight 1개이고, gauge는 최초 증가 때만 등록된다: [공식 시험](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/tests/suite/v2/server_diagnostics.rs), [registry 구현](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/diagnostics/src/lib.rs). 기존의 모든 gauge 필수/0 조건은 새 서버를 영구 busy로 판단했다. 필수 in-flight ≤1, 등록된 queue/turn =0, loaded threads 빈 배열을 요구하도록 보정했다. PID·필수 gauge·형식·RPC 오류는 fail closed다. 이 동작을 특정 future 설치 버전 allowlist로 막지 않는다.
- 실제 한도: compressed download **250 MiB**, extracted total **1 GiB**, **5000 entries**. 현재 실제 package의 압축 해제 크기가 250 MiB를 넘으므로 byte 한도를 분리했다. 이전 보고서의 500 entries/128 MB 표현은 현재 구현과 다르다.

## 실제 검증

최종 local image: `codex-for-home-assistant:fix04-test`.

Image ID: `sha256:e9e37e438d3f790b403a91ab08826426f74b56015c60591c9462a359ff85aab4`.

Build: `docker build --build-arg BUILD_ARCH=amd64 --build-arg BUILD_VERSION=0.7.1 -t codex-for-home-assistant:fix04-test codex_home_assistant` — exit 0. 동일 image를 개발 HAOS 18.2 VM의 Docker로 load하여 검증했다.

| 검증 | 결과 |
| --- | --- |
| `.venv/bin/pytest -q` | **189 passed in 48.85s** |
| 5000/5001 entries 실제 archive boundary | PASS |
| 6개 변조 × relative/absolute current, previous-only, staged-only, live executable, live resource reference | PASS, inode/path/실행 process 보존 |
| 실제 fixture process의 launch/readiness/restore/두 번째 서버 실패/drain timeout | PASS, PID/version/record와 process별 signal 최대 1회 확인 |
| ShellCheck, Hadolint, Actionlint, Yamllint, AppArmor parser, Node syntax, `git diff --check` | PASS |
| `gitleaks dir --no-banner --redact --exit-code 1 codex_home_assistant` | PASS, no leaks |
| `bash tests/docker-smoke.sh <final image>` | **exit 0**, ttyd/SSH/browser/Core·Supervisor fixture 포함 |
| `CODEX_TEST_APPARMOR=codex_ha_fix04 bash tests/codex-update-smoke.sh <final image>` | **exit 0**, 실제 custom AppArmor enforce·Codex package·PID 재시작 |
| `bash tests/update-smoke.sh ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.0 <final image>` | **exit 0**, auth/settings/keys/user files/memory/GitHub data 보존 |
| Managed sandbox / feedback / memory / managed auth / browser approval / user-files smoke | 각 exit 0, correction image `sha256:a21906f7fac882553080913ed23fffabae82e281fa3ffc66e4ff8b96af9736c1`에서 실행. 이후 delta는 diagnostics adapter·drain 실패 표시이며 최종 image의 위 3개 시험 및 unit regression으로 다시 검증 |

`codex-update-smoke.sh`는 실제 pinned baseline bytes를 local archive fixture로 재포장한다. Candidate resources/정책, 실제 wrapper 기록·JSON escaping, immutable executable, idle RPC, 실제 PID 교체와 graceful 종료를 확인한다. 더 최신 upstream release를 실제로 받아 운영 세션에 적용했다는 증거는 아니다.

HAOS Docker는 SSH Unix-socket forwarding으로 접근했고 테스트용 named volume에 synthetic `/config`만 만들었다. 전체 smoke의 guest loopback published port는 개발 호스트까지 별도 SSH forwarding하여 ttyd/SSH를 검사했다. Generic fixture smoke는 Supervisor와 같은 seccomp 전제 및 AppArmor unconfined fixture를 쓰고, updater smoke는 실제 수정 AppArmor를 고유 이름으로 load해 enforce 상태에서 별도로 검사했다. 사용자 운영 Core/Supervisor API·실제 config/auth 내용은 사용하지 않았다.

초기 image 시험의 system bwrap proc 실패, 실제 diagnostics 자기 카운트/미등록 gauge, socket 생성과 signal-handler 준비의 race를 실제 실행에서 발견해 수정했다. 테스트의 developer instruction 검사는 여러 message에 나뉜 내용을 join하여 검사한다. 빈 fixture config에서 보호 경로 preflight가 간헐적으로 거부되는 경우도 관측하여, full/update fixture는 초기화된 HA에 존재하는 synthetic secrets.yaml·.storage 구조를 준비하도록 보완했다. 보호 target이 없는 사용자 환경의 자동 apply는 계속 fail closed다. 이들은 pytest만으로 runtime PASS를 대신하지 않은 결과다.

## 남은 검증과 인계

- Native aarch64 build/runtime 및 수정 CI의 실제 GitHub run: **NOT RUN**. CI step은 추가하고 정적 검증했으며 기존 stable ARM 증거를 재사용하지 않았다.
- 사용자 운영 HAOS의 Supervisor App 설치·업데이트 인식, 옵션 checkbox UI, 실제 mobile Remote 및 활성 model turn 수용: **NOT RUN**, DEV 발행 뒤 사용자 시험 대상이다.
- Compressed 250 MiB/extracted 1 GiB의 exact byte boundary: **NOT RUN**. 실제 full package 수용 및 5000-entry boundary는 별도로 PASS했다.
- Markdown 전용 lint는 로컬 실행하지 않았다. 문서 diff와 YAML/workflow lint는 확인했다.
- 임시 test container/volume, 고유 AppArmor profile과 forwarding을 정리했고 개발 HAOS VM은 작업 전의 `shut off` 상태로 복원했다. 원래 개발 App과 production AppArmor file은 변경하지 않았다.
- 다음 Reviewer는 현재 working tree 및 본 보고서로 인수 여부를 판단한다. 인수 가능하면 기존 승인대로 미사용 `0.7.1-dev.N`의 dev CI/tag Builder/GHCR 발행을 수행한다. 본 Executor는 외부 발행을 하지 않았다.
