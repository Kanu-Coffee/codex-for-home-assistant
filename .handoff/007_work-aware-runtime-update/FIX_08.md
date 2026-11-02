# FIX_08 — Reviewer 수용 및 DEV 0.7.3-dev.6 배포 지시

작성일: 2026-11-02 (Asia/Seoul)
Reviewer: Codex / 실행: 별도 Executor
리뷰 대상: `adfbaaa` / branch `feat/fix03-mobile-proxy-bootstrap`
판정: **ACCEPTED FOR DEV CANDIDATE PUBLICATION — 로컬 구현 수용**
예정 버전: **0.7.3-dev.6**
배포 상태: **지시 발행 / 실제 배포 전**

## 1. 사용자 요청과 수용 범위

사용자는 Reviewer 리뷰 후 합격이면 새 DEV 버전 배포를 지시하는 FIX를 발행하라고 요청했다. FIX_03~07의 수정 이력과 현 코드를 검토하고 아래 독립 검증에 근거해 로컬 구현을 수용한다. 이번 문서는 별도 Executor의 새 DEV 공개 배포 지시다. Reviewer는 제품 버전 변경·commit/push/PR/merge/tag/release·운영 HAOS 작업을 직접 실행하지 않는다.

수용은 **DEV 시험 후보 공개** 범위다. Stable 승격이나 실제 ChatGPT 모바일의 자동 reconnect/resume, HAOS·물리 ARM 수용까지 완료됐다는 판정은 아니다. 사용자의 DEV 업데이트/실기 확인을 위해 새 후보를 게시한다.

다음 Executor는 이 FIX를 실행하고 `FIX_08_REPORT.md`를 신규 작성한다. PLAN 및 기존 REPORT/FIX 문서는 보존한다. FIX_07은 보고서가 있으므로 반복 실행하지 않는다.

## 2. 리뷰에서 확인한 내용과 증거

- raw `app-server proxy`를 JSONL lifecycle host로 보내던 wrapper 분기를 분리했다. 실제 SSH/bootstrap 경로가 초기화·조회 RPC를 처리한다.
- proxy argv/record 불일치와 커널 peer 불일치가 unknown으로 보류된다. 경로·mtime·무관한 accepted connection만으로 owner를 인정하던 문제를 보완했다.
- status는 미관측 인증을 성공으로 표시하지 않으며, 다른 PID를 sshd listener로 오판하던 경로를 보완했다.
- nonempty ephemeral은 검사와 transaction pre-signal 단계에서 보류되고 기존 server/대화가 유지된다. 영속 대화는 실제 서버 세대 교체 후 복원·다음 turn의 문맥 유지 시험을 제공한다.
- 관리 record 존재/버전 문자열과 복원 capability를 구분하고 실제 restore 함수를 transaction에 연결했다.

### Reviewer 독립 검증

| 항목 | 결과 | 증거 |
| --- | --- | --- |
| 전체 pytest | **321 passed, 7 skipped / 145.45초** | `.test-tmp/review007-fix07/pytest-full.log` |
| 실제 이미지 SSH/S6/bootstrap 및 추가 peer inventory | **PASS**, helpers=1/unknown=0/canApply=true | `.test-tmp/review007-fix07/image-peer-smoke.log` |
| 이미지/소스 일치 | runtime manager 및 transaction SHA-256 일치 | 아래 식별값 |
| Node syntax(runtime manager/transaction), wrapper ShellCheck, diff | **PASS** | Reviewer 직접 실행 |
| b7b3479..HEAD 제품/시험 diff Gitleaks | **no leaks found** | Reviewer 직접 실행 |

검증 이미지: `codex-ha:test-fix07`, image ID `sha256:2a8e6937cb0c0ab3e38a1bdc1eb07d16ac9bcafaa2e78659292b933a2e3f3756`. 이 이미지는 **dev.5 label을 가진 로컬 시험본**이며 새 릴리스 이미지를 대신하지 않는다.

이미지와 HEAD의 일치 확인값:

- `codex-runtime-manager.mjs`: `3404d5d6878aa237e19daea13a13b47ccc6917c2d313b45a166f40e50042eee3`.
- `codex-server-transaction.mjs`: `44ff247a1287e4814e0470b29276a921314628ee552e53af6aae3a39b9a05c3e`.

