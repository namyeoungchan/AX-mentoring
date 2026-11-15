import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import readXlsxFile from 'read-excel-file/node';
import { createMentoringActivities } from './mentoring-activities.mjs';
import { createMentoringExport } from './mentoring-export.mjs';
import { createMentoringFeedback } from './mentoring-feedback.mjs';

export async function mentoringExportScenario(r) {
    const clock = Date.parse('2026-11-10T20:00:00+09:00'), now = () => clock;
    const w = await r.workspaces.create({ name: '멘토링 보고서 검증', guildId: '173456789012345678' });
    const db = (await r.workspaces.open(w.id)).db;
    const groups = await r.staff.setupGroups(w.id, { count: 1, revision: (await r.workspaces.snapshot(w.id)).revision }, { id: 'admin', role: 'admin', username: 'export.root' });
    const [team] = groups.teams;
    const makeUser = async (name, role, discordId) => {
        const user = (await r.auth.signup({ username: `export.${role}.${name.length}${discordId?.slice(-2) || ''}`, name, password: 'test-password-12345', ...(discordId ? { discordId } : {}) }, () => {})).user;
        await r.store.db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,1)').run(w.id, user.id, role);
        return user;
    };
    const kim = await makeUser('김멘토', 'instructor', '273456789012345671');
    const lee = await makeUser('이멘토', 'instructor', '273456789012345672');
    const student = await makeUser('학생', 'student');
    const manager = await makeUser('운영자', 'admin');
    await db.prepare("INSERT INTO lms_records VALUES('learners','learner-a',?)").run(JSON.stringify({ id: 'learner-a', name: '박학생', courseId: team.courseId, team: team.name, discordId: '373456789012345678', email: '', status: '정상', progress: 0, color: 'sage' }));
    await db.prepare("INSERT INTO mentors(id,discord_id,name) VALUES(1,'273456789012345671','김멘토'),(2,'273456789012345672','이멘토')").run();
    for (const [id, mentor, start, end, status] of [[1, 1, '2026-11-03T14:00:00', '2026-11-03T15:00:00', 'completed'], [2, 2, '2026-11-04T10:00:00', '2026-11-04T10:50:00', 'approved'],
        [3, 1, '2026-11-20T10:00:00', '2026-11-20T11:00:00', 'approved'], [4, 1, '2026-11-05T10:00:00', '2026-11-05T11:00:00', 'pending'], [5, 2, '2026-10-01T10:00:00', '2026-10-01T11:00:00', 'completed']]) {
        await db.prepare('INSERT INTO slots(id,mentor_id,start_time,end_time,label) VALUES(?,?,?,?,?)').run(id, mentor, start, end, `예약 ${id}`);
        await db.prepare("INSERT INTO bookings(id,slot_id,user_id,user_name,status) VALUES(?,?,'373456789012345678','박학생',?)").run(id, id, status);
    }
    const feedback = createMentoringFeedback(r.store.db, r.workspaces, { now });
    const record = { date: '2026-11-03', time: '14:10', endTime: '15:40', content: '배포 파이프라인 점검\n다음: 모니터링 설정', revision: 0 };
    assert.equal((await feedback.read(w.id, '1', kim)).canRecord, false, 'unverified Discord ID cannot claim the session');
    for (const user of [kim, lee]) await r.store.db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run(w.id, user.id, '173456789012345678', user.discordId, clock);
    assert.equal((await feedback.read(w.id, '1', kim)).canRecord, true, 'mentor may record own ended session');
    assert.equal((await feedback.read(w.id, '1', lee)).canRecord, false, 'other mentors cannot record');
    assert.equal((await feedback.read(w.id, '3', kim)).canRecord, false, 'future session cannot be recorded');
    await assert.rejects(feedback.saveRecord(w.id, '1', record, lee), { status: 403 });
    await assert.rejects(feedback.saveRecord(w.id, '1', record, student), { status: 403 });
    await assert.rejects(feedback.saveRecord(w.id, '3', { ...record, date: '2026-11-10', time: '10:00', endTime: '11:00' }, kim), { status: 403 });
    await assert.rejects(feedback.saveRecord(w.id, '4', record, manager), { status: 403 }, 'pending booking is not a held session');
    await assert.rejects(feedback.saveRecord(w.id, '1', { ...record, endTime: '14:00' }, kim), { status: 422 });
    await assert.rejects(feedback.saveRecord(w.id, '1', { ...record, date: '2026-11-11' }, kim), { status: 422 });
    await assert.rejects(feedback.saveRecord(w.id, '1', { ...record, content: '  ' }, kim));
    const saved = await feedback.saveRecord(w.id, '1', record, kim);
    assert.equal(saved.record.revision, 1);
    assert.equal(saved.record.updatedByName, '김멘토');
    await assert.rejects(feedback.saveRecord(w.id, '1', { ...record, content: '오래된 화면' }, manager), { status: 409 });
    await feedback.saveRecord(w.id, '1', { ...record, revision: 1, content: '배포 파이프라인 점검 (관리자 정정)' }, manager);
    const slot = await db.prepare('SELECT start_time,end_time FROM slots WHERE id=1').get();
    assert.deepEqual({ ...slot }, { start_time: '2026-11-03T14:00:00', end_time: '2026-11-03T15:00:00' }, 'booked slot time is preserved');
    const activities = createMentoringActivities(r.store.db, r.workspaces, { now });
    await activities.create(w.id, { id: randomUUID(), mentorId: lee.id, courseId: team.courseId, teamId: team.id, studentIds: ['learner-a'], title: '환경 설정 지원', date: '2026-11-06', time: '09:00', endTime: '09:30', content: '도커 설치' }, lee);
    await activities.create(w.id, { id: randomUUID(), mentorId: lee.id, courseId: team.courseId, teamId: team.id, studentIds: ['learner-a'], title: '범위 밖', date: '2026-09-01', time: '09:00', endTime: '09:30', content: '제외' }, lee);

    const exporter = createMentoringExport(r.store.db, r.workspaces, { now });
    await assert.rejects(exporter.download(w.id, { from: '2026-11-01', to: '2026-11-30' }, kim), { status: 403 });
    await assert.rejects(exporter.download(w.id, { from: '2026-11-01', to: '2026-11-30' }, student), { status: 403 });
    await assert.rejects(exporter.download(w.id, { from: '2026-11-30', to: '2026-11-01' }, manager), { status: 422 });
    await assert.rejects(exporter.download(w.id, { from: 'bad' }, manager), { status: 422 });
    const file = await exporter.download(w.id, { from: '2026-11-01', to: '2026-11-30' }, manager);
    assert.equal(file.filename, '멘토링-기록_2026-11-01_2026-11-30.xlsx');
    const sheets = await readXlsxFile(file.body);
    assert.deepEqual(sheets.map(s => s.sheet), ['요약', '김멘토', '이멘토']);
    const [summary, kimSheet, leeSheet] = sheets.map(s => s.data);
    assert.deepEqual(summary[1].slice(0, 6), ['김멘토', 1, 0, 1, 90, 1.5], 'corrected actual time is reported');
    assert.deepEqual(summary[2].slice(0, 6), ['이멘토', 1, 1, 2, 80, 1.3]);
    assert.deepEqual(summary[3].slice(0, 5), ['합계', 2, 1, 3, 170]);
    assert.equal(kimSheet.length, 2, 'future, pending and out-of-range sessions are excluded');
    assert.deepEqual(kimSheet[1].slice(0, 10), ['2026-11-03', '14:10', '15:40', 90, '예약 멘토링', '예약 1', team.courseId ? (await r.workspaces.snapshot(w.id)).courses.find(c => c.id === team.courseId).title : '', team.name, '박학생', '배포 파이프라인 점검 (관리자 정정)']);
    assert.deepEqual(leeSheet.slice(1).map(row => [row[0], row[4]]), [['2026-11-04', '예약 멘토링'], ['2026-11-06', '직접 기록']]);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lms_audit WHERE action='mentoring.session.record'").get()).n, 2);
    await r.workspaces.setArchived(w.id, true, { id: 'admin', role: 'admin', username: 'export.root' });
    assert.equal((await feedback.read(w.id, '1', manager)).canRecord, false);
    await assert.rejects(feedback.saveRecord(w.id, '1', { ...record, revision: 2 }, manager), { status: 403 });
}
