# Codex for Home Assistant — 문서 주도 개발 패키지

이 디렉터리는 **Home Assistant OS용 `Codex for Home Assistant` App(구 Add-on)** 을 구현하기 위한 단일 문서 기준점이다.

프로젝트의 핵심은 다음 세 기능을 하나의 Home Assistant App에 제공하는 것이다.

1. 컨테이너 내부의 **Codex CLI**
2. Home Assistant Ingress 기반 **웹 터미널**
3. 일반 SSH 및 Codex Desktop용 **Remote SSH**

App은 별도 설정 없이 Home Assistant의 `/config` 전체를 읽고 쓸 수 있으며, Home Assistant Core API와 Supervisor API의 `manager` 역할을 사용해 상태 조회, 서비스 호출, 실제 기기 테스트, 로그 확인, 설정 검사, Core/App 운영을 수행한다.

## 문서 읽기 순서

AI 에이전트와 사람 모두 아래 순서를 따른다.

1. `AGENTS.md` — 에이전트 진입점
2. `rules.md` — 최상위 작업 규칙
3. `progress.md` — 현재 상태와 다음 할 일
4. `product_spec.md` — 제품 요구사항과 수용 기준
5. `architecture.md` — 런타임 및 데이터 흐름
6. `addon_spec.md` — Home Assistant App 계약과 파일 구조
7. `security.md` — 권한·위험·운영 가드레일
8. `implementation_plan.md` — 구현 순서와 완료 정의
9. `test_plan.md` — 검증 매트릭스
10. `release_git.md` — GitHub 및 릴리스 절차
11. `decisions.md` — 확정된 설계 결정
12. `references.md` — 최신 공식 근거

## 문서 간 우선순위

충돌이 있으면 다음 순서로 해석한다.

1. 사용자의 현재 명시적 지시
2. `rules.md`
3. `decisions.md`의 Accepted 결정
4. `product_spec.md`
5. `architecture.md` 및 `addon_spec.md`
6. 나머지 문서

충돌을 발견한 에이전트는 임의로 조용히 선택하지 말고, 결정을 내린 뒤 관련 문서와 `progress.md`를 같은 작업에서 갱신한다.

## 현재 상태

- 요구사항 및 구조 문서화: 완료
- 구현 코드: 미작성
- 첫 목표: 동작 가능한 amd64 MVP 구현, 검증, GitHub push 및 PR 생성

상세 상태는 `progress.md`가 유일한 기준이다.

## 첫 실행

`master_prompt.md`의 프롬프트를 Codex Desktop에 붙여 넣는다. Codex는 이 문서 세트를 프로젝트 루트로 옮기거나 현재 저장소에 병합한 뒤 구현을 시작해야 한다.

## 프로젝트 이름

- 표시명: `Codex for Home Assistant`
- 권장 GitHub 저장소명: `codex-for-home-assistant`
- 권장 App 디렉터리: `codex_home_assistant`
- 권장 App slug: `codex_home_assistant`

## 중요한 구현 사실

- 2026년 Home Assistant 공식 문서의 명칭은 **App**이며, 과거 명칭은 Add-on이다.
- SSH **외부 포트**는 `options` JSON 값이 아니라 Home Assistant App의 **Network 설정**에서 변경한다.
- `SUPERVISOR_TOKEN`은 이 프로젝트의 의도상 웹 터미널과 SSH/Codex 세션에서 사용 가능하게 한다.
- `hassio_role`은 `manager`로 고정하며 `admin`, `docker_api`, `full_access`, `host_network`는 사용하지 않는다.
- App 자체는 강력한 관리자 도구이므로 기본적으로 `stage: experimental`, 관리자 전용 패널, 공개키 SSH만 허용한다.
