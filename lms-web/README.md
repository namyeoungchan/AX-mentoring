# AX LearningOps 웹

React + TypeScript + Vite + Tailwind CSS로 만든 반응형 운영 웹입니다. Node.js / Express API가 워크스페이스별 SQLite 파일을 사용합니다. 기존 Python 봇 DB는 연결된 워크스페이스로 이관하고, 전환 이후 봇도 웹 API로 데이터를 읽고 저장합니다. 연동 URL과 키가 없는 기존 설치는 로컬 DB를 유지합니다.

수업 당일 점검·장애 대응·유지보수 인수는 [CLASS-RUNBOOK.md](./CLASS-RUNBOOK.md)에서 시작하세요.
자동 통합 검증 결과와 실제 Discord 리허설의 남은 항목: [CLASS-READINESS.md](./CLASS-READINESS.md).

워크스페이스 생성·역할별 화면·수강생 승인 절차: [WORKSPACES.md](./WORKSPACES.md), [DISCORD-LMS.md](./DISCORD-LMS.md).

현장 관리자용 버튼별 설정 순서: [WORKSPACE-SETUP-GUIDE.md](./WORKSPACE-SETUP-GUIDE.md).
Discord 공지 발송·실패 재시도·수동 게시: [NOTICE-DELIVERY.md](./NOTICE-DELIVERY.md).
과제 제출 대상·운영자 알림·D-1 수동 대체: [ASSIGNMENT-ALERTS.md](./ASSIGNMENT-ALERTS.md).
팀 일괄 배정과 개인별 Discord 복구: [TEAM-OPERATIONS.md](./TEAM-OPERATIONS.md).

명단 출결·회차 마감·CSV 장애 복구 절차: [ATTENDANCE.md](./ATTENDANCE.md).
웹에서 봇 초대·서버 구축을 진행할 수 있는 범위: [WEB-BOT-INVITE.md](./WEB-BOT-INVITE.md).

기존 봇 데이터 전체 이관·운영 작업·자동 게시 패널: [BOT-DATA.md](./BOT-DATA.md).

## 실행

최초 관리자 등록·비밀번호 변경·복구는 [AUTH-OPERATIONS.md](./AUTH-OPERATIONS.md), Discord 가입 인증·봇 초대 시 채널 자동 구성은 [DISCORD-LMS.md](./DISCORD-LMS.md)를 참고하세요. 개발 환경에서도 로그인이 필요하며 `npm run bot:setup`으로 최초 관리자 설정 키를 준비할 수 있습니다.

Node.js 24 이상이 필요합니다.

```powershell
cd lms-web
npm install
npm run dev
```

- 웹: http://127.0.0.1:5173
- API: http://127.0.0.1:3001/api/health
- 샘플 화면은 별도 `VITE_APP_MODE=demo` 빌드에서만 제공합니다. 운영 빌드는 `?demo=1`로 전환되지 않습니다.

기본 모드는 API 연결입니다. 초기 DB가 비어 있으면 화면에도 0건으로 표시합니다. 샘플 모드는 실제 DB를 변경하지 않고 브라우저에 저장합니다.

`npm run dev`는 API와 Vite를 함께 실행합니다. 외부 API를 이미 실행하고 있다면 `npm run dev:web`을 사용합니다.

## 기존 봇 데이터 연결

`.env.example`을 `.env`로 복사한 뒤 웹 서비스의 영속 DB 경로를 지정합니다. 원격 봇의 기존 DB는 파일 경로 공유 대신 [전체 이관](./BOT-DATA.md)으로 연결합니다. `BOT_DB_PATH`의 상대 경로 기준은 `lms-web/`입니다.

```dotenv
BOT_DB_PATH=../data/mentoring.db
```

기본값은 프로젝트 루트의 `data/mentoring.db`입니다. 파일이 없다면 새 DB를 만듭니다. 테스트는 별도 임시 DB를 사용합니다. 이 작업에서 운영 중인 Discord 봇이나 원격 DB 접속은 수행하지 않았습니다.

| 기존 봇 테이블 | 웹 연결 |
| --- | --- |
| `mentors` | 멘토 조회·등록·수정 |
| `slots`, `bookings` | 멘토링 조회·신규 예약·승인·완료·취소 API |
| `assignments` | 과제 조회·등록·마감·재개 |
| `submissions` | 제출 내용·링크·제출일시 조회 |

과정·수강생·팀·출결·점수·공지 초안·서버 정보는 `lms_records`에 저장합니다. 추가 인덱스로 과정 코드/기수, 이메일, Discord ID, 팀 코드, 동일 차시 출결, 동일 평가항목 점수의 중복을 차단합니다. `lms_audit`에는 변경 전후 값, 작업자, 작업 유형, 대상을 저장합니다.

