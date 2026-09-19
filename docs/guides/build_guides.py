"""Build role-specific, print-first HTML from reviewed product workflows."""
from pathlib import Path
import qrcode
import qrcode.image.svg

HERE = Path(__file__).resolve().parent
OUT = HERE / 'output'
OUT.mkdir(exist_ok=True)
URL = 'https://ax-learningops-web.onrender.com'
qrcode.make(URL, image_factory=qrcode.image.svg.SvgPathImage, border=2).save(OUT / 'lms-qr.svg')
ICONS = {
 'grid':'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
 'users':'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
 'check':'<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
 'chat':'<path d="M21 11a9 9 0 0 1-9 9H4l-2 2v-10a10 10 0 0 1 19-1Z"/><path d="M7 9h10M7 13h6"/>',
 'book':'<path d="M3 4h5a5 5 0 0 1 4 2 5 5 0 0 1 4-2h5v16h-5a5 5 0 0 0-4 2 5 5 0 0 0-4-2H3ZM12 6v16"/>',
 'clock':'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
 'send':'<path d="m3 3 19 9-19 9 4-9Zm4 9h15"/>',
 'shield':'<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
}
def icon(name):
 return f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICONS[name]}</svg>'
def card(title,text,sym='check'):
 return f'<article class="card"><div class="card-top"><span class="icon">{icon(sym)}</span></div><h3>{title}</h3><p>{text}</p></article>'
def cards(*items):return '<div class="cards">'+''.join(items)+'</div>'
def note(title,text):return f'<aside class="note"><strong>{title}</strong><p>{text}</p></aside>'
def section(label,title):return f'<div class="section-heading"><span>{label}</span><h2>{title}</h2></div>'
def flow(items):
 return '<ol class="flow">'+''.join(f'<li><b>{i:02d}</b><strong>{title}</strong><p>{desc}</p></li>' for i,(title,desc) in enumerate(items,1))+'</ol>'
def steps(items):
 return '<ol class="steps">'+''.join(f'<li><span>{i:02d}</span><div><h3>{title}</h3><p>{desc}</p></div></li>' for i,(title,desc) in enumerate(items,1))+'</ol>'
def route(title,items):
 return f'<div class="route"><span>{title}</span><p>'+'<i>›</i>'.join(f'<b>{x}</b>' for x in items)+'</p></div>'
def faq(items):
 return '<div class="faq">'+''.join(f'<div><h3>{title}</h3><p>{body}</p></div>' for title,body in items)+'</div>'
def checklist(items):return '<div class="checklist">'+''.join(f'<p><span>✓</span>{x}</p>' for x in items)+'</div>'
def page(role,no,kicker,title,intro,content):
 labels={'admin':'워크스페이스 관리자','mentor':'멘토','student':'학생'}
 return f'''<section class="page {role}" aria-label="{labels[role]} 가이드 {no}쪽"><header><a href="{URL}" class="brand">{icon('grid')}<span>AX <b>LearningOps</b></span></a><span class="role-label">{labels[role]} 가이드</span></header><div class="page-title"><span class="eyebrow">{kicker}</span><h1>{title}</h1><p>{intro}</p></div><main class="content">{content}</main><footer><span>AX LearningOps · 2026.09.19 개정 · 시작·종료 코드 출석 가이드</span><span>{labels[role]} <b>{no:02d}</b> / 03</span></footer></section>'''
def access():
 return f'<div class="access"><img src="lms-qr.svg" alt="LMS 접속 QR 코드"/><div><span class="eyebrow">시작하는 곳</span><h3>웹은 학습 기록, Discord는 소통</h3><p>QR을 스캔하거나 아래 주소를 누르세요.</p><a href="{URL}">ax-learningops-web.onrender.com ↗</a></div></div>'

