# FIX_16 — 인수된 DEV 후보의 실제 게시 실행

작성: 2026-10-29, Reviewer. 기준: HEAD `5529c66` 위 working tree, FIX_15 및 FIX_15_REPORT.

## 리뷰 판정

**상태표시 수정 및 DEV 메타데이터 인수 / DEV 배포 진행 승인 유지 / 실제 게시 미완료.** 이번 리뷰에서 추가로 요구하는 제품 코드 수정은 없다. 이번 인계는 기능 보완을 반복하는 FIX가 아니라, FIX_15에서 이미 요청했으나 수행하지 않은 배포 실행을 위한 다음 Executor 단계다. 별도의 반복 Reviewer 승인을 기다릴 필요가 없다.

FIX_15_REPORT는 배포 준비와 실제 게시를 구분해 미수행을 정확히 기록했다. 그러나 FIX_15의 범위는 준비뿐 아니라 DEV 게시까지였다. 실제 외부 실행 오류나 권한 거부 증거가 보고서에 없으므로 기술적으로 배포가 불가능했다고 판정하지 않는다.

## 독립 확인

- `getStatus()`에서 idle managed 서버 존재만으로 설정하던 migration 차단과 자동 자격 배제 조건이 제거됐다. `applyUpdate`의 busy/unknown·policy·cooldown·journal 안전 로직을 제거하는 변경은 없다.
- 신규 FIX_15 회귀는 수작업 status 객체로 formatter를 확인하며 `getStatus` 계산 자체를 호출하지 않는다. 이를 보완해 Reviewer는 기존 managed app-server/owned companion fixture를 실제 subprocess와 등록 record로 실행하고 `getStatus()`를 직접 조회했다. 관리형 서버가 살아 있는 상태에서 `canApply=true`, `isIdle=false`, `autoApplyReady=true`, `liveHandoverBlocked=false`를 확인했으며 future cooldown을 설정하면 `autoApplyReady=false`와 waiting 표시를 확인했다. 사전검사 자격이며 실제 전환 성공 보장은 아니다.
- `.venv/bin/python -m pytest -q tests/test_addon_contract.py tests/test_codex_update_contract.py -k 'fix15 or addon or readiness'`: **22 passed, 113 deselected in 6.11s**. runtime manager Node syntax, wrapper ShellCheck, `git diff --check` PASS. 전체 suite **268 passed, 1 skipped**는 Executor 보고 결과이며 이번 Reviewer가 전체를 재실행한 결과는 아니다.
- manifest/Docker/package·lock/changelog/MOTD/repository의 `0.7.3-dev.1` 및 DEV 표식을 검토하고 채널 계약 테스트를 통과했다. 개발 사양의 과거 일괄 보류·CLI 미구현 설명도 정정됐다.
- `git ls-remote --heads origin dev`: `dc8a11a381153ffc79ef3d546b430d2e674d4fc0`. `git ls-remote --tags origin '0.7.3*'`: 결과 없음. `gh release view 0.7.3-dev.1 --json tagName,isPrerelease,url`: `release not found`. 따라서 새 후보가 사용자가 설치 가능한 상태라는 근거는 없다. GHCR 전체 namespace를 조회한 것은 아니며 image 부재를 별도로 단정하지 않는다.
- 현재 로컬 branch는 main이며 후보 전체가 미커밋이다. 이 상태를 main에 그대로 게시하거나 DEV metadata를 stable에 합치지 않는다.

## 다음 Executor 작업 — 배포를 끝낸다

1. FIX_15의 DEV 배포 지시와 `docs/development/releasing.md`를 수행한다. 현재 working tree와 handoff 이력, 새 session host와 테스트를 보존한다. remote main/dev 상태를 다시 확인한 뒤 `codex/` 기능 브랜치에서 DEV 대상 변경을 준비하고 필요시 dev와의 충돌을 해결한다. DEV metadata를 main에 병합하지 않는다.
2. remote version/tag 충돌이 없으면 준비된 **0.7.3-dev.1**을 사용한다. 충돌이 생겼다면 기존 설치/공개 후보보다 높은 새 미사용 DEV 번호를 사용하고 모든 version 필드를 다시 맞춘다. 기존 tag/image 덮어쓰기나 force push는 하지 않는다.
3. 기존 로컬 검사, secret scan, DEV 대상 PR의 CI 및 non-publishing Builder, native amd64/aarch64 필수 build/smoke를 통과시킨다. 실제 실패가 있으면 원인을 수정하고 재검사한다. PR을 생성하면 현재 task에 첨부한다.
4. 검증된 후보를 dev에 병합하고 해당 branch CI를 확인한 뒤 같은 SHA의 annotated version tag로 publishing Builder를 실행한다. 기존 SBOM/Critical gate, signature/provenance/attestation 및 multiarch 공개 조회를 그대로 적용한다.
5. DEV prerelease를 게시하고 공개 `#dev` metadata·정확한 version image·서명·provenance를 확인한다. 사용자에게 설치할 정확한 DEV version, repository URL 및 Release URL을 제공한다. stable 승격, 실제 HA 장치 변경, 삭제·재설치는 하지 않는다.
6. `FIX_16_REPORT.md`를 신규 작성한다. source commit, PR, CI/Builder, Release URL, image digest와 공개 검증 결과를 기록한다. 실제 외부 도구 실패나 접근 제한으로 게시하지 못했다면 수행한 단계·정확한 실패·남은 조치를 기록한다. 준비만 끝난 상태를 배포 완료로 쓰거나, 이미 허용된 DEV 게시에 재승인을 요구하지 않는다.

## 완료 및 수용 경계

이 단계 완료는 사용자가 새 DEV image를 설치할 수 있도록 게시와 검증까지 끝낸 상태다. 실제 HAOS Store 표시·설치, 자동 scheduler 전체 경로, mobile Remote 및 장시간 운영시험은 사용자/격리 HAOS 수용 전까지 NOT RUN이다. 수동 apply 결과를 자동 슬롯 전체 성공으로 기록하지 않는다. FIX_15의 유휴 전환·작업 중 보류·같은 대화 문맥 보존·인증/데이터 유지 시나리오를 DEV 운영시험에 전달한다.
