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

- Stable `0.7.0`은 `amd64`, 64비트 `aarch64` release; native aarch64 CI와 멀티아키 GHCR 검증은 `PASS`
- 실제 Raspberry Pi/aarch64 HAOS 수용은 `NOT RUN`; 2026-08-14 릴리스 승인에서 이 공백을 명시적으로 수용했으며 실행한 것으로 표기하지 않음. Armv7/32-bit ARM은 미지원
- `stage: stable`
- 기본 `boot: manual`
- public GHCR version tag 기반 배포
- Supervisor `manager`, 고정 민감 경로 밖의 `/config` read-write
- AppArmor가 root/nested `secrets.yaml`과 `.storage` content를 정상적인 Codex 직접 파일 접근에서 명시적으로 차단해 해당 경로로 내용이 Codex에 전달되지 않으며 managed Codex requirements가 `.storage` directory read도 차단; validator용 AppArmor listing allowance는 profile 범위에 남음
- Init/Codex launch가 보호 tree의 symlink·special-file·pre-existing-hardlink를 fail closed 검사; post-check external hardlink TOCTOU와 비보호 copy는 잔여 한계
- 기본/강제 Codex sandbox는 network-enabled `workspace-write`; legacy danger option은 호환 입력만 유지
- Interactive/Codex/S6에 ambient `SUPERVISOR_TOKEN`을 상속하지 않지만 root process의 runtime credential 직접 read와 raw API response는 잔여 위험
- `hassio_role: admin`, Docker API, `full_access`, host network와 AppArmor 비활성화는 사용하지 않음

과거 MVP 프롬프트와 초기 구현·Git 운영 계획은 [archive](../archive/README.md)에 보존되어 있으며 현재 지침으로 사용하지 않습니다.
