# 역할별 인포그래픽 가이드

2026-09-17 기준 AX LearningOps 운영 화면과 Discord 흐름을 설명합니다. 각 가이드는 A4 세로 3쪽이며 본문 텍스트·아이콘은 벡터, 접속 QR은 SVG입니다. 새 학생은 관리자 발급 계정으로 로그인하고 이름·비밀번호를 설정하는 절차를 반영했습니다.

- [워크스페이스 관리자 PDF](output/admin-guide.pdf)
- [멘토 PDF](output/mentor-guide.pdf)
- [학생 PDF](output/student-guide.pdf)
- [전체 9쪽 통합 PDF](output/all-role-guides.pdf)
- [전체 페이지 미리보기](output/review-contact-sheet.png)

관리자는 운영 준비·출결·과제 배포·계정 발급, 멘토는 담당 조·수업 운영·멘토링, 학생은 첫 로그인·인증·제출·예약·기록 확인을 중심으로 설명합니다. 총관리자만 가능한 비밀번호 재발급·계정 삭제를 구분합니다.

## 다시 만들기

저장소 루트에서 실행합니다. Node.js 24, lms-web의 npm 의존성, Chrome, 한국어 글꼴(Apple SD Gothic Neo 또는 Noto Sans KR)이 필요합니다. 생성 환경은 macOS Chrome이며 PDF에 사용 글꼴을 포함합니다.

```sh
python3 -m venv /tmp/learningops-guide-venv
/tmp/learningops-guide-venv/bin/pip install qrcode pymupdf Pillow
/tmp/learningops-guide-venv/bin/python docs/guides/build_guides.py
node docs/guides/render.mjs
/tmp/learningops-guide-venv/bin/python docs/guides/verify_guides.py
```

본문은 build_guides.py, 색상·배치는 guide.css에서 수정합니다. render.mjs는 글꼴 로딩 후 페이지 넘침과 푸터 여백을 검사합니다. verify_guides.py는 페이지 수, A4 크기, 한글 텍스트, 글꼴 포함, 접속 링크를 검사하고 통합본·미리보기를 만듭니다. 결과는 output의 layout-checks.json과 pdf-checks.json에 남습니다.

검수 근거: lms-web의 STUDENT-ACCOUNTS.md, ATTENDANCE.md, ASSIGNMENT-ALERTS.md, WORKSPACE-SETUP-GUIDE.md 및 관리자·멘토·학생 화면 구현. 실제 학생 정보나 운영 계정 정보는 포함하지 않습니다.
