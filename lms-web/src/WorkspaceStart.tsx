import { ArrowRight, BookOpenCheck, ChevronRight, Compass, Server, ShieldCheck, UserRoundPlus } from 'lucide-react'

export default function WorkspaceStart({ platformAdmin, go }: { platformAdmin: boolean; go: (page: string) => void }) {
  const steps = [
    { title: '운영자 초대 · 선택', description: '함께 운영할 관리자가 있으면 초대하세요. 혼자 운영한다면 건너뛰어도 됩니다.', owner: '총관리자', icon: ShieldCheck, tone: 'sage', action: platformAdmin ? '관리자 초대' : '', page: 'members', note: '총관리자가 진행합니다' },
    { title: '학습 공간 구축', description: '조를 구성하고 Discord 서버에 봇을 연결하세요.', owner: '워크스페이스 관리자', icon: Server, tone: 'sky', action: 'Discord 빠른 설정', page: 'discord', note: '' },
    { title: '멘토 초대', description: '메인 강사와 조 담당 멘토를 초대하고 배정하세요.', owner: '워크스페이스 관리자', icon: UserRoundPlus, tone: 'peach', action: '멘토 초대·배정', page: 'members', note: '' },
    { title: '멘토 온보딩', description: '기본 정보를 입력하고 과제·멘토링 업무를 확인하세요.', owner: '초대받은 멘토', icon: BookOpenCheck, tone: 'lavender', action: '', page: '', note: '초대 수락 후 멘토가 진행합니다' },
  ]
  return <section className="workspace-start" aria-labelledby="workspace-start-title">
    <div className="workspace-start-heading"><span className="workspace-start-symbol"><Compass size={23} aria-hidden="true" /></span><div><h2 id="workspace-start-title">워크스페이스 시작하기</h2><p>함께할 사람부터 학습 공간까지, 차례대로 준비하세요.</p></div><span className="workspace-start-count">운영 준비 가이드</span></div>
    <ol className="workspace-start-steps">{steps.map((step, index) => <li className="workspace-start-card" key={step.title}>
      <div className="workspace-start-card-top"><span className={`workspace-start-icon ${step.tone}`}><step.icon size={21} aria-hidden="true" /></span><span className="workspace-start-number">STEP <strong>{String(index + 1).padStart(2, '0')}</strong></span></div>
      <h3>{step.title}</h3><p className="workspace-start-description">{step.description}</p><span className="workspace-start-owner">{step.owner}</span>
      <div className="workspace-start-action">{step.action ? <button onClick={() => go(step.page)}>{step.action}<ArrowRight size={15} aria-hidden="true" /></button> : <p><BookOpenCheck size={15} aria-hidden="true" />{step.note}</p>}</div>
      {index < steps.length - 1 && <ChevronRight className="workspace-start-connector" size={16} aria-hidden="true" />}
    </li>)}</ol>
    <details className="workspace-setup-guide"><summary>관리자 설정 순서 · 화면과 버튼 안내</summary>
      <p>현재 선택한 워크스페이스 이름을 확인한 뒤 아래 순서로 진행하세요. 초대와 서버 설정은 선택한 워크스페이스에 적용됩니다.</p>
      <ol>
        <li><h3>관리자 참여 · 선택</h3><p>혼자 운영한다면 건너뛰세요. 함께할 관리자가 있다면 <strong>구성원 · 초대 → 새 계정 또는 기존 계정 선택 → 참여 권한: 워크스페이스 관리자</strong>로 초대를 만드세요. 안내문을 복사해 전달하면 상대방이 로그인한 뒤 <strong>초대 수락</strong>을 누릅니다.</p>{platformAdmin && <button className="button secondary" onClick={() => go('members')}>관리자 초대 화면 열기</button>}</li>
        <li><h3>조 구성</h3><p><strong>Discord 빠른 설정 → 운영할 조 수 → 조 구성 저장</strong>. 저장 후 화면에 필요한 조가 표시되는지 확인합니다.</p><button className="button secondary" onClick={() => go('discord')}>조 구성·서버 연결 화면 열기</button></li>
        <li><h3>Discord 서버 연결</h3><p>Discord에서 서버를 만든 뒤 채널 링크를 복사합니다. <strong>Discord 채널 링크 또는 서버 ID → 서버 연결하고 계속 → 이 서버에 앱 초대</strong> 순서로 진행합니다. 봇 초대는 Discord의 서버 관리 권한이 있는 사람이 승인해야 합니다.</p><p>연결과 구축 결과를 자동 확인합니다. 마지막 내 LMS 인증 단계에서 코드를 복사하고 Discord로 이동해 본인 계정을 인증하세요. 채널 이름 변경은 상세 설정 열기에서 진행합니다.</p></li>
        <li><h3>멘토 초대와 담당 조</h3><p><strong>구성원 · 초대 → 새 계정 또는 기존 계정 선택 → 멘토 구분과 담당 조 선택 → 초대 만들기 → 안내문 복사</strong>. 복사한 안내문을 멘토에게 직접 전달하세요. 메인 강사는 전체 조, 조 담당 멘토는 선택한 조를 담당합니다.</p><button className="button secondary" onClick={() => go('members')}>멘토 초대·담당 조 화면 열기</button></li>
        <li><h3>학생 계정 발급과 수업 준비</h3><p><strong>학생 계정 발급</strong>에서 로그인 아이디와 과정·조를 지정하고 초기 비밀번호를 발급하세요. 학생에게 계정 정보를 전달하면 첫 로그인에서 이름과 새 비밀번호를 설정합니다. 수강생의 Discord 참여·인증 뒤 <strong>학생 계정 발급</strong>에서 과정과 팀을 확인합니다. 멘토에게는 첫 로그인 후 기본 정보·Discord 인증·업무 안내를 완료하도록 안내하세요.</p><button className="button secondary" onClick={() => go('student-accounts')}>학생 계정 발급 화면 열기</button></li>
      </ol>
      <p>저장 오류가 보이면 같은 작업을 반복하기 전에 새로고침하고 저장된 결과를 확인하세요. 봇 구축 실패는 Discord 권한·역할 순서를 확인한 뒤 해당 실패 작업을 재시도합니다.</p>
    </details>
  </section>
}
