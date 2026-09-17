# AX LearningOps 웹

React + TypeScript + Vite + Tailwind CSS로 만든 반응형 운영 웹입니다. Node.js / Express API가 워크스페이스별 SQLite 파일을 사용합니다. 기존 Python 봇 DB는 연결된 워크스페이스로 이관하고, 전환 이후 봇도 웹 API로 데이터를 읽고 저장합니다. 연동 URL과 키가 없는 기존 설치는 로컬 DB를 유지합니다.

워크스페이스 생성·역할별 화면·수강생 승인 절차: [WORKSPACES.md](./WORKSPACES.md), [DISCORD-LMS.md](./DISCORD-LMS.md).

<!-- <<<<<<< fix/issue-4-workspace-setup-guide -->
현장 관리자용 버튼별 설정 순서: [WORKSPACE-SETUP-GUIDE.md](./WORKSPACE-SETUP-GUIDE.md).
Discord 공지 발송·실패 재시도·수동 게시: [NOTICE-DELIVERY.md](./NOTICE-DELIVERY.md).
과제 제출 대상·운영자 알림·D-1 수동 대체: [ASSIGNMENT-ALERTS.md](./ASSIGNMENT-ALERTS.md).
팀 일괄 배정과 개인별 Discord 복구: [TEAM-OPERATIONS.md](./TEAM-OPERATIONS.md).
