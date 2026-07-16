# 개발 문서

[프로젝트 README](../../README.md) · [기여 안내](../../CONTRIBUTING.md) · [보관 문서](../archive/README.md)

이 디렉터리는 사용자 설치 안내와 분리된 구현 계약, 아키텍처, 보안 모델, 테스트 전략과 검증 기록을 보관합니다. 런타임 이미지에는 포함되지 않습니다.

## 문서 지도

| 문서 | 역할 |
| --- | --- |
| [rules.md](rules.md) | 저장소 작업 원칙과 제품 불변조건 |
| [product_spec.md](product_spec.md) | 제품 요구사항과 수용 기준 |
| [architecture.md](architecture.md) | 신뢰 경계, 런타임 구성요소와 데이터 흐름 |
| [addon_spec.md](addon_spec.md) | Home Assistant 앱 패키징·옵션 계약 |
| [security.md](security.md) | 상세 threat model과 운영 가드레일 |
| [test_plan.md](test_plan.md) | 자동·컨테이너·HAOS 검증 전략 |
| [decisions.md](decisions.md) | Architecture Decision Records |
| [references.md](references.md) | 공식 근거와 구현 참고 자료 |
| [progress.md](progress.md) | 릴리스·실기·CI 증거를 포함한 누적 개발 기록 |
| [releasing.md](releasing.md) | 현재 workflow 기반 릴리스·검증·롤백 절차 |

## 작업 순서

1. 루트 [AGENTS.md](../../AGENTS.md)와 [rules.md](rules.md)를 읽습니다.
2. [progress.md](progress.md)에서 현재 상태와 검증 공백을 확인합니다.
3. 변경과 관련된 제품·아키텍처·보안·테스트 계약을 읽습니다.
4. 런타임 변경은 작은 단위로 구현하고 관련 자동 테스트를 실행합니다.
5. 사용자 영향이 있으면 앱 `README.md`, `DOCS.md`, 영문 문서와 `CHANGELOG.md`를 함께 갱신합니다.
6. 테스트하지 않은 사항은 PASS로 기록하지 않습니다.

## 런타임 경계

앱 동작을 바꾸는 주요 표면은 다음과 같습니다.

- `codex_home_assistant/rootfs/**`
- `codex_home_assistant/Dockerfile`
- `codex_home_assistant/playwright/package*.json`
- `codex_home_assistant/config.yaml`
- `.github/workflows/**`
- `tests/**`

일반 README와 이 디렉터리의 문서는 Docker image에 복사되지 않습니다. 반면 `codex_home_assistant/rootfs/usr/local/share/codex-ha/AGENTS.md`는 런타임 지침이므로 루트의 개발용 `AGENTS.md`와 혼동하지 마세요.

## 현재 배포 제약

- `amd64` 전용
- `stage: experimental`
- 기본 `boot: manual`
- public GHCR version tag 기반 배포
- Supervisor `manager`, `/config` read-write
- `hassio_role: admin`, Docker API, `full_access`, host network와 AppArmor 비활성화는 사용하지 않음

과거 MVP 프롬프트와 초기 구현·Git 운영 계획은 [archive](../archive/README.md)에 보존되어 있으며 현재 지침으로 사용하지 않습니다.
