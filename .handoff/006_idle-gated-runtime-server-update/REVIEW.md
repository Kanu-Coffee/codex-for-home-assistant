# DEV 배포 Reviewer 확인

2026-10-29: `0.7.3-dev.1` 공개 DEV 배포를 확인했다. PR #59는 dev에 병합됐고 PR checks, dev CI 40826178307, tag Builder 40826859164는 성공했다. 태그는 source `8e0cab75299bc633b827b9bff3dcbbffde20fe89`를 가리킨다. 공개 prerelease와 dev manifest version을 확인했으며 GHCR generic manifest digest는 `sha256:27920e6e31711c8613c5984fca71fe79ce59584f4a48dbb693131915e5920503`이고 amd64와 arm64를 포함한다. 이 확인은 실제 HAOS 설치 및 운영시험의 대체가 아니다. 서명과 attestation을 이번 리뷰에서 독립 재검증하지 않았다.

로컬 정리로 이 프로젝트의 미사용 `codex-ha:004-test`, `0.7.2-dev.1-test`, `0.7.2-dev.2-test`, `fix09-test` 이미지 4개를 삭제했다. 안정판 시험 이미지와 최근 시험 이미지는 보존했다. 루트 파일시스템 가용 공간은 표시 기준 70G에서 75G로 증가했다. 다른 프로젝트와 공유되는 Docker build cache는 소유 범위를 확정하지 못해 유지했다. 격리 시험 디렉터리 일괄 삭제 명령은 실행 환경에서 거부되어 삭제하지 않았다. `probe-cli-home2`에서는 실제 프로세스가 실행 중인 것도 확인했다.
