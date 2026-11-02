# FIX_14 — 제목 생성용 내부 thread와 사용자 대화의 구분

## 1. 재리뷰 판정

Reviewer: Codex, 2026-10-29. HEAD `5529c66` 위 working tree 및 FIX_13_REPORT를 검토했다. **문맥 유실 방지 보완 인정 / REQUEST CHANGES — 실제 유휴 TUI 전환 미완료**. 제품 코드는 수정하지 않았다.

독립 공식 바이너리+합성 모델 시험에서 내용 있는 ephemeral 대화의 전환을 보류하고 같은 worker의 다음 요청에 이전 합성 메시지가 포함됨을 확인했다. FIX_13의 명시적 제한·부분 구현 보고는 정확하다. 새 문맥 유실 결함을 재현한 것은 아니다. 그러나 실제 TUI의 유휴 전환이 계속 보류되는 기존 미완료는 남아 있다.

## 2. P1 이월 — 제목 생성용 thread가 정상 유휴 적용을 막음

`knownEmpty`는 client `thread/start`의 params 원장과 관측 turn 부재만으로 판단한다. 이 조건에 들어오지 않는 TUI 내부 ephemeral thread는 `ephemeral_history_unverified`로 전환을 취소한다. 보고서대로 일반 TUI의 첫 요청이 끝난 뒤에도 적용되지 않는다. 내용이 있는 사용자 대화를 보호하는 조건을 없애서는 안 되며, 내부 thread의 용도를 구별해야 한다.

### 이번에 추가 확인한 구체적 근거

실제 production WebSocket endpoint에 공식 0.162.1 frontend를 PTY로 연결하고 localhost 합성 첫 요청 완료 후 metadata만 추적했다. 원문 prompt/응답은 수집하지 않았다. `review13-trace-host.mjs`는 `_sendInternalRpc` 결과의 제한된 metadata를 기록할 뿐 제품 코드를 변경하지 않는다.

```text
사용자 thread:
  ephemeral=false, pathPresent=true, pathExists=true
  originator=codex-tui, threadSource=user, source=vscode
내부 thread:
  ephemeral=true, pathPresent=false, pathExists=false
  originator=codex-tui, threadSource=thread_title, source=vscode
두 thread 모두 전환 시점의 작업 원장은 busy=false
```

즉 이번 정상 TUI를 막는 구체적 대상은 `threadSource:'thread_title'`인 thread였다. 증거는 Git 제외 `.test-tmp/review006-fix11/review13-thread-metadata.log`, `.test-tmp/review006-fix12/review13-trace.log`에 있다. 부모 ID는 둘 다 null로, parent 유무만으로는 구별할 수 없었다.

해당 버전 생성 schema에서 `threadSource`는 **optional analytics source classification**이며 타입은 열린 string이다. 이 문자열 하나만으로 임의 사용자 대화를 폐기해도 된다는 권한/빈 대화 증거로 삼으면 안 된다.

### 다음 Executor의 집중 작업

1. 정확한 baseline의 공식 source/protocol 및 실제 lifecycle에서 제목 생성용 thread가 언제 생성되고 언제 완료·정리되는지 확인한다. `thread_title`·originator·관리형 frontend의 소유권·진행 요청/turn의 부재를 함께 사용해 검증 가능한 제한된 내부 유형을 분류한다.
2. 완료된 내부 제목 작업은 사용자 대화와 같은 persisted resume 의무를 적용하지 않고, 지원되는 종료/정리 또는 필요시 재생성 경로로 처리한다. 아직 실행·대기 중인 제목 작업은 기존대로 보호한다. 단순 `ephemeral` 전체 또는 arbitrary analytics string만 근거로 데이터를 버리지 않는다.
3. 사용자 직접 ephemeral 대화는 현재 문맥 보호를 유지한다. 실제 history를 인계할 수 없는 경우 그 구체적인 상태의 제한을 표시하되, 정상 TUI의 완료된 제목 작업까지 같은 이유로 영구 보류하지 않는다.
4. FIX_13의 알려진 빈 대화 원장과 ID 매핑·rollback 보호를 유지한다. 사용자·제목 생성용·미확인 ephemeral을 분리한 실제 stateful 회귀를 추가한다. fake fixture에 knownEmpty를 주입하는 것만으로 실제 내부 lifecycle을 검증하지 않는다.

## 3. 수용 기준

- 공식 TUI에서 첫 합성 turn을 완료하고 `thread_title`이 생긴 상태에서 정상 유휴 업데이트가 가능해야 한다. 같은 frontend의 다음 요청·응답과 기존 사용자 문맥이 유지돼야 한다.
- 내용 있는 사용자 ephemeral 대화는 기존 문맥이 유지되거나 구체적으로 안전 보류해야 한다. 빈 사용자 대화와 단순 UI 열림은 보류 원인이 아니어야 한다.
- 제목 생성·tool·approval·queued 등 실제 작업 중에는 중단하지 않고, 완료 후 다음 허용 검사에서 적용한다. 후보 실패·rollback 뒤 다음 요청도 검사한다.
- 실제 wrapper/manager/scheduler와 frontend가 연결된 경로의 검증을 기록한다. direct control 성공과 자동 스케줄 전체 인수를 구별한다.

## 4. 이번 검증과 배포

독립 `tests/test_codex_update_fix03.py` **8 passed in 10.15s**. 공식 문맥 보존 대조와 실제 TUI 유휴 보류를 재현했다. Node syntax(session host)·wrapper ShellCheck·`git diff --check` PASS. 전체 suite·Docker/VM/native ARM/HAOS/mobile·실모델 수용은 이번 Reviewer가 실행하지 않았다.

다음 Executor는 이 1건을 수행하고 `FIX_14_REPORT.md`를 신규 작성한다. 기존 handoff는 보존한다. 정상 유휴 TUI 경로를 인수한 뒤 dev 게시로 인계하며, HAOS에서 업데이트로 인식되도록 실제 기존 설치/공개 dev보다 높은 미사용 version을 설정한다. 사용자 실기기 수용은 dev 게시 후 수행 가능하도록 정확한 버전·저장소·시험 절차를 전달한다. 현재는 기본 TUI 유휴 전환이 계속 보류돼 배포 인수 조건 미충족이다.
