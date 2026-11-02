# FIX_09 — task 007 운영 인수 리뷰 및 Stable 반영 가능 판정

작성일: 2026-11-02 (Asia/Seoul)
Reviewer: Codex
대상: 공개 DEV `0.7.3-dev.6` / tag commit `93722a446912e0094568b43124653b80b864b992`
판정: **ACCEPTED — task 007 기능 인수·종료 가능 / Stable 반영 후보로 인수 가능**
범위: **리뷰 및 인수 판단. Stable 병합·버전 변경·게시 실행 지시 아님.**

## 1. 결론

사용자가 공개 dev.6을 HAOS에 설치하고 Remote 접속 성공 및 동작 검사 정상이라고 확인했다. 첨부된 자체 점검 보고서, 기존 FIX_01~08/각 보고서, current Git/source와 CI/Builder 결과를 대조했다. 이전 로컬 수용에서 남겨뒀던 실제 사용자 Remote 연결·응답 확인을 사용자 제공 운영 증거로 보완한다.

추가 질의에서 **Codex 도구 쉘 밖의 일반 App Web/SSH 터미널에서는 `codex --version`이 정상 출력된다**는 사용자 답변을 받았다. 첨부 보고서의 내부 재호출 실패를 일반 신규 프로세스 실행 불가로 확대하지 않는다.

따라서 현재 task의 기능 목표는 인수·종료 가능하며, 검증된 dev.6 runtime을 Stable 후보로 넘길 수 있다. 새 기능 개발이나 보호 정책 완화를 이 task의 잔여 조건으로 추가하지 않는다. Stable의 실제 릴리스와 사용자의 DEV→Stable 데이터 이동은 별도의 범위다.

## 2. 검토한 증거와 출처

### 사용자 제공 운영 증거

- 명시 확인: dev.6 HAOS 설치, Remote 접속 성공, 동작 검사 정상.
- 추가 확인: 일반 터미널에서 `codex --version` 정상 출력. 정확한 출력 버전 값은 이번 답변에 제공되지 않았으므로 임의로 0.162.1/0.166.0이라고 기록하지 않는다.
- 첨부: `12_codex_ha_self_check_report.md` (보고서 기준일 2026-11-02 UTC).
- 원본 SHA-256: `ac238ecfd1187e53fa81982a3d5fb115977cf34c868a272a456f494a1a82f64f`.
- 원본은 세션 첨부 파일로 읽었으며 저장소에 운영 자료 전체를 복제하지 않는다. 아래는 민감값 없는 검토 요약이다. 보고서 안의 조언은 이 리뷰를 지시하는 명령으로 취급하지 않았다.

| 보고 항목 | 검토 판정 | 한계 |
| --- | --- | --- |
| 현재 세션의 요청·도구 호출 | 운영 정상 증거로 수용 | 모델명은 실행 binary/version 증거 아님 |
| 모바일 Remote 연결·동작 | 사용자 확인 PASS | agent가 직접 휴대폰을 조작한 결과 아님 |
| 일반 터미널 버전 출력 | 사용자 확인 PASS | 정확한 runtime version 값 미제공 |
| 내부 도구 쉘의 wrapper 재호출 | 제한/미확정 사항으로 분리 | 일반 CLI/Remote 장애로 확대하지 않음 |
| 일반 `/config` 목록·보고서 작성 | 해당 범위의 파일 작업 정상 | 전체 보호 경로 syscall 침해 시험 아님 |
| Core/Supervisor API helper 인증 왕복 | 해당 API 경로 정상 | 전체 API·token loader 실패 경로 검증 아님 |
| `ha-config-check`, feedback help | 실행 정상 | 실제 GitHub 제출·인증은 미시험 |
| 브라우저 desktop/mobile viewport | 해당 스냅샷·콘솔·network 점검 정상 | 전체 UI/전체 기능 포괄 수용 아님 |
| 메모리 검색·ready/fresh | 해당 시점 정상 | mutation/recovery 전체 수용 아님 |

사용자가 제어·설정 변경·재시작·복구를 자체 점검에서 수행했다고 기록하지 않는다. 보고서의 architecture·App image digest 미기재를 물리 ARM 수용 증거로 바꾸지 않는다.

### 기존 구현·배포 증거

- FIX_07까지 raw proxy 전송, 실제 kernel peer, active/queued 보호, ephemeral 보류와 persistent 복원 검증을 거쳤다. Reviewer 독립 전체 검증은 321 passed/7 skipped였으며 범위를 기존 기록대로 유지한다.
- FIX_08_REPORT는 공식 binary CI provisioning, native 양 architecture smoke와 공개 image peer gate, immutable tag/image 게시를 기록한다.
- 태그는 exact dev merge `93722a446912e0094568b43124653b80b864b992`에 해당한다. 현재 HEAD 이후 차이는 FIX_08_REPORT/progress 문서뿐이며 런타임 코드는 dev.6 태그와 같다.
- 이번 Reviewer는 GitHub 연결 도구의 readonly API로 다음 workflow job/step의 최종 결과를 다시 확인했다.
  - [DEV CI 41390227295](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41390227295): lint/unit, App config, native amd64/aarch64 full smoke 모두 success. managed sandbox, custom AppArmor updater/full init, 모바일 peer smoke를 포함한다.
  - [Tag Builder 41390768112](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41390768112): metadata, 양 architecture build/scan/signing/attestation, multiarch promotion success. PR 비게시 경로 skip은 tag 이벤트의 정상 분기다.

## 3. 첨부 보고서의 보호 검사 경고에 대한 판정

