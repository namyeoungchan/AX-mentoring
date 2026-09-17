# 마일스톤 1 배포 기록

2026-09-17 사용자 배포 요청에 따라 `release/m1-first-class` → `main` → `develop` 역반영으로 진행한다. 이 문서는 배포 전 구성을 기록하며 최종 커밋·배포 결과는 GitHub Release `m1-first-class-2026-09-17`에 남긴다.

## 대상

| 구성 | 운영 대상 | 영속 데이터 |
| --- | --- | --- |
| Web/API | `ax-learningops-web` (`srv-dakvlolbedkc73anep60`) / https://ax-learningops-web.onrender.com | `/app/data/mentoring.db`, workspace DB / `dsk-dakvlotbedkc73aneq1g` |
| Discord 봇 | `ax-mentoring` (`srv-d860bd77f7vs73e6f0d0`) | `/data/mentoring.db` / `dsk-d860bd77f7vs73e6f0i0` |
| GitHub Pages | https://namyeoungchan.github.io/AX-mentoring/ | API는 위 활성 Web 사용 |

중지된 예전 Web(`asanax-learningops-web`)과 중복 봇(`ax-mentoring-bot`)은 그대로 중지 상태를 유지한다. Blueprint의 이름만 보고 중복 봇을 시작하지 않는다. Pages의 `VITE_API_BASE_URL`은 활성 Web 주소로 수정했다.

## 검증·백업·순서

- 통합 PR #27과 빠른 설정 PR #29의 CI 통과: 서버 103개, Python 80개, 브라우저 37개, 빌드·정적 검사.
- 릴리스 보강: DB를 열거나 마이그레이션하기 전에 `scripts/start_with_backup.py`로 메인·workspace DB 백업과 무결성을 검사한다. 백업 실패 시 애플리케이션을 시작하지 않는다. 시작 절차 회귀 검증 2개를 추가해 Python 총 82개를 확인한다.
- 백업은 DB와 같은 영속 디스크의 `predeploy-backups/<DB명>-<커밋 해시>`에 저장한다. 같은 커밋 재시작은 기존 백업을 검증 후 재사용한다. 자동 삭제하지 않으므로 공간과 보존 정책을 운영자가 관리해야 한다. 별도 외부 백업 정책을 대체하지 않는다.
- Render의 배포 전 자동 디스크 스냅샷 존재 확인: Web `2026-09-17 00:05:58 UTC`, Bot `2026-09-17 00:14:31 UTC`. SSH 키 인증은 거부되어 SSH를 통한 수동 백업·복구 시험은 수행하지 않았다.
- 두 활성 서비스의 자동 배포를 잠시 끄고, Web을 정확한 main 커밋으로 배포한다. 시작 백업과 health를 확인한 뒤 같은 커밋의 봇을 배포한다. Pages 결과와 봇 연결을 확인하고 기존 자동 배포 설정을 복구한다.
- 영속 디스크 서비스의 이전 인스턴스가 종료되고 새 인스턴스가 같은 디스크를 연결한 뒤 시작 백업이 실행된다. 백업 중에는 해당 서비스가 요청을 받지 않는다. 새 설치처럼 DB가 없으면 `new-database`를 기록하므로 기존 운영 서비스에서는 이 결과를 정상 백업으로 취급하지 않는다.

## 남은 현장 확인

봇의 기존 로컬 DB는 배포 전부터 외래 키 위반을 포함해 엄격 백업 검사에서 시작이 중단되었다. Web의 메인·workspace DB 8개는 엄격 검사를 통과했다. 봇에만 `--allow-existing-foreign-key-errors`를 명시하여 기존 행을 그대로 보존하고 위반 건수를 manifest·시작 로그에 기록한다. SQLite 무결성·체크섬·위반 건수 일치는 계속 검사하며 Web의 엄격 검사는 유지한다. 이 백업의 검증·복구도 동일한 명시적 옵션이 필요하다. 기존 데이터 정리는 수행하지 않았다.

실제 Discord 스테이징 수업 리허설, 비개발자 문서 인수, 연락망·RPO/RTO·외부 백업 보관 정책은 미완료다. #15·#16 및 마일스톤의 현장 완료를 자동 테스트나 배포 성공으로 대체하지 않는다. [CLASS-READINESS.md](./CLASS-READINESS.md), [CLASS-RUNBOOK.md](./CLASS-RUNBOOK.md)를 따른다.
