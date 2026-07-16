# references.md — 공식 근거

검증 기준일: **2026-07-15**

구현 시작 시 아래 공식 문서의 최신 내용을 다시 확인한다. 기술 문서는 바뀔 수 있으므로 이 목록은 근거와 탐색 출발점이지 영구 고정값이 아니다.

## Home Assistant 공식

- App 개발 개요  
  https://developers.home-assistant.io/docs/apps/

- App tutorial  
  https://developers.home-assistant.io/docs/apps/tutorial/

- App configuration (`config.yaml`, ports, ingress, map, API roles, options/schema)  
  https://developers.home-assistant.io/docs/apps/configuration/

- App communication (Core API proxy, WebSocket, Supervisor API, `SUPERVISOR_TOKEN`)  
  https://developers.home-assistant.io/docs/apps/communication/

- Local App testing  
  https://developers.home-assistant.io/docs/apps/testing/

- Publishing and GitHub Actions builder  
  https://developers.home-assistant.io/docs/apps/publishing/

- Presentation, AppArmor, security rating, Ingress  
  https://developers.home-assistant.io/docs/apps/presentation/

- App repository structure  
  https://developers.home-assistant.io/docs/apps/repository/

- Supervisor API endpoints  
  https://developers.home-assistant.io/docs/api/supervisor/endpoints/

- Home Assistant WebSocket API  
  https://developers.home-assistant.io/docs/api/websocket/

- Home Assistant Core `2026.7.2` automation WebSocket handlers (`automation/config`)
  https://github.com/home-assistant/core/blob/2026.7.2/homeassistant/components/automation/__init__.py

- Home Assistant Core `2026.7.2` automation entity raw configuration
  https://github.com/home-assistant/core/blob/2026.7.2/homeassistant/components/automation/config.py

- Home Assistant Core `2026.7.2` `search/related` schema와 automation/entity search 의미
  https://github.com/home-assistant/core/blob/2026.7.2/homeassistant/components/search/__init__.py#L33-L75
  https://github.com/home-assistant/core/blob/2026.7.2/homeassistant/components/search/__init__.py#L210-L268
  https://github.com/home-assistant/core/blob/2026.7.2/homeassistant/components/search/__init__.py#L321-L344

- Home Assistant Core `2026.7.2` automation related 공식 테스트
  https://github.com/home-assistant/core/blob/2026.7.2/tests/components/search/test_init.py#L516-L539

- Home Assistant Core `2026.7.2` WebSocket `invalid_format`/`unknown_error` 처리
  https://github.com/home-assistant/core/blob/2026.7.2/homeassistant/components/websocket_api/connection.py#L281-L331

- Home Assistant authentication providers (`trusted_networks` order, trusted proxy overlap)
  https://www.home-assistant.io/docs/authentication/providers/

- Home Assistant HTTP forwarded-client and `trusted_proxies` configuration
  https://www.home-assistant.io/integrations/http/

- Home Assistant authentication permissions
  https://developers.home-assistant.io/docs/auth_permissions/

- Home Assistant Core `2026.7.1` trusted networks provider
  https://github.com/home-assistant/core/blob/2026.7.1/homeassistant/auth/providers/trusted_networks.py

- Home Assistant Core `2026.7.1` user administration WebSocket API
  https://github.com/home-assistant/core/blob/2026.7.1/homeassistant/components/config/auth.py

- Home Assistant Core `2026.7.1` built-in permission policies (`system-read-only`)
  https://github.com/home-assistant/core/blob/2026.7.1/homeassistant/auth/permissions/system_policies.py

- Home Assistant Supervisor App network implementation snapshot (`8821586`)
  https://github.com/home-assistant/supervisor/tree/8821586aee2f1ab2c545626fb1c0f9a6d14885ce

- Home Assistant Supervisor Core WebSocket proxy implementation snapshot (`8821586`)
  https://github.com/home-assistant/supervisor/blob/8821586aee2f1ab2c545626fb1c0f9a6d14885ce/supervisor/api/proxy.py

- 공식 example App repository  
  https://github.com/home-assistant/apps-example

- 2026.04 BuildKit migration
  https://developers.home-assistant.io/blog/2026/04/02/builder-migration/

- Home Assistant base image source (`2026.06.1`, Alpine 3.24)
  https://github.com/home-assistant/docker-base/tree/2026.06.1

- Home Assistant builder actions (`2026.06.0`)
  https://github.com/home-assistant/builder/tree/2026.06.0/actions

- 공식 App repository 검증 snapshot (`apps-example` commit `280691b`)
  https://github.com/home-assistant/apps-example/tree/280691b1ba32c9b9fdc627f20e9eaeb3241f766b

## OpenAI Codex 공식

- Codex CLI  
  https://developers.openai.com/codex/cli

- Codex authentication 및 headless/device code login  
  https://developers.openai.com/codex/auth

- ChatGPT Remote connections — 일반 desktop-host 흐름 참고용이며 이 App의 검증된 모바일 직접 SSH 경로와 구분
  https://developers.openai.com/codex/remote-connections

