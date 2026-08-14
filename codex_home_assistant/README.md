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

- root·중첩 `secrets.yaml`과 `.storage`를 제외한 `/config`를 읽고 수정하는 Codex CLI
- Home Assistant Core API와 Supervisor `manager` helper
- 브라우저를 닫았다 다시 열어도 이어지는 공유 `tmux` Web 터미널
- ChatGPT 모바일 Remote가 앱 내장 Codex에 직접 연결할 수 있는 공개키 전용 SSH
- Home Assistant 모바일 앱/웹의 **OPEN WEB UI**
- 대시보드의 데스크톱·모바일 화면과 console/network 오류를 확인하는 Headless Chromium
- HA 구조와 사용자가 명시한 별칭·용도·선호를 보존하는 프로젝트 자체 검증형 로컬 메모리
- 앱 버그와 기능 제안을 읽기 전용으로 검증하고 정제된 보고서로 만드는 `$ha-feedback`

> [!WARNING]
> 이 앱은 Home Assistant 설정과 원시 Core/Supervisor API 응답을 다루는 강한 관리자 도구입니다. 보호 경로 외 `/config`와 API·로그·브라우저 결과에는 민감정보가 있을 수 있습니다. 중요한 변경 전에는 backup을 만들고 계획과 diff를 확인하세요. SSH 포트를 인터넷에 직접 공개하지 마세요.

## 빠른 시작

1. 안정판 `0.7.0` 앱을 설치하고 시작합니다. `amd64`와 64비트 `aarch64`를 지원합니다. Manifest는 `stage` 키를 생략해 Supervisor의 기본 stable 채널을 사용하며 `boot: manual`입니다. Native ARM CI와 멀티아키텍처 image 검증은 통과했습니다. 실제 Raspberry Pi/aarch64 HAOS 실기는 실행되지 않았고, 이 공백은 자동 검증 결과를 근거로 릴리스 승인 과정에서 명시적으로 수용됐습니다.
2. **OPEN WEB UI**를 누릅니다.
3. 처음 한 번 `ha-codex-login`으로 로그인합니다.
4. `ha-codex`를 실행합니다.
5. “현재 구성을 읽기 전용으로 살펴보고 아직 수정하지 마”라고 시작해 보세요.

SSH를 사용하지 않는다면 `authorized_keys`를 비워 둬도 됩니다. Web UI는 그대로 동작합니다.

Custom AppArmor와 `/etc/codex/requirements.toml`은 모든 `secrets.yaml`과 `/config/.storage` content의 직접 접근을 명시적으로 차단합니다. 따라서 정상적인 Codex 직접 파일 접근 경로로는 이 content를 읽을 수 없고 그 내용이 Codex에 전달되지 않습니다. Validator용 `.storage` directory listing만 AppArmor profile에 남기고 managed requirements는 Codex의 directory read도 거부합니다. Init과 매 Codex 실행은 symlink·특수 파일·다중 hardlink를 fail closed 검사합니다. 나머지 `/config`는 RW이며 검사 후 외부 hardlink 추가, 비보호 경로로 복사된 값, root runtime credential, API·로그·브라우저 raw 결과까지 막는 완전한 DLP는 아닙니다.

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

```text
$ha-feedback bug 앱에서 발견한 증상을 읽기 전용으로 재현·진단하고 공개 가능한 보고서를 만들어 줘.
```

GitHub 직접 제출은 후보 검색이 가능한 경우의 10분 만료·1회용 preview와 별도 확인 뒤에만 실행됩니다. 검색 또는 제출 결과가 불확실하면 자동 재시도하지 않고 Issue Form으로 전환합니다.

설치, 전체 설정값, 모바일 Remote, 업데이트, 보안과 문제 해결은 [한국어 사용 설명서](DOCS.md)를 확인하세요. 영문 안내는 [English user guide](DOCS.en.md)에 있습니다.

비공식 커뮤니티 프로젝트이며 OpenAI 또는 Home Assistant/Nabu Casa와 제휴하거나 보증받은 제품이 아닙니다.
