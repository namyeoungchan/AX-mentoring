# GitHub Pages 테스트

Pages에는 React 정적 파일만 배포합니다. Python 봇, Express API, SQLite는 Render 등 별도 서버에서 실행합니다.

## 화면 테스트 배포

1. 저장소 쓰기 권한이 있는 GitHub 계정으로 코드를 `main`에 push합니다. `lms-web/`과 `.github/workflows/pages.yml`을 포함합니다. `.env`, DB, `.tools`, `node_modules`는 제외됩니다.
2. 저장소 **Settings → Pages → Build and deployment → Source → GitHub Actions**를 선택합니다.
3. **Actions → Deploy LearningOps to GitHub Pages → Run workflow**를 실행합니다. 이후 웹 코드가 `main`에 push되면 자동 배포합니다.
4. 배포 성공 후 주소: `https://namyeoungchan.github.io/asanAX-mentoring/#dashboard`

`VITE_API_BASE_URL` Repository Variable이 비어 있으면 **데모 모드**로 빌드합니다. 첫 화면은 로그인·회원가입 미리보기이며 **데모 둘러보기**로 운영 화면을 볼 수 있습니다. 변경은 브라우저에만 저장하며 실제 가입 인증과 Discord 채널 생성은 실행하지 않습니다.

## 실제 데이터 연결

1. [RENDER-SYNC.md](./RENDER-SYNC.md)에 따라 웹 API 수신 서버를 배포합니다. 기존 Render Worker와는 별도 서비스입니다.
2. API 서버 환경변수에 `NODE_ENV=production`, 16자 이상의 `ADMIN_PASSWORD`, `ALLOWED_ORIGINS=https://namyeoungchan.github.io`를 설정합니다. Origin에는 저장소 경로를 넣지 않습니다.
3. GitHub **Settings → Secrets and variables → Actions → Variables**에 `VITE_API_BASE_URL=https://실제-API-서비스.onrender.com`을 추가합니다. `/api` 경로, 토큰, 쿼리 문자열은 넣지 않습니다.
4. Pages workflow를 다시 실행하고 웹에서 관리자 비밀번호로 로그인합니다.
5. Render 봇과 API에 동기화 URL/키를 설정한 뒤 **아산 AX 운영 현황**에서 실제 수신 시각과 연결 상태를 확인합니다. Pages 배포만으로 Render 봇 연결이 완료되지는 않습니다.

다른 도메인의 로그인은 메모리의 임시 Bearer 세션을 사용합니다. 제3자 쿠키가 필요하지 않으며 페이지를 새로고침하면 다시 로그인합니다. 같은 도메인에서는 HttpOnly 쿠키를 사용하며 세션은 DB에 8시간 보관됩니다. 관리 데이터와 Render 조회용 스냅샷은 별도입니다. 가입 인증·채널 구성의 봇 연동은 [DISCORD-LMS.md](./DISCORD-LMS.md)를 참고하세요. 기존 과제·멘토링 수정 내용을 원격 봇으로 전송하는 기능은 아직 없습니다.

## 환경변수 구분

| 위치 | 사용 방식 |
| --- | --- |
| GitHub Actions Secrets | workflow에서 명시적으로 참조해야 사용할 수 있습니다. 현재 Pages workflow는 비밀값을 읽지 않습니다. |
| GitHub Actions Variables | `VITE_API_BASE_URL`만 공개 빌드 설정으로 사용합니다. |
| Render Environment | 봇 토큰·동기화 키·관리자 비밀번호 등 서버 값입니다. Pages로 자동 전달되지 않습니다. |
| Git에 커밋된 `.env` | 비밀 저장소가 아닙니다. 실제 토큰을 커밋했다면 발급처에서 폐기·재발급하고 Git 이력에서도 제거해야 합니다. |

`VITE_*`는 브라우저 번들에서 읽을 수 있습니다. Discord 토큰, 관리자 비밀번호, 동기화 키에 이 접두사를 붙이지 마세요. 현재 workflow는 `dist/`만 업로드합니다.

## 로컬 배포 경로 검증

```powershell
cd lms-web
npm run build:pages
npm run test:pages
```

별도 `dist-pages/`에 데모를 빌드해 하위 경로, 정적 자산, 해시 탐색, 데모 저장, 모바일 화면, API 호출이 없는지 검증합니다. 실제 배포 성공 여부는 GitHub Actions에서 별도로 확인해야 합니다.

참고: [Vite GitHub Pages 배포](https://vite.dev/guide/static-deploy#github-pages), [GitHub Pages 게시 소스](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site), [Vite 환경변수 공개 범위](https://vite.dev/guide/env-and-mode#env-variables).
