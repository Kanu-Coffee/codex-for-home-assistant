# FIX_10 — FIX_09 리뷰: 메타데이터 누락 시 예외 발급·실제 artifact identity 미검증

## 판정과 확인한 사실

- Reviewer, 2026-10-13 Asia/Seoul. **CHANGES REQUESTED**. 자동 업데이트 runtime 인수는 유지하며 보안 gate의 fail-closed/identity 구현 수정을 요청한다.
- 기준: PLAN/REPORT와 FIX_01~09 및 보고서, root HEAD `22cece2`, release worktree `/tmp/codex-ha-dev-release` HEAD `40559dbbaf69d17d94d10918fc673335eb9ff927`.
- 개선: 전역 ignore 제거, preflight workflow 연결, 미검토 경로·변경 module 버전 차단과 실제 Grype 시험 추가는 확인했다. 아래 재현은 남은 metadata/hash 경계를 검사한다.
- 독립 pytest **204 passed in 68.09s**, actionlint/diff PASS. [Builder 38365844933](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38365844933)는 tag SHA `2c9cad274b781bb856703914f1c4af3176cb1547`, [DEV CI 38366256596](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38366256596)는 이후 test shebang 수정 SHA `40559dbbaf69d17d94d10918fc673335eb9ff927`에서 success다. 동일 SHA의 두 결과로 혼동하지 않는다.
- 공개 `0.7.1-dev.5` manifest 조회 PASS: generic `sha256:759f0f7b8917e539bcc3c603d798a8bd95b51085047ee638b7b337cbd6fc14bb`, amd64 `sha256:812b3db7dd654d0a6d2c458e6e8e1aaae72a3c29718a6209bbedd6c055f5f8a6`, arm64 `sha256:62df7d345d668eb7cd0c5f75a8dcee5380866ae35734e5b72247301a332ad77b`.
- Remote main은 기존 `a32698851e3c3539f5d4b823e60d4f0d29038df1`이다. 기존 handoff/tag/image를 보존한다. 이번 Reviewer는 구현·외부 게시물·운영 HA를 변경하지 않았다. 다음 Executor는 `FIX_10_REPORT.md`를 작성한다.

## 독립 재현 결과

Release의 `tests/fixtures/sbom_vuln_gate/sbom-reviewed-only.spdx.json`을 private directory에 복제하고 아래 변화만 적용했다. 실제 CLI `sbom-go-binary-preflight.py --sbom ... --emit-gated-config ... --emit-gated-vex ...`를 호출했다.

| 변화 | 실제 preflight exit | 예외 정책/VEX 발급 |
| --- | --- | --- |
| 모든 Go package의 `sourceInfo` 제거, Go PURL/이름/버전 유지 | **0** | **둘 다 발급** |
| 위 변화 + document name/namespace 제거 | **0** | **둘 다 발급** |
| 허용 경로/버전 유지, 모든 선언 SHA256 값을 `b` 64개로 변경 | **0** | **둘 다 발급** |
| document name/namespace를 미검토 product 문자열로 변경 | **0** | **둘 다 발급** |

첫 fixture의 실제 Grype 0.120.1 대조: root의 빈 정책은 **exit 2/Critical 6**, 잘못 발급된 gated config+VEX는 **exit 0/Critical 0/ignored 6**. 즉 metadata가 없는데도 실제 보안 gate를 통과한다. `/tmp/codex-ha-review10/`에 fixture와 `filtered.json`, `raw.json`을 저장했다. 기존 로컬 scanner/cache만 사용했고 시험 container는 종료됐다. 실제 HA·secret/session 본문은 사용하지 않았다.

## 1. P1 — sourceInfo가 없으면 이미 수집한 오류도 버리고 예외를 발급한다

근거: `.github/scripts/sbom-go-binary-preflight.py:148-164`, `171-183`, `202-209`, `emit_gated_policy`.

- Go 탐색이 특정 `sourceInfo` 문구에만 의존한다. 해당 문자열이 없으면 Go PURL이 있는 package도 무시한다.
- `binary_modules`가 비면 `return True, []`로 document identity 오류까지 버린다. 이후 emitter는 항상 6개 예외와 VEX를 발급한다.
- 일부 metadata만 있는 경우에도 expected module은 **존재할 때만** 검사하므로 필수 module 누락을 차단하지 않는다.