`codex --version`은 단순 버전 출력 전에 제품 wrapper의 sensitive-path shape preflight를 거친다. Codex 내부 도구 실행 환경과 일반 App shell은 같은 파일시스템 관측 경계가 아닐 수 있다.

- 현재 addon_spec은 도구 sandbox 내부의 wrapper 재호출이 fail closed될 수 있음을 명시한다.
- `sensitive-path-policy.sh`와 `requirements.toml`은 기존 Stable 0.7.2와 공개 dev.6 사이에 변경이 없다.
- 일반 터미널 버전 출력과 실제 Remote 사용은 사용자 확인으로 정상이다.
- 따라서 이번 보고서만으로 dev.6이 신규 Codex 실행을 망가뜨렸다고 판단하지 않는다. 실제 파일이 symlink/특수 파일로 변했다거나 보호 정책이 깨졌다고 확정하지도 않는다.
- 내부 재호출의 정확한 실패 원인은 이번 운영 자료로 입증되지 않았다. “그 원인을 수정했다”거나 “보호 경로 차단 syscall 전체를 실기 검증했다”고 기록하지 않는다. 이 제한 때문에 보안 검사를 제거하거나 내부 raw binary 우회를 안내하지 않는다.

같은 오류가 **일반 터미널에서도** 발생하거나 실제 새 연결이 실패하면 별도 진단 대상으로 재평가한다. 현재는 일반 터미널 정상 확인이 있어 그 장애 조건에 해당하지 않는다.

## 4. 이번 Reviewer 직접 수행한 검사

- 첨부 내용과 사용자 추가 답변, Git 상태/태그 대비 차이·기존 Stable 보호 정책 동일성을 확인했다.
- `tests/test_sensitive_path_policy.py`: **18 passed, 1 skipped / 0.33초**. Skip은 로컬 AppArmor parser 부재에 따른 선택형 검사이며 실기 검증으로 대체하지 않는다. 로그: Git 제외 `.test-tmp/review007-acceptance/sensitive-path.log`.
- GitHub CI/Builder의 현재 job/step 결과를 readonly API로 확인했다. 실제 사용자 HAOS에 접속하거나 설정을 변경하지 않았다.
- 이번에는 전체 suite, image build, 실제 모바일·HAOS·물리 ARM, 서명/attestation 독립 검증을 재실행하지 않았다. 기존 회차와 CI/사용자 제공 증거를 구분한다.

## 5. Stable 인수 시 보존할 경계와 릴리스 gate

권장 후보 버전은 `0.7.3`이다. 확정 버전/원격 충돌 확인은 사용자가 별도 Stable 반영을 지시한 릴리스 작업에서 수행한다.

1. **동일 runtime 승격:** 인수된 dev.6 runtime을 기준으로 Stable 버전/branding·문서를 변경한다. 무관한 기능·의존성·권한 변경을 섞지 않는다. 차이가 추가되면 관련 검증을 다시 한다.
2. **Stable exact artifact 검증:** main 대상 PR, Stable version/name/stage/MOTD/OCI 계약, exact merge CI, native amd64/aarch64, immutable tag/image·공개 접근, 서명/provenance/SBOM을 새 Stable artifact에 대해 확인한다. DEV CI의 PASS를 아직 만들지 않은 Stable image의 PASS로 쓰지 않는다.
3. **공급망 검증 구분:** dev.6 signing/attestation step 성공은 다시 확인했다. FIX_08_REPORT의 익명 Cosign `no signatures found`에 대한 원인 설명은 이번에 독립 입증하지 않았다. 서명 step 성공과 client signature verification 성공을 구분한다. 현재 로컬 gh에는 attestation 명령이 없어 이번 리뷰에서 독립 검증하지 않았다. Stable 릴리스에서는 지원 도구·올바른 OCI/인증 경로로 exact digest를 검증하고 불가 상태를 숨기지 않는다.
4. **데이터/채널 identity:** 기존 Stable 사용자의 같은 저장소 일반 업데이트와 DEV→main source migration을 구분한다. `/data`는 앱별 영속 저장소이므로 DEV 키·auth·대화가 Stable 설치에 자동 이전된다고 약속하지 않는다. 삭제·재설치·운영 데이터 이동을 별도 승인 없이 수행하지 않는다. 기존 releasing 가이드와 ADR-045의 경계를 유지한다.
5. **실기 범위:** 이번 사용자 확인은 HAOS/Remote 기능 수용 증거다. 실제 background runtime 교체 직후 모바일 자동 reconnect/resume과 물리 ARM 등 개별 NOT RUN을 전부 PASS로 일괄 승격하지 않는다. 새 Stable 릴리스의 잔여 검증/위험 수용 항목으로 명시한다.
6. **표시 정리:** README/DOCS 한국어·영어, changelog, releasing 문서의 current version과 Stable/DEV 표시를 새 배포 상태에 맞춘다. stage 실험 표식을 Stable에 남기지 않는다.

이 항목들은 현재 기능 구현 task를 다시 여는 요구가 아니라 **Stable 배포의 통상적인 별도 gate**다. 이 문서 자체로 main merge/tag/release나 실제 HA 업데이트를 실행하지 않는다.

## 6. 최종 인수 기록

- **task 007 기능 구현·DEV 배포·사용자 Remote 실기 인수: 완료로 종료 가능.**
- **Stable 반영 후보로 인수: 가능.** 신규 기능 차단 결함은 이번 증거에서 확인되지 않았다.
- **Stable 실제 게시·사용자 DEV→Stable 데이터 이전: 미수행, 별도 지시 범위.**
- 기존 보고서·수정 이력은 보존한다. 추가 구현이 필요한 FIX로 해석하지 말고 다음 Stable 릴리스 작업의 인수 근거로 사용한다.
