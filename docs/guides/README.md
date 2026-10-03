# 역할별 인포그래픽 가이드

2026-09-19 시작·종료 코드 출석 개정본입니다. 강의 시간대 입력 → 시작 코드 생성·입실 → 종료 코드 생성·퇴실 흐름을 반영했습니다. 각 가이드는 A4 세로 3쪽이며 본문 텍스트·아이콘은 벡터, 접속 QR은 SVG입니다. 관리자 발급 계정의 첫 로그인·이름·비밀번호 설정 절차도 포함합니다.

- [워크스페이스 관리자 PDF](output/admin-guide.pdf)
- [멘토 PDF](output/mentor-guide.pdf)
- [학생 PDF](output/student-guide.pdf)
- [전체 9쪽 통합 PDF](output/all-role-guides.pdf)
- [전체 페이지 미리보기](output/review-contact-sheet.png)

현재 운영 가이드는 LMS 로그인 후 **도움말** 탭에서 확인합니다. 관리자·메인 강사·조 담당 멘토·수강생의 기능별 실제 화면과 PDF를 제공합니다. 본인 역할의 파일만 조회할 수 있으며 기존 공개 `/guides/*.pdf` 주소는 폐기했습니다.

관리자는 도움말 → **PDF 등록·교체**에서 대상 역할과 기능을 선택해 5MB 이하의 PDF를 등록할 수 있습니다. 파일은 워크스페이스 DB에 저장되어 백업·복원 대상에 포함됩니다. 다른 역할의 파일을 등록할 수 있지만 해당 가이드의 본문과 파일을 열람할 수는 없습니다. 기본 화면 안내는 유지되며 기본 PDF로 복원할 수 있습니다.

현재 기능별 가이드는 `lms-web/server/help-catalog.mjs`, Discord 연계 본문은 `help-discord-catalog.mjs`입니다. 총 59개(관리자 26, 메인 강사 10, 조 담당 멘토 12, 수강생 11), 212단계입니다. 기존 LMS 41개에 Discord 연계 18개를 추가했습니다. 도움말에서 번호 탭 또는 이전·다음 단계로 이동하고, 실제 LMS·Discord 화면의 번호와 주황색 테두리 위치를 따라 사용합니다. PDF도 한 단계당 한 페이지로 같은 순서를 제공합니다.

2026-10-03 사용자가 로그인한 실제 Discord 웹 클라이언트에서 26개의 단계 이미지를 확보했습니다. 시작하기·입퇴실 입력 창·과제 대시보드·멘토 시간대/슬롯 설정·예약 날짜/시간 선택·신청 확인·조 담당 멘토 인증 안내를 포함합니다. Windows UI Automation으로 실제 요소를 확인하고, 원본 창 위에 번호와 테두리를 표시하는 네이티브 오버레이를 올린 뒤 필요한 영역만 촬영했습니다. UI를 재구성하거나 실제 신청·출석·설정 변경을 제출하지 않았습니다. 브라우저 탭·계정 목록·다른 구성원의 개인정보는 촬영 영역에서 제외했습니다. 서버명·담당 멘토명·날짜는 촬영 당시 화면이며 예시 데이터로 표시하지 않습니다.

`server/help-discord-captures.mjs`에 촬영 출처·일자·이미지 크기·강조 영역을 등록합니다. 캡처가 있는 단계만 `imageAvailable: true`로 제공하며, LMS 자동 촬영기는 등록된 Discord 이미지를 덮어쓰지 않고 재사용합니다. 다시 촬영할 때는 실제 클라이언트에서 해당 단계 번호를 강조하고 JPG와 등록 메타데이터를 함께 교체합니다. 학생 예약의 날짜 선택과 시간 선택은 별도 단계입니다.

미촬영 Discord 단계는 15개입니다. 현재 로그인 계정에 없는 관리자 과제 입력/메인 강사 인증 화면, 게시 공지, 과제 제출 양식, 예약 승인/결과와 멘토링 기록 작성 DM은 추가 촬영이 필요합니다. 해당 단계는 화면 캡처 준비 중임을 명시하고 글로 안내하며 이미지 요청은 404를 반환합니다. 준비된 실제 이미지는 도움말과 PDF에 동일하게 들어갑니다. 코드로 만든 화면을 실제 Discord 화면이라고 표시하지 않습니다.

`lms-web`에서 `npm run build` 후 `npm run guides:build`를 실행합니다. 별도 임시 SQLite DB에 가상 계정·예시 데이터를 만들고 실제 앱에 각 역할로 로그인합니다. `scripts/help-guide-capture.mjs`가 실제 표시된 요소의 위치를 읽어 브라우저 오버레이로 번호·테두리를 표시한 뒤 촬영하며, 대상이 없으면 실패합니다. 운영 DB·Discord 봇은 사용하지 않습니다. `HELP_GUIDE_IDS` 환경변수에 쉼표로 구분한 ID를 지정하면 해당 가이드만 다시 촬영합니다. PDF 본문·배치만 변경한 경우 `node scripts/rebuild-help-pdfs.mjs`로 기존 이미지를 재사용하고 푸터 겹침을 검사합니다.

생성된 `server/help-assets`는 공개 정적 폴더가 아니며 서버가 매 요청마다 워크스페이스와 정확한 역할을 확인합니다. PDF뿐 아니라 단계 이미지도 동일하게 제한합니다. `capture-manifest.json`에는 단계·실제 요소·강조 영역을 기록합니다. 저장소 루트에서 `python docs/guides/verify_help_guides.py`를 실행하면 단계별 PDF 페이지 수·한글·글꼴 포함·이미지의 강조 표시를 검사하고 `pdf-checks.json`을 갱신합니다.

Discord 안내의 검수 근거는 `cogs/panel_objects.py`, `cogs/lms_onboarding.py`, `cogs/lms_auth.py`, `cogs/attendance_panel.py`, `cogs/assignment.py`, `cogs/lms_mentoring.py`, `ui/mentor_availability.py`, `ui/mentor_setup.py`, `ui/date_select.py`, `ui/time_select.py`, `ui/confirm_view.py`, `ui/approval_view.py`와 `lms-web/shared/channel-guides.json`입니다. Discord 과제 생성은 Discord 관리자/운영자 권한이 필요하고, 가능 시간 등록은 LMS 인증된 조 담당 멘토만 가능하며, 메인 강사에게는 해당 가이드를 제공하지 않습니다.

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
위의 이전 통합 문서는 기록용입니다. 이 생성기는 더 이상 공개 정적 폴더에 문서를 복사하지 않습니다.

검수 근거: lms-web의 STUDENT-ACCOUNTS.md, ATTENDANCE.md, ATTENDANCE-CODES.md, ASSIGNMENT-ALERTS.md, WORKSPACE-SETUP-GUIDE.md 및 관리자·멘토·학생 화면 구현. 실제 학생 정보나 운영 계정 정보는 포함하지 않습니다.