SQLite WAL과 트랜잭션을 사용합니다. 서버가 발급한 데이터 버전이 바뀌면 저장을 `409`로 거절해 다른 웹 사용자나 봇의 변경을 덮어쓰지 않습니다. 화면의 **새로고침** 버튼으로 최근 데이터를 불러옵니다. 실시간 push 동기화는 없습니다.

예약·과제·참여도·비밀평가 패널은 선언된 채널에 자동 게시·고정하고 주기적으로 갱신합니다. 버튼과 기존 새로고침 명령으로도 갱신할 수 있습니다. 전환한 봇의 조회·제출·리마인더는 웹 DB를 사용합니다. 공지 초안의 자동 발송은 별도 기능입니다.

웹 API가 워크스페이스별 SQLite 파일을 소유하고, 다른 호스트의 봇은 인증된 HTTPS API로 접근합니다. 원격 호스트끼리 DB 파일을 공유할 필요가 없습니다. 별도 웹 호스트에서는 `/api`를 관리 API로 프록시하거나 [GitHub Pages 연결 설정](./GITHUB-PAGES.md)의 별도 API 주소 방식을 사용하세요.

## 구현 범위

참고 문서: 플랫폼 구축 상세기능명세 문서 (2026-09-15). 문서의 관리자 웹 제외 조건은 이번 웹 구축 요청에 따라 확장했습니다. 문서의 전체 플랫폼 기능이 완료된 상태는 아닙니다.

| 기능 | 현재 구현 | 추가 구현 필요 |
| --- | --- | --- |
| 과정 | 코드·기수·기간·Discord 서버 ID 등록, 상태 변경 | 기본정보 수정, 과정별 운영 권한 |
| 수강생·팀 | 등록·수정·팀 배정, 중복 및 소속 검증, 웹 배정에 따른 Discord 팀 역할·비공개 채널 자동 설정 | Excel 일괄 등록 |
| 멘토 | 기존 봇 DB 조회·등록·수정 | 담당 과정/팀 권한 제어 |
| 출결 | 회차 시작·마감, 담당 범위 명단 일괄 입력, 미처리 인원, 사후 정정 사유·전후 이력, 확정된 본인 기록 조회 | Discord 버튼 출석, 자동 지각·결석 판정 및 알림 |
| 성적 | 학생별 항목·배점·점수 등록/수정, 합산, 배점 초과 검증 | 과정별 공통 평가항목 설정, Excel 일괄 등록 |
| 과제 | 기존 봇 과제 조회·등록·마감·재개, 제출물 조회 | 과제 수정, 피드백, S3 제출, 웹 변경 자동 게시 |
| 멘토링 | 기존 예약 조회, 50분 예약 생성, 승인·완료, 취소 API, 중복 슬롯 검증 | 예약 이동, 상세 상담 기록, 즉시 Discord 알림 |
| 공지 | 초안·미리보기, 공통 Discord 공지 채널 발송, 상태·이력·실패 재시도·수동 기록, 멘션 차단 | 예약 발송·첨부 파일·역할별 수신 |
| 파일 | S3 미연결 상태 및 요구 구성 안내 화면 | S3 Private Bucket, 권한 검사, 업로드/다운로드, 만료 URL |
| 서버 | 배포 환경 메타데이터 등록 및 조회 | 원격 에이전트, 실제 봇 배포·시작·중지 |
| 내보내기 | 과정·수강생·팀·멘토·출결·성적·공지 CSV, 명단 출결 CSV 복구 입력 | 문서 기준 XLSX 양식 및 다른 항목 가져오기 |
| 인증·권한 | 개인 계정 로그인·비밀번호 변경·서버 계정 복구, Discord 봇 가입 인증, 전체/워크스페이스 관리자·강사·수강생 권한, 초대 및 가입 승인, 본인 학습 조회 | Discord OAuth, 세부 담당 과정 권한, 자동 계정 복구 |
| Discord 채널 | 서버별 카테고리·텍스트·음성 구성, 봇 연결 시 생성·재사용, 채널 안내 고정글, 적용 이력 | 일반 채널 삭제·이동, 과제·멘토링 운영 패널 자동 게시 |
| 온보딩 | 서버 참여 안내 DM 및 채널 대체 안내, 자기소개 버튼, 승인·인증·과정 등록 확인 후 역할 부여, 팀 이동 시 이전 팀 역할 회수 | 세부 단계별 통계 |
| 이력 | API 변경 전후 값, 작업자·유형·대상·일시 | 실제 Discord/S3 연동 실패 및 재시도 기록 |

