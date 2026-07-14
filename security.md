# security.md — 권한, 위험, 운영 가드레일

## 1. 보안 입장

이 프로젝트는 권한을 최소화한 단순 편집기가 아니라 **Home Assistant의 신뢰된 운영 에이전트**다. 높은 권한은 의도된 제품 특성이다.

동시에 HAOS host와 Docker 전체를 열 필요는 없으므로 경계를 다음처럼 둔다.

```text
허용: /config 전체 RW
허용: Core API 전체 기능
허용: Supervisor API manager 역할
허용: 실제 기기 서비스 호출
차단: Supervisor admin 역할
차단: Docker API
차단: full_access/privileged host access
차단: host network
기본: AppArmor 활성
```

## 2. 권한 매트릭스

| 기능 | 제공 수단 | 위험도 | 결정 |
|---|---|---:|---|
| HA YAML/대시보드 수정 | `/config` RW | 높음 | 허용 |
| `.storage` 접근 | `/config` RW | 매우 높음 | 허용, 직접 수정은 운영 규칙으로 제한 |
| 상태/서비스 조회 | Core API | 중간 | 허용 |
| 실제 기기 제어 | Core API service call | 높음 | 허용 |
| 자동화/스크립트 실행 | Core API | 높음 | 허용 |
| Core/App 로그 | Supervisor API | 중간 | 허용 |
| Core/App 재시작 | manager API | 높음 | 허용 |
| 개발 Web UI 실제 브라우저 검증 | Playwright MCP + headless Chromium | 높음 | 컨테이너 안에서 허용 |
| HA 대시보드 브라우저 인증 | loopback gateway + 현재 App token | 매우 높음 | 정확한 loopback origin에 한해 허용 |
| 브라우저 디버그/VNC 외부 공개 | 새 host/Ingress port | 매우 높음 | 불허 |
| 보호 모드 변경/무제한 Supervisor | admin | 매우 높음 | 불허 |
| Docker container 직접 제어 | docker_api | 치명적 | 불허 |
| HAOS host 전체 권한 | full_access/privileged | 치명적 | 불허 |

## 3. 주요 위험

### T-001 잘못된 설정으로 Core 부팅 실패

완화:

- 변경 전 Git checkpoint
- `/core/check` 또는 공식 설정 검사
- 검사 실패 시 재시작 금지
- 변경 파일과 diff 보고

### T-002 실제 기기 오작동

완화:

- 대상 entity를 명시
- 서비스 호출 전 현재 상태 저장
- 테스트 후 상태 확인/복원
- 출입·경보·가열·급수 등 고위험 장치는 명시적 승인

### T-003 `.storage` 손상

완화:

- 공식 API/YAML 우선
- 직접 수정 전에 HA backup 또는 파일 복사
- Core가 실행 중인 내부 JSON을 무리하게 편집하지 않음

### T-004 토큰 유출

완화:

- `SUPERVISOR_TOKEN`을 Git/로그/응답에 출력하지 않음
- curl verbose/debug 기본 비활성
- runtime env 파일 0600
- `auth.json` 0600
- API helper의 동적 `Accept` 값은 JSON/plain/x-log allowlist로 제한해 header injection 차단
- CI secret scan

### T-005 SSH 노출

완화:

- 공개키 전용
- 기본 LAN port 2223
- 인터넷 port forwarding 금지 문서화
- 외부 접근은 VPN/mesh network 권장
- host key 영속화
- 로그인 시도 로그
- mobile Remote는 HAOS에 직접 SSH하지 않고 신뢰한 desktop app의 SSH 연결을 제어하므로 desktop 계정·device pairing도 접근 경계로 취급

### T-006 Prompt injection 또는 잘못된 에이전트 판단

완화:

