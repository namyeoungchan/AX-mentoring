# 역할별 인포그래픽 가이드

2026-09-19 시작·종료 코드 출석 개정본입니다. 강의 시간대 입력 → 시작 코드 생성·입실 → 종료 코드 생성·퇴실 흐름을 반영했습니다. 각 가이드는 A4 세로 3쪽이며 본문 텍스트·아이콘은 벡터, 접속 QR은 SVG입니다. 관리자 발급 계정의 첫 로그인·이름·비밀번호 설정 절차도 포함합니다.

- [워크스페이스 관리자 PDF](output/admin-guide.pdf)
- [멘토 PDF](output/mentor-guide.pdf)
- [학생 PDF](output/student-guide.pdf)
- [전체 9쪽 통합 PDF](output/all-role-guides.pdf)
- [전체 페이지 미리보기](output/review-contact-sheet.png)

운영 다운로드: [통합본](https://ax-learningops-web.onrender.com/guides/all-role-guides.pdf), [관리자](https://ax-learningops-web.onrender.com/guides/admin-guide.pdf), [멘토](https://ax-learningops-web.onrender.com/guides/mentor-guide.pdf), [학생](https://ax-learningops-web.onrender.com/guides/student-guide.pdf).

관리자·메인 강사는 정확한 예정 시간대를 입력하고 시작·종료 코드를 생성합니다. 학생은 Discord 패널 또는 웹 나의 출결에서 코드를 입력하며, 입퇴실이 곧 출석 기록입니다. 종료 코드 입력 시간이 끝나면 등록이 종료되고, 누락·예외를 검토해 출결을 확정합니다. 코드 재입력은 최초 시각과 멘토 정정을 유지합니다.

## 다시 만들기

저장소 루트에서 실행합니다. Node.js 24, lms-web의 npm 의존성, Chrome, 한국어 글꼴(Apple SD Gothic Neo 또는 Noto Sans KR)이 필요합니다. macOS·Windows Chrome에서 생성할 수 있으며 PDF에 사용 글꼴을 포함합니다. Python 파일 입출력은 UTF-8을 사용합니다.

```sh
python3 -m venv /tmp/learningops-guide-venv
/tmp/learningops-guide-venv/bin/pip install qrcode pymupdf Pillow
/tmp/learningops-guide-venv/bin/python docs/guides/build_guides.py
node docs/guides/render.mjs
/tmp/learningops-guide-venv/bin/python docs/guides/verify_guides.py
```

본문은 build_guides.py, 색상·배치는 guide.css에서 수정합니다. render.mjs는 글꼴 로딩 후 페이지 넘침과 푸터 여백을 검사합니다. verify_guides.py는 페이지 수, A4 크기, 한글 텍스트, 글꼴 포함, 접속 링크를 검사하고 통합본·미리보기를 만듭니다. 결과는 output의 layout-checks.json과 pdf-checks.json에 남습니다.
검증을 통과한 PDF 4개는 `lms-web/public/guides`에도 복사합니다. 원본 출력과 이 배포 사본을 함께 커밋하면 Render와 GitHub Pages에서 다운로드할 수 있습니다.

검수 근거: lms-web의 STUDENT-ACCOUNTS.md, ATTENDANCE.md, ATTENDANCE-CODES.md, ASSIGNMENT-ALERTS.md, WORKSPACE-SETUP-GUIDE.md 및 관리자·멘토·학생 화면 구현. 실제 학생 정보나 운영 계정 정보는 포함하지 않습니다.
