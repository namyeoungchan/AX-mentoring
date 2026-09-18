# PostgreSQL 전환

웹 API에 `DATABASE_URL`을 지정하면 PostgreSQL을 사용합니다. 비워 두면 기존 SQLite를 사용합니다. Discord 봇은 기존 웹 API를 계속 호출하며 DB 연결 문자열을 갖지 않습니다. PostgreSQL 17로 서버·봇 브리지·이관을 검증합니다.

## 데이터 구조와 동시 처리

- 공통 계정·워크스페이스: `ax_main`. 각 워크스페이스: `ax_w_<id>`. 스키마 접두사는 `PG_NAMESPACE`로 분리합니다.
- Node 비동기 연결 풀은 기본 10개, Python 저장 작업 프로세스는 기본 2개입니다. 같은 워크스페이스의 변경 트랜잭션은 advisory lock으로 직렬화하고 조회·다른 워크스페이스는 함께 처리합니다.
- Python 프로세스는 재사용하고 DB 연결은 작업 완료 후 닫습니다. 작업 대기열은 전체 64개, 워크스페이스당 16개, 대기 5초·실행 25초로 제한합니다. 포화 시 503을 반환합니다.
- 봇 HTTP 연결을 재사용합니다. 일시적 오류만 같은 요청 ID로 한 번 재시도해 중복 변경을 막습니다. Discord gateway 봇은 하나만 실행합니다.
- 관리자 인증 후 `GET /api/admin/performance`에서 대기열·처리 시간·프로세스 재시작 횟수를 확인합니다. 운영 처리량 수치는 실제 배포 후 측정해야 합니다.

## Render 전환 순서

1. `render.postgres.yaml`의 DB를 **기존 웹 서비스와 같은 리전**에 만듭니다. PostgreSQL 17, RAM 1GB, 저장공간 5GB 설정입니다. 새 유료 DB가 생성되므로 적용 시 Render의 현재 요금을 확인합니다. 외부 DB 접속은 기본 차단합니다.
2. 현재 관리자 화면에서 전체 `.axbackup`을 다운로드해 보관합니다. 최종 전환 동안 봇을 일시 중단하고 운영자·학생의 변경 요청을 중지합니다.
3. 이 브랜치의 검증된 코드를 배포합니다. 웹 서비스는 기존 영구 디스크와 **인스턴스 1개**를 유지합니다. 현재 관리자 초기화·복구 잠금은 프로세스 단위이므로 여러 웹 인스턴스로 확장하지 않습니다.
4. 웹 환경변수에 DB의 **Internal Database URL**을 `DATABASE_URL`로 설정하고 `PG_NAMESPACE=ax`, `PG_POOL_MAX=10`, `BOT_STORAGE_WORKERS=2`, `MIGRATE_SQLITE_TO_POSTGRES=1`을 지정합니다. 연결 문자열은 저장소나 프런트엔드 환경변수에 넣지 않습니다.
5. 시작 시 기존 SQLite 파일의 검증된 백업을 영구 디스크에 남기고, 임시 PostgreSQL 스키마로 이관합니다. 원본의 모든 테이블 행과 ID 시퀀스를 검증하고 외래 키를 확인한 후 빈 대상 스키마에 게시합니다. 원본 SQLite 파일은 보존합니다. 실패하면 웹 시작을 중단합니다.
6. 로그의 `migration: applied`와 `/api/health`의 `backend: postgresql`을 확인합니다. 관리자 재로그인, 워크스페이스·수강생·조·출결 조회, 과제·예약 변경, 백업 다운로드와 테스트용 복구를 확인합니다. 이후 봇을 재개하고 Discord에서 실제 출석 등록을 확인합니다.
7. `MIGRATE_SQLITE_TO_POSTGRES`를 제거합니다. 관리자 다운로드 백업과 이관 전 SQLite 파일을 별도 보관합니다. 기존 디스크를 즉시 제거하지 않습니다.