`sourceInfo`는 SPDX의 optional free-form field다([공식 명세 §7.12](https://spdx.github.io/spdx-spec/v2.3.1/package-information/#712-source-information-field)). 특정 문구가 없다는 이유로 Go가 없다고 판단하면 안 된다. Scanner/catalgoger의 metadata 변화도 안전하게 처리해야 한다.

**수정·필수 시험:**

1. Go 존재 여부를 PURL/type 등 별도 증거와 대조한다. Go package인데 host binary mapping이 없거나 불명확하면 **정책 미발급 + nonzero**여야 한다.
2. Document 검증 오류를 모든 분기에서 유지한다. 필수 binary/module 누락·불명확/중복 mapping도 거부한다.
3. 정말 Go가 없는 유효 image를 허용한다면 **빈 ignore/VEX**만 생성한다. 식별자 없는 image나 Go 정보가 사라진 image에는 예외를 발급하지 않는다.
4. 위 두 metadata 누락 fixture를 실제 preflight+Grype로 회귀 검증한다. Raw Critical 6인 fixture는 metadata 누락 후에도 gate가 실패해야 한다.

## 2. P1 — 경로·module version 검사만 있고 binary hash/architecture/product 대조가 없다

근거: `REVIEWED_BINARY_PROFILES`, `validate_sbom:171-177/211-219`, `emit_gated_policy`.

검토한 expected binary hash/image digest/architecture 값이나 실제 image를 검사하는 입력이 없다. Checksum은 algorithm/value가 비어 있지 않은지만 확인하며 기대값과 비교하지 않는다. Document name/namespace도 non-empty인지 확인할 뿐 검토 대상과 대조하지 않는다. 따라서 같은 경로·module 버전으로 다른 executable content를 선언해도 예외가 발급된다. 생성 VEX도 template을 복사하므로 exact artifact와 연결되지 않는다.

위 SHA256 변경 재현은 실제 악성 executable 실행 시험이 아니라 **선언된 hash조차 검증하지 않음**을 보여주는 음성 시험이다. 보고서의 exact binary identity/hash 확인 완료 주장은 성립하지 않는다.

**수정·필수 시험:**

1. 검토한 architecture별 binary bytes 또는 exact image digest와 대조하는 identity 증거를 실제 scan target에 연결한다. Module version/경로/문서명 문자열만으로 승인하지 않는다.
2. 같은 경로·version의 hash 변경, 다른 architecture/product, 필수 identity 누락은 **정책 미발급 + nonzero**여야 한다. Unknown Go executable 추가도 계속 거부해야 한다.
3. SBOM checksum이 binary의 실제 SHA256이 아니라면 이를 binary hash처럼 사용하지 않는다. 실제 image/추출 binary와 검토한 manifest의 hash를 대조하거나 적절한 immutable image identity 방식을 사용한다.
4. 유효한 exact target에만 dynamic policy를 발급하고 ignore-only/VEX-only/combined가 다른 target으로 재사용되지 않는지 확인한다.

## 완료·배포 순서

- 위 **metadata 4종 및 hash/architecture/product 음성 시험**을 실제 경로에서 통과시킨 뒤 새 DEV를 준비한다. Runtime 전체 재작성을 요구하지 않는다.
- 기존 source/tag/image는 수정·삭제·덮어쓰지 않는다. 다음 미사용 DEV 번호와 exact SHA의 CI/native amd64/ARM·bounded-policy scanner 검증을 완료한 뒤 tag Builder를 실행한다. Tag를 먼저 발행하고 다른 SHA의 CI를 같은 SHA의 결과처럼 제시하지 않는다.
- FIX_10_REPORT/progress에는 검사한 실제 hash/identity의 종류·기대값 출처·음성 결과·새 image/CI digest 및 남은 NOT RUN을 기록한다. 실제 사용자 HAOS 설치/UI/mobile 수용은 계속 사용자 시험 대상이며 main/stable·운영 HA는 변경하지 않는다.
