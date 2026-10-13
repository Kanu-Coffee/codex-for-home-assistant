# FIX_10_REPORT — 실제 바이너리 검증과 기본 검사 fallback, DEV 0.7.1-dev.6 배포

- 역할: Executor, 2026-10-13 Asia/Seoul. FIX_10의 metadata/hash/product/architecture 결함을 수정했다. 독립 Reviewer 판정을 대신하지 않는다.
- 구현 커밋: root `5eb8a32`. 배포 커밋: `22fae4ffcf71750b8dccc8418ebb1b091a894ecf`; annotated tag `0.7.1-dev.6` object `4c4c79c75e37d6616a28cc0011f1b9cbae5b92d2`. 동일 배포 SHA의 DEV CI 성공 후 태그를 발행했다.
- main은 `a32698851e3c3539f5d4b823e60d4f0d29038df1`, stable 0.7.0·기존 DEV 태그/이미지·기존 handoff 문서는 보존했다. 운영 HA를 변경하지 않았다.

## 구현과 수정 결과

1. `.github/scripts/sbom-go-binary-preflight.py`: Go PURL/모듈 이름과 sourceInfo를 독립 대조한다. 문서 name/namespace 누락, 필수 module 누락, 중복/불명확 mapping을 거부한다. sourceInfo를 전부 제거해도 Go 없는 이미지로 처리하지 않는다. 실제 identity에 바이너리가 있는데 SBOM에서 Go 전체가 사라진 경우도 거부한다. 진짜 비-Go inventory는 빈 예외만 발급한다.
2. Docker image inspect의 immutable config ID로 임시 컨테이너를 만들고, 실행 없이 gh/yq 파일을 추출해 SHA256을 계산한다. 임시 컨테이너와 volume은 finally에서 제거한다. 실제 파일 SHA256 = SPDX files SHA256 = architecture별 reviewed manifest 값이어야 예외를 발급한다. Go module package checksum을 executable hash로 사용하지 않는다.
3. Linux/architecture/build matrix, product name/version, 단일 DESCRIBES image subject, OCI PURL과 SPDX root checksum의 일관성을 검증한다. Docker config ID와 SPDX manifest digest는 서로 다른 종류다. 둘을 같은 digest라고 주장하거나 비교하지 않는다. 실제 바이너리 bytes와 product/architecture 대조가 이번 identity 연결 근거다.
4. `.github/security/reviewed-go-binaries.json`: 기존 dev.5 Builder `38365844933`의 실제 architecture SBOM에 기록된 파일 해시를 고정했다. 원래 gh archive checksum 검증과 Alpine signed package 설치 경로는 유지한다. 해시 고정은 검토한 동일 bytes 식별이며 보안 패치나 모든 실행 경로의 exploitability 증명은 아니다.
5. 성공 시 검증한 원본 SBOM bytes의 snapshot과 한정 module 예외 config를 생성한다. Workflow 두 scanner 단계가 같은 snapshot/config를 사용한다. 실패 전에 과거 config/VEX/snapshot을 제거한다. 기본 `.grype.yaml`은 빈 ignore를 유지하며 Critical finding은 계속 빌드를 실패시킨다.
6. 제품 runtime/권한/옵션을 재작성하지 않았다. DEV branding, experimental 채널을 유지하고 App metadata/문서/계약의 버전을 0.7.1-dev.6으로 올렸다. 내장 Codex baseline은 0.162.1이다.

| 검토 파일 | amd64 SHA256 | arm64 SHA256 |
| --- | --- | --- |
| /usr/local/bin/gh | 141507c337e8b202ad398550c3b73d72f5af92e86f71665214538a81efd4c409 | ccbb0f14178faefac1cb0f336a853071fa63a1d0df23ef5ab7a304fe3859e082 |
| /usr/bin/yq | 6f1c9630222c71eaa4718a92bb7f13655290b6e5432e5e5691059894b6ac74ad | 8a70f06c16d44de4a4caaf38907e55f2da156c0f024e5be5acb7acfa3cee76b4 |

## 계획에서 조정한 부분

- 사용자의 과도한 gate 완화 요청에 따라 유효하지만 새 module/version/binary bytes는 exit 3으로 **예외 미발급 + 기본 취약점 검사**를 수행한다. 미검토 바이너리라는 이유만으로 영구 차단하지 않는다. 필수 metadata 누락, 실제 파일과 SBOM의 해시 불일치 등 모순은 exit 1로 차단한다. 새 파일에 기존 예외를 승계하지 않는다.
- 실제 Grype/SPDX 경로에서 image-scoped VEX product와의 매칭이 실패했다. SPDX adapter가 image tags/repoDigests 정보를 보존하지 않는 문제 때문에, VEX를 enforce한다고 주장하지 않는다. 생성 VEX는 exact subject/config ID/SBOM hash를 기록하는 감사 자료이며 scanner 입력에서 제거했다. 실제 enforcement는 actual-image preflight + 검증된 SBOM snapshot + config 한 경로다. 생성 config 자체는 다른 실행 환경에서 재사용을 막는 암호학적 capability가 아니며, CI producer가 검증한 snapshot과 함께 사용하도록 통제한다.

