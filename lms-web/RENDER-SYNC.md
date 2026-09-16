# Render 공통 봇과 워크스페이스 운영 데이터 연결

봇 인스턴스는 기존 Render Worker 하나입니다. 전체 워크스페이스의 채널 구성·가입 초대·인증과 공통 상태 보고는 [DISCORD-LMS.md](./DISCORD-LMS.md)의 공통 연결을 사용합니다. 이 문서는 같은 봇이 각 워크스페이스의 웹 저장소를 읽고 서버 상태와 함께 조회용 스냅샷을 전송하는 설정입니다.

## 구현한 연결

```text
기존 Render Background Worker
  Discord 봇 → 서버별 웹 저장소
  cogs/learningops_sync.py (기본 60초 간격, 읽기 전용)
       │ HTTPS POST + 동기화 전용 키
       ▼
LearningOps 웹 API /api/integrations/render/snapshot
  lms_remote_snapshots에 조회용 데이터 저장
       │ 관리자 인증 후 조회
       ▼
해당 서버에 연결된 워크스페이스 → 봇 연결 현황
```

예약 및 과제 원본은 변경하지 않습니다. 조회용 스냅샷은 서버별 워크스페이스에 별도로 저장됩니다. 원격 스냅샷은 웹의 수정 API로 전달되지 않습니다.

표시 항목은 Discord 연결 보고, 서버 이름·멤버 수, 마지막 수신 시각, 멘토, 예약, 과제, 제출 내용/링크입니다. 서버 멤버 수는 수강생 수와 다릅니다. 각 표에는 최신 1,000건을 표시하고 합계는 원본 DB 전체 건수를 사용합니다. 3분 이상 새 데이터가 없으면 **동기화 지연 / 현재 상태 확인 불가**를 표시합니다. 기존 Worker가 온라인인지 Render API로 확인하는 기능은 아닙니다.

## 적용 순서

1. **웹 API를 외부에서 접근 가능한 HTTPS 주소에 배포합니다.** 현재 `http://127.0.0.1:5173`은 이 PC에서만 접근 가능하므로 Render Worker가 보낼 수 없습니다. 웹 API는 Render 또는 다른 서버에 배포할 수 있습니다. 선택용 설정은 `render.receiver.yaml`에 있습니다. 이 설정은 별도 웹 서비스와 별도 디스크를 생성하는 구성으로, 아직 클라우드에 적용하지 않았습니다.
2. 웹 API에 `NODE_ENV=production`, `ADMIN_PASSWORD`(16자 이상), `ALLOWED_ORIGINS`(실제 웹 도메인), `LEARNINGOPS_SYNC_TOKEN`(32자 이상), `LEARNINGOPS_SOURCE_ID=asan-ax`를 설정합니다. 원격 수신 데이터는 웹 서버의 영속 DB에 저장됩니다.
3. `npm run sync:setup`이 생성한 `lms-web/.env`의 **동기화 키 값**을 웹 API와 기존 Render Worker에 동일하게 설정합니다. 이 값은 Discord 봇 토큰이나 관리자 비밀번호와 별개입니다. 브라우저 번들에는 포함하지 않습니다.
4. 기존 Render Worker의 Environment에 다음 값을 추가합니다.

```dotenv
LEARNINGOPS_SYNC_URL=https://실제-웹-API-도메인/api/integrations/render/snapshot
LEARNINGOPS_SYNC_TOKEN=<웹 API와 같은 전용 키>
LEARNINGOPS_SYNC_INTERVAL=60
```

5. `bot.py`, `cogs/learningops_sync.py`, `requirements.txt`가 포함된 코드를 기존 Worker에 배포합니다. 기존 `DISCORD_TOKEN`, `DB_PATH=/data/mentoring.db`와 디스크 설정을 유지합니다. 고정 `GUILD_ID`는 런타임에 필요하지 않습니다. 코드를 로드하려면 한 번 재배포해야 하며, 그동안 봇이 잠시 재연결됩니다. 무중단 적용을 보장하지 않습니다.
6. 각 웹 워크스페이스에 Discord 서버를 1:1로 연결합니다. 이미 연결됐다면 추가 작업은 없습니다. 웹 저장소 연결이 준비된 서버마다 스냅샷을 전송합니다. Worker 로그의 `LearningOps snapshot published`와 웹의 `동기화 정상`을 확인합니다. 첫 동기화는 Discord 연결 준비가 끝난 후 실행됩니다. 브라우저는 15초 간격으로 수신 상태를 갱신합니다.

Render 대시보드 주소만으로는 운영 DB를 읽거나 환경변수를 적용할 수 없습니다. 이 세션에서는 Render 계정 인증, 서비스 배포, 운영 데이터 수신을 아직 수행하지 않았습니다. 로컬에서 테스트한 데이터는 운영 데이터로 저장하지 않았습니다.

## 장애 시 동작

- URL/키가 비어 있으면 동기화 기능을 시작하지 않습니다.
- 잘못된 동기화 설정은 봇의 기존 기능 시작을 막지 않습니다.
- 전송 타임아웃은 20초이며 실패 시 다음 주기에 재시도합니다. 전송 실패가 봇의 명령 처리 루프를 종료하지 않습니다.
- 주기는 30~120초로 제한합니다. 전송은 한 작업에서 순차 실행되어 겹치지 않습니다.
- HTTPS만 허용하며 HTTP는 localhost 테스트용으로만 허용합니다. 리다이렉트를 따라가며 인증 키를 전달하지 않습니다.
- 수신 API는 전용 Bearer 키, Discord 서버와 워크스페이스 연결, 데이터 형식, 건수, 생성 시각, 재전송 여부를 검증합니다. 관리자 로그인 세션은 동기화 키로 대체할 수 없습니다.
- 동기화 키, Discord 토큰 및 API 응답 본문을 로그에 출력하지 않습니다.
- 재시도 오류 시 과거 스냅샷을 유지하되 현재 온라인 상태로 표시하지 않습니다.

## 검증

```powershell
python -m unittest discover -s tests -p "test_learningops_sync.py" -v
cd lms-web
npm test
npm run test:e2e
```

관련 공식 문서: [Worker 네트워크 제약](https://render.com/docs/private-services), [디스크 접근 및 재배포 제약](https://render.com/docs/disks).
