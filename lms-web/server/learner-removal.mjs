// Keep the original learner identity for historical attendance and score records.
// Moving it out of the active roster also frees email/Discord uniqueness indexes.
export async function archiveLearner(db, learner, actor, now = Date.now()) {
    const archived = { ...learner, status: '비활성', removedAt: now };
    await db.prepare("INSERT INTO lms_records(kind,id,data) VALUES('removedLearners',?,?)").run(learner.id, JSON.stringify(archived));
    await db.prepare("DELETE FROM lms_records WHERE kind='learners' AND id=?").run(learner.id);
    await db.prepare('INSERT INTO lms_audit(actor,action,target,before_json,after_json) VALUES(?,?,?,?,?)').run(actor, 'learner.remove', learner.id, JSON.stringify(learner), JSON.stringify(archived));
}
