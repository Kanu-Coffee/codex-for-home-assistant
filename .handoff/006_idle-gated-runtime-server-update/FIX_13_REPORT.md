# FIX_13 Executor 보고서

작성: 2026-10-29. 결과: **문맥 유실 방지 일부 구현 / 실제 TUI 유휴 전환 미완료**.

기본 `thread/read`의 `turns:[]`를 내용 부재의 증거로 사용하지 않도록 보완했다. relay가 client의 `thread/start`를 관측한 뒤 해당 thread의 `turn/start`나 `turn/started`를 관측하지 않은 경우만 빈 대화 재생성 대상으로 인정한다. 원장에는 ID만 저장하며 내용은 복사하지 않는다. 이미 turn을 관측했거나 생성 경위가 불명인 미저장 대화는 기존 worker를 유지하고 `thread_restorability_unverified`로 보류한다. 기존 journal과 worker를 무단 삭제하지 않는다.

## 공식 바이너리 격리 결과

- `.test-tmp/review006-fix12/fix13-preserve.py`: 실제 0.162.1 ephemeral 대화의 첫 합성 turn 후 교체를 시도했다. 전환은 `thread_restorability_unverified`/`restored`로 보류됐고 동일 worker의 다음 요청에 이전 합성 메시지가 포함됐다. 기존의 조용한 문맥 유실은 이 경로에서 재현되지 않았다.
- `.test-tmp/review006-fix11/tui_production_probe.py`: 공식 TUI와 production WebSocket endpoint에서 첫 요청 후 `busy:false`였지만 생성 경위를 입증하지 못한 내부 ephemeral thread 때문에 전환이 보류됐다. `rollbackStatus:restored`, 같은 TUI의 후속 합성 요청은 정상 도달했다.
- 두 시험은 별도 HOME/CODEX_HOME과 localhost 합성 모델을 사용하고 control socket을 직접 호출했다. 사용자 운영 HA·실모델·실제 계정은 사용하지 않았다.

## 미완료 및 한계

**FIX_13 전체 수용 기준은 미충족이다.** 내용 있는 ephemeral 대화의 문맥을 새 worker로 인계하는 구현이 없으며, 실제 TUI의 내부 ephemeral thread도 안전한 소유권/용도를 구분하지 못해 유휴 전환이 보류된다. 빈 화면 자체는 차단 조건이 아니지만 현재 구현의 관측 불확실성 때문에 실제 유휴 TUI에서도 보류가 발생한다. 이는 사용자가 원하는 정상 유휴 업데이트를 완성한 상태가 아니다. 이전 조건을 단순히 blanket으로 완화하거나 문맥을 버리면서 성공을 보고하지 않았다.

다음 단계는 내부 ephemeral thread의 실제 생성·소유권과 lifecycle을 공식 프로토콜/소스 및 실측으로 구분하고, 사용자 내용이 있는 ephemeral 대화의 지원 가능한 인계 경로를 구현하는 것이다. scheduler·wrapper 전체 경로, HAOS VM/mobile·실모델·ARM·장기 수용과 dev 배포는 이번에 수행하지 않았다. 새 dev 배포 시 기존 설치본보다 높은 버전이 필요하다는 사용자 조건은 유지한다.

## 검증

- `tests/test_codex_update_fix03.py` → **8 passed in 10.19s**. 수동으로 thread를 등록한 기존 fixture에 알려진 빈 생성 원장을 추가했다.
- `tests/test_codex_update_contract.py -k 'production_stdio or fix09_idle'` → **6 passed, 109 deselected in 7.19s**. 최초 실행은 알려진 빈 생성 원장을 설정하지 않은 fake fixture 1개가 실패했고 fixture를 정정한 뒤 재실행했다.
- Node syntax, wrapper ShellCheck 및 `git diff --check` 통과. 전체 suite 및 Docker build는 이번에 실행하지 않았다.
