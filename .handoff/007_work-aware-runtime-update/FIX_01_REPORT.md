# FIX_01_REPORT — Executor 진행 보고

작성일: 2026-10-30  
상태: **미완료**

## 수행한 작업

- `tests/test_codex_wire_probe.py`에 실제 공식 app-server Unix 소켓과 `app-server proxy`에 HTTP WebSocket Upgrade, masked initialize frame, 응답 ID/result와 SIGHUP 종료를 검사하는 선택형 재현 테스트를 작성했다. `CODEX_WIRE_PROBE_BINARY`를 지정하지 않으면 건너뛴다. 시험은 임시 HOME과 CODEX_HOME을 사용하며 운영 인증을 읽지 않는다.
- 공식 `rust-v0.162.1`의 `codex-package-x86_64-unknown-linux-musl.tar.gz`를 `.test-tmp/task007-baseline`에 내려받았다. GitHub release가 제공한 SHA-256 `a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3`과 일치함을 확인하고 추출했다.
- baseline `0.162.1` 및 기존 로컬 `0.165.0` 실행 파일로 각각 해당 테스트를 실행해 1 passed를 확인했다. 0.165.0 로컬 실행 파일 SHA-256은 FIX_01의 `c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5`이다. 0.165.0 archive 무결성은 이번에 확인하지 않았다.

## 한계와 남은 작업

위 결과는 실제 서버의 transport 초기화와 종료만 확인한다. thread 생성·조회, 모델 응답·대화 복원·재연결·TUI·stdio relay, 실제 작업 ledger, admission barrier, scheduler 전환과 rollback은 수행하지 않았다. 기존 runtime manager의 CLI/stdio 프로세스 생존 blocker와 loaded thread blocker는 남아 있다. FIX_01의 단계 1 일부만 완료했고 단계 2~6은 미완료다.

HAOS VM, native ARM, 전체 pytest, image smoke, 실제 client 시험은 NOT RUN이다. 운영 서비스·인증·HA 데이터는 변경하지 않았다. 이 보고서는 사용자 목표의 달성을 뜻하지 않는다.
