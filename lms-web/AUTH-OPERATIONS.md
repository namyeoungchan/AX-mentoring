# 운영 계정 로그인

총관리자도 개인 아이디와 비밀번호로 로그인합니다. 기존 수강생·강사·워크스페이스 관리자 계정과 Discord 가입 승인 절차는 유지됩니다. 새 학생은 [관리자 발급 계정](./STUDENT-ACCOUNTS.md)으로 로그인하고 이름·새 비밀번호를 설정합니다. 소속과 권한은 서버에서 검사합니다.

## 최초 관리자 등록

1. API 환경변수 `ADMIN_PASSWORD`에 16자 이상의 무작위 설정 키를 지정합니다. `npm run bot:setup` 또는 Render Blueprint가 키를 생성할 수 있습니다. 클라이언트 빌드 변수나 Git에 넣지 않습니다.
2. 웹 로그인 화면에서 **최초 관리자 등록**을 선택합니다.
3. 이름·아이디·새 비밀번호(15~128자)와 관리자 설정 키를 입력합니다. 설정 키는 API 서버의 `ADMIN_PASSWORD`입니다. Discord 사용자 ID는 필요하지 않습니다.
4. 등록한 개인 계정으로 로그인되고, 이후에는 모든 역할이 같은 로그인 폼을 사용합니다.

최초 관리자 등록은 DB당 한 번입니다. 같은 아이디의 기존 사용자를 승격하지 않으며 동시 등록 중 하나만 성공합니다. 등록 이후 설정 키를 제거해도 로그인은 유지됩니다. 공용 관리자 세션은 폐기되며 `/api/login`은 더 이상 동작하지 않습니다. `NODE_ENV=production`에서는 등록 전에도 공용 로그인을 허용하지 않습니다. 개발용 호환 로그인은 `ALLOW_LEGACY_ADMIN=true`를 명시한 경우에만 사용할 수 있습니다.

관리자 계정을 만든다고 기존 데이터·회원·워크스페이스가 초기화되지는 않습니다. DB와 워크스페이스 파일을 영속 볼륨에 보관해야 합니다.

## 비밀번호와 세션

- 총관리자가 워크스페이스 관리자 초대와 함께 발급한 계정은 첫 로그인 시 초기 비밀번호를 변경해야 합니다. 변경 전에는 본인 로그인 정보 조회·비밀번호 변경·로그아웃만 허용합니다. 초기 비밀번호는 최초 발급 응답에만 포함되고 DB에는 scrypt 해시만 저장되며, 초대 목록·미리보기·감사 이력에는 비밀번호를 포함하지 않습니다. 기존 계정은 이 발급 기능으로 덮어쓰지 않습니다.

- 로그인 후 **비밀번호 변경**에서 현재 비밀번호를 확인하고 새 비밀번호를 저장합니다. 다른 기기의 모든 세션을 폐기하고 현재 브라우저에는 새 세션을 발급합니다.
- 비밀번호는 scrypt와 계정별 salt로, 세션 토큰은 SHA-256 해시로 DB에 저장합니다. 평문 비밀번호와 토큰을 저장하지 않습니다.
- 계정·IP별 로그인 시도 제한은 DB에 저장되어 프로세스 재시작 후에도 적용됩니다. 세션 유효기간은 8시간입니다.
- 개인 계정 로그인은 같은 교실의 공용 IP에서 15분에 1,200회까지 요청할 수 있습니다. 계정별로는 15분에 10회까지 시도하며 로그인 성공 시 해당 계정의 횟수를 초기화합니다. 잘못된 비밀번호의 반복 시도는 계속 제한합니다. 초대 계정 가입은 같은 IP에서 1시간에 100회, 학생 계정 발급은 관리자 계정당 1시간에 100회로 제한합니다.
- 비밀번호 계산은 동시에 4개씩 처리하고 최대 128개를 60초까지 대기시킵니다. 대기열 초과는 재시도 시간을 포함한 503, 횟수 초과는 남은 시간을 포함한 429로 안내합니다.
- 웹과 API를 같은 HTTPS 주소로 제공하면 Secure·HttpOnly·SameSite=Strict 쿠키로 새로고침 후에도 로그인 상태를 유지합니다. 브라우저 localStorage/sessionStorage에 인증 토큰을 저장하지 않습니다.
- GitHub Pages와 외부 API를 조합하면 기존 메모리 Bearer 방식으로 로그인합니다. 이 구성에서는 새로고침 시 다시 로그인해야 합니다. 운영 웹은 Render API가 제공하는 웹 주소로 접속하거나 같은 도메인의 `/api` 프록시를 사용하세요.