전체 pytest는 `/tmp` quota와 긴 Unix socket 경로를 피하기 위해 Reviewer가 `/home/lee` 아래 직접 만든 짧은 임시 basetemp에서 실행했다. 해당 임시 디렉터리는 종료 후 정리했고 로그는 Git 제외 경로에 보존했다. 7개 skipped는 실행 완료로 간주하지 않는다. Executor는 배포 검증 시 실제 skip 사유를 기록한다.

추가 image peer smoke는 기존 `tests/mobile-ssh-smoke.py`에 검사 중 `inspectAllSessions()` 결과를 확인하는 부분만 붙인 격리 Reviewer 스크립트다. 실제 이미지의 Python/Netlink·등록 proxy/owner 인식은 확인했으나 제품 custom AppArmor·HAOS의 동일 동작을 확인한 것은 아니다.

## 3. 배포 전 필수 준비 — 새 CI에서도 검증이 재현되어야 함

### 3.1 Git·현재 상태와 버전 확정

1. AGENTS와 rules/progress, 관련 제품·구조·App·보안·시험 문서, 기존 handoff를 읽는다. Git status/diff, remote·인증, 현재 branch·HEAD를 확인한다. Reviewer가 추가한 FIX_08/progress와 다른 작업자 변경을 보존한다.
2. 현재 작업 branch의 FIX_03~07 커밋이 모두 포함되는지 확인한다. 최신 DEV를 fetch해 대조하고 필요하면 충돌을 해결한다. force push, reset/clean으로 기존 작업 삭제, handoff 이력 덮어쓰기를 하지 않는다.
3. 로컬에는 dev.5까지 확인됐으나 **실제 원격 tag/release/GHCR의 dev.6 사용 여부는 Executor가 다시 확인**한다. 이미 할당됐으면 덮어쓰지 말고 같은 계열의 다음 미할당 번호를 선택해 근거를 보고한다. 아래 명령·문서의 예정 버전을 확정 버전으로 맞춘다.

### 3.2 CI fixture 준비와 이미지 관측 gate

**중요:** 현재 신규 positive/negative 교체 시험은 `.test-tmp/task007-baseline/bin/codex`와 `.test-tmp/resume-166/bin/codex`의 실 패키지에 의존한다. 일부 시험은 없으면 assert 실패한다. 이 캐시는 Git에 없고 현 CI에는 해당 공식 패키지 준비 단계가 없다. 로컬 321 PASS만 보고 깨끗한 runner의 CI를 성공한다고 가정하지 않는다.

Executor는 릴리스 준비 범위에서 다음을 구현하고 검증한다.

- 기존 CI의 pytest 전에 공식 0.162.1과 0.166.0의 정확한 target 패키지를 다운로드·checksum 검증·안전 추출하는 재현 가능한 준비 단계/프로젝트 스크립트를 추가한다. 경로를 환경 인자로 일반화해도 되지만 해당 시험이 실제로 실행되게 한다.
- 실제 package layout·owner/mode를 유지한다. 잘못된 root 소유권·group write, 긴 socket path, archive까지 통째 복사하는 불필요한 부하를 검토한다. 테스트 편의를 위해 제품 inventory/integrity 검증을 낮추지 않는다.
- 공식 출처의 checksum과 실제 target/version을 고정·기록한다. 아키텍처별 native 실행은 해당 target을 사용한다. host 전용 시험과 image native 시험을 구분한다.
- 중요한 proxy/ephemeral/persistent 교체 시험을 통째로 skip 처리해 CI를 통과시키지 않는다. 기존 선택형 시험도 어떤 항목이 실행/skip됐는지 `pytest -ra`로 남긴다.
- 정상 proxy가 연결 중인 **실제 이미지**에서 peer inventory가 helpers로 인식되고 unknown이 아닌지 자동 smoke에 포함한다. 기존 Reviewer image-peer-smoke를 참고해 기존 image smoke를 확장한다. native amd64/aarch64 CI 양쪽에 연결한다.
- Python3와 Netlink 조회가 실제 이미지에서 사용 가능함을 검사한다. 필요한 런타임 의존성이 우연한 개발 환경에만 있지 않은지 확인한다. custom AppArmor/native CI에서 불가하면 원인을 해결하며 금지 권한을 추가하지 않는다.