admin=[
page('admin',1,'01 / 운영 공간 준비','첫 수업을 위한<br/>준비, 네 단계면 됩니다.','초대받은 계정으로 로그인한 뒤, 운영할 워크스페이스 이름부터 확인하세요.',
 access()+section('SETUP','Discord 빠른 설정')+flow([
 ('조 구성','운영할 조 수 입력<br/><b>조 구성 저장</b>'),
 ('서버 연결','Discord 채널 링크<br/>또는 서버 ID 입력'),
 ('앱 초대·구축','<b>이 서버에 앱 초대</b><br/>설치 승인 후 웹으로'),
 ('내 LMS 인증','웹에서 코드 발급<br/>Discord에서 인증'),
 ])+route('화면 경로',['Discord 채널 설정','Discord 빠른 설정'])+
 cards(card('서버는 Discord에서 준비','새 서버가 필요하면 Discord 왼쪽 <b>+ → 직접 만들기</b>를 선택하세요. 채널을 연 주소를 복사해 웹에 붙여 넣습니다.','chat'),card('완료 표시까지 확인','앱 초대는 Discord 서버 관리 권한이 있는 사람이 승인합니다. 화면의 <b>앱 연결 확인</b>과 구축 결과를 확인하세요.','shield'))+
 note('여기서 말하는 관리자는 워크스페이스 관리자입니다.','총관리자가 발급한 초대를 수락해 참여합니다. 초기 비밀번호를 받았다면 먼저 변경하세요. 전체 계정 초기화·삭제는 총관리자에게 요청합니다.')),
page('admin',2,'02 / 수업 운영','기록하고 저장한 뒤,<br/>필요한 알림을 보내세요.','출결·팀·과제의 저장 결과는 웹에서 확인합니다. Discord 알림은 별도로 전달됩니다.',
 section('ATTENDANCE','코드로 강의를 시작하고 종료하세요')+
 flow([('시간대 입력','과정 · 날짜 · 차시<br/>시작 · 종료 예정 시각'),('강의 시작','<b>시작 코드 생성</b><br/>학생 코드 입력 → 입실'),('강의 종료','<b>종료 코드 생성</b><br/>학생 코드 입력 → 퇴실'),('출결 확정','누락 · 예외 저장<br/>미처리 0명 후 <b>확정</b>')])+
 note('시작·종료 코드 입력이 입실·퇴실 출석입니다.','예정 시간대와 실제 코드 생성 시각을 구분합니다. 종료 코드를 생성하면 이전 시작 코드는 종료됩니다. 코드 유효시간 동안 퇴실을 받고 누락·지각 등은 멘토가 정정합니다.')+
 section('ASSIGNMENTS','과제: 대상 확인 후 배포')+
 '<div class="split-diagram"><div class="source">'+icon('book')+'<strong>과제 만들기</strong><span>팀 / 개인 선택</span></div><div class="branches"><div><b>팀 과제</b><span>→</span><strong>각 팀의 비공개 채팅</strong></div><div><b>개인 과제</b><span>→</span><strong>인증된 수강생의 DM</strong></div></div></div>'+
 route('발송 순서',['과제 관리','과제 제출 대상·알림','대상·마감 확인','과제 배포'])+
 cards(card('배포 요청 ≠ 발송 완료','대기·발송 완료·실패를 대상별로 확인하세요. 팀 채널 미설정이나 개인 인증 누락은 대기할 수 있습니다.','send'),card('제출과 마감 알림도 확인','팀은 한 건 이상 제출하면 완료로 집계합니다. 미제출 대상 D-1 안내는 한국시간 오전 9시부터 처리합니다.','clock'))),
page('admin',3,'03 / 사람·알림·문제 해결','문제가 생겨도<br/>확인할 순서는 같습니다.','누구에게 어떤 권한이 있는지, 저장과 전달 중 어디까지 끝났는지 먼저 확인하세요.',
 section('PEOPLE','구성원과 수강생 관리')+
 cards(card('멘토 초대·담당 조 배정','<b>구성원 · 초대</b>에서 멘토를 초대합니다. 메인 강사는 전체 조, 조 담당 멘토는 선택한 조를 담당합니다.','users'),card('학생 계정·초기 비밀번호 발급','<b>학생 계정 발급</b>에서 아이디와 과정·조를 지정합니다. 발급된 초기 비밀번호는 한 번만 표시되므로 학생에게 전달하세요.','check'))+
 note('구성원 제외와 계정 삭제는 다릅니다.','워크스페이스에서 제외해도 개인 계정과 다른 워크스페이스 소속은 남습니다. 워크스페이스 관리자 변경·삭제 및 전체 계정 복구는 총관리자에게 요청하세요.')+
 section('RECOVERY','이 상태라면 이렇게 하세요')+
 faq([
 ('알림이 대기 / 실패예요','Discord 인증·팀 채널·앱 권한을 확인하세요. 확정 실패는 원인을 고친 뒤 <b>알림 재시도</b>를 누릅니다. 결과가 불명확하면 <b>기존 메시지 확인</b>부터 진행하세요.'),
 ('Discord가 안 되지만 수업은 진행해야 해요','웹이 정상이면 출결을 계속 저장합니다. 웹도 안 되면 사전 CSV나 종이 명단에 기록하고, 복구 후 같은 회차에 가져와 확인·저장하세요.'),
 ('공지를 직접 전달해야 해요','<b>공지 관리</b>에서 초안·미리보기·발송 상태를 확인합니다. 수동 게시가 필요하면 자동 발송을 먼저 중지하고 기존 메시지와 중복되지 않게 처리하세요.'),
 ])+
 checklist(['수업 전: 과정·팀 명단과 오늘의 출결 회차 확인','수업 후: 미처리 0명, 출결 저장·마감, 알림 실패 확인'])+
 '<p class="closing">문의할 때: 워크스페이스 · 발생 시각 · 진행한 작업 · 오류 문구를 전달하세요.<br/>비밀번호와 인증 코드는 전달하지 마세요.</p>'),
]
mentor=[
page('mentor',1,'01 / 참여와 담당 범위','담당 조를 확인하고,<br/>멘토 활동을 시작하세요.','초대받은 아이디로 계정을 만들거나 로그인한 뒤, 초대 수락을 누릅니다.',
 access()+section('ONBOARDING','멘토 온보딩')+steps([
 ('기본 정보 저장','<b>활동 이름</b>과 <b>전문 분야</b>를 입력하세요. 활동 이름은 해당 워크스페이스에서 사용합니다.'),
 ('Discord 서버 참여','화면의 <b>Discord 서버 참여</b>를 누릅니다. 초대 링크가 없거나 만료되면 <b>초대 링크 발급 · 재발급</b>을 사용하세요.'),
 ('LMS 인증','웹에서 <b>인증 코드 받기</b> → 해당 서버에서 <b>/lms인증 코드:발급코드</b>를 실행합니다. 다른 워크스페이스에서는 별도로 인증합니다.'),
 ('업무 안내 확인','과제 생성·예약 승인·멘토링 진행 안내를 순서대로 확인합니다. 안내 확인은 실제 업무 완료 기록과는 다릅니다.'),
 ])+
 '<div class="role-comparison"><div><span>메인 강사</span><strong>전체 조</strong><p>시작·종료 코드 및 출결 확정</p></div><div><span>조 담당 멘토</span><strong>배정받은 조</strong><p>담당 조 입퇴실 확인·출결 정정</p></div></div>'+
 note('멘토는 수강생 자기소개를 작성하지 않습니다.','담당 조가 잘못 보이면 워크스페이스 관리자에게 배정 변경을 요청하세요. 본인이 담당 범위를 바꿀 수는 없습니다.')),
page('mentor',2,'02 / 수업 진행','명단을 빠르게 확인하고,<br/>수업에 집중하세요.','출결·성적·팀 배정은 본인에게 허용된 과정과 담당 조 범위에서 처리합니다.',
 route('좌측 메뉴 · 모바일은 메뉴 열기',['워크스페이스 선택','출결 관리'])+
 flow([('시간 확인','강의 예정 시간대<br/>한국시간으로 확인'),('입실 안내','강사의 <b>시작 코드</b><br/>학생이 패널 · 웹에 입력'),('퇴실 안내','강사의 <b>종료 코드</b><br/>학생이 패널 · 웹에 입력'),('예외·확정 확인','누락 · 지각 등 저장<br/>전체 처리 후 확정')])+
 '<p class="closing">시작 코드 생성이 강의 시작, 종료 코드 생성이 강의 종료입니다. 웹과 Discord는 같은 기록을 사용합니다.</p>'+
 note('누락·예외는 명단에서 정정하세요.','시작 코드만 등록한 학생은 미처리로 남습니다. 퇴실 누락과 지각 등을 확인해 저장하세요. 코드 재입력은 멘토 정정을 덮어쓰지 않습니다. 메인 강사·관리자가 종료 코드를 생성하고 출결을 확정합니다.')+
 section('DAILY WORK','함께 사용하는 메뉴')+
 cards(card('과제 만들기','<b>멘토 온보딩 → 과제 만들기</b>에서 과정·제목·마감일을 입력합니다. 현재 멘토 화면의 생성 과제는 팀 과제이며, 선택한 과정 전체에 공개됩니다.','book'),card('알림 배포 요청','과제 생성 후 관리자에게 <b>과제 배포</b>를 요청하세요. 개인 과제 생성과 배포 알림 관리는 관리자 화면에서 진행합니다.','send'),card('수업 현황·성적 관리','<b>수업 현황</b>에서 과정과 과제 현황을 확인합니다. <b>성적 관리</b>에서는 담당 범위의 평가항목과 점수를 확인·입력합니다.','grid'),card('팀 배정·기존 신청 확인','담당 대상과 소속 팀을 확인하세요. 신규 학생 계정 발급은 관리자에게 요청합니다. 기존 가입 신청은 허용된 범위에서 처리합니다.','users'))),
page('mentor',3,'03 / 멘토링과 문제 해결','예약부터 피드백까지,<br/>한 흐름으로 이어가세요.','Discord 인증을 완료하고 멘토링을 받을 수 있는 시간을 먼저 등록하세요.',
 section('MENTORING','멘토링 운영 흐름')+
 steps([
 ('시간과 예약 슬롯 준비','Discord에서 <b>/멘토 설정</b>을 실행해 시간대와 예약 가능한 슬롯을 설정합니다.'),
 ('수강생 신청 검토','봇이 보내는 DM에서 신청을 확인하고 승인하거나 사유와 함께 거절합니다. DM 수신이 가능한지 확인하세요.'),
 ('확정된 일정에 진행','확정 시간에 담당 조 음성 채널에서 진행합니다. 조 대화 채널에 피드백과 다음 할 일을 공유하세요.'),
 ])+
 section('QUICK HELP','막힌 단계부터 확인하세요')+
 faq([
 ('회차가 없거나 명단 저장이 충돌해요','관리자에게 오늘 강의의 시작 코드 생성을 요청하세요. 저장 충돌은 입력을 보관한 뒤 <b>명단 새로고침</b>으로 학생 입퇴실·다른 멘토의 변경과 대조합니다.'),
 ('팀 채널이 보이지 않아요','맞는 워크스페이스·Discord 서버인지 확인하고 인증 완료와 담당 조를 확인하세요. 관리자에게 팀 배정과 동기화 상태 확인을 요청합니다.'),
 ('비밀번호를 잊었어요','워크스페이스 관리자를 통해 총관리자에게 초기 비밀번호 재발급을 요청하세요. 다시 로그인한 뒤 본인 비밀번호로 변경합니다.'),
 ])+
 checklist(['수업 전: 담당 조·회차·명단 확인','수업 후: 출결 저장, 예약 처리, 피드백 전달 확인'])+
 note('출결 기록은 웹에서 이어갈 수 있습니다.','Discord나 봇만 멈췄다면 웹 출결 입력을 계속하세요. 웹도 사용할 수 없으면 CSV·종이 명단에 기록하고 관리자와 함께 복구합니다.')),
]
student=[
page('student',1,'01 / 첫 로그인과 학습 준비','받은 계정으로 로그인,<br/>가입 없이 시작하세요.','학생은 직접 가입하지 않습니다. 관리자에게 아이디와 초기 비밀번호를 받으세요.',
 access()+section('START','첫 참여 체크포인트')+
 steps([
 ('발급받은 계정으로 로그인','관리자가 전달한 <b>아이디와 초기 비밀번호</b>로 로그인하세요. 과정과 조는 관리자가 미리 배정합니다.'),
 ('내 이름 입력 · 비밀번호 변경','첫 로그인 화면에서 <b>본인 이름</b>을 입력하고 초기 비밀번호와 다른 새 비밀번호를 설정합니다. <b>설정 완료하고 시작하기</b>를 누르세요.'),
 ('Discord 참여 · LMS 인증','웹의 <b>워크스페이스 참여 현황</b>에서 서버에 참여하고 인증 코드를 받으세요. 시작하기 채널의 <b>1 · LMS 인증</b>에 입력합니다.'),
 ('자기소개 작성 · 팀 채널 확인','본인 계정을 확인한 뒤 <b>2 · 자기소개 작성</b>을 완료합니다. 인증·팀 배정·자기소개가 완료되면 학습 채널이 열립니다.'),
 ])+
 note('인증은 워크스페이스마다 따로 진행합니다.','다른 서버에서 인증했더라도 현재 서버에서 새로 인증하세요. 가입 인증 코드·초대 링크는 웹에서 재발급합니다. 채널이 보이지 않으면 위 네 단계를 확인하고, 비밀번호 복구는 관리자에게 요청하세요.')+
 '<div class="success-strip">'+icon('check')+'<span>준비 완료 기준</span><strong>Discord 인증 완료 + 내 팀 채널 표시</strong></div>'),
page('student',2,'02 / 과제와 멘토링','알림을 확인하고,<br/>제출 완료까지 확인하세요.','과제명과 마감일은 웹의 과제 메뉴 또는 Discord /과제 목록에서 확인합니다.',
 '<div class="delivery-pair"><div>'+icon('users')+'<strong>팀 과제 알림</strong><span>내 팀 채팅에서 확인</span></div><div>'+icon('chat')+'<strong>개인 과제 알림</strong><span>봇의 개인 DM에서 확인</span></div></div>'+
 section('SUBMIT','과제 제출은 Discord 제출 패널에서')+
 flow([('과제 선택','과제 채널의<br/><b>과제 제출하기</b>'),('내용 작성','제출 항목 작성<br/>필요한 링크 첨부'),('제출 확인','제출 버튼 클릭<br/><b>제출 완료</b> 확인')])+
 note('중복 제출과 팀 대표 제출에 유의하세요.','현재 개인별로 같은 과제에 한 번 제출할 수 있습니다. 팀 과제는 팀원의 제출 한 건 이상이면 완료로 집계하며, LMS 배정 팀으로 제출됩니다. 수정이 필요하면 멘토에게 문의하세요.')+
 section('BOOKING','멘토링 예약')+
 steps([
 ('예약 가능한 시간 선택','Discord 멘토링 채널의 예약 패널에서 멘토와 가능한 시간을 선택해 신청합니다.'),
 ('신청 상태 확인','신청만으로 확정되지 않습니다. 멘토 승인 결과를 확인하세요. <b>/mybooking</b>으로 본인 예약 현황을 볼 수 있습니다.'),
 ('확정 시간에 참여','안내된 팀 음성 채널에 참여하세요. 일정 변경이 필요하면 멘토에게 알리고 기존 예약을 확인합니다.'),
 ])+
 '<p class="closing">개인 과제 알림을 받으려면 봇의 DM을 수신할 수 있어야 합니다.<br/>알림이 오지 않아도 웹에서 과제와 마감일을 확인하세요.</p>'),
page('student',3,'03 / 입퇴실과 나의 학습','시작·종료 코드로,<br/>강의 출석을 기록하세요.','해당 수업 서버에서 LMS 학생 계정의 Discord 인증을 먼저 완료하세요.',
 section('ATTENDANCE','시작 코드는 입실, 종료 코드는 퇴실')+
 flow([('강의 시작','패널 <b>입실</b>을 눌러<br/><b>시작 코드</b> 입력'),('강의 종료','패널 <b>퇴실</b>을 눌러<br/><b>종료 코드</b> 입력'),('웹에서도 가능','<b>나의 출결</b>에서<br/>같은 6자리 코드 입력')])+
 note('두 코드를 등록하면 출석 기록이 완료됩니다.','강사가 안내한 유효시간 내 코드를 입력하세요. 나의 출결에서 강의 예정 시간대와 실제 입퇴실 시각을 확인합니다. 코드 없이 출석할 수 없으며, 재입력은 최초 시각을 유지합니다.')+
 section('MY LEARNING','웹에서 내 기록 확인')+
 cards(card('과정 · 팀 · 성적','좌측에서 워크스페이스를 선택하세요. <b>나의 학습</b>에서 과정·팀, <b>나의 성적</b>에서 점수를 확인합니다. 모바일은 <b>메뉴 열기</b>를 누르세요.','users'),card('출결 · 과제 · 마감일','<b>나의 출결</b>에서 회차 마감 후 확정 기록을 봅니다. <b>과제</b>에서 마감일을 확인하고, 제출은 Discord 패널에서 진행하세요.','check'))+
 section('QUICK HELP','막힌 단계부터 확인하세요')+
 faq([
 ('출석 등록이 안 돼요','현재 서버의 LMS 인증과 시작·종료 코드 종류·만료 여부를 확인하세요. 시작 코드 등록 없이 퇴실할 수 없습니다. 누락·지각·결석 정정은 멘토에게 요청하세요.'),
 ])+
 '<div class="help-path"><span>학습·출결·과제 문의</span><b>담당 멘토</b><i>→</i><span>계정·팀·서버 문의</span><b>워크스페이스 관리자</b></div>'+
 '<p class="closing">문의할 때: 워크스페이스 · 과제/회차 · 발생 시각 · 오류 문구를 알려주세요.<br/>비밀번호나 가입 인증 코드는 공유하지 마세요.</p>'),
]
styles=(HERE/'guide.css').read_text(encoding='utf-8')
for name,role,pages in [('admin-guide','워크스페이스 관리자',admin),('mentor-guide','멘토',mentor),('student-guide','학생',student)]:
 doc='<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AX LearningOps — '+role+' 가이드</title><style>'+styles+'</style></head><body>'+''.join(pages)+'</body></html>'
 (OUT/(name+'.html')).write_text(doc, encoding='utf-8')
print('Built 3 role guides, 9 pages.')
