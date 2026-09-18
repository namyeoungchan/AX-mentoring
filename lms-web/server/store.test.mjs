import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';
async function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'learningops-store-'));
    const store = await createStore(join(directory, 'test.db'));
    t.after(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }); });
    return store;
}
const course = { id: 'course1', title: 'AX LearningOps', category: 'AX', description: '1기', progress: 0, learners: 0, weeks: '8주', mentor: '', theme: 'green', status: '모집 중', code: 'AX', cohort: '1', guildId: '', startDate: '2026-09-01', endDate: '2026-12-01' };
const student = { id: 'student1', name: '테스트 학생', email: 'test@example.com', discordId: '123456789012345678', courseId: 'course1', team: '', status: '정상', progress: 0, color: 'sage' };
const mentor = { id: 'new', name: '테스트 멘토', discordId: '223456789012345678', bio: '개발' };
const write = async (s, kind, value) => await s.mutate({ revision: (await s.snapshot()).revision, changes: [{ kind, value }] });
async function seed(s) { await write(s, 'courses', course); await write(s, 'learners', student); await write(s, 'mentors', mentor); }
test('empty DB initializes the bot schema without fake operational data', async (t) => {
    const s = await fixture(t);
    const data = await s.snapshot();
    assert.equal(data.courses.length, 0);
    assert.equal(data.sessions.length, 0);
    assert.ok((await s.db.prepare("PRAGMA table_info(assignments)").all()).some(r => r.name === 'fields'));
});
test('course/student changes persist and enforce duplicate email and course code', async (t) => {
    const s = await fixture(t);
    await seed(s);
    assert.equal((await s.snapshot()).courses[0].learners, 1);
    await assert.rejects(async () => await write(s, 'learners', { ...student, id: 'student2' }), /UNIQUE/);
    await assert.rejects(async () => await write(s, 'courses', { ...course, id: 'course2' }), /UNIQUE/);
    assert.equal((await s.snapshot()).learners.length, 1);
});
test('score boundaries, course membership, and transactional rollback', async (t) => {
    const s = await fixture(t);
    await seed(s);
    const score = { id: 'score1', studentId: student.id, courseId: course.id, item: '프로젝트', score: 20, maximum: 30 };
    await write(s, 'scores', score);
    await assert.rejects(async () => await write(s, 'scores', { ...score, score: 31 }));
    await write(s, 'courses', { ...course, id: 'course2', code: 'OTHER' });
    await assert.rejects(async () => await write(s, 'scores', { ...score, courseId: 'course2' }), /소속 과정/);
    const revision = (await s.snapshot()).revision;
    await assert.rejects(async () => await s.mutate({ revision, changes: [{ kind: 'scores', value: { ...score, score: 25 } }, { kind: 'scores', value: { ...score, score: -1 } }] }));
    assert.equal((await s.snapshot()).scores[0].score, 20);
});
test('attendance correction saves before/after audit with reason', async (t) => {
    const s = await fixture(t);
    await seed(s);
    const attendance = { id: 'att1', studentId: student.id, courseId: course.id, date: '2026-09-15', period: 1, status: '결석', reason: '미참석' };
    await write(s, 'attendance', attendance);
    await write(s, 'attendance', { ...attendance, status: '공결', reason: '증빙 확인' });
    const audit = await s.db.prepare("SELECT * FROM lms_audit WHERE action='attendance.update'").get();
    assert.equal(JSON.parse(audit.before_json).status, '결석');
    assert.equal(JSON.parse(audit.after_json).reason, '증빙 확인');
    await assert.rejects(async () => await write(s, 'attendance', { ...attendance, id: 'att2' }), /UNIQUE/);
});
test('reads existing bot rows and web writes remain visible to bot SQL', async (t) => {
    const s = await fixture(t);
    await seed(s);
    await s.db.prepare("INSERT INTO assignments(week,title,due_date) VALUES(1,'기존 과제','2026-10-01')").run();
    await s.db.prepare("INSERT INTO submissions(assignment_id,user_id,user_name,team,content) VALUES(1,'1','학생','팀1','내용')").run();
    const original = (await s.snapshot()).assignments[0];
    assert.equal(original.submitted, 1);
    await write(s, 'assignments', { ...original, status: '마감' });
    assert.equal((await s.db.prepare('SELECT is_active FROM assignments WHERE id=1').get()).is_active, 0);
    await write(s, 'assignments', { id: 'new', title: '웹 과제', course: course.title, courseId: course.id, due: '2026-10-01', submitted: 0, total: 0, status: '진행 중' });
    assert.equal((await s.db.prepare('SELECT COUNT(*) AS count FROM assignments').get()).count, 2);
});
test('mentoring creates compatible slots, rejects conflicts, approves and cancels atomically', async (t) => {
    const s = await fixture(t);
    await seed(s);
    const session = { id: 'new', title: '멘토링', mentor: mentor.name, mentorId: '1', studentId: student.id, team: '', date: '2026-10-01', time: '14:00', status: '승인 대기' };
    await write(s, 'sessions', session);
    assert.equal((await s.db.prepare('SELECT status FROM bookings').get()).status, 'pending');
    await assert.rejects(async () => await write(s, 'sessions', { ...session, id: 'other' }), /이미 멘토링 슬롯/);
    const created = (await s.snapshot()).sessions[0];
    await write(s, 'sessions', { ...created, status: '예약 확정' });
    assert.equal((await s.db.prepare('SELECT status FROM bookings').get()).status, 'approved');
    await write(s, 'sessions', { ...(await s.snapshot()).sessions[0], status: '취소' });
    assert.equal((await s.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).count, 0);
    assert.equal((await s.snapshot()).sessions[0].status, '취소');
    await write(s, 'sessions', session);
    assert.equal((await s.db.prepare('SELECT COUNT(*) AS count FROM slots').get()).count, 1);
    assert.equal((await s.db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).count, 1);
});
test('stale revisions never overwrite newer data, including bot writes', async (t) => {
    const s = await fixture(t);
    await seed(s);
    const stale = (await s.snapshot()).revision;
    await s.db.prepare("UPDATE mentors SET bio='changed by bot' WHERE id=1").run();
    await assert.rejects(async () => await s.mutate({ revision: stale, changes: [{ kind: 'courses', value: { ...course, title: 'stale' } }] }), /다른 작업/);
    assert.equal((await s.snapshot()).courses[0].title, course.title);
});
test('remote process actions and unconnected module changes cannot report success', async (t) => {
    const s = await fixture(t);
    await assert.rejects(async () => await write(s, 'servers', { id: 'b1', name: 'remote', provider: 'Docker', region: 'Seoul', status: '실행 중', version: '1' }));
    await assert.rejects(async () => await write(s, 'settings', { name: 'AX', reminders: false, onboarding: true, qa: true }), /연결되지/);
});
