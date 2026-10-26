# FIX_10 — dev.2 게시 전 최종 네트워크 자원 회수 보완

- Reviewer: Codex, 2026-10-26. FIX_09의 부분 관측 필드 전달과 활성 I/O 취소, 기존 VM S6/AppArmor 측정의 범위를 검토했다. 사용자 후속 요청은 준비 완료 후 실제 dev.2 게시와 실기기 시험 안내까지 수행하는 것이다.
- 배포 준비의 마지막 점검에서 redirect 이전 response가 닫히지 않는 경계를 확인했다. 자체 302 trickle → 정상 JSON fixture에서 완료/abort 후에도 이전 응답 socket이 남았다. Redirect마다 새 timeout을 발급하는 구현도 전체 작업 budget이 아니다.
- 같은 자원 회수 경계에서 비동기 archive open과 abort가 겹치면 cleanup 이후 파일이 생성되지 않도록 보완한다. 기존 150ms abort 시험만으로 open 대기 경계까지 검증했다고 표현하지 않는다.

## 요구 수정·검증

1. release JSON과 package download 모두 redirect response/request를 다음 hop 전에 닫고, 이전 hop의 error가 새 hop을 잘못 reject하지 않게 한다. Redirect 개수를 제한하고 상대 Location도 안전하게 해석한다.
2. release JSON의 전체 deadline을 redirect chain 전체에 공유한다. 완료·오류·abort의 timer/listener/stream 회수를 보장한다.
3. 대기 중인 archive open이 완료·close된 뒤 최종 임시 archive를 지운다. 중복 resolve/reject를 막고 늦은 callback이 취소 이후 stream이나 파일을 다시 남기지 않도록 한다.
4. daemon의 기본 feed는 고정 공식 endpoint를 유지한다. VM/단위 fixture 때문에 추가된 ambient `CODEX_RELEASE_FEED_URL` 우회는 제거하고 자체 테스트 프로세스의 transport injection으로 검증한다.
5. Redirect trickle의 전체 명령 종료, chain 전체 deadline, abort/늦은 open 잔류 0, 기존 활성 I/O 취소를 회귀로 검증한다. 실패 시에도 직접 생성한 서버·자식이 정리돼야 한다.
6. 전체 pytest·필수 린트·후보 build를 확인한다. 수정한 최신 image를 개발 HAOS VM의 합성 data/config 및 기존 enforced profile에서 정상/active-I/O 정지로 재검증하고 기존 App·VM 상태를 복원한다. Docker stop과 Supervisor 일반 stop의 증거는 구별한다.

## 실행·인계 경계

- 사용자 추가 요청에 따라 같은 Codex 세션이 배포 준비에 필요한 이 소규모 보완을 수행하고 `FIX_10_REPORT.md`에 실제 결과를 남긴다. 이전 handoff는 변경하지 않는다.
- 인수 가능한 결과에서 dev branch PR/CI, immutable `0.7.2-dev.2` tag와 signed amd64/aarch64 image·prerelease 게시까지 진행한다. Main/stable은 유지하며 사용자 운영 장치의 설치·재시작은 수행하지 않는다.
- 실기기 수용은 dev.2 exact 게시 후 사용자에게 인계한다. VM 격리 Docker 검증은 실제 사용자 Supervisor 일반 stop/restart·Remote·ARM 실기 수용의 대체가 아니다.
