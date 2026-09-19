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
}
