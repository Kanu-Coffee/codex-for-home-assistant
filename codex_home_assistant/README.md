<p align="right">
  <strong>한국어</strong> · <a href="README.en.md">English</a>
</p>

# Codex for Home Assistant

Home Assistant 안에서 Codex와 대화하며 설정을 살펴보고 대시보드, 자동화, 엔티티와 오류를 정리할 수 있는 Ingress Web 터미널 앱입니다.

<p align="center">
  <img src="https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/main/docs/assets/web-terminal-preview.png" alt="Codex for Home Assistant 실제 Web 터미널 미리보기">
</p>

<p align="center"><em>공개 0.5.0 이미지의 실제 Web 터미널을 격리 Docker에서 캡처했습니다. 실제 HAOS에서는 Home Assistant Ingress 안에 표시됩니다.</em></p>

## 주요 기능

- `/config` 전체를 읽고 수정하는 Codex CLI
- Home Assistant Core API와 Supervisor `manager` helper
- 브라우저를 닫았다 다시 열어도 이어지는 공유 `tmux` Web 터미널
- 공개키 전용 SSH와 데스크톱 Codex SSH 프로젝트
- Home Assistant 모바일 앱/웹의 **OPEN WEB UI**
- 대시보드의 데스크톱·모바일 화면과 console/network 오류를 확인하는 Headless Chromium
- HA 구조와 사용자가 명시한 별칭·용도·선호를 보존하는 프로젝트 자체 검증형 로컬 메모리

> [!WARNING]
> 이 앱은 Home Assistant 설정을 직접 바꿀 수 있는 강한 관리자 도구입니다. 중요한 변경 전에는 backup을 만들고 계획과 diff를 확인하세요. SSH 포트를 인터넷에 직접 공개하지 마세요.

## 빠른 시작

1. 앱을 설치하고 시작합니다. 현재 **amd64 전용**, `stage: experimental`, `boot: manual`입니다.
2. **OPEN WEB UI**를 누릅니다.
3. 처음 한 번 `ha-codex-login`으로 로그인합니다.
4. `ha-codex`를 실행합니다.
5. “현재 구성을 읽기 전용으로 살펴보고 아직 수정하지 마”라고 시작해 보세요.

SSH를 사용하지 않는다면 `authorized_keys`를 비워 둬도 됩니다. Web UI는 그대로 동작합니다.

## 활용 예시

```text
Bubble Card가 이미 설치되어 있는지 확인하고,
현재 대시보드를 보존하면서 모바일 1열 홈 화면을 설계해 줘.
먼저 계획과 diff만 보여 주고 승인 뒤 적용·검증해 줘.
```

```text
내 평일 기상·외출·귀가 시간과 현재 센서를 바탕으로
만들 만한 자동화 5개를 오작동 방지 조건과 함께 제안해 줘.
아직 파일은 수정하지 마.
```

설치, 전체 설정값, 모바일 Remote, 업데이트, 보안과 문제 해결은 [한국어 사용 설명서](DOCS.md)를 확인하세요. 영문 안내는 [English user guide](DOCS.en.md)에 있습니다.

비공식 커뮤니티 프로젝트이며 OpenAI 또는 Home Assistant/Nabu Casa와 제휴하거나 보증받은 제품이 아닙니다.
