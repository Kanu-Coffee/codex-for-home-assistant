# FIX_01_REPORT — boot smoke 판정 보완과 updater SIGTERM wake-up 실증

- 역할: Executor, 2026-10-14 Asia/Seoul. `.handoff/003_s6-startup-permission-denied/FIX_01.md`의 두 P2를 반영했다. Reviewer 제품 수정(프로파일 ix)은 유지했고 기존 handoff 문서를 덮어쓰지 않았다.
- 기준: root `feat/codex-auto-update` HEAD `d63c42c`, 시작 시 working tree에 Reviewer의 FIX_01.md·progress 수정만 존재. remote `dev` `22fae4f`·main `a326988`와 기존 태그/image는 그대로다. 이번 회차 push/tag/발행/운영 HA 변경은 하지 않았다.

## 검증 스크립트 수정 (`tests/apparmor-boot-smoke.sh`)

1. 단일 유한 deadline(`APPARMOR_BOOT_TIMEOUT`, 기본 180s) 안에서 running 상태 → init 완료 로그 → S6 서비스 up(`s6-svstat`) → ingress HTTP까지 매 반복마다 함께 검사한다. 각 단계 실패는 `last_reason`으로 기록하고 deadline 후 실패 시 state·로그 tail·svstat·HTTP 코드 진단을 출력한다. 컨테이너가 먼저 exited되면 즉시 실패하며 exit code를 남기고, `exited:126`은 exec 거부로 구분해 별도 메시지로 실패한다. 고정 sleep(45s)은 제거했다.
2. HTTP 판정은 관측된 정상 응답 **200**만 통과(`EXPECTED_INGRESS_CODE=200`). 000/403/502/503은 준비 완료로 인정하지 않고 deadline까지 재시도 후 실패. Reviewer가 지적한 403/502/503 거짓 성공을 stub으로 재현·차단 확인(아래 표).
3. 부팅·degraded 양 분기 모두 공통 `require_clean_stop`을 사용한다. `docker stop -t 75`(env로 조정) 후 exited 상태까지 유한 wait, 최종 `exited:0`이 아니면(137 포함) 진단과 함께 실패한다.
4. 프로세스 검사는 busybox `pgrep` 실정에 맞췄다: `pgrep -x sshd`는 busybox에서 커맨드 라인 전체와 매칭되지 않아 정상 기동에서도 실패했고, `sh -c` 래퍼는 패턴을 담은 셸 자신을 매칭해 degraded 검사에 거짓 양성을 냈다. `docker exec CONTAINER pgrep <flags> <pattern>` 직접 호출로 교체하고 부팅(sshd 존재)·degraded(sshd 부재)를 구분 검사한다.
5. fixture options에 `codex_auto_update: false`를 명시해 부팅 smoke가 외부 GitHub release check와 경합하지 않게 했다. updater 서비스 등록·프로세스 실행 자체는 계속 요구하며 실제 네트워크 갱신 동작은 기존 updater smoke의 담당으로 남겼다.

## 실증 중 발견한 updater SIGTERM 결함과 최소 수정

- 보완 스크립트를 개발 HAOS VM(slug 이름 `codex_home_assistant`로 enforce된 수정 프로파일 + 공개 dev.6 image)에서 처음 실행하자 **모든 검사를 통과한 후 clean stop이 실패**했다(exit 137). 통제 재현(valid/invalid authorized_keys 양쪽, `stop -t 200`)에서 두 경우 모두 정확히 같은 지점에서 200s 후 SIGKILL됐다.
- 프로세스 스냅샷 원인: 다른 서비스는 모두 down된 상태에서 `codex-updater`(node daemon)가 `want down`인데 TERM에 응답하지 않았다. `codex-updater-daemon.mjs`는 SIGTERM 핸들러에서 `isRunning=false` 플래그만 세우고 슬롯 대기 `setTimeout`을 최대 **3600초**로 잔류시켜, 플래그가 다음 wake까지 최대 1시간 뒤에야 반영된다. 즉 dev.6 image에서는 정상 종료(exit 0)가 구조적으로 불가능했다 — auto-update OFF 옵션도 같은 결과였다.
- FIX_01은 updater shutdown 설계 변경을 요구하지 않지만, 그 수용 기준(137이면 실패)과 실제 image 동작이 양립하지 않는다. PLAN의 스케줄·예산·재시작·apply 계약(시간대 슬롯, 일 12회 idle, rolling 24h cooldown, busy 보류, 세션 소유)을 그대로 두고 데몬의 **대기만 깨우는 최소 수정**을 했다: `sleepBeforeNextPass()`가 타이머 handle과 resolve를 보관하고, `stopOnSignal()`이 플래그 설정 후 대기 중이면 즉시 깨운다. 연주를 중단하거나 busy 중 강제 종료하는 변경은 없다. 스케줄링·apply·restart 로직과 Grype gate는 미수정이다.
- 이 수정은 image 내용 변경이므로 dev.6 image로는 clean stop 검사가 통과할 수 없고, Reviewer도 이 관측을 반영해 검증 판정을 확정해야 한다. 범위를 벗어난 조정임을 명확히 기록한다.