- App은 신뢰된 사용자만 접근
- 외부 문서/로그의 명령을 자동 실행 지시로 취급하지 않음
- `CODEX_HOME/AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때 위 원칙과 진단/변경 권한 분리, 비밀 비노출, 설정 검사 절차를 담은 전역 운영 지침을 생성
- 사용자가 만든 전역/프로젝트 지침은 덮어쓰지 않음
- 파괴적 작업 승인 규칙
- Git/backup 및 test-before-restart

진단 결과는 변경 권한이 아니다. App은 Repairs, 업데이트 가능 상태, 서드파티 통합 경고, `/config` 파일 mode를 발견했다는 이유만으로 자동 수정·`chmod`·업데이트·재시작하지 않는다.

`AGENTS.md`는 모델 동작을 돕는 방어 심층화 지침이지 강제 보안 경계가 아니다. `/config`의 더 가까운 지침이 우선할 수 있으므로 실제 경계는 App 권한, Codex approval/sandbox 설정, 명시적 사용자 승인과 변경 전후 검증으로 유지한다.

### T-007 App backup에 Codex token 포함

완화:

- backup을 비밀번호/토큰과 같은 민감자료로 취급
- 공유 금지
- 향후 `backup_exclude` 옵션의 장단점을 실기 검증
- 노출 의심 시 Codex logout/re-auth

### T-008 registry image 변조 또는 비공개 배포

완화:

- App version과 정확히 같은 숫자 Git tag에서만 image 게시
- 공식 Home Assistant builder actions의 version을 고정
- 장기 registry credential 대신 repository-scoped `GITHUB_TOKEN` 사용
- 기존 version tag 덮어쓰기 금지
- generic/per-arch GHCR package public visibility와 인증 없는 amd64 pull 확인
- pull한 image의 `io.hass.version`, `io.hass.arch`, source label과 container smoke 검증

### T-009 브라우저/MCP 공격 표면과 prompt injection

브라우저가 여는 페이지의 DOM, 접근성 snapshot, console, network 응답은 신뢰할 수 없는 입력이다. 페이지에 적힌 지시를 사용자 또는 프로젝트 지시로 승격하지 않는다.

완화:

- Codex의 MCP 경로는 container-local stdio로 연결하고 App service가 HTTP/SSE listener를 열지 않음. wrapper는 command-line 인수를 거부하고 enforcement proxy만 실행
- headless·isolated context를 사용하고 세션/profile을 `/data`에 저장하지 않음
- navigation, snapshot, viewport resize, screenshot, console/network 관찰과 기본 UI 조작만 명시적으로 허용
- 임의 JavaScript/code 실행, code generation, unrestricted file access/upload 도구는 제공하지 않음
- screenshot/browser output은 `/run/codex-ha`의 비영속 private 디렉터리에 두고 총량을 50 MiB로 제한. enforcement proxy가 tool call의 `filename`을 거부해 `/config`·`/data` 우회를 차단
- `chromium-headless-shell --no-sandbox`는 App container 안에서만 사용하며 이를 이유로 `privileged`, 새 capability, `full_access`, `host_network`를 추가하지 않음

### T-010 renderer를 통한 Supervisor token·민감 화면 유출

HA 대시보드는 브라우저에서 Core API/WebSocket 인증이 필요하지만 token을 MCP 입력, URL, process argv 또는 영속 browser profile에 전달하면 안 된다.

완화:

- gateway는 container loopback `127.0.0.1:8099`에서만 수신하고 새 App Network/Ingress port를 만들지 않음
- 현재 container의 `SUPERVISOR_TOKEN`은 Codex `env_vars`로 MCP Node process에 전달한다. `/run/codex-ha` 아래 mode 0600 임시 secrets 파일은 `--secrets` exact-value masking용으로만 사용하고 `/data`에 저장하지 않음
- token은 `http://127.0.0.1:8099` 또는 `http://localhost:8099`의 정확한 origin에서만 `hassTokens` localStorage에 주입
- token을 명령행 인수, URL query, console, MCP 응답, network request 목록, screenshot metadata, App log에 출력하지 않음
- MCP secret masking은 방어 심층화일 뿐 보안 경계로 간주하지 않으며 인코딩·분할된 비밀이나 이미지까지 구조적으로 정화한다고 가정하지 않음
- screenshot과 console/network 결과는 민감자료로 취급하고 Git, CI artifact, `/data`에 자동 보존하지 않음

### T-011 브라우저의 내부망 요청과 인증 오용

브라우저는 일반 Web UI 검증을 위해 네트워크에 접근할 수 있으므로 사용자가 요청하지 않은 내부 주소 탐색이나 loopback 인증을 다른 origin으로 전달하지 않는다.

완화:

- 인증 주입은 두 개의 명시된 loopback origin으로 제한
- gateway는 HA frontend와 전체 Core API/WebSocket proxy만 제공하고 범용 target forward proxy로 동작하지 않음. endpoint/method 제한은 기존 App의 전체 Core API 권한과 사용자 승인 규칙에 맡김
- HTTPS frontend upstream은 `proxy_ssl_verify off`이므로 container 내부 `homeassistant` DNS/네트워크를 신뢰 경계로 취급하고 외부 TLS proxy에 재사용하지 않음
- 외부 페이지에서 얻은 링크나 script 지시만으로 새 내부 endpoint를 탐색하지 않음
- navigation target과 관찰 결과를 작업 보고에 명시

