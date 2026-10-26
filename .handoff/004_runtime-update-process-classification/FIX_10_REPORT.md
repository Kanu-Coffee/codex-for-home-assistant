# FIX_10_REPORT — 최종 네트워크 회수 보완 및 dev.2 배포 준비 검증

- 작성: Codex, 2026-10-26. 사용자 명시 요청에 따라 FIX_09 리뷰에서 배포 준비·게시 작업까지 이어서 수행했다. 기능 브랜치는 `fix/runtime-update-dev-0.7.2-2`, 기준 commit은 `aa76fe8`이며 이전 Executor의 변경과 handoff를 보존한다.

## 수정 결과

- `fetchJson()`은 redirect 이전 request/response를 destroy하고 hop별 error 소유권을 구분한다. 하나의 전체 timeout과 abort listener가 chain 전체를 감싼다. 최대 10 hop 및 상대 Location 해석을 적용했다.
- package download도 redirect 소켓을 닫고 settled/generation guard를 적용했다. Pending archive open을 최종 cleanup 전에 기다려 취소 후 archive 재생성을 막는다.
- ambient release-feed override를 제거해 daemon의 공식 endpoint 기본값을 유지했다. 활성 I/O 시험은 자체 Node 프로세스의 transport injection으로 바꿨다. Fixture 요청 진입 확인과 pytest finalizer로 자식·서버 회수를 보장했다.
- Redirect 응답이 계속 진행되는 case, redirect chain 전체 deadline, delayed open/abort의 잔류 파일 0을 실제 모듈로 검증하는 회귀를 추가했다. 새 테스트를 실제 제품 호출과 무관한 import fallback이나 복제 case 문으로 대신하지 않았다.

## 실제 검증

- 새 네트워크 집중 회귀: **2 passed, 102 deselected in 2.47s**.
- 전체 `.venv/bin/pytest -q`: **247 passed, 1 skipped in 86.26s**. Skip은 기존 선택형 scanner 경로이며 제품 실행 PASS로 바꾸지 않는다.
- 전체 tracked shell entrypoint ShellCheck, Dockerfile Hadolint, GitHub Actions actionlint, AppArmor parse, Markdown 및 `git diff --check` PASS. YAML은 기존 line-length warning만 남았다.
- amd64 local image `codex-ha:0.7.2-dev.2-test` build PASS. ID `sha256:9372aaa7dd5fe25046d884101f1f3a096146bc482e9b9fbca8cae3fe749b7893`.

## 최신 image의 개발 HAOS VM 재검증

- 기존 checkout 소유 VM helper/SSH 경로를 사용했고 private key 내용·실제 credential을 읽거나 출력하지 않았다. 시작 전 VM은 shut off였다.
- 위 image를 VM Docker에 적재하고 자체 합성 `/config`/`/data`, 합성 token 및 테스트용 공개키를 사용했다. 기존 `2ba6e346_codex_home_assistant` profile의 enforce 상태에서 실제 `/init` 및 S6 서비스를 실행했다.
- 정상 후보 image: Ingress 200, updater/memoryd/ttyd/ingress/sshd up, **30초 Docker stop 유예에서 약 3초/exit 0**, 합성 data marker 보존 PASS.
- 활성 I/O fixture: 같은 image와 실제 `/init`에 테스트용 Node preload로 updater transport만 자체 loopback trickle 서버로 연결했다. Fixture 요청 진입을 확인하고 **약 3초/exit 0**, data marker 보존 PASS. Preload/server는 테스트 자료이며 release image에 포함하지 않는다.
- 자체 container·fixture·VM test image를 제거한다. 기존 stable/DEV App 설정·설치에는 변경을 가하지 않는다. VM을 시작 전 shut off 상태로 복원한 결과는 progress의 최종 배포 기록에 남긴다.

## 인수 범위와 다음 단계

- 위 결과는 로컬 구현·격리 VM의 최신 source 실행 인수 근거다. 실제 Supervisor 일반 stop/restart·사용자 Web/SSH/Remote 재연결·ARM 하드웨어·장기 안정성은 여전히 사용자 실기기 수용 항목이다.
- 사용자 승인 범위 내에서 dev.2의 PR/CI·release build/SBOM/Critical gate·서명·provenance/SPDX·익명 공개 조회·prerelease 게시를 진행한다. 각 run과 최종 digest는 `docs/development/progress.md`에 확정 결과로 기록한다.
- Main/stable 승격이나 사용자 운영 기기 업데이트를 수행하지 않는다. 게시 완료 후 dev repository 새로고침 및 0.7.2-dev.2 실기기 시험을 사용자에게 인계한다.
