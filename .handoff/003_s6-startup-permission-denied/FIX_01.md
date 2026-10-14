# FIX_01 — 부팅 smoke의 준비 완료·HTTP·종료 판정 보완

- Reviewer, 2026-10-14 Asia/Seoul. 기준 root HEAD `d63c42c0a2c1c28c89e2ab25cf882704c97447b9`, working tree clean. PLAN/REPORT와 현재 구현·Git diff를 검토했다.
- 판정: **CHANGES REQUESTED (P2, 검증 스크립트 한정)**. AppArmor 제품 수정은 인수 가능하다. S6 디렉터리에 ix만 추가하고 기존 민감 deny·bwrap·manager·runtime을 유지한 선택은 적절하다. 새로운 보안 구조나 updater runtime 재작성을 요구하지 않는다.
- Executor의 VM audit/before-after 증거는 REPORT에 기록된 실행 증거로 검토했다. 이번 Reviewer가 VM을 재실행한 것은 아니다. 실제 Supervisor App 설치와 native 양 architecture CI는 아직 NOT RUN이다. 수동 profile load를 Supervisor App 등록 검증 완료로 표현하지 않는다.
- 공식 Home Assistant S6 예시의 `/etc/s6-overlay/** rwix`를 다시 확인했다: https://developers.home-assistant.io/docs/apps/presentation/#apparmor . 기존 broad rule이 r/w를 제공하므로 추가 ix만으로 부족하다는 근거는 없다.
- 독립 `.venv/bin/pytest -q`: **219 passed in 80.57s**. Executor 당시 218 passed/1 skipped와 달리 이번 환경에서는 skip 없이 통과했다. ShellCheck와 commit diff whitespace 검사 PASS. Remote dev는 여전히 `22fae4f`, main은 `a326988`; 새 배포는 없다.

## P2 — init 로그를 전체 서비스 준비 완료로 간주하고 오류 HTTP도 통과시킨다

대상: `tests/apparmor-boot-smoke.sh:48-68,138-152,193-207`.

`Codex runtime ready`는 oneshot init 스크립트 마지막에서 출력된다. 그 이후 S6가 의존 longrun을 시작하므로 해당 로그 직후 모든 service가 up이거나 nginx가 HTTP를 처리한다고 보장되지 않는다. 현재 코드는 이 시점에 current.ok/service up/curl을 단 한 번 검사해 정상적인 느린 부팅도 실패할 수 있다.

반대로 HTTP 판정은 nonempty이고 000이 아니면 성공이다. Reviewer가 동일 predicate에 200/403/502/503을 입력하니 **네 값 모두 PASS**했다. nginx는 up이지만 ttyd upstream이 실패해 502를 내는 경우에도 Web UI 정상 판정이 된다. 이 smoke가 보완하려던 실제 부팅 가용성 gate가 거짓 성공할 수 있다.

수정:

1. 단일 deadline 안에서 container running, init 완료, 필요한 S6 service up, HTTP 예상 정상 응답까지 polling한다. service가 up 직후 죽는 경우를 포함해 최소한 전체 조건 확인 시점의 running 상태를 함께 검사한다. 즉시 exited 상태는 로그와 실제 exit code를 남기고 실패한다.
2. `/`의 fixture 응답은 실제 관측한 정상 **HTTP 200**을 요구한다(다른 정상 status가 필요하면 이유·경로를 명시). 403/5xx/000은 준비 완료로 인정하지 않는다. timeout 동안 잠깐의 502는 재시도할 수 있지만 지속되면 실패해야 한다.
3. 고정 sleep을 추가해 readiness를 가리지 않는다. 실패 시 init/S6/HTTP 최소 진단을 출력한다. REPORT의 실패 로그 수집 주장과 실제 fail 경로를 맞춘다.

## P2 — degraded 종료는 SIGKILL이어도 clean stop 성공으로 처리한다

대상: `tests/apparmor-boot-smoke.sh:208-210`.

`docker stop -t 75`의 성공은 Docker가 container를 멈췄다는 뜻이다. 제한시간 후 SIGKILL로 종료해도 Docker 명령은 성공할 수 있다. 정상 boot는 State.ExitCode=0을 확인하지만 degraded 분기에는 검사하지 않아 **exit 137도 전체 smoke PASS**가 가능하다. REPORT도 초기 check와 경합한 137을 관측했으므로 실제로 중요한 경계다.

수정:

- 두 분기에 같은 bounded stop helper를 사용해 최종 exited 상태와 exit code를 검사한다. 137/nonzero면 최소 로그와 함께 실패한다.
- 45초 대기는 정상 종료의 증거가 아니다. Boot smoke에서 외부 GitHub release check를 통제하는 fixture/mock 또는 명시적 auto-update OFF를 고려한다. Updater 서비스가 실제 실행되고 있음을 확인하는 조건은 유지한다. 외부 업데이트 동작은 기존 updater smoke가 담당하므로 이번 수정에 updater shutdown 설계 변경은 요구하지 않는다.

## 수용·다음 단계

- 초기 init 로그 후 서비스/HTTP가 늦게 준비되는 경우 timeout 안에 통과, HTTP 502/503이 계속되면 실패, degraded 종료 137이면 실패하는 동작을 확인한다. 작은 subprocess/stub 시험을 사용해도 되지만 실제 enforced boot를 대체하지 않는다.
- ShellCheck/관련 계약 시험, 가능한 개발 VM enforced boot를 수행하고 `FIX_01_REPORT.md`에 결과를 기록한다. 기존 PLAN/REPORT는 수정하지 않는다.
- 이후 기존 사용자 DEV 배포 승인 범위에서 버전 준비와 exact SHA 양 architecture CI를 진행한다. 단순 read-only 원격 확인·검증 준비를 새 승인 대기로 멈출 필요는 없다. main/stable 승격은 범위 밖이다.
- native CI와 Supervisor App 설치가 남아 있으므로 현재 버전을 사용자 설치용 수정 배포 완료로 선언하지 않는다. 이를 이유로 새 권한 제한이나 보안 예외 gate를 추가하지 않는다.