Render의 [내부 연결 안내](https://render.com/docs/postgresql-creating-connecting)와 [Blueprint 필드](https://render.com/docs/blueprint-spec)를 참고합니다. 이 파일이나 DB 설정을 저장소에 추가하는 것만으로 운영 DB가 생성·이관되지는 않습니다.

## 수동 이관과 검증

Node 24와 Python 저장소 의존성이 필요합니다. 작업 디렉터리는 `lms-web/`입니다. `DATABASE_URL`은 목적지 DB, `PG_NAMESPACE`는 아직 사용하지 않은 접두사로 설정합니다.

```sh
npm ci
python -m pip install -r server/requirements-storage.txt
# 관리자가 다운로드한 백업: 원본 전체 행 비교만 수행하고 임시 스키마를 정리
npm run db:migrate -- --backup /secure/current.axbackup
# 검증 후 빈 대상에 게시
npm run db:migrate -- --backup /secure/current.axbackup --apply
# 실행 중인 SQLite 웹을 중지한 상태에서 직접 내보내기와 이관
npm run db:migrate -- --sqlite /app/data/mentoring.db --output /app/data/before-postgres.axbackup --apply
```

`--sqlite`는 호환 스키마를 열기 때문에 현재 버전의 SQLite 마이그레이션을 적용할 수 있습니다. 운영 시작 경로에서는 먼저 `start_with_backup.py`가 원본 파일 백업을 보장합니다. 수동 경로에서도 원본 파일 백업 후 실행하세요. SQLite 메인 파일과 `.workspaces` 디렉터리가 함께 있어야 합니다.

이미 존재하는 대상은 덮어쓰지 않습니다. 앱을 미리 실행해 빈 스키마가 생성된 경우 별도 접두사로 검증하고 의도한 대상을 확인합니다. 이관·복구는 로그인 세션·출석 코드를 무효화하고 미발송 알림·초대 작업을 중지하므로 관리자와 학생은 다시 로그인해야 합니다.

## 백업·복구·실패 대응

- 관리자 화면의 `.axbackup` 다운로드·파일 검증·초기화·복구가 PostgreSQL에서도 동작합니다. 기존 SQLite 백업도 업로드할 수 있습니다. 압축 파일 한도는 기존과 같은 32MB입니다.
- 초기화·복구 직전 안전 백업은 `ax_control.backups`에 저장하고 관리자 화면에서 다운로드합니다. 이는 동일 DB 안의 안전장치이므로 외부 다운로드와 Render DB 백업도 별도로 유지합니다.
- 매 서비스 시작 전 PostgreSQL 논리 백업을 영구 디스크 `predeploy-backups/`에 남깁니다. 자동 삭제는 하지 않으므로 디스크 사용량을 확인하고 외부 보관 후 정리합니다.
- 임시 스키마에서 복구 데이터를 검증한 후 트랜잭션으로 스키마 이름을 교체합니다. 앱 재시작 실패 시 이전 스키마로 되돌립니다. 복구 이후 기존 알림이 갑자기 재발송되지 않습니다.
- **이관 후 새 데이터가 쓰이기 전**에는 `DATABASE_URL`을 제거해 보존된 SQLite로 되돌릴 수 있습니다. **새 데이터가 쓰인 후** SQLite로 단순 전환하면 그 변경분을 잃습니다. 변경 요청을 중지하고 PostgreSQL 백업·복구를 사용하세요.

## 검증 명령

```sh
npm test
python -m unittest discover -s ../tests
# POSTGRES_TEST_URL에 격리된 테스트 DB 설정
npm run test:postgres
# PLAYWRIGHT_DATABASE_URL에 같은 테스트 DB 설정
npm run test:e2e
```

PostgreSQL 통합 테스트는 무작위 스키마를 사용하고 정리합니다. 브라우저 테스트는 별도 접두사를 사용하지만 실패 분석을 위해 DB를 남기므로 CI의 일회성 DB를 권장합니다. CI는 SQLite와 PostgreSQL을 각각 검증합니다. PostgreSQL DDL은 `server/postgres/*.sql`과 `schema.json`을 함께 갱신해야 합니다. SQLite DDL은 PostgreSQL에서 실행하지 않으며 알려지지 않은 스키마 버전은 시작을 거부합니다.
