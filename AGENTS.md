# AGENTS.md

이 저장소에서 작업하는 AI 에이전트는 구현 전에 다음 순서로 맥락을 확인한다.

1. `docs/development/rules.md`의 저장소 원칙과 제품 불변조건을 읽는다.
2. `docs/development/progress.md`에서 현재 상태와 미검증 항목을 확인한다.
3. 변경과 관련된 `product_spec.md`, `architecture.md`, `addon_spec.md`, `security.md`, `test_plan.md`를 `docs/development/`에서 읽는다.
4. 작은 범위로 변경하고 위험에 맞는 검증을 수행한다.
5. 사용자 영향이 있으면 한국어·영어 README/DOCS, 예시와 changelog를 함께 검토한다.
6. 완료 전 `git diff`와 실제 테스트 결과를 확인하고, 검증하지 않은 항목은 명시적으로 남긴다.

개발 문서 지도는 `docs/development/README.md`, 과거 계획은 `docs/archive/README.md`를 따른다. 보관 문서는 현재 지침으로 사용하지 않는다.

## 절대 조건

- 테스트하지 않은 것을 테스트 완료라고 쓰지 않는다.
- 비밀값, `SUPERVISOR_TOKEN`, Codex `auth.json`, browser token과 SSH private key를 출력하거나 커밋하지 않는다.
- `/config` 전체 read-write와 Core/Supervisor API `manager` 권한은 현재 제품 요구사항이다. 임의로 제한 proxy나 read-only 구조로 바꾸지 않는다.
- `hassio_role: admin`, `docker_api: true`, `full_access: true`, `host_network: true`, `apparmor: false`를 도입하지 않는다.
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/AGENTS.md`는 image에 포함되는 런타임 지침이다. 이 루트 개발용 파일과 혼동하지 않는다.
- Home Assistant App과 OpenAI Codex의 시점 의존 동작을 구현하거나 문서화할 때는 최신 공식 문서를 다시 확인한다.
- 외부 push, PR, release와 실제 Home Assistant 변경은 사용자가 요청하거나 명시적으로 승인한 범위에서만 수행한다.