- Codex configuration reference  
  https://developers.openai.com/codex/config-reference

- Codex non-interactive mode  
  https://developers.openai.com/codex/noninteractive

- Codex CLI release `0.144.1`
  https://github.com/openai/codex/releases/tag/rust-v0.144.1

- Codex Linux sandbox/container guidance
  https://developers.openai.com/codex/agent-approvals-security/

- Codex environment variables
  https://developers.openai.com/codex/environment-variables/

- Codex custom instructions and `AGENTS.md` discovery
  https://developers.openai.com/codex/agent-configuration/agents-md

- OpenAI Responses MCP tool descriptions, JSON schema and approval/read-only filtering
  https://platform.openai.com/docs/api-reference/responses/create

## 구현 참고 프로젝트

- Advanced SSH & Web Terminal (`8fd57f1`)
  https://github.com/hassio-addons/app-ssh/tree/8fd57f130a790435b81a1dbb4ff4cffc8f53061d

- Home Assistant official SSH App (`9f8cc5a`)
  https://github.com/home-assistant/addons/tree/9f8cc5ab71927c0339bbc44e4a4bb6180d7b60ec/ssh

이 프로젝트는 SSH/Web Terminal/Inress 패턴을 참고할 수 있으나, 불필요한 `host_network`, `docker_api`, host hardware 권한까지 복사하지 않는다. 라이선스와 attribution 요구를 확인하고 코드를 가져오면 준수한다.

## 근거로 확정한 핵심 사항

- Home Assistant App은 container image이며 repository root에 `repository.yaml`이 필요하다.
- `map`의 `homeassistant_config`는 `read_only: false`와 custom container path를 지원한다.
- exposed host port는 `ports` mapping 및 App Network UI에서 관리한다.
- Ingress는 `ingress`, `ingress_port`, `ingress_stream`을 지원한다.
- Core API proxy는 `http://supervisor/core/api/`, WebSocket은 `ws://supervisor/core/websocket`이다.
- Supervisor의 Core WebSocket proxy는 Core의 `auth_required`를 전달하며 App은 그 뒤 첫 인증 frame의 `access_token`에 `SUPERVISOR_TOKEN`을 보낸다. Upgrade 요청의 `Authorization` header는 요구되지 않는다.
- Core `2026.7.2`의 `automation/config` 성공 응답은 automation entity의 `raw_config`를 그대로 반환하므로, unavailable/invalid automation에서는 `{ "config": null }`이 합법적인 성공 응답일 수 있다.
- Supervisor API는 `http://supervisor/`와 `SUPERVISOR_TOKEN`을 사용한다.
- `hassio_role` 값에는 `manager`와 `admin`이 별도로 존재한다.
- 이 App의 ChatGPT mobile Remote 경로는 App SSH endpoint에 직접 연결하며, 원격 login shell의 PATH에서 `codex`를 찾아 내장 app-server를 bootstrap한다.
- 이 App 경로에는 별도의 Mac/Windows desktop app이나 페어링된 중계 host가 필요하지 않다.
- Headless Codex는 `codex login --device-auth` 또는 local `auth.json` 복사를 지원한다.
- Codex config는 `approval_policy`, `sandbox_mode`, file credential store를 지원한다.
- Supervisor 2026.04부터 legacy `build.yaml`과 자동 `BUILD_FROM` 주입을 사용하지 않으며 Dockerfile이 build source of truth다.
- 현재 generic Home Assistant Alpine base는 `3.24`, builder composite actions는 `2026.06.0`이다.
- Codex CLI는 `0.144.1` amd64 musl release artifact와 GitHub asset digest를 사용한다.
- 직접 Remote SSH는 remote login shell의 PATH에서 `codex`를 찾고 HA App에 저장된 Codex 인증을 요구한다.
- Supervisor Core/App 로그 endpoint는 `Accept: text/plain` 또는 `text/x-log`를 사용하며 JSON Accept만 보내면 협상이 실패할 수 있다.
- Codex는 `CODEX_HOME`의 `AGENTS.md`를 전역 지침으로 읽고 프로젝트 root부터 현재 디렉터리까지 더 가까운 지침을 뒤에 결합한다.
- OpenAI MCP tool surface는 tool description과 JSON schema를 모델에 제공하고 read-only annotation을 approval filtering에 사용할 수 있으므로, 사용자 명시 기억의 호출 조건은 model-visible description에 두되 source/status/transient/canonical 검증은 server-side에서도 강제해야 한다.
- 일반 Supervisor App은 고정 IP를 요청하지 않고 App pool에 동적으로 연결되므로 현재 `/32`는 update/recreate 뒤 영구 신원이 아니다.
- `trusted_networks` source가 `trusted_proxies`와 겹치면 Core가 provider login을 거부하며, Docker 전체 대역 신뢰나 synthetic X-Forwarded-For는 다른 App 사칭 범위를 넓힌다.
- Core의 지원되는 admin WebSocket API는 `group_ids`와 `local_only`를 지정한 일반 user 생성과 Home Assistant credential 연결을 제공한다. `.storage` 직접 편집은 필요하지 않다.
