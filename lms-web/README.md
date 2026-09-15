# 천안 AX LearningOps 웹

React + TypeScript + Vite + Tailwind CSS로 만든 반응형 운영 웹입니다. Node.js / Express 관리 API가 기존 Python 봇과 같은 SQLite 파일을 사용합니다. 기존 봇에는 선택적으로 활성화되는 Render 데이터 전송 모듈을 추가했습니다. URL과 키를 설정하지 않으면 기존 동작을 유지합니다.

## 실행

Node.js 24 이상이 필요합니다.

```powershell
cd lms-web
npm install
npm run dev
```

- 웹: http://127.0.0.1:5173
- API: http://127.0.0.1:3001/api/health
- 샘플 화면: http://127.0.0.1:5173/?demo=1

기본 모드는 API 연결입니다. 초기 DB가 비어 있으면 화면에도 0건으로 표시합니다. 샘플 모드는 실제 DB를 변경하지 않고 브라우저에 저장합니다.

`npm run dev`는 API와 Vite를 함께 실행합니다. 외부 API를 이미 실행하고 있다면 `npm run dev:web`을 사용합니다.

## 기존 봇 데이터 연결

`.env.example`을 `.env`로 복사한 뒤 **봇이 사용하는 실제 DB 경로**를 지정합니다. `BOT_DB_PATH`의 상대 경로 기준은 `lms-web/`입니다.

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

기존 예약/과제의 채널 패널이나 Discord 메시지는 DB 변경만으로 즉시 갱신되지 않습니다. 기존 봇의 패널 새로고침 명령을 사용해야 합니다. 웹 저장 후 자동 Discord 게시/DM 발송은 구현하지 않았습니다. 기존 봇의 예약 조회 및 승인 예약 리마인더는 공유 DB의 값을 읽습니다.

SQLite 파일은 API와 봇이 같은 호스트의 로컬 볼륨에서 공유하는 구성을 기준으로 합니다. 웹과 API는 다른 서버에 둘 수 있지만 원격 호스트끼리 SQLite 파일을 네트워크 파일시스템으로 공유하는 구성은 지원 대상으로 삼지 않았습니다. 별도 웹 호스트에서는 `/api`를 관리 API로 프록시하거나 [GitHub Pages 연결 설정](./GITHUB-PAGES.md)의 별도 API 주소 방식을 사용하세요.

## 구현 범위

참고 문서: `천안_AX_LearningOps_플랫폼_구축_제안서_상세기능명세_Word호환본.docx` (2026-09-15). 문서의 관리자 웹 제외 조건은 이번 웹 구축 요청에 따라 확장했습니다. 문서의 전체 플랫폼 기능이 완료된 상태는 아닙니다.

| 기능 | 현재 구현 | 추가 구현 필요 |
| --- | --- | --- |
| 과정 | 코드·기수·기간·Discord 서버 ID 등록, 상태 변경 | 기본정보 수정, 과정별 운영 권한 |
| 수강생·팀 | 등록·수정·팀 배정, 중복 및 소속 검증 | Excel 일괄 등록, Discord 역할·채널 자동 설정 |
| 멘토 | 기존 봇 DB 조회·등록·수정 | 담당 과정/팀 권한 제어 |
| 출결 | 수동 등록·수정, 수정 사유 및 전후 이력 | 차시 개설, Discord 버튼 출석, 자동 지각·결석 판정 및 알림 |
| 성적 | 학생별 항목·배점·점수 등록/수정, 합산, 배점 초과 검증 | 과정별 공통 평가항목 설정, Excel 일괄 등록, 학생 본인 조회 |
| 과제 | 기존 봇 과제 조회·등록·마감·재개, 제출물 조회 | 과제 수정, 피드백, S3 제출, 웹 변경 자동 게시 |
| 멘토링 | 기존 예약 조회, 50분 예약 생성, 승인·완료, 취소 API, 중복 슬롯 검증 | 예약 이동, 상세 상담 기록, 즉시 Discord 알림 |
| 공지 | 대상 과정 및 수신 역할을 포함한 초안 등록·수정 | 실제 Discord 발송·예약·재시도 |
| 파일 | S3 미연결 상태 및 요구 구성 안내 화면 | S3 Private Bucket, 권한 검사, 업로드/다운로드, 만료 URL |
| 서버 | 배포 환경 메타데이터 등록 및 조회 | 원격 에이전트, 실제 봇 배포·시작·중지 |
| 내보내기 | 과정·수강생·팀·멘토·출결·성적·공지 CSV | 문서 기준 XLSX 양식 및 가져오기 |
| 인증·권한 | 관리자 비밀번호, HttpOnly 세션, 로그인 제한, Origin 검증 | Discord OAuth, 최고관리자/과정운영자/멘토/학생별 RBAC |
| 이력 | API 변경 전후 값, 작업자·유형·대상·일시 | 실제 Discord/S3 연동 실패 및 재시도 기록 |

실제 서버 조작 및 봇 모듈 설정 버튼은 API 모드에서 비활성화되어 있습니다. 공지는 초안만 저장하고 S3 파일 업로드는 수행하지 않습니다. 단일 관리자용 웹이므로 수강생·멘토 계정에 관리자 비밀번호를 공유하는 운영을 전제로 하지 않습니다.

## 운영 배포

GitHub Pages에서 화면을 테스트하거나 별도 API를 연결하려면 [GITHUB-PAGES.md](./GITHUB-PAGES.md)를 참고하세요.

개발 모드는 API가 `127.0.0.1`에만 바인딩됩니다. 비밀번호를 비워 두면 로컬 개발 접속만 허용합니다. 운영에서는 다음 값을 설정하세요.

```dotenv
NODE_ENV=production
ADMIN_PASSWORD=<16자 이상의 비밀번호>
ALLOWED_ORIGINS=https://lms.example.com
BOT_DB_PATH=/absolute/path/mentoring.db
```

```powershell
npm run build
npm start
```

API가 `dist/`도 함께 제공합니다. 운영 도메인의 HTTPS reverse proxy를 포트 3001로 연결하세요. 같은 도메인에서는 Secure / HttpOnly / SameSite=Strict 쿠키를 사용합니다. Pages처럼 다른 도메인에서는 메모리에만 보관하는 Bearer 세션을 사용하며 새로고침하면 다시 로그인합니다. 서버 재시작 시에도 세션은 만료됩니다. 비밀번호나 봇 토큰을 `VITE_*` 환경변수에 넣지 않습니다.

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

웹의 **아산 AX 운영 현황** 메뉴는 기존 Render 봇이 전송한 조회용 데이터를 표시합니다. 연결 설정과 적용 순서는 [RENDER-SYNC.md](./RENDER-SYNC.md)를 참고하세요. 코드 구현과 실제 Render 배포는 별개이며, 원격 설정 적용 전에는 수신 대기로 표시됩니다.

## Windows 백그라운드 실행

터미널 세션 종료 후에도 로컬 서버를 유지하려면 `lms-web` 디렉토리에서 `npm run dev:background`를 사용하세요. 창을 띄우지 않고 웹과 API를 실행하며, 이미 사용 중인 포트의 프로세스를 종료하지 않습니다. 실행 로그는 `.local-logs/`에 저장됩니다. 백그라운드 실행은 개발용이며 코드 변경 시 API 재시작이 필요합니다.
