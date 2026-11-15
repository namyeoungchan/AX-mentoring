import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createAssignmentAlerts } from './assignment-alerts.mjs'

export async function assignmentCourseScenario(workspaces, storage) {
  const guildId = '123456789012345691'
  const w = await workspaces.create({name:'과제 자동 연결',guildId}), db = (await workspaces.open(w.id)).db
  await storage.state(w.id)
  const addCourse = async id => db.prepare('INSERT INTO lms_records(kind,id,data) VALUES(?,?,?)').run('courses',id,JSON.stringify({id,title:id}))
  const call = (kwargs = {}, requestId = randomUUID()) => storage.call({guildId,operation:'create_assignment',args:[1,'자동 연결','','2099-10-01','team'],kwargs,requestId})
  await assert.rejects(call(),{status:422})
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM assignments').get()).n,0)
  await addCourse('one')
  const receipt = randomUUID(), first = await call({},receipt)
  assert.equal((await db.prepare('SELECT course_id FROM lms_assignment_courses WHERE assignment_id=?').get(first.result)).course_id,'one')
  assert.equal((await storage.status(guildId)).assignmentCourses[0].id,'one')
  await addCourse('two')
  assert.deepEqual(await call({},receipt),first)
  await assert.rejects(call(),{status:422})
  await assert.rejects(call({course_id:'another-workspace-course'}),{status:422})
  const second = await call({course_id:'two'})
  assert.equal((await db.prepare('SELECT course_id FROM lms_assignment_courses WHERE assignment_id=?').get(second.result)).course_id,'two')
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM assignments').get()).n,2)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_storage_receipts').get()).n,2)
  const legacy = await db.prepare("INSERT INTO assignments(week,title,due_date,type) VALUES(1,'기존 과제','2099-10-01','team')").run()
  await workspaces.snapshot(w.id)
  assert.equal(await db.prepare('SELECT course_id FROM lms_assignment_courses WHERE assignment_id=?').get(Number(legacy.lastInsertRowid)),undefined)
  await db.prepare("DELETE FROM lms_records WHERE kind='courses' AND id='two'").run()
  await workspaces.snapshot(w.id)
  assert.equal((await db.prepare('SELECT course_id FROM lms_assignment_courses WHERE assignment_id=?').get(Number(legacy.lastInsertRowid))).course_id,'one')
  // Existing bindings never move to a different course when the list changes.
  assert.equal((await db.prepare('SELECT course_id FROM lms_assignment_courses WHERE assignment_id=?').get(second.result)).course_id,'two')
  const admin = { id: 'admin', role: 'admin', username: 'deletion-admin' }
  const id = first.result
  const preview = () => storage.assignmentDeletion(w.id, String(id), null, admin)
  const before = await preview()
  await db.prepare('INSERT INTO lms_assignment_publications VALUES(?,?,?)').run(id, 1, 'admin')
  const submission = await db.prepare("INSERT INTO submissions(assignment_id,user_id,user_name,content) VALUES(?,'123456789012345699','수강생','제출물')").run(id)
  await db.prepare('INSERT INTO lms_submission_targets VALUES(?,?)').run(Number(submission.lastInsertRowid), 'team:one')
  await db.prepare("INSERT INTO assignment_reminders(assignment_id,team) VALUES(?,'1조')").run(id)
  await assert.rejects(storage.assignmentDeletion(w.id, String(id), { revision: before.revision, requestId: randomUUID() }, admin), { status: 409 })
  assert.ok(await db.prepare('SELECT 1 FROM lms_assignment_courses WHERE assignment_id=?').get(id))
  assert.ok(await db.prepare('SELECT 1 FROM lms_assignment_publications WHERE assignment_id=?').get(id))
  await assert.rejects(storage.assignmentDeletion(w.id, String(id), null, { id: 'outsider', role: 'student' }), { status: 403 })
  const other = await workspaces.create({ name: '삭제 격리 확인' })
  await assert.rejects(storage.assignmentDeletion(other.id, String(id), null, admin), { status: 404 })
  const latest = await preview(), deletion = { revision: latest.revision, requestId: randomUUID() }
  assert.equal(latest.submissionCount, 1)
  assert.deepEqual(await storage.assignmentDeletion(w.id, String(id), deletion, admin), { deleted: true })
  assert.deepEqual(await storage.assignmentDeletion(w.id, String(id), deletion, admin), { deleted: true })
  for (const table of ['assignments', 'submissions', 'lms_assignment_courses', 'lms_assignment_publications', 'assignment_reminders']) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'assignments' ? 'id' : 'assignment_id'}=?`).get(id)).n, 0)
  }
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_submission_targets WHERE submission_id=?').get(Number(submission.lastInsertRowid))).n, 0)
  assert.equal((await db.prepare("SELECT state FROM lms_outbox WHERE kind='submission' AND source_id=?").get(String(id))).state, 'cancelled')
  // Discord uses the same worker path, including legacy callers without a revision.
  assert.deepEqual(await storage.call({ guildId, operation: 'delete_assignment', args: [second.result], requestId: randomUUID() }), { result: true })
  assert.deepEqual(await storage.call({ guildId, operation: 'delete_assignment', args: [second.result], requestId: randomUUID() }), { result: false })
  await assignmentPublicationScenario(workspaces, storage)
}

async function assignmentPublicationScenario(workspaces, storage) {
  const guildId = '123456789012345692'
  const w = await workspaces.create({ name: 'Discord 생성 알림', guildId }), db = (await workspaces.open(w.id)).db
  await storage.state(w.id)
  const add = (kind, id, data) => db.prepare('INSERT INTO lms_records(kind,id,data) VALUES(?,?,?)').run(kind, id, JSON.stringify({ id, ...data }))
  for (const id of ['a', 'b', 'empty']) await add('courses', id, { title: id })
  for (const [id, courseId] of [['t1', 'a'], ['t2', 'a'], ['tb', 'b']]) await add('teams', id, { name: id, courseId })
  for (const [id, courseId, team, status, discordId] of [
    ['l1', 'a', 't1', '정상', '223456789012345691'],
    ['l2', 'a', 't1', '정상', '223456789012345692'],
    ['l3', 'a', '', '정상', ''],
    ['withdrawn', 'a', 't2', '중도탈락', '223456789012345694'],
    ['other', 'b', 'tb', '정상', '223456789012345695'],
  ]) await add('learners', id, { name: id, courseId, team, status, discordId })
  const body = (type = 'team', courseId = 'a') => ({ guildId, operation: 'create_assignment', args: [2, '새 과제', '실습 내용', '2099-10-01', type], kwargs: { course_id: courseId }, requestId: randomUUID() })
  const jobs = id => db.prepare("SELECT * FROM lms_outbox WHERE kind='publication' AND source_id=? ORDER BY event_key").all(String(id))
  const publication = id => db.prepare('SELECT * FROM lms_assignment_publications WHERE assignment_id=?').get(id)
  const request = body(), first = await storage.call(request)
  assert.deepEqual(await storage.call(request), first)
  const teamJobs = await jobs(first.result)
  assert.equal(teamJobs.length, 1)
  const payload = JSON.parse(teamJobs[0].payload)
  assert.equal(payload.targetKey, 'team:t1')
  assert.equal(payload.publicationGuildId, guildId)
  assert.equal(payload.assignmentId, String(first.result))
  assert.match(payload.description, /실습 내용/)
  assert.equal(teamJobs[0].state, 'pending')
  assert.ok(await publication(first.result))

  const admin = { id: 'admin', role: 'admin', username: 'publication-admin' }
  const alerts = createAssignmentAlerts(null, workspaces)
  const initial = (await alerts.read(w.id, admin)).assignments.find(a => a.id === String(first.result))
  await add('learners', 'late', { name: 'late', courseId: 'a', team: 't2', status: '정상', discordId: '' })
  await alerts.publish(w.id, initial.id, { revision: initial.revision }, admin)
  assert.equal((await jobs(first.result)).length, 1, 'manual publish must not expand or duplicate the creation audience')

  const personal = await storage.call(body('individual'))
  const personalJobs = await jobs(personal.result)
  assert.deepEqual(personalJobs.map(j => JSON.parse(j.payload).learnerId).sort(), ['l1', 'l2', 'l3', 'late'])
  assert.equal(JSON.parse(personalJobs.find(j => JSON.parse(j.payload).learnerId === 'l3').payload).targetId, '')
  const web = await storage.call({ ...body(), revision: (await storage.state(w.id)).revision }, admin.username, w.id)
  assert.equal((await jobs(web.result)).length, 0)
  assert.equal(await publication(web.result), undefined)
  const empty = await storage.call(body('individual', 'empty'))
  assert.equal(await publication(empty.result), undefined)
  await add('learners', 'new', { name: 'new', courseId: 'empty', team: '', status: '정상', discordId: '' })
  const ready = (await alerts.read(w.id, admin)).assignments.find(a => a.id === String(empty.result))
  await alerts.publish(w.id, ready.id, { revision: ready.revision }, admin)
  assert.equal((await jobs(empty.result)).length, 1)

  // A publication write failure must roll back the assignment and retry receipt too.
  const next = (await db.prepare('SELECT MAX(id) AS id FROM assignments').get()).id + 1
  await db.prepare('INSERT INTO lms_outbox(id,event_key,kind,source_id,guild_id,payload,actor,created_at) VALUES(?,?,?,?,?,?,?,?)').run('collision', `publication:${next}:team:t1`, 'publication', 'collision', guildId, '{}', 'test', 0)
  const failed = body()
  await assert.rejects(storage.call(failed), { status: 422 })
  assert.equal(await db.prepare('SELECT 1 FROM assignments WHERE id=?').get(next), undefined)
  assert.equal(await db.prepare('SELECT 1 FROM lms_assignment_courses WHERE assignment_id=?').get(next), undefined)
  assert.equal(await publication(next), undefined)
  assert.equal(await db.prepare('SELECT 1 FROM lms_storage_receipts WHERE id=?').get(failed.requestId), undefined)
  await db.prepare("DELETE FROM lms_outbox WHERE id='collision'").run()
  await storage.call({ guildId, operation: 'delete_assignment', args: [personal.result], requestId: randomUUID() })
  assert.ok((await jobs(personal.result)).every(j => j.state === 'cancelled'))
}
