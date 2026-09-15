# LMS 계정 및 Discord 채널 설정

## 로그인과 가입 인증

1. 웹 회원가입 화면에서 이름·아이디·비밀번호·본인의 Discord 사용자 ID를 입력합니다. 이메일 인증으로 표시하지 않습니다.
2. 10분간 유효한 일회용 코드가 표시됩니다. 교육 서버에서 `/lms인증 코드:발급코드`를 실행합니다.
3. 봇의 비공개 응답에서 LMS 아이디를 확인하고 **내 계정 가입 인증** 버튼을 누릅니다. 본인이 직접 가입한 계정만 인증하세요.
4. 웹에서 **인증 상태 확인**을 누르거나 자동 확인을 기다립니다. 인증 후 아이디·비밀번호로 로그인합니다.

계정은 Discord 인증이 완료될 때 생성됩니다. 수강생은 본인의 과정·출결·점수·과제만 조회할 수 있습니다. 연결 기준은 인증된 Discord ID입니다. 운영자가 수강생 관리에서 같은 ID를 과정에 등록하면 연결됩니다. `정상`·`수료` 상태의 수강생에게 학습 데이터를 제공합니다. 가입한 이름이나 이메일이 같다는 이유로 연결하지 않습니다. 원격 Render 조회용 스냅샷은 관리자 전용입니다.

일반 가입자가 관리자 권한을 선택할 수 없습니다. 기존 운영자는 로그인 화면 아래 **관리자 로그인**에서 서버의 `ADMIN_PASSWORD`를 사용합니다. 개발 환경에서도 인증을 생략하지 않습니다. 비밀번호 초기화·Discord 계정 변경·멘토/과정운영자 권한은 이번 범위에 포함되지 않습니다.

비밀번호는 salt와 scrypt(N=32768, r=8, p=3)로 저장합니다. 코드와 세션 토큰은 SHA-256 해시로만 DB에 저장합니다. 인증 코드는 1회 사용, 10분 만료, 1분 간격 재발급이며 이전 코드는 즉시 무효화됩니다. 가입 상태 확인용 토큰은 브라우저 메모리에만 있으며, 가입 도중 새로고침하면 다시 신청해야 합니다. 미완료 신청은 24시간 후 정리합니다. 로그인·가입·코드 조회에는 서버 측 요청 제한을 적용합니다.

같은 도메인에서는 Secure(운영)·HttpOnly·SameSite=Strict 쿠키를 사용합니다. Pages처럼 다른 도메인에서는 메모리의 Bearer 세션으로 연결하므로 새로고침하면 다시 로그인합니다. 세션은 8시간 유효하고 DB에 보관되어 API 재시작 후에도 유효합니다. 관리자 비밀번호가 변경되면 기존 관리자 세션은 무효화됩니다.

## 웹에서 채널 구성

관리자 메뉴 **Discord 채널 설정**에서 서버 ID와 카테고리·텍스트·음성 채널 구성을 입력합니다. 기본안은 공지·질문·과제·멘토링·팀 채팅·팀 음성 채널입니다. 원하는 이름과 수, 상위 카테고리로 변경할 수 있습니다. 최대 30개입니다.

- **봇 연결 시 자동 적용**을 켜고 저장하면 해당 서버가 봇에 연결될 때 작업이 생성됩니다. 이미 봇이 참여 중인 서버도 다음 확인 주기에 적용합니다.
- 자동 적용을 끄면 설정만 저장합니다. 저장 후 **적용 요청**으로 실행할 수 있습니다.
- 봇은 서버 초대 이벤트와 30초 주기로 작업을 확인합니다. 이 기능은 봇이 참여한 여러 서버를 지원합니다. 가입 인증은 별도로 지정한 `LEARNINGOPS_AUTH_GUILD_ID` 서버를 사용합니다.
- 카테고리를 먼저 생성합니다. 같은 이름·유형·상위 카테고리의 채널은 재사용합니다. 중복 후보가 여러 개면 실패로 표시합니다.
- 기존 채널을 삭제·이동·이름 변경하지 않습니다. 새 채널은 서버와 카테고리의 기본 접근 권한을 따릅니다. 비공개 역할 설정은 Discord에서 관리하세요.
- 봇에는 **채널 관리** 권한이 필요합니다. 적용 중 설정 변경과 중복 실행은 차단합니다. 실패한 작업은 자동 반복하지 않으며 권한/연결 문제를 해결한 후 재요청합니다.
- 작업당 봇 처리 제한은 180초, 서버 임대는 300초입니다. 부분 생성 후 실패했을 때도 기존 채널을 재사용해 재시도합니다. 전송 장애로 완료 확인이 누락되면 시간 초과로 표시될 수 있습니다.

