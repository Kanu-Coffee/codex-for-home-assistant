# references.md — 공식 근거

검증 기준일: **2026-07-12**

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

## 구현 참고 프로젝트

- Advanced SSH & Web Terminal  
  https://github.com/hassio-addons/app-ssh

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
- Headless Codex는 `codex login --device-auth` 또는 local `auth.json` 복사를 지원한다.
- Codex config는 `approval_policy`, `sandbox_mode`, file credential store를 지원한다.
