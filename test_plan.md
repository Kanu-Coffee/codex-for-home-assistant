# test_plan.md — 검증 전략

## 1. 테스트 계층

### L1 정적 검사

모든 PR에서 실행한다.

- YAML parse 및 yamllint
- Markdown lint
- shellcheck
- Dockerfile lint
- App config 정책 검사
- secret scan
- 실행 파일 permission 검사

### L2 로컬 컨테이너 테스트

Supervisor가 없어도 검증 가능한 항목:

- image build
- Codex binary 실행
- init idempotency
- config rendering
- SSH config syntax
- ttyd/tmux process startup
- 실제 ttyd WebSocket resize와 동일 tmux pane 재접속
- helper argument validation
- API response media type 협상과 header injection 거부
- token redaction
- `/data` persistence fixture

### L3 Supervisor/App 개발 환경

공식 local app devcontainer 또는 실제 HAOS에서 검증:

- App 인식/설치/시작
- `/config` mount
- Ingress/WebSocket
- options 적용
- Network port mapping
- `SUPERVISOR_TOKEN`
- Core/Supervisor API

### L4 실제 사용자 HAOS E2E

- 장치 코드 인증
- Web UI Codex TUI
- SSH/Remote SSH
- 실제 안전한 엔티티 service call
- 자동화 Trace/log 분석
- Core check/restart
- App update persistence

## 2. 자동 테스트 케이스

| ID | 테스트 | 기대 결과 |
|---|---|---|
| AT-001 | `config.yaml` parse | 오류 없음 |
| AT-002 | 금지 key 정책 | admin/docker_api/full_access/host_network/apparmor false 없음 |
| AT-003 | `/config` map | homeassistant_config RW path `/config` |
| AT-004 | API 권한 | homeassistant_api, hassio_api true / manager |
| AT-005 | Codex version | pin된 버전 출력 |
| AT-006 | init 두 번 실행 | 데이터 손실/중복 없음 |
| AT-007 | 기존 config.toml | 사용자 값 보존 |
| AT-008 | authorized_keys 렌더링 | 정확한 줄/0600 |
| AT-009 | empty keys | SSH 로그인 비활성, Web service 정상 |
| AT-010 | host keys | 재시작 fixture에서 동일 fingerprint |
| AT-011 | `sshd -t` | 성공 |
| AT-012 | ttyd command | tmux wrapper 안전한 인수 사용 |
| AT-013 | auto-start false | shell 실행 |
| AT-014 | auto-start true | codex 1회 후 shell |
| AT-015 | API helper no token | stdout/stderr에 token 없음 |
| AT-016 | API 4xx/5xx | non-zero exit와 body 요약 |
| AT-017 | shellcheck | 오류 없음 |
| AT-018 | secret scan | 실제 credential 없음 |
| AT-019 | 실제 ttyd WebSocket shell | 101 handshake 후 `/config`, non-dumb TERM으로 명령 실행 |
| AT-020 | 기본 전역 `AGENTS.md` | 생성·0644, 핵심 안전 규칙 포함, 재초기화 시 사용자 수정/override 보존 |
| AT-021 | API `Accept` 협상 | 기본 JSON, 로그 x-log, 비허용/CRLF 값 요청 전 거부 |
| AT-022 | ttyd resize/reconnect | resize 반영 후 WebSocket 재연결에도 session/pane/pid 동일 |

## 3. HAOS 수동/E2E 시나리오

### E2E-001 설치 및 시작

1. repository 등록 또는 local App 설치
2. App 설치
3. 기본 옵션으로 시작
4. logs 확인

성공 기준:

- App가 running
- Web UI 버튼 표시
- SSH keys 미설정 경고 외 치명적 오류 없음

### E2E-002 웹 터미널 기본 모드

1. auto-start false
2. Web UI 열기
3. `pwd`, `command -v codex`, `echo $CODEX_HOME`, `echo $TERM`

성공 기준:

```text
/config
/usr/local/bin/codex
/data/codex
tmux-256color
```

### E2E-003 웹 터미널 자동 Codex

1. auto-start true
2. App 재시작 또는 새 tmux 세션
3. Web UI 열기
4. Codex TUI 확인
5. Codex 종료

성공 기준:

- Codex 자동 시작
- 종료 후 shell 복귀

### E2E-004 tmux 재접속

