import assert from 'node:assert/strict';

export async function courseManagementScenario(runtime) {
    const { workspaces, courseManagement: manager } = runtime;
    const admin = { id: 'admin', role: 'admin', username: 'course-admin' };
    const w = await workspaces.create({ name: '주차별 과정 관리' });
    const course = { id: 'course', title: '일정 과정', category: 'AX', description: '주차별 수업', progress: 0, learners: 0, weeks: '4주 과정', mentor: '', theme: 'green', status: '모집 중', code: 'SCHEDULE', cohort: '1', startDate: '2026-09-01', endDate: '2026-09-30' };
    await workspaces.mutate(w.id, { revision: (await workspaces.snapshot(w.id)).revision, changes: [{ kind: 'courses', value: course }] }, 'admin');
    const db = (await workspaces.open(w.id)).db;
    const initial = await manager.read(w.id, course.id, admin);
    const oldWorkspace = await workspaces.snapshot(w.id);
    await db.prepare("INSERT INTO assignments(week,title,due_date) VALUES(1,'먼저 만든 과제','2026-09-20')").run();
    await db.prepare("INSERT INTO lms_audit(actor,action,target) VALUES('bot','submission.created','1')").run();
    assert.notEqual((await workspaces.snapshot(w.id)).revision, oldWorkspace.revision);
    let result = await manager.update(w.id, course.id, { revision: initial.revision, changes: { status: '진행 중' } }, admin);
    assert.equal(result.course.status, '진행 중');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM assignments').get()).n, 1);
    const session = { id: 'lesson', week: 1, title: 'AI 실습', date: '2026-09-03', startTime: '10:00', endTime: '12:00', notes: '노트북 준비' };
    result = await manager.update(w.id, course.id, { revision: result.revision, changes: { schedule: [session] } }, admin);
    assert.deepEqual((await workspaces.snapshot(w.id)).courses[0].schedule, [session]);
    await assert.rejects(manager.update(w.id, course.id, { revision: initial.revision, changes: { schedule: [] } }, admin), { status: 409 });
    for (const invalid of [{ ...session, date: '2026-10-01' }, { ...session, week: 5 }, { ...session, endTime: '09:00' }]) {
        await assert.rejects(manager.update(w.id, course.id, { revision: result.revision, changes: { schedule: [invalid] } }, admin));
    }
    await assert.rejects(manager.update(w.id, course.id, { revision: result.revision, changes: { title: 'unsupported' } }, admin));
    assert.deepEqual((await manager.read(w.id, course.id, admin)).course.schedule, [session]);
    await assert.rejects(manager.read(w.id, course.id, { id: 'outsider', role: 'student' }), { status: 403 });
    const other = await workspaces.create({ name: '다른 과정 공간' });
    await assert.rejects(manager.read(other.id, course.id, admin), { status: 404 });
    result = await manager.update(w.id, course.id, { revision: result.revision, changes: { schedule: [{ ...session, title: '수정 수업', week: 2, date: '2026-09-10' }] } }, admin);
    result = await manager.update(w.id, course.id, { revision: result.revision, changes: { schedule: [] } }, admin);
    assert.deepEqual(result.course.schedule, []);
    assert.equal(result.course.title, course.title);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lms_audit WHERE action='courses.update'").get()).n, 4);
    await runtime.store.db.prepare('UPDATE lms_workspaces SET archived_at=? WHERE id=?').run(Date.now(), w.id);
    await assert.rejects(manager.update(w.id, course.id, { revision: result.revision, changes: { status: '종료' } }, admin), { status: 409 });
}
