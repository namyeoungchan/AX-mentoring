import { ArrowRight, BookOpenCheck, ChevronRight, Compass, Server, ShieldCheck, UserRoundPlus } from 'lucide-react'

export default function WorkspaceStart({ platformAdmin, go }: { platformAdmin: boolean; go: (page: string) => void }) {
  const steps = [
    { title: '운영자 초대', description: '워크스페이스를 함께 운영할 관리자를 지정해요.', owner: '총괄 관리자', icon: ShieldCheck, tone: 'sage', action: platformAdmin ? '관리자 초대' : '', page: 'members', note: '총괄 관리자가 진행해요' },
    { title: '학습 공간 구축', description: '조를 구성하고 Discord 서버에 봇을 연결해요.', owner: '워크스페이스 관리자', icon: Server, tone: 'sky', action: '조·서버 설정', page: 'discord', note: '' },
    { title: '멘토 초대', description: '메인 강사와 조 담당 멘토를 초대하고 배정해요.', owner: '워크스페이스 관리자', icon: UserRoundPlus, tone: 'peach', action: '멘토 초대·배정', page: 'members', note: '' },
    { title: '멘토 온보딩', description: '기본 정보를 입력하고 과제·멘토링 업무를 익혀요.', owner: '초대받은 멘토', icon: BookOpenCheck, tone: 'lavender', action: '', page: '', note: '초대 수락 후 멘토가 진행해요' },
  ]
  return <section className="workspace-start" aria-labelledby="workspace-start-title">
    <div className="workspace-start-heading"><span className="workspace-start-symbol"><Compass size={23} aria-hidden="true" /></span><div><h2 id="workspace-start-title">워크스페이스 시작하기</h2><p>함께할 사람부터 학습 공간까지, 차근차근 준비해요.</p></div><span className="workspace-start-count">운영 준비 가이드</span></div>
    <ol className="workspace-start-steps">{steps.map((step, index) => <li className="workspace-start-card" key={step.title}>
      <div className="workspace-start-card-top"><span className={`workspace-start-icon ${step.tone}`}><step.icon size={21} aria-hidden="true" /></span><span className="workspace-start-number">STEP <strong>{String(index + 1).padStart(2, '0')}</strong></span></div>
      <h3>{step.title}</h3><p className="workspace-start-description">{step.description}</p><span className="workspace-start-owner">{step.owner}</span>
      <div className="workspace-start-action">{step.action ? <button onClick={() => go(step.page)}>{step.action}<ArrowRight size={15} aria-hidden="true" /></button> : <p><BookOpenCheck size={15} aria-hidden="true" />{step.note}</p>}</div>
      {index < steps.length - 1 && <ChevronRight className="workspace-start-connector" size={16} aria-hidden="true" />}
    </li>)}</ol>
  </section>
}
