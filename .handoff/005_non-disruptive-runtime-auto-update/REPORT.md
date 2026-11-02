# REPORT — 0.7.2 장기 연결 보존형 자동 업데이트 PLAN 취소 및 종결

## 1. 개요

- **작성일자:** 2026-10-28 (Asia/Seoul)
- **작업자:** Executor
- **상태:** **취소 (Cancelled / Superseded by task 006)**
- **대상 계획:** `.handoff/005_non-disruptive-runtime-auto-update/PLAN.md`

## 2. 취소 사유 및 경과

1. **사용자 Clarification 및 요구사항 변경:**
   - task 005 PLAN은 "새 세션에는 신버전을 자동 선택하고 기존 CLI/TUI·Remote stdio 연결은 구버전으로 유지"하는 방식을 계획하였다.
   - 그러나 사용자 피드백에 따라 "CLI·Remote stdio 연결이 유지되어 있더라도 진행 중인 실제 작업(요청, 응답 생성, 승인 대기, 백그라운드 작업 등)이 없는 실제 유휴(Idle) 상태라면 **기존 실행 서버 자체를 신버전으로 자동 전환(업데이트)**해야 한다"는 명확한 요구가 확인되었다.
   - 새 프로세스에만 신버전을 선택하고 기존 서버를 계속 구버전으로 남기는 방식은 수용 조건에 맞지 않는다.

2. **후속 계획으로의 대체:**
   - 이에 따라 handoff 불변 원칙(기존 handoff 수정/삭제 금지)을 준수하여 task 005 PLAN은 본 보고서를 통해 공식적으로 **취소 종결(Superseded)** 처리한다.
   - 실제 작업 유휴 판정 및 기존 서버 전환에 대한 새로운 요구사항은 `.handoff/006_idle-gated-runtime-server-update/PLAN.md`로 분리 수립되었으며, 구현 및 검증은 task 006에서 수행한다.

## 3. 코드 변경 및 영향

- task 005에 따른 제품 코드 수정, 커밋, 릴리스, 배포 작업은 일체 수행되지 않았다.
- 모든 후속 작업은 `.handoff/006_idle-gated-runtime-server-update/`에서 Executor로 진행한다.