## 실행 결과

| 검증 | 명령/환경 | 결과 |
| --- | --- | --- |
| 회귀 로직 stub 시험 | PATH에 docker/cat/sudo stub을 심고 실 스크립트 실행 | S1 느린 준비(로그→svstat→502 transient→200) **PASS exit 0** / S2 지속 503 **FAIL**(`last condition: ingress returned http=503`) / S3 early exit 126 **FAIL**(exec 거부 메시지) / S4 degraded stop 137 **FAIL**(clean stop 검사) / S5 지속 403 **FAIL** |
| 이미지 재빌드 | root 코드(수정 프로파일 + wake-up 데몬), `docker build --platform linux/amd64 -t codex-for-home-assistant:fix01-test` | exit 0, image `1635bdf1b50b` |
| VM enforced 부팅 smoke | HAOS 18.2 VM, 레포 `apparmor.txt` 원본(SHA `b93d714e…`)을 slug 이름 enforce, 스크립트 SHA `f99636ee…`와 동일본 사용, alpine 하네스(bash+docker-cli) | **PASS exit 0**: 부팅·degraded 양쪽 runtime ready, 서비스 up, HTTP 200, secrets/.storage read 차단, configuration.yaml RW, clean stop `exited:0` |
| VM dev.6 before/after(이 회차 통제 실험) | 동일 fixture valid/invalid options, `stop -t 200` | dev.6 image: 양쪽 stop 200s 후 `exited:137` (updater 대기 결함 재현) — fix01-test image는 동일 절차에서 종료 0 |
| `.venv/bin/pytest -q` | root, daemon 수정 포함 | **218 passed, 1 skipped**(기존 apparmor_parser 부재 test; Reviewer 환경 219과 동일 집합) |
| ShellCheck / node --check / yamllint / actionlint | 스크립트·daemon 문법·workflow | PASS |
| VM 정리 | debug 컨테이너·volume(dbg3, 003dbg, dbg2 포함) 제거, `/tmp/003` 삭제, 프로파일 `-R` unload 확인, `haos-vm stop`으로 shut off 복원 | PASS. VM Docker의 `codex-for-home-assistant:fix01-test` image는 재검증용으로 보존(운영 App·기존 image/태그 미변경) |

## PLAN/FIX 대비 남은 검증

- 새 boot gate의 GitHub 양 architecture 실 실행, Supervisor App 설치 기동(dev VM UI), dev.7 버전 상승·문서·changelog·Builder·GHCR 발행, 사용자 HAOS 수용: 여전히 **NOT RUN**. push/발행은 사용자 승인 범위이므로 이번 Executor는 root 커밋까지만 했고 remote에 게시하지 않았다.
- updater TERM wake-up 수정의 busy-중 종료 semantics(체크 진행 중 TERM: 현재 반복 완료 후 exit)는 VM smoke과 데몬 로직으로 확인했고, 슬롯·budget·cooldown 상태 전환 자체는 기존 updater smoke 회귀로 커버된다.

## 다음 행동

- Reviewer: 프로파일 ix 인수 유지 판정 위에 daemon wake-up 조정의 수용 여부를 확정하고, 수용이면 existing DEV 승인 범위에서 dev.7 준비(버전·문서·exact SHA 양 arch CI·enforced boot gate 포함)와 Supervisor VM 설치를 진행할 것. 기각 요구 시 `FIX_02.md`로 회신.