프로세스 실행·중지 및 봇 모듈 설정 버튼은 API 모드에서 비활성화되어 있습니다. Discord 채널 구성은 별도 연동 모듈로 처리합니다. 공지는 초안만 저장하고 S3 파일 업로드는 수행하지 않습니다. 관리 기능은 워크스페이스 관리자에게 제공하며 강사는 출결·성적·가입 승인을 처리하고 수강생은 본인 학습만 조회합니다.

## 운영 배포

GitHub Pages에서 화면을 테스트하거나 별도 API를 연결하려면 [GITHUB-PAGES.md](./GITHUB-PAGES.md)를 참고하세요.

개발 모드는 API가 `127.0.0.1`에만 바인딩되며 로그인이 필요합니다. 최초 등록에는 관리자 설정 키가 필요합니다. 등록 이후 개인 아이디·비밀번호로 로그인합니다. 운영에서는 다음 값을 설정하세요.

```dotenv
NODE_ENV=production
ADMIN_PASSWORD=<16자 이상의 최초 관리자 설정 키>
ALLOWED_ORIGINS=https://lms.example.com
BOT_DB_PATH=/absolute/path/mentoring.db
```

```powershell
npm run build
npm start
```

API가 `dist/`도 함께 제공합니다. 운영 도메인의 HTTPS reverse proxy를 포트 3001로 연결하세요. 같은 도메인에서는 Secure / HttpOnly / SameSite=Strict 쿠키를 사용합니다. Pages처럼 다른 도메인에서는 메모리에만 보관하는 Bearer 세션을 사용하며 새로고침하면 다시 로그인합니다. 세션은 DB에 8시간 보관하고 계정 비밀번호 변경 시 해당 계정의 기존 세션을 무효화합니다. 비밀번호나 봇 토큰을 `VITE_*` 환경변수에 넣지 않습니다.

Docker 구성도 포함되어 있습니다. 프로젝트 루트가 build context입니다.

```powershell
cd lms-web
docker compose up -d --build
```

호스트의 `../data`에 컨테이너 `node` 사용자(uid 1000)가 읽고 쓸 수 있어야 합니다. SQLite의 WAL/SHM 파일도 같은 볼륨에 유지합니다. Docker CLI가 현재 환경에 없어 이미지 빌드와 컨테이너 실행은 검증하지 않았습니다. 클라우드 배포는 수행하지 않았습니다.

## 검증

```powershell
npm run build
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
```

DB 통합 테스트는 중복·권한 연결 관계·점수 경계·변경 이력·예약 충돌·취소 슬롯 재사용·트랜잭션 롤백·동시 수정 충돌을 검증합니다. 브라우저 테스트는 인증, 폼 저장 및 오류, 새로고침 유지, CSV 다운로드, 360/390/820/1440px 화면, 미연결 조작 차단을 검증합니다.

## 구성

```text
src/App.tsx          탐색, 인증, 공통 입력창
src/Dashboard.tsx    DB 기반 운영 통계 및 일정
src/Operations.tsx   수강생·팀·멘토·출결·성적·공지·제출 내역
src/Management.tsx   과정·멘토링·과제·서버·운영 이력
src/useWorkspace.ts API 조회, 변경 요청, 충돌·인증 오류 처리
server/index.mjs    Express 인증 및 API, 정적 파일 제공
server/store.mjs    기존 봇 DB 연결, 검증 및 트랜잭션
```

구성 참고: [Vite](https://vite.dev/guide/), [Tailwind Vite 플러그인](https://tailwindcss.com/docs/installation/using-vite), [Node SQLite](https://nodejs.org/api/sqlite.html), [Express 보안 설정](https://expressjs.com/en/advanced/best-practice-security.html).

## Render 아산 AX 운영 데이터

**아산 AX 워크스페이스 → 봇 연결 현황** 메뉴는 기존 Render 봇이 전송한 조회용 데이터를 표시합니다. 연결 설정과 적용 순서는 [RENDER-SYNC.md](./RENDER-SYNC.md)를 참고하세요. 코드 구현과 실제 Render 배포는 별개이며, 원격 설정 적용 전에는 수신 대기로 표시됩니다.

## Windows 백그라운드 실행

터미널 세션 종료 후에도 로컬 서버를 유지하려면 `lms-web` 디렉토리에서 `npm run dev:background`를 사용하세요. 창을 띄우지 않고 웹과 API를 실행하며, 이미 사용 중인 포트의 프로세스를 종료하지 않습니다. 실행 로그는 `.local-logs/`에 저장됩니다. 백그라운드 실행은 개발용이며 코드 변경 시 API 재시작이 필요합니다.
