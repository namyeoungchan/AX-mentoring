import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

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
}
