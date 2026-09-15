# LMS 계정 및 Discord 채널 설정

## 워크스페이스와 권한

워크스페이스 생성·전환·저장소 구조는 [WORKSPACES.md](./WORKSPACES.md)를 참고하세요.

- 전체 관리자: 기존 `ADMIN_PASSWORD`로 로그인하고 워크스페이스를 생성합니다. **구성원 · 초대**에서 개인 아이디를 지정해 워크스페이스 관리자를 초대합니다.
- 워크스페이스 관리자: 본인 워크스페이스를 운영하고 강사를 초대합니다. 다른 워크스페이스 생성이나 관리자 지정은 할 수 없습니다.
- 강사: 수업·과제 현황 조회, 출결·성적 입력, 수강생 가입 승인 화면을 사용합니다.
- 수강생: 승인과 Discord 본인 인증을 완료한 워크스페이스에서 본인 학습 정보만 조회합니다.

관리자·강사 초대 링크는 지정한 아이디로만 수락할 수 있습니다. 7일간 유효하고 한 번만 사용되며 취소할 수 있습니다. DB에는 링크 토큰의 해시만 저장합니다. 링크는 생성 직후 복사해서 직접 전달합니다. 이메일이나 Discord DM을 자동 발송하지 않습니다. 초대받은 관리자·강사는 기존 가입 인증 절차를 거쳐 개인 계정으로 로그인하고 초대를 수락합니다.

## 수강생 가입 → 승인 → Discord 참여

1. 회원가입 화면에서 워크스페이스·이름·아이디·비밀번호·본인의 Discord 사용자 ID를 입력합니다. 이 단계에서 교육 Discord 서버에 참여할 필요는 없습니다.
2. 계정이 생성되고 **가입 신청 현황**이 표시됩니다. 재접속해도 승인 상태를 조회할 수 있지만, 승인 전에는 워크스페이스의 학습 데이터를 읽을 수 없습니다.
3. 해당 워크스페이스의 관리자 또는 강사가 **가입 승인**에서 신청을 승인하거나 사유를 남겨 반려합니다. 승인 시 연결된 Discord 서버를 선택합니다.
4. 봇이 승인 작업을 가져가면 해당 서버의 초대 링크를 발급합니다. 신청자 본인의 웹 화면에 **Discord 서버 참여** 링크가 표시됩니다. 봇 미연결·권한 부족은 발급 대기 또는 실패로 표시합니다.
5. 수강생은 Discord에 참여한 후 웹에서 **Discord 인증 코드 받기**를 누르고 해당 서버에서 `/lms인증 코드:발급코드`를 실행합니다. 비공개 응답의 아이디를 확인하고 인증 버튼을 누릅니다.
6. 인증된 Discord ID·승인된 서버가 모두 일치하면 워크스페이스 참여가 완료됩니다. **인증 후 학습 화면 열기**를 누르면 본인 학습 화면으로 이동합니다.

Discord 초대는 1회 사용·24시간 만료입니다. 웹은 시간 오차를 고려해 23시간까지만 링크를 제공합니다. 만료·발급 실패 시 신청자가 재발급을 요청할 수 있습니다. 초대 링크를 아는 것만으로 LMS 권한이 생기지는 않습니다. 봇에는 초대 생성 권한이 필요하며, 일반 구성원이 볼 수 있는 텍스트 채널에서 링크를 생성합니다.

워크스페이스 참여와 과정 배정은 별도입니다. 관리자가 수강생 관리에서 같은 Discord ID를 과정에 배정하면 본인 과정·출결·성적·과제가 연결됩니다. `정상`·`수료` 상태에 한해 학습 정보를 제공합니다. 이름이나 이메일만으로 다른 수강생 데이터에 연결하지 않습니다.

비밀번호는 salt와 scrypt(N=32768, r=8, p=3)로 저장합니다. 인증 코드·세션·관리자/강사 초대 토큰은 SHA-256 해시로 저장합니다. Discord 가입 인증 코드는 10분 유효·1회 사용이며 1분 간격으로 재발급할 수 있습니다. 가입·로그인·초대 재발급에는 요청 제한을 적용합니다.