## 계정 복구

총관리자가 **전체 계정 관리**에서 초기 비밀번호를 재발급할 수 있습니다. 이메일·Discord 자동 복구는 제공하지 않습니다. 웹에 접근할 수 없는 긴급 복구는 운영자가 요청자의 본인 여부를 확인하고 **실제 운영 DB를 사용하는 서버 터미널**에서 실행합니다.

```sh
cd /app/lms-web
npm run account:reset -- 사용자아이디
```

비밀번호는 화면에 표시되지 않는 대화형 입력으로 두 번 받습니다. 명령 인자나 환경변수로 비밀번호를 넘기지 않습니다. 해당 계정의 비밀번호를 변경하고 모든 세션을 폐기합니다. 역할과 워크스페이스 소속은 변경하지 않습니다. 이 기능에는 공개 HTTP 엔드포인트가 없습니다.

## Render에서 로그인 제공

기존 봇 Worker와 별도로 `lms-web/render.receiver.yaml`을 사용해 웹 서비스를 배포합니다. 이 서비스 하나가 빌드한 React 웹과 API를 함께 제공합니다. 데이터 디스크 `/app/data`를 유지하고 `ALLOWED_ORIGINS`를 실제 웹의 HTTPS Origin으로 지정합니다. Blueprint의 `TRUST_PROXY_HOPS=1`은 Render 프록시 1단계 구성용입니다.

배포 후 **Render 웹 서비스 주소**에 접속해 최초 관리자 등록을 진행합니다. Pages만 배포해도 사용자 DB/API가 생성되지는 않습니다. Pages에서 `VITE_API_BASE_URL`이 없으면 데모 대신 서비스 미연결 화면을 표시합니다.

Render의 실제 주소는 플랫폼이 제공하는 `RENDER_EXTERNAL_URL`에서 읽어 자동으로 허용합니다. 서비스 이름을 변경해도 기존 주소로 로그인할 수 있습니다. GitHub Pages·커스텀 도메인은 `ALLOWED_ORIGINS`에 명시해야 합니다. 현재 Blueprint는 `https://ax-learningops-web.onrender.com,https://namyeoungchan.github.io`를 지정합니다. 환경변수 변경은 재배포 후 적용됩니다. 요청의 Host 또는 X-Forwarded-Host를 허용 목록으로 사용하지 않습니다.

