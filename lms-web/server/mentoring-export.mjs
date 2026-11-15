import { z } from 'zod';
import { ApiError } from './store.mjs';
import { sessionRecordKind } from './mentoring-feedback.mjs';
import { sheetName, workbook } from './xlsx.mjs';

const range = z.object({ from: z.string().date(), to: z.string().date() });
const kst = value => Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+09:00`);
const minutes = (date, time, endDate, endTime) => Math.max(0, Math.round((kst(`${endDate}T${endTime}:00`) - kst(`${date}T${time}:00`)) / 60000));
const detailHeader = ['날짜', '시작', '종료', '진행 시간(분)', '구분', '제목', '학습 과정', '팀', '참여자', '멘토링 내용', '멘티 응답', '상태'];
const detailWidths = [12, 7, 7, 12, 12, 28, 20, 14, 24, 60, 40, 18];

// Admin-only report: ended bookings (with any post-session correction) plus manual activity records.
export function createMentoringExport(main, workspaces, { now = Date.now } = {}) {
    async function entries(id, from, to) {
        const db = (await workspaces.open(id)).db, data = await workspaces.snapshot(id);
        const staff = await main.prepare(`SELECT u.id,u.name,u.discord_id FROM lms_workspace_members m JOIN lms_users u ON u.id=m.user_id
            WHERE m.workspace_id=? AND m.role='instructor'`).all(id);
        const byDiscord = new Map(staff.map(u => [u.discord_id, u]));
        const records = new Map((await db.prepare('SELECT id,data FROM lms_records WHERE kind=?').all(sessionRecordKind)).map(r => [r.id, JSON.parse(r.data)]));
        const responses = await db.prepare(`SELECT q.booking_id,q.role,r.content,e.data AS edit FROM lms_mentoring_feedback_requests q
            JOIN lms_mentoring_feedback_responses r ON r.request_id=q.id LEFT JOIN lms_records e ON e.kind='mentoringFeedbackEdit' AND e.id=r.event_id
            ORDER BY r.submitted_at,r.event_id`).all();
        const answers = (bookingId, role) => responses.filter(r => r.booking_id === bookingId && r.role === role)
            .map(r => (role === 'mentor' && r.edit ? JSON.parse(r.edit).content : r.content)).join('\n\n');
        const course = courseId => data.courses.find(c => c.id === courseId)?.title || '';
        const result = [];
        const bookings = await db.prepare(`SELECT b.id,b.status,b.user_id,b.user_name,s.start_time,s.end_time,s.label,m.id AS mentor_id,m.name AS mentor_name,
            m.discord_id AS mentor_discord FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN mentors m ON m.id=s.mentor_id
            WHERE b.status IN ('approved','completed')`).all();
        for (const b of bookings) {
            const bookingId = String(b.id), record = records.get(bookingId);
            const date = record?.date || b.start_time.slice(0, 10), time = record?.time || b.start_time.slice(11, 16);
            const endDate = record?.date || b.end_time.slice(0, 10), endTime = record?.endTime || b.end_time.slice(11, 16);
            if (date < from || date > to || kst(`${endDate}T${endTime}:00`) > now()) continue;
            const user = byDiscord.get(b.mentor_discord) || staff.find(u => u.name === b.mentor_name), learner = data.learners.find(l => l.discordId && l.discordId === b.user_id);
            result.push({ mentorKey: user ? user.id : `bot:${b.mentor_id}`, mentorName: user?.name || b.mentor_name, kind: '예약 멘토링',
                date, time, endTime, minutes: minutes(date, time, endDate, endTime), title: b.label, course: learner ? course(learner.courseId) : '',
                team: learner?.team || '', participants: learner?.name || b.user_name, participantIds: [learner?.id || `discord:${b.user_id}`],
                content: record?.content || answers(bookingId, 'mentor'), mentee: answers(bookingId, 'mentee'),
                status: `${b.status === 'completed' ? '완료' : '예약 확정'}${record ? ' · 실제 시간 기록' : ''}` });
        }
        for (const row of await db.prepare("SELECT data FROM lms_records WHERE kind='mentoringActivity'").all()) {
            const a = JSON.parse(row.data);
            if (a.date < from || a.date > to) continue;
            result.push({ mentorKey: a.mentorId, mentorName: staff.find(u => u.id === a.mentorId)?.name || a.mentorName, kind: '직접 기록',
                date: a.date, time: a.time, endTime: a.endTime, minutes: minutes(a.date, a.time, a.date, a.endTime), title: a.title, course: a.courseTitle,
                team: a.teamName, participants: a.students.map(s => s.name).join(', '), participantIds: a.students.length ? a.students.map(s => s.id) : [`team:${a.teamId}`],
                content: a.content, mentee: '', status: a.revision > 1 ? '수정됨' : '' });
        }
        return result.sort((x, y) => x.date.localeCompare(y.date) || x.time.localeCompare(y.time) || x.title.localeCompare(y.title));
    }
    async function download(id, query, user) {
        await workspaces.requireRole(id, user, ['admin']);
        const parsed = range.safeParse(query);
        if (!parsed.success) throw new ApiError(422, '조회 기간의 시작일과 종료일을 입력하세요.');
        const { from, to } = parsed.data;
        if (from > to) throw new ApiError(422, '시작일은 종료일보다 늦을 수 없습니다.');
        if ((Date.parse(to) - Date.parse(from)) / 86400000 > 731) throw new ApiError(422, '한 번에 최대 2년까지 내려받을 수 있습니다.');
        const rows = await entries(id, from, to), meta = await workspaces.metadata(id);
        const mentors = [...new Map(rows.map(r => [r.mentorKey, r.mentorName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ko'));
        const used = new Set(['요약']);
        const total = list => ({ bookings: list.filter(r => r.kind === '예약 멘토링').length, manual: list.filter(r => r.kind === '직접 기록').length,
            minutes: list.reduce((sum, r) => sum + r.minutes, 0), empty: list.filter(r => !r.content.trim()).length,
            students: new Set(list.flatMap(r => r.participantIds)).size, last: list.at(-1)?.date || '' });
        const line = (name, list) => { const t = total(list); return [name, t.bookings, t.manual, list.length, t.minutes, Math.round(t.minutes / 6) / 10, t.students, t.empty, t.last]; };
        const summary = [['멘토', '예약 멘토링(건)', '직접 기록(건)', '총 건수', '총 진행 시간(분)', '총 진행 시간(시간)', '참여 학생·팀 수', '내용 미작성(건)', '최근 진행일'],
            ...mentors.map(([key, name]) => line(name, rows.filter(r => r.mentorKey === key))), line('합계', rows), [],
            ['워크스페이스', meta.name], ['조회 기간', `${from} ~ ${to}`],
            ['생성 시각', `${new Date(now()).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국시간)`],
            ['기준', '종료된 예약 확정·완료 멘토링과 직접 입력한 멘토링 기록. 실제 진행 시간이 기록된 예약은 그 시간을 사용합니다.']];
        const sheets = [{ name: '요약', rows: summary, widths: [20, 15, 14, 10, 16, 17, 16, 15, 13] },
            ...mentors.map(([key, name]) => ({ name: sheetName(name, used), widths: detailWidths,
                rows: [detailHeader, ...rows.filter(r => r.mentorKey === key).map(r => [r.date, r.time, r.endTime, r.minutes, r.kind, r.title, r.course, r.team, r.participants, r.content, r.mentee, r.status])] }))];
        return { filename: `멘토링-기록_${from}_${to}.xlsx`, body: workbook(sheets) };
    }
    return { entries, download };
}