생성한 채널을 기존 과제·온보딩·멘토링 패널의 고정 채널 ID에 자동 배정하거나 패널 메시지를 게시하는 기능은 아직 없습니다. 해당 모듈의 채널 ID 설정은 별도로 맞춰야 합니다. 채널 생성과 운영 모듈의 연결은 구분됩니다.

## 서버 연결 설정

```powershell
cd lms-web
npm run bot:setup
```

이 명령은 Git에서 제외된 `lms-web/.env`에 관리자 비밀번호·가입 인증 키·채널 설정 키를 생성합니다. 기존 값은 유지하고 값을 터미널에 출력하지 않습니다. 로컬 관리 로그인은 이 파일의 `ADMIN_PASSWORD`를 사용합니다. `LEARNINGOPS_AUTH_GUILD_ID`에는 실제 교육 서버 ID를 입력하세요.

웹 API 환경변수:

```dotenv
NODE_ENV=production
ADMIN_PASSWORD=<16자 이상>
ALLOWED_ORIGINS=https://namyeoungchan.github.io
LEARNINGOPS_AUTH_GUILD_ID=<실제 교육 Discord 서버 ID>
LEARNINGOPS_AUTH_TOKEN=<가입 인증 전용 32자 이상 키>
LEARNINGOPS_PROVISION_TOKEN=<채널 설정 전용 32자 이상 키>
```

기존 Render 봇 환경변수:

```dotenv
LEARNINGOPS_AUTH_URL=https://실제-API-주소/api/integrations/discord/verify
LEARNINGOPS_AUTH_TOKEN=<API와 같은 가입 인증 키>
LEARNINGOPS_PROVISION_URL=https://실제-API-주소/api/integrations/discord/provision
LEARNINGOPS_PROVISION_TOKEN=<API와 같은 채널 설정 키>
```

봇의 `GUILD_ID`와 API의 `LEARNINGOPS_AUTH_GUILD_ID`는 가입 인증용으로 일치해야 합니다. 채널 설정 대상 서버 ID는 웹에서 별도로 지정합니다. 봇을 초대할 때 `bot`·`applications.commands` scope를 포함하세요. 기본 봇 명령 동기화는 기존 `GUILD_ID`에 유지되며 채널 자동 구성은 다른 서버에서도 동작합니다.

원격에서 API를 사용할 때 HTTPS와 영속 DB 볼륨이 필요합니다. reverse proxy를 통과한다면 실제 배포 구조에 맞춰 `TRUST_PROXY_HOPS`를 지정해야 로그인 제한이 클라이언트 IP별로 적용됩니다. 직접 접속 기본값은 0입니다. 키를 `VITE_*` 변수나 GitHub Pages 번들에 넣지 않습니다. 동기화·가입 인증·채널 설정은 각각 별도 키를 사용합니다.

API와 봇을 재배포하고 Pages의 `VITE_API_BASE_URL`을 실제 API 주소로 설정하면 사용할 수 있습니다. API가 없는 Pages 빌드에서는 로그인·회원가입 화면과 **데모 둘러보기**만 제공하며 계정 생성과 Discord 채널 적용은 실행하지 않습니다.

## 검증

```powershell
cd lms-web
npm test
npm run test:e2e
npm run build:pages
npm run test:pages
cd ..
python -m unittest discover -s tests -p "test_*.py" -v
```

로컬 임시 DB와 모의 Discord 객체로 가입·인증·권한 차단·채널 생성 및 재사용·실패 재시도를 검증합니다. 실제 Discord 서버의 채널 생성과 Render 배포 검증은 별도로 필요합니다.

구현 참고: [Node scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback), [discord.py interactions](https://discordpy.readthedocs.io/en/stable/interactions/api.html), [discord.py 채널 생성](https://discordpy.readthedocs.io/en/stable/api.html#discord.Guild.create_text_channel).