구현 점검 참고: [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## 로그아웃과 Discord 계정 연결

관리자·강사·수강생 화면 상단의 **로그아웃**은 현재 서버 세션을 폐기하고 로그인 화면으로 이동합니다. 새로고침해도 로그인 상태가 복원되지 않습니다. 서버에 연결하지 못하면 실패를 표시하고 다시 시도할 수 있습니다.

강사는 초대 계정 가입 시, 학생은 발급 계정의 첫 로그인 설정 시 Discord ID를 입력하지 않습니다. 웹의 일회용 코드를 Discord 봇에서 확인하면 해당 Discord 계정이 자동 연결됩니다. 이미 다른 LMS 계정에 연결된 Discord 계정과 중복 연결은 거절합니다. 기존에 연결한 계정은 유지합니다.

수강생 웹 화면의 단계별 안내에서 서버 초대를 수락하고 인증 코드를 복사한 뒤, Discord **시작하기 → 1 · LMS 인증** 패널에 입력합니다. 표시된 계정을 확인하고 **내 계정 가입 인증**을 누른 뒤 자기소개를 작성합니다. 웹으로 돌아와 **인증 후 학습 화면 열기**를 누르면 완료 상태를 확인합니다. 같은 계정·워크스페이스의 유효한 코드는 재요청해도 유지되며, 코드 원문은 만료 전까지 서버 메모리에만 보관합니다. 서버 재시작 후 다시 요청하면 새 코드가 발급됩니다.

## 웹 주소 전환

목표 웹 주소는 `https://ax-learningops-web.onrender.com`이고, `render.receiver.yaml`의 서비스 이름과 허용 Origin을 이에 맞췄습니다. 파일 수정만으로 운영 서비스의 주소가 변경되지는 않습니다. Render가 실제로 부여한 URL과 영속 데이터 연결을 확인한 후 다음 값을 적용합니다.

- 웹 서비스: `ALLOWED_ORIGINS=https://ax-learningops-web.onrender.com,https://namyeoungchan.github.io`, `NODE_ENV=production`
- 봇 Worker: `LEARNINGOPS_PROVISION_URL=https://ax-learningops-web.onrender.com/api/integrations/discord/provision`
- 봇 Worker의 가입 인증을 사용하는 경우: `LEARNINGOPS_AUTH_URL=https://ax-learningops-web.onrender.com/api/integrations/discord/verify`
- 봇 Worker의 스냅샷 전송을 사용하는 경우: `LEARNINGOPS_SYNC_URL=https://ax-learningops-web.onrender.com/api/integrations/render/snapshot`
- GitHub Pages를 사용하는 경우: Repository Variable `VITE_API_BASE_URL=https://ax-learningops-web.onrender.com`을 설정한 뒤 Pages를 다시 빌드합니다. Render 웹 자체는 같은 주소의 API를 사용합니다.

Blueprint 서비스 이름은 리소스 식별에 사용되므로 기존 서비스와의 연결을 확인해야 합니다. 새로운 서비스를 만들게 되는 경우 기존 `/app/data`의 SQLite와 워크스페이스 데이터가 자동 이동한다고 가정하지 않습니다. 새 웹의 `/api/health`, 관리자 로그인, 기존 데이터 조회를 확인한 뒤 봇의 주소를 전환합니다. 관련 공식 문서: [Blueprint 리소스 관리](https://render.com/docs/infrastructure-as-code), [웹 서비스 URL](https://render.com/docs/web-services).

## 총관리자의 전체 계정 관리

개인 총관리자 계정으로 로그인해 **전체 계정 관리**를 엽니다. 모든 계정의 이름·아이디·워크스페이스 소속을 검색할 수 있습니다. 워크스페이스 관리자·강사·수강생과 개발용 공용 관리자는 이 API를 사용할 수 없습니다.

**초기 비밀번호 재설정**에서 대상 아이디를 확인하면 새 무작위 초기 비밀번호를 한 번 표시합니다. 기존 비밀번호로 되돌리는 것이 아니라 새 초기 비밀번호를 발급합니다. 기존 로그인과 진행 중 인증 코드를 무효화하고 다음 로그인에서 본인 비밀번호로 바꾸도록 합니다. 본인 계정 재설정 시 발급 정보를 확보한 후 다시 로그인하세요. 비밀번호 원문은 목록·감사 기록에 저장하지 않습니다.

**계정 삭제**에서 대상 아이디를 입력하면 로그인 계정, 세션, 소속, 가입 신청, 인증·멘토 프로필을 제거하고 미수락 초대를 취소합니다. 출결·과제 등 운영 이력은 보존합니다. 마지막 총관리자 계정은 삭제할 수 없습니다. 삭제는 계정 단위이며 실제 운영 계정을 일괄 삭제하는 작업은 제공하지 않습니다. 재설정·삭제는 `lms_account_audit`에 작업자·대상·시각을 기록합니다.