이 작업은 이미 수용한 runtime 결함을 다시 구현하라는 지시가 아니라 **배포 전 재현성·릴리스 gate 보완**이다. 준비 중 새로운 runtime 결함이 발견되거나 관측·보호 계약을 바꿔야 한다면 그 변경과 회귀를 명확히 검토하고, 해결 전 게시하지 않는다.

### 3.3 메타데이터·사용자 문서

- `config.yaml` version, Dockerfile 기본 BUILD_VERSION, Playwright package.json 및 package-lock 루트/루트 package version을 dev.6 또는 확정 버전으로 일치시킨다. 의존성을 불필요하게 올리지 않는다.
- CHANGELOG에 새 버전 항목을 작성한다. dev.5의 과거 항목을 새 버전으로 덮어쓰지 않는다. proxy 전송/peer·상태 진단·복원과 ephemeral 보호를 요약한다.
- 한국어·영어 루트/App README·DOCS, runtime-handover/test_plan/progress의 버전과 실제 지원 경계를 정리한다. FIX_03~07 runtime 변경이 사용자 문서에서 빠지지 않게 한다.
- 사용자 안내: 기존 SSH 키는 유지되며 반복 revoke/키 재생성은 필요 없다. 실제 모바일 연결·모델 응답·다음 요청·업데이트 후 복원은 새 후보 설치 후 별도 수용 항목이다. 검증 불가능한 임시 대화는 안전을 위해 보류할 수 있다.
- DEV App 이름/panel/stage/repository/MOTD/OCI metadata를 유지한다. Stable `main`과 사용자 HAOS를 변경하지 않는다. bundled Codex 0.162.1 및 기존 스케줄·권한·민감경로 정책은 이번 릴리스 때문에 바꾸지 않는다.
- 게시 전 문구는 후보/검증 상태로, 게시 후 문구는 실제 결과에 맞춘다. 공개 완료를 먼저 선언하지 않는다.

## 4. 최종 로컬·CI 검증과 DEV merge

1. 새 버전·최종 소스에서 전체 pytest(`-ra`, 짧고 충분한 용량의 임시 basetemp), 관련 negative/positive 실 binary 시험을 실행한다. 공식 패키지/실행 파일 신원과 skip 사유를 기록한다.
2. Node syntax, ShellCheck, YAML/변경 Markdown, 필요 workflow actionlint/Dockerfile Hadolint, secret scan, diff 검사를 수행한다. 정책·토큰·민감경로 계약을 유지한다.
3. 새 label로 amd64 image를 build하고 실제 SSH/S6/bootstrap·키 보존/폐기·peer inventory smoke를 수행한다. 실제 AppArmor 시험과 native ARM 결과는 가능한 검사·CI에서 확인하고 미검증을 숨기지 않는다.
4. 명시적 파일 목록으로 커밋하고 branch를 push해 **base dev** PR을 만든다. 다중행 PR 본문은 파일/구조화 인자로 전달한다. PR 본문은 문제→수정→검증→실기 미검증 순으로 작성한다.
5. PR CI와 비게시 Builder의 최종 결론을 기다린다. metadata, full unit/lint, native amd64/aarch64 build/smoke 및 새 image-peer gate가 모두 성공해야 한다. 검사 중인 상태에서 merge 가능하다는 이유로 진행하지 않는다. admin 우회는 사용하지 않는다.
6. 통과한 exact PR HEAD를 DEV에 병합하고 merge SHA를 기록한다. 해당 merge SHA의 DEV CI도 성공한 뒤 tag를 진행한다. 이후 다른 commit이 들어왔다고 임의 최신 HEAD를 tag하지 않는다.

## 5. Immutable 게시와 공개 접근 확인

