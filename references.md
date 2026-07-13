# references.md — 공식 근거

검증 기준일: **2026-07-13**

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

- Codex Remote SSH connections  
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
- Supervisor API는 `http://supervisor/`와 `SUPERVISOR_TOKEN`을 사용한다.
- `hassio_role` 값에는 `manager`와 `admin`이 별도로 존재한다.
- Codex Remote SSH는 원격 login shell의 PATH에서 `codex`를 찾고 원격 인증을 요구한다.
- ChatGPT mobile Remote는 SSH host에 직접 연결하지 않고 페어링된 desktop app을 제어하며, desktop app이 SSH remote project와 app server를 담당한다.
- Headless Codex는 `codex login --device-auth` 또는 local `auth.json` 복사를 지원한다.
- Codex config는 `approval_policy`, `sandbox_mode`, file credential store를 지원한다.
- Supervisor 2026.04부터 legacy `build.yaml`과 자동 `BUILD_FROM` 주입을 사용하지 않으며 Dockerfile이 build source of truth다.
- 현재 generic Home Assistant Alpine base는 `3.24`, builder composite actions는 `2026.06.0`이다.
- Codex CLI는 `0.144.1` amd64 musl release artifact와 GitHub asset digest를 사용한다.
- Codex Remote SSH는 remote login shell의 PATH에서 `codex`를 찾고 remote host 자체의 인증을 요구한다.
- Supervisor Core/App 로그 endpoint는 `Accept: text/plain` 또는 `text/x-log`를 사용하며 JSON Accept만 보내면 협상이 실패할 수 있다.
- Codex는 `CODEX_HOME`의 `AGENTS.md`를 전역 지침으로 읽고 프로젝트 root부터 현재 디렉터리까지 더 가까운 지침을 뒤에 결합한다.
