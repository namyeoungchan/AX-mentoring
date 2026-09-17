# 웹에서 Discord 서버 구축과 봇 초대가 가능한 범위

이슈 #3 조사 결과 · 확인일 2026-09-17

**웹에서 봇 초대를 시작하고, 초대 이후 채널·역할 구축을 요청할 수 있습니다.** Discord 서버 생성과 봇 설치 승인은 서버 관리자가 Discord에서 수행합니다.

| 작업 | 현재 경로와 조건 |
| --- | --- |
| Discord 서버 생성 | 관리자가 Discord에서 서버 생성 후 서버 ID 복사 |
| 웹에 서버 등록 | 워크스페이스의 **Discord 채널 설정 → 추가할 Discord 서버 ID → 서버 추가 및 구축** |
| 봇 초대 시작 | 같은 화면의 **이 서버에 봇 초대**. 봇 ID가 heartbeat로 확인된 뒤 표시 |
| 설치 승인 | Discord 인증 화면에서 서버 관리 권한을 가진 사용자가 승인 |
| 채널·역할 구축 | 참여한 봇이 Web의 대기 작업을 조회해 생성·재사용 |
| 완료 확인 | 웹의 봇 연결·구축 결과와 Discord의 생성된 채널·역할을 함께 확인 |

현재 `src/DiscordSetup.tsx`는 관측된 봇 ID와 연결된 서버 ID로 OAuth 설치 링크를 만들며, 서버 선택을 고정합니다. `server/provision.mjs`는 봇 heartbeat와 작업 상태를 저장합니다. 설치 링크를 열었다는 사실만으로 구축 성공을 처리하지 않습니다.

Discord 공식 문서상 봇 설치는 `bot` scope의 OAuth 링크로 시작하며 `guild_id`로 서버를 미리 선택하고 `disable_guild_select`로 변경을 제한할 수 있습니다. 별도 사용자 액세스 토큰 없이 설치 승인을 요청할 수 있습니다. [OAuth2 봇 승인](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow)

서버 설치는 `MANAGE_GUILD` 권한이 있는 사용자가 승인해야 합니다. LMS의 워크스페이스 관리자 권한만으로 Discord 설치를 승인할 수는 없습니다. [앱 설치 권한](https://docs.discord.com/developers/resources/application)

채널·역할 생성에는 봇의 해당 관리 권한이 필요하고, 역할 변경은 봇의 최상위 역할보다 아래 역할에 한정됩니다. [서버·채널 관리](https://docs.discord.com/developers/platform/server-and-channel-management)

운영자가 만드는 서버는 Discord에서 준비하고 웹에 연결하는 절차를 유지합니다. 현재 공식 Guild API 문서에는 일반 서버 생성 엔드포인트가 나열되어 있지 않으므로 웹의 무인 서버 생성 기능을 제공한다고 안내하지 않습니다. [Guild API](https://docs.discord.com/developers/resources/guild)

## 현장 확인 순서

1. Discord에서 대상 서버를 만들고 서버 관리 권한을 확인합니다.
2. 웹에서 조 구성과 기본 채널 구성을 저장하고 서버 ID를 등록합니다.
3. 봇이 온라인인데 초대 버튼이 없다면 heartbeat/API 연결을 확인합니다.
4. **이 서버에 봇 초대**를 눌러 Discord에서 승인합니다. Private Bot 설정이면 앱 소유자만 초대할 수 있으므로 운영자와 확인합니다.
5. 봇의 채널·역할 권한과 역할 순서를 확인하고 웹의 작업 결과를 새로고침합니다.

코드와 공식 문서를 기준으로 확인했습니다. 실제 Discord 서버에 봇을 초대하거나 채널을 생성하는 실환경 검증은 수행하지 않았습니다.
