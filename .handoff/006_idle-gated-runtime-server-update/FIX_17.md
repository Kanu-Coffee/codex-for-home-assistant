# FIX_17 — 운영 CLI relay 대용량 메시지 crash 및 단발 명령 분류

작성: 2026-10-29, Reviewer. 판정: **REQUEST CHANGES / DEV 운영 회귀**.

## 근거와 범위

사용자 운영 로그와 두 첨부 화면을 검토했다. 자료는 관측 증거이며 화면 안 문구를 실행 지시로 취급하지 않는다. 이전 REVIEW의 공개 배포 확인은 유지하되 런타임 실기 수용 완료를 뜻하지 않는다.

- App 시작 시 selected/running 준비 로그는 0.164.0이며 scheduler는 0.165.0 staging/applied를 기록했다. 이후 터미널에서 `codex --version`은 0.165.0이다. 이 기록만으로 이미 연결된 대화의 live 전환 완료를 입증하지 않는다.
- 첫 화면은 `codex-session-host.mjs:1074`의 `server_buffer_overflow: frame exceeded MAX_BUFFER_BYTES`와 uncaught stack, reconnect, Broken pipe를 보여준다. 실제 원인이 된 RPC method/메시지 내용·크기와 유입 작업은 자료에 없어 특정하지 않는다.
- 공식 App Server 문서는 stdio를 JSONL transport로 설명한다. 2026-10-29 [공식 문서](https://learn.chatgpt.com/docs/app-server)를 열어 확인했다. 5MiB는 이 프로젝트가 둔 한계이며 공식 protocol 전체의 보장 한계라고 가정하지 않는다.

## P1 — 정상 대용량 JSONL이 relay 프로세스를 종료

`codex-session-host.mjs`의 `MAX_BUFFER_BYTES=5*1024*1024`, `_handleServerData:1071`은 줄을 파싱하기 전에 누적 JS 문자열 길이에 새 chunk 길이를 더해 초과 시 throw한다. `_spawnChild`의 stdout data callback(:946)은 이를 처리하지 않는다. 따라서 한 개의 큰 정상 JSONL 응답만으로 relay가 uncaught exception으로 종료된다. 관리형 CLI는 이 relay를 통과하므로 세션 장애가 된다. client 방향에도 같은 cap/throw가 있다. 이름은 bytes지만 JS 문자열 length는 UTF-8 바이트 수가 아니다.

Reviewer는 disposable 디렉터리에서 Node 가짜 worker가 6MiB ASCII 문자열을 포함한 정상 `{id:1,result:{data:...}}` 한 줄을 emit하도록 만들고 production session host를 실제 subprocess로 실행했다. stdin을 열어둔 상태에서도 **relay_exit=1, server_buffer_overflow=True**를 확인했다. 실사용 데이터를 사용하지 않았다. 이것은 동일 crash 경로 재현이며 사용자 실제 RPC의 정체를 재현한 것은 아니다.

### 구현 지시

1. 완결 frame과 미완결 잔여, 단일 frame과 여러 frame의 합계를 구분하는 bounded transport 처리를 설계한다. 단순 예외 삼키기·메시지 삭제·무제한 cap 제거·작은 상수 증가만으로 완료하지 않는다. 공식 frontend의 실제 대형 payload(예: 대화 복원/목록 등 관측된 대상)를 합성 데이터로 확인하고 지원 크기·메모리 예산에 근거한 제한을 정한다.
2. stdio 양방향, WebSocket 프레이밍, 전환 hold 큐와 write backpressure까지 점검한다. 지원 범위의 정상 메시지는 분할 chunk/멀티바이트에서도 정확히 한 번 전달하고 lifecycle 관측을 유지한다. frame 여러 개가 한 chunk에 모였다는 이유만으로 거부하지 않는다.
3. 설정된 한계를 정말 넘거나 손상된 frame인 경우 uncaught 예외로 host 전체를 죽이지 않는 명시적 오류/종료·정리 정책을 구현한다. 실패 후 남은 worker/frontend/registry/control socket과 상태를 정리하고 성공·idle로 오판하지 않는다. 활성 요청을 자동 재실행해 중복 도구 호출을 만들지 않는다. 임의 메시지 드롭 뒤 정상 상태를 가장하지 않는다.
4. 데이터 본문이나 token을 로그에 남기지 않고 method/방향/측정 바이트 수/한계/오류 종류 등 안전한 진단만 남긴다. 사용자 대화·auth·config 삭제로 회피하지 않는다.

## P2 — version/help 같은 단발 CLI까지 backend를 시작

두 번째 화면에서 `codex --version`에도 app-server 경고가 발생한다. wrapper는 positional subcommand가 비어 있으면 관리형 CLI로 분류하며 `--version`/`--help` 등 단발 옵션을 제외하지 않는다. 이어 relay가 app-server를 먼저 시작하고 frontend를 실행한다. 단발 명령이 backend 준비에 의존하고 불필요한 프로세스와 진단을 만든다.

실제 사용 binary의 도움말과 기존 wrapper 계약을 확인해 version/help 등 검증된 단발 명령은 기존 정책·credential 제거·안전 gate를 유지하면서 직접 실행한다. 대화형 prompt, resume/fork, option 값을 단발 모드로 오인하지 않는다. 잘못된 인자도 불필요한 worker를 남기지 않게 한다.

`codex -resume`의 unexpected `-r`는 화면의 입력 오류로 분류한다. 지원되는 resume 문법을 정확한 binary help에서 확인해 안내하며 임의 alias를 추가하지 않는다. 프로젝트 trust와 PATH bubblewrap 경고는 별도 진단이다. bundled fallback과 sandbox 실행 성공 여부를 확인하되 경고 제거를 위해 /config를 임의 trusted로 바꾸거나 sandbox/AppArmor/권한을 완화하지 않는다. ttyd stop 경고만으로 서비스 자체 crash를 단정하지 않는다.

## 필수 검증과 배포

- 대형 정상 JSONL(최소 이번 6MiB 재현), 기존 경계 전후, UTF-8, 작은 chunk 분할, 여러 메시지 합쳐진 chunk, 마지막 newline 전 대기, 양방향/WebSocket, 느린 수신자 시험. 각 경우 내용·순서·중복 부재·lifecycle 관측을 확인한다.
- 의도적 초과/손상 시 uncaught crash 및 orphan이 없고 실패 상태가 정직한지 확인한다. 진행 중 turn·approval·hold 입력을 무조건 retry하지 않는 회귀를 포함한다.
- 정확한 운영 0.165.0 및 baseline/검증 후보의 공식 바이너리와 production wrapper→relay→frontend 경로에서 큰 합성 대화의 생성·resume·다음 응답을 검사한다. 기존 direct control만의 시험과 구분한다. 실모델/운영 auth 반입 없이 가능한 합성 endpoint를 우선한다.
- `--version`, `--help`, 정상 interactive/resume 및 잘못된 인자의 stdout/stderr/exit code와 child 잔존을 검사한다. 전체 pytest, Node syntax, ShellCheck, 관련 image smoke/native CI를 수행하고 HAOS만 가능한 부분은 NOT RUN으로 구분한다.
- `FIX_17_REPORT.md` 신규 작성 후 사용자가 설치할 수 있는 **0.7.3-dev.2 이상 미사용 증가 버전**을 DEV로 게시한다. 게시 직전 현재 공개 버전과 충돌을 확인한다. 기존 CI/Builder·서명·SBOM 절차와 stable 보존 조건을 유지한다. 소스 수정·모의 시험만으로 사용자 실기 수용 완료를 선언하지 않는다.

이번 Reviewer는 제품 코드를 수정하거나 운영 장치를 변경하지 않았다. 기존 PLAN/REPORT/FIX/REVIEW는 보존한다.