같은 도메인에서는 Secure(운영)·HttpOnly·SameSite=Strict 쿠키를 사용합니다. Pages처럼 다른 도메인에서는 메모리의 Bearer 세션을 사용하므로 새로고침하면 다시 로그인합니다. 계정·가입 신청·승인 기록은 DB에 남습니다. 세션은 8시간 유효하며 관리자 비밀번호 변경 시 기존 전체 관리자 세션은 무효화됩니다.

## 웹에서 채널 구성

관리자 메뉴 **Discord 채널 설정**에서 서버 ID와 카테고리·텍스트·음성 채널 구성을 입력합니다. 기본안은 공지·질문·과제·멘토링·팀 채팅·팀 음성 채널입니다. 원하는 이름과 수, 상위 카테고리로 변경할 수 있습니다. 최대 30개입니다.

- **봇 연결 시 자동 적용**을 켜고 저장하면 해당 서버가 봇에 연결될 때 작업이 생성됩니다. 이미 봇이 참여 중인 서버도 다음 확인 주기에 적용합니다.
- 자동 적용을 끄면 설정만 저장합니다. 저장 후 **적용 요청**으로 실행할 수 있습니다.
- 봇은 서버 초대 이벤트와 30초 주기로 작업을 확인합니다. 이 기능은 봇이 참여한 여러 서버를 지원합니다. 수강생 인증은 승인된 워크스페이스의 연결 서버를 사용하고 관리자·강사 최초 가입 인증은 `LEARNINGOPS_AUTH_GUILD_ID` 서버를 사용합니다.
- 카테고리를 먼저 생성합니다. 같은 이름·유형·상위 카테고리의 채널은 재사용합니다. 중복 후보가 여러 개면 실패로 표시합니다.
- 기존 채널을 삭제·이동·이름 변경하지 않습니다. 새 채널은 서버와 카테고리의 기본 접근 권한을 따릅니다. 비공개 역할 설정은 Discord에서 관리하세요.
- 봇에는 **채널 관리** 권한이 필요합니다. 적용 중 설정 변경과 중복 실행은 차단합니다. 실패한 작업은 자동 반복하지 않으며 권한/연결 문제를 해결한 후 재요청합니다.
- 작업당 봇 처리 제한은 180초, 서버 임대는 300초입니다. 부분 생성 후 실패했을 때도 기존 채널을 재사용해 재시도합니다. 전송 장애로 완료 확인이 누락되면 시간 초과로 표시될 수 있습니다.

생성한 채널을 기존 과제·온보딩·멘토링 패널의 고정 채널 ID에 자동 배정하거나 패널 메시지를 게시하는 기능은 아직 없습니다. 해당 모듈의 채널 ID 설정은 별도로 맞춰야 합니다. 채널 생성과 운영 모듈의 연결은 구분됩니다.

## 서버 연결 설정

기존 Render 봇 하나가 전체 워크스페이스를 관리합니다. 아래 URL과 키는 이 봇에 한 번만 설정합니다. 이후 추가 워크스페이스에는 웹에서 Discord 서버 ID를 연결하고 동일한 봇을 초대합니다. **봇 연결 현황**에서 공통 봇 상태와 현재 워크스페이스의 서버 참여 상태를 확인합니다.

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

최초 관리자·강사 가입 인증용 서버는 봇의 `GUILD_ID`와 API의 `LEARNINGOPS_AUTH_GUILD_ID`를 맞춥니다. 수강생 가입 승인 대상 서버는 워크스페이스의 **Discord 채널 설정**에서 연결합니다. 봇 초대에 `bot`·`applications.commands` scope를 포함하세요. 기존 운영 명령은 기존 `GUILD_ID`에 유지하고, 다른 참여 서버에는 `/lms인증`만 추가 동기화합니다. 수강생 초대 발급은 `LEARNINGOPS_PROVISION_URL/TOKEN` 설정을 함께 사용합니다.

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
