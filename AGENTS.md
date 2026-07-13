# AGENTS.md

이 저장소에서 작업하는 모든 AI 에이전트는 코드를 읽거나 수정하기 전에 다음을 수행한다.

1. `rules.md` 전체를 읽는다.
2. `progress.md`에서 현재 마일스톤과 미완료 항목을 확인한다.
3. `product_spec.md`, `architecture.md`, `addon_spec.md`, `security.md`, `test_plan.md`에서 현재 작업과 관련된 항목을 읽는다.
4. 작업 계획과 검증 방법을 `progress.md`의 Current Work에 기록한다.
5. 구현·테스트·문서 갱신·Git 작업을 하나의 완결된 변경으로 수행한다.
6. 완료 직전에 `progress.md`를 실제 결과에 맞게 갱신한다.

## 절대 조건

- 테스트하지 않은 것을 테스트 완료라고 쓰지 않는다.
- 비밀값, `SUPERVISOR_TOKEN`, Codex `auth.json`, SSH 개인키를 출력하거나 커밋하지 않는다.
- `/config` 전체 RW와 Core/Supervisor API `manager` 권한은 제품 요구사항이다. 임의로 제한 프록시나 읽기 전용 구조로 바꾸지 않는다.
- `hassio_role: admin`, `docker_api: true`, `full_access: true`, `host_network: true`, `apparmor: false`를 도입하지 않는다.
- Home Assistant의 최신 공식 App 예제와 OpenAI Codex 공식 문서를 구현 시점에 다시 확인한다.
- 작업이 끝나면 기능 브랜치에 커밋하고 GitHub로 push하며, 가능하면 PR을 만든다.
