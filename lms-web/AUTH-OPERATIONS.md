# 운영 계정 로그인

전체 관리자도 개인 아이디와 비밀번호로 로그인합니다. 기존 수강생·강사·워크스페이스 관리자 계정과 Discord 가입 승인 절차는 유지됩니다. 소속과 권한은 서버에서 검사합니다.

## 최초 관리자 등록

1. API 환경변수 `ADMIN_PASSWORD`에 16자 이상의 무작위 설정 키를 지정합니다. `npm run bot:setup` 또는 Render Blueprint가 키를 생성할 수 있습니다. 클라이언트 빌드 변수나 Git에 넣지 않습니다.
2. 웹 로그인 화면에서 **최초 관리자 등록**을 선택합니다.
3. 이름·아이디·새 비밀번호(15~128자)와 관리자 설정 키를 입력합니다. 설정 키는 API 서버의 `ADMIN_PASSWORD`입니다. Discord 사용자 ID는 필요하지 않습니다.
4. 등록한 개인 계정으로 로그인되고, 이후에는 모든 역할이 같은 로그인 폼을 사용합니다.

최초 관리자 등록은 DB당 한 번입니다. 같은 아이디의 기존 사용자를 승격하지 않으며 동시 등록 중 하나만 성공합니다. 등록 이후 설정 키를 제거해도 로그인은 유지됩니다. 공용 관리자 세션은 폐기되며 `/api/login`은 더 이상 동작하지 않습니다. `NODE_ENV=production`에서는 등록 전에도 공용 로그인을 허용하지 않습니다. 개발용 호환 로그인은 `ALLOW_LEGACY_ADMIN=true`를 명시한 경우에만 사용할 수 있습니다.

관리자 계정을 만든다고 기존 데이터·회원·워크스페이스가 초기화되지는 않습니다. DB와 워크스페이스 파일을 영속 볼륨에 보관해야 합니다.

## 비밀번호와 세션

- 로그인 후 **비밀번호 변경**에서 현재 비밀번호를 확인하고 새 비밀번호를 저장합니다. 다른 기기의 모든 세션을 폐기하고 현재 브라우저에는 새 세션을 발급합니다.
- 비밀번호는 scrypt와 계정별 salt로, 세션 토큰은 SHA-256 해시로 DB에 저장합니다. 평문 비밀번호와 토큰을 저장하지 않습니다.
- 계정·IP별 로그인 시도 제한은 DB에 저장되어 프로세스 재시작 후에도 적용됩니다. 세션 유효기간은 8시간입니다.
- 웹과 API를 같은 HTTPS 주소로 제공하면 Secure·HttpOnly·SameSite=Strict 쿠키로 새로고침 후에도 로그인 상태를 유지합니다. 브라우저 localStorage/sessionStorage에 인증 토큰을 저장하지 않습니다.
- GitHub Pages와 외부 API를 조합하면 기존 메모리 Bearer 방식으로 로그인합니다. 이 구성에서는 새로고침 시 다시 로그인해야 합니다. 운영 웹은 Render API가 제공하는 웹 주소로 접속하거나 같은 도메인의 `/api` 프록시를 사용하세요.

## 계정 복구

현재는 이메일·Discord 자동 비밀번호 복구를 제공하지 않습니다. 운영자가 요청자의 본인 여부를 확인하고 **실제 운영 DB를 사용하는 서버 터미널**에서 실행합니다.

```sh
cd /app/lms-web
npm run account:reset -- 사용자아이디
```

비밀번호는 화면에 표시되지 않는 대화형 입력으로 두 번 받습니다. 명령 인자나 환경변수로 비밀번호를 넘기지 않습니다. 해당 계정의 비밀번호를 변경하고 모든 세션을 폐기합니다. 역할과 워크스페이스 소속은 변경하지 않습니다. 이 기능에는 공개 HTTP 엔드포인트가 없습니다.

## Render에서 로그인 제공

기존 봇 Worker와 별도로 `lms-web/render.receiver.yaml`을 사용해 웹 서비스를 배포합니다. 이 서비스 하나가 빌드한 React 웹과 API를 함께 제공합니다. 데이터 디스크 `/app/data`를 유지하고 `ALLOWED_ORIGINS`를 실제 웹의 HTTPS Origin으로 지정합니다. Blueprint의 `TRUST_PROXY_HOPS=1`은 Render 프록시 1단계 구성용입니다.

배포 후 **Render 웹 서비스 주소**에 접속해 최초 관리자 등록을 진행합니다. Pages만 배포해도 사용자 DB/API가 생성되지는 않습니다. Pages에서 `VITE_API_BASE_URL`이 없으면 데모 대신 서비스 미연결 화면을 표시합니다.

구현 점검 참고: [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