1. 확정 버전의 annotated tag를 exact DEV merge SHA에 만들고 해당 tag만 push한다. 기존 dev.5/tag/image를 덮어쓰지 않는다. 원격 tag의 dereference가 의도한 SHA인지 검증한다.
2. tag Builder를 끝까지 확인한다. amd64/aarch64 build, 취약점 gate, multiarch manifest, signing/attestation, final version tag promotion 모두 성공해야 한다. gate를 무력화하거나 미검토 예외로 통과시키지 않는다.
3. GHCR에서 버전 tag를 **익명 registry 자격**으로 조회한다. 임시 bearer token은 출력·로그·문서에 남기지 않는다. multiarch digest와 linux/amd64·linux/arm64 digest, App version labels를 확인한다.
4. 서명/provenance/SPDX는 workflow 성공과 독립 검증을 구분한다. 가능한 공식 도구로 expected repository/workflow/source tag·SHA/identity와 exact digest를 검증한다. 못 한 검증을 PASS로 쓰지 않는다.
5. exact 공개 이미지에서 새 version·명령·wrapper/peer smoke를 확인한다. 로컬 로그인으로 pull한 것만으로 공개 접근 완료라고 판단하지 않는다.
6. 익명 HTTP로 DEV repository.yaml과 config.yaml에 접근해 DEV 이름·확정 버전·image를 확인한다.
7. 이미 검증된 tag를 사용해 **draft=false, prerelease=true, Stable latest 아님**인 GitHub 사전 릴리스를 만든다. 명시적으로 DEV target을 사용하고 소스 tag가 exact merge SHA인지 재확인한다. 릴리스 노트에 실기 미검증과 client reconnect/resume 수용 경계를 명시한다.
8. `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`를 설치 경로로 전달한다. 실제 사용자 장치의 Store 노출/설치/재시작은 관측하지 않았다면 완료했다고 쓰지 않는다. 운영 HAOS는 사용자 별도 요청 없이 조작하지 않는다.

## 6. 실패 대응

- CI·native build·공개 접근·공급망·보호 정책 검증이 실패하면 게시 완료로 보고하지 않는다. 해당 단계 원인을 해결하고 영향을 받는 검사만 다시 수행한다.
- tag 게시 중 실패는 실제 공개 상태와 digest를 먼저 확인한다. 동일 source의 workflow 재실행은 기존 immutable 검증을 유지한다. 소스 변경이 필요하면 새 DEV 번호를 사용한다. 강제 tag 이동·다른 이미지 덮어쓰기는 하지 않는다.
- 사용자 데이터·키·auth를 지우지 않는다. Stable/main에 자동 rollback/promotion하지 않는다. 게시 후 중대 결함은 새 DEV 수정/되돌림 버전과 명확한 노트로 처리한다.

## 7. 보고와 완료 기준

`FIX_08_REPORT.md`를 새로 작성하고 progress를 갱신한다.

- 확정 App version, 원 코드 `adfbaaa` 포함 여부, 릴리스 준비 commit, PR URL, DEV merge SHA, immutable tag 및 dereference SHA.
- CI fixture provisioning·image peer gate 변경, 최종 로컬 검사·CI/Builder URL과 결과, skip 사유.
- exact image multiarch/하위 digest·version labels, 익명 source/registry 접근, signature/attestation 독립 검증 여부.
- prerelease URL과 draft/prerelease/latest 상태, DEV 설치 경로, 게시 결과 문서 갱신 여부.
- 실제 ChatGPT mobile 자동 reconnect/resume, HAOS/Supervisor·물리 ARM·custom AppArmor의 PASS/PARTIAL/NOT RUN을 정확히 구분한다. native CI를 물리 ARM 수용으로 바꾸지 않는다.
- 사용자 확인 항목: 기존 키로 모바일 연결 → 실제 응답·후속 요청 → 지원하는 영속 대화의 유휴 업데이트 뒤 복원. 실패 시 키를 요청하지 말고 인증 후 bootstrap/transport의 정제된 오류와 버전만 수집한다.

완료는 **확정 새 DEV의 최종 검사·CI·immutable image 게시·익명 접근·DEV source 새 버전·GitHub prerelease·정확한 보고**까지다. PR만 열거나 로컬 이미지 build만 하고 배포 완료라고 하지 않는다. Reviewer는 이번 문서 발행까지만 수행하며 실제 배포는 별도 Executor가 진행한다.