## 검증

- `.venv/bin/pytest -q`: **216 passed in 70.62s**. 로컬 실제 Grype 0.120.1 음성 대조 포함.
- Release metadata와 gate 집중 시험: **40 passed in 9.38s**. Gate 계약은 22개다.
- sourceInfo 제거, document identity 동시 제거, 필수 module/해시/identity 누락, 잘못된 product/architecture/OS, 중복 mapping, OCI digest 모순, 실제 hash 변경, Go inventory 제거의 실패 계약을 확인했다. 새 정상 의존성의 exit 3과 예외 미생성도 확인했다.
- 실제 scanner 대조: 검토 fixture는 gated Critical 0/ignored 6; sourceInfo 제거 fixture는 preflight 실패, raw Grype exit 2/Critical 6. 문자열 matcher로 scanner를 모사하지 않았다.
- 기존 양 architecture 실제 SBOM과 manifest 해시 대조 PASS. 로컬 실제 Docker 파일 추출로 amd64 gh/yq 해시 대조 PASS. Tag Builder의 amd64와 native ARM 모두 실제 이미지 추출/preflight/Critical gate PASS.
- Actionlint, Python compile, git diff --check PASS; YAML lint error 없음(경고 별도); `.github` Gitleaks PASS.
- [DEV CI 38372005484](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38372005484): exact SHA `22fae4f`, 전체 job SUCCESS. Lint job pytest **215 passed, 1 skipped**; scanner container가 없는 lint job에서 실제 Grype 대조 한 건만 skip, 로컬에서는 실행했다. amd64/native ARM runtime smoke, updater/persistence/AppArmor 경로 PASS.
- [Tag Builder 38372618286](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38372618286): 같은 SHA, amd64/aarch64 gate·publish·Cosign signing·provenance/SBOM attestation·multi-arch promotion SUCCESS. 비게시 build job의 skipped는 예상 조건이다.
- 익명 GHCR 조회로 multi-arch/각 architecture manifest와 config bytes의 SHA256, linux/architecture 및 App version label 0.7.1-dev.6을 검증했다.
- 공개 이미지를 익명 pull하고 network none으로 baseline 실행: `codex-cli 0.162.1`, app-version `0.7.1-dev.6` 확인. 같은 공개 amd64 이미지에서 gh/yq를 실행 없이 추출한 SHA256도 reviewed manifest와 일치했다. 사용자 데이터 volume은 연결하지 않았다.

| 공개 artifact | digest |
| --- | --- |
| 0.7.1-dev.6 multi-arch | sha256:d4046cbeb2da1763f95471eb1d0df21881b77c6cd2c9b269a2c6c7b2517653b5 |
| amd64 | sha256:bb5c2b8353f2b3c1205db9540f490c5e314aae648460f0daf68190752fe90fbb |
| arm64 | sha256:f2d1ff6332b9ff526ec61e4936020291a614b313707388c1568cb9b08faa4410 |

## 재검토/재시작 제한과 남은 검증

- 기존 runtime 기준: idle 재검토 예산은 설정 timezone의 slotDate별 **12회**다. 날짜 전환 시 daemon이 예산을 초기화하고 paused_busy를 복구한다. 대화 턴별 또는 영구 제한이 아니다.
- 재시작은 nextRestartAllowedAt에 기록하는 **rolling 24시간 cooldown**이다. App 재기동만으로 해제되지 않고 시간이 지나면 다시 가능하다. 영구 dead-end 방지 동작과 테스트는 기존 runtime에 유지했다.
- 실제 사용자 HAOS의 설치/업데이트, 옵션 UI, 활성 세션 유지와 적용, mobile/model 실제 턴 수용은 이번 작업에서 **NOT RUN**이며 사용자 설치 시험 대상이다. VM/운영 HA를 변경하지 않았다.
- 공개 서명/attestation의 독립 cryptographic verify는 이번 회차 **NOT RUN**이다. Builder에서 signing/attestation step이 성공한 사실과 구분한다.
- 설치 채널: `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`, App 0.7.1-dev.6. main/stable 승격이나 GitHub Release 생성은 수행하지 않았다.