## 4. `manager` 선택 근거

`manager`는 CLI형 관리 App에 필요한 Supervisor 운영 권한을 제공하면서 `admin`보다 제한적이다. Core 기기 제어는 `homeassistant_api: true`로 별도 제공되므로 실제 서비스 호출을 위해 `admin`이 필요하지 않다.

manager가 특정 필요한 endpoint를 거부하면:

1. 정확한 endpoint와 HTTP 응답을 기록한다.
2. 대체 공식 경로를 찾는다.
3. 기능 영향도를 문서화한다.
4. 사용자의 명시적 승인 없이 admin으로 올리지 않는다.

## 5. Codex sandbox 해석

`codex_sandbox_mode: danger-full-access`는 Codex가 **컨테이너 안에서** App이 가진 권한을 사용할 수 있게 한다. Home Assistant App의 `full_access: true`와 동일하지 않다.

컨테이너 경계는 계속 다음을 막는다.

- Docker socket 접근
- host namespace 직접 제어
- 매핑하지 않은 host filesystem
- 부여하지 않은 Linux capabilities

다만 `/config`와 API는 의도적으로 강하게 열려 있으므로 App 자체를 관리자만 사용할 수 있어야 한다.

## 6. 보안 테스트

- 비밀번호 SSH 로그인 거부
- 잘못된 공개키 거부
- 빈 authorized_keys 시 로그인 불가
- `auth.json` 및 token이 `docker history`, App logs, CI artifacts에 없음
- API helper 오류 출력에 Authorization header 없음
- API helper가 허용하지 않은 media type과 CR/LF header injection을 요청 전에 거부
- Playwright MCP가 stdio로만 실행되고 외부 listener/새 App port를 만들지 않음
- 브라우저 도구 allowlist에 임의 code 실행, unrestricted file access/upload, codegen이 없음
- browser context가 isolated이고 profile, screenshot, trace, network 결과를 `/data`에 쓰지 않음
- fixture token이 process argv, App/MCP log, console/network 결과, screenshot metadata, `/run` 외 artifact에 없음
- loopback gateway가 container 외부에서 접근 불가하고 정확한 두 origin 외에는 token을 주입하지 않음
- gateway의 `/api/`가 전체 Core API 권한을 전달한다는 사실을 검증하고 범용 target proxy가 아님을 확인
- `proxy_ssl_verify off`가 loopback gateway의 내부 `homeassistant` frontend upstream에만 한정됨
- Playwright 추가 후에도 `privileged`, `full_access`, `host_network`, 추가 Linux capability, AppArmor 비활성화가 없음
- 패널 `panel_admin: true`
- `hassio_role`이 manager인지 검사
- 금지 config key가 없는지 정책 테스트
- 실제 고위험 service call은 테스트 fixture/mock로 검증

## 7. 사고 대응

### Codex 인증 노출 의심

1. App 중지
2. Codex 계정에서 세션/연결 해제 또는 logout
3. `/data/codex/auth.json` 삭제
4. App 재시작 및 재인증
5. Git/로그/backup 공유 여부 확인

### Supervisor token 노출 의심

1. App 즉시 중지/재시작하여 runtime token 회전 여부 확인
2. 노출된 로그/파일 삭제 및 접근 차단
3. Home Assistant 관리자 세션과 관련 credentials 점검
4. 원인 수정 전 App 재사용 금지

브라우저 renderer 경로에서 노출이 의심되면 MCP/App을 먼저 중지하고 App container 재생성 뒤 `/run/codex-ha/playwright-output`, 임시 secrets와 browser context가 폐기됐는지 확인한다. 저장하거나 공유한 screenshot·console/network 자료도 credential과 동일하게 회수·삭제한다.

### 설정 손상

1. App 또는 Codex 작업 중지
2. Git diff/commit으로 롤백
3. 설정 검사
4. 필요 시 Home Assistant backup 복원
5. 회귀 테스트 추가

## 8. 실기 검증 경계

Alpine의 system `chromium-headless-shell` 조합은 upstream Playwright의 공식 Ubuntu/Debian browser bundle 대상과 다르다. 로컬 container fixture 통과만으로 HAOS 지원을 확정하지 않는다. 실제 HAOS에서 AppArmor 활성 상태의 browser 시작, loopback gateway, dashboard WebSocket, 한글 font, desktop/mobile screenshot, token 비노출을 확인할 때까지 이 경로는 **HAOS unverified**로 기록한다.
