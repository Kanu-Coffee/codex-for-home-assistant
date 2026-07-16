# Documentation assets

## Web terminal previews

- `web-terminal-preview.png`: desktop viewport, 1280×855
- `web-terminal-mobile-preview.png`: mobile viewport, 390×844

두 이미지는 public `0.5.0` image의 실제 `ttyd` + `tmux` Web terminal을 비밀정보 없는 격리 Docker 환경에서 캡처했습니다. `/etc/motd`, 설치된 Codex CLI 버전과 `/config` 작업 경로만 표시합니다.

실제 HAOS에서는 이 terminal이 Home Assistant Ingress 안에 표시됩니다. 캡처에는 Home Assistant sidebar와 Ingress frame이 포함되지 않았으므로 실제 HAOS 전체 화면으로 오해할 수 있는 문구를 사용하지 마세요.

향후 실제 HAOS 캡처를 추가할 때는 token, 사용자명, 내부 URL, 위치, entity ID, dashboard 내용과 notification을 가리고 desktop/mobile 양쪽에서 동작을 재확인해야 합니다.