1. Web UI를 열고 별도 SSH에서 `session_id`, `pane_id`, `pane_pid`, client/pane 크기 기록
2. App을 재시작하지 않고 Web UI만 닫기
3. tmux session/pane process가 유지되는지 확인
4. Web UI를 다시 열어 같은 ID인지 비교
5. 브라우저 크기를 바꾸고 tmux client/pane 크기 변화 확인

성공 기준:

- 기존 session/pane/process와 화면 복원
- resize가 실제 tmux client에 반영

App 업데이트·재시작은 컨테이너 프로세스를 종료하므로 이 시나리오 사이에 실행하지 않는다.

### E2E-005 헤드리스 인증

1. `ha-codex-login`
2. 다른 브라우저에서 device code 완료
3. `codex login status`
4. App restart
5. status 재확인

성공 기준: 재로그인 없이 인증 유지

### E2E-006 SSH

1. authorized_keys 설정
2. Network port 2223 확인
3. Windows에서 접속

```powershell
ssh -p 2223 root@<ha-host>
```

성공 기준:

- public key 성공
- password 로그인 실패
- `/config` 시작
- `codex --version` 성공

### E2E-007 Desktop SSH 프로젝트와 mobile Remote

1. Windows `~/.ssh/config` alias 생성
2. 일반 `ssh <alias>` 성공
3. Codex Desktop Connections에 host 추가
4. `/config` 선택
5. 파일 읽기/테스트 파일 생성/삭제
6. 선택적으로 mobile Remote에서 연결된 desktop host의 같은 SSH 프로젝트 작업 계속

성공 기준: remote app server가 시작되고 desktop 또는 mobile Remote를 통해 작업 완료

### E2E-008 Core API

```bash
ha-api GET /config
ha-api GET /states
```

성공 기준: 인증 오류 없이 JSON 반환, token 미출력

### E2E-009 안전한 기기 서비스 호출

대상은 사용자가 지정한 테스트용 조명/스위치로 한정한다.

1. before state 저장
2. service call
3. state change 확인
4. 원상 복구

성공 기준: 기대 상태와 로그 일치

### E2E-010 Supervisor manager

- Core info
- Core/App logs를 먼저 직접 `Accept: text/x-log`로 조회
- `ha-core-logs`, `ha-addon-logs` 결과를 직접 요청과 비교
- config check
- 테스트 App info/logs
- 허용되는 경우 테스트 App restart

성공 기준: manager 범위를 표로 기록. 거부된 endpoint는 admin 승격 없이 문서화.

### E2E-011 `/config` 변경 및 검사

1. 안전한 package/test file 생성
2. YAML parse
3. Home Assistant config check
4. 삭제/롤백

성공 기준: 실제 RW와 검사 흐름 확인

### E2E-012 업데이트 영속성

1. auth 상태와 host key fingerprint 기록
2. 새 App image로 update
3. 재시작
4. 인증/SSH known_hosts 확인

성공 기준: 인증과 host key 유지

이 시나리오는 App 삭제나 `/data` 초기화 없이 일반 업데이트로 실행한다.

### E2E-013 Codex 운영 지침

1. App 업데이트/재시작 뒤 `/data/codex/AGENTS.md` 존재 확인
2. 새 Codex 세션에서 적용된 지침 요약 요청
3. 파일에 식별 가능한 사용자 문장을 추가하고 App 재시작
4. 사용자 문장 보존 확인

성공 기준: 기본 안전 지침이 새 세션에 적용되고 기존 `AGENTS.md` 또는 `AGENTS.override.md`를 덮어쓰지 않음

## 4. 회귀 테스트 우선순위

P0:

- App 부팅 불가
- Web UI 접속 불가
- SSH/Remote SSH 불가
- Codex auth 유실
- `/config` 손상
- token 로그 노출

P1:

- auto-start 옵션 오동작
- tmux 재접속 실패
- manager API helper 실패
- 사용자 `AGENTS.md` 덮어쓰기
- 한글/resize 문제

P2:

- 문서/번역/UX 개선

## 5. 테스트 결과 기록 형식

`progress.md`에 다음을 남긴다.

```markdown
### Verification
- [x] <command/test>: PASS — <evidence>
- [ ] <HAOS-only test>: NOT RUN — <reason>
- [x] Secret scan: PASS
- Known issues:
```

CI 링크와 HAOS 버전, App 버전, 아키텍처를 기록한다.
