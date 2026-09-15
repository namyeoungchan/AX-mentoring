import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth } from './auth.mjs'
import { createStore } from './store.mjs'
import { studentLearning } from './student.mjs'

const options = { adminPassword: 'test-admin-password-1234', allowLegacyAdmin: true, botToken: 'test-discord-auth-token-123456789012345', guildId: '123456789012345678' }
const member = { username: 'student.test', name: '테스트 학생', password: 'test-password-1234', discordId: '555456789012345678' }
const verify = (code, overrides = {}) => ({ code, discordId: member.discordId, guildId: options.guildId, ...overrides })

test('first administrator needs the server key; setup is atomic, closes permanently and revokes legacy access', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const auth = createAuth(db, options)
    const old = auth.adminLogin(options.adminPassword)
    const input = { username: 'owner.test', name: '운영 관리자', password: 'owner-password-123456', setupKey: options.adminPassword }
    await assert.rejects(auth.setup({ ...input, setupKey: 'incorrect-key-12345678' }), { status: 401 })
    const results = await Promise.allSettled([auth.setup(input), auth.setup({ ...input, username: 'second.owner' })])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const result = results.find(result => result.status === 'fulfilled').value
    assert.equal(result.user.role, 'admin')
    assert.equal(auth.session(result.token).id, result.user.id)
    assert.equal(auth.session(old.token), null)
    assert.throws(() => auth.adminLogin(options.adminPassword), { status: 401 })
    assert.equal(auth.setupEnabled(), false)
    await assert.rejects(auth.setup(input), { status: 409 })
    const restarted = createAuth(db)
    assert.equal(restarted.setupEnabled(), false)
    assert.equal(restarted.session(result.token).role, 'admin')
    assert.equal((await restarted.login({ username: result.user.username, password: input.password })).user.role, 'admin')
    const serialized = JSON.stringify(db.prepare('SELECT * FROM lms_users').all())
    assert.ok(!serialized.includes(input.password))
    assert.ok(!serialized.includes(input.setupKey))
  } finally { db.close() }
})

test('public signup cannot choose a platform role or promote an existing username', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const auth = createAuth(db, options)
    await assert.rejects(auth.signup({ ...member, platform_role: 'admin' }, () => {}))
    const student = await auth.signup(member, () => {})
    await assert.rejects(auth.setup({ username: member.username, name: member.name, password: member.password, setupKey: options.adminPassword }), { status: 409 })
    assert.equal(auth.session(student.token).role, 'student')
    const disabled = createAuth(db, { ...options, allowLegacyAdmin: false })
    assert.throws(() => disabled.adminLogin(options.adminPassword), { status: 401 })
  } finally { db.close() }
})

test('password changes reauthenticate, rotate the current session and revoke all old sessions across restarts', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const auth = createAuth(db, options)
    const first = await auth.signup(member, () => {})
    const second = await auth.login({ username: member.username, password: member.password })
    const newPassword = 'replacement-password-123456'
    await assert.rejects(auth.changePassword(first.user, { currentPassword: 'incorrect', newPassword }), { status: 401 })
    assert.ok(auth.session(second.token))
    await assert.rejects(auth.changePassword(first.user, { currentPassword: member.password, newPassword: member.password }), { status: 422 })
    const changed = await auth.changePassword(first.user, { currentPassword: member.password, newPassword })
    assert.equal(auth.session(first.token), null)
    assert.equal(auth.session(second.token), null)
    assert.equal(auth.session(changed.token).id, first.user.id)
    await assert.rejects(auth.login({ username: member.username, password: member.password }), { status: 401 })
    const restarted = createAuth(db, options)
    assert.equal((await restarted.login({ username: member.username, password: newPassword })).user.id, first.user.id)
    assert.equal(restarted.session(changed.token).id, first.user.id)
  } finally { db.close() }
})

test('server-console recovery preserves roles and revokes sessions only for the target account', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const auth = createAuth(db, options)
    const owner = await auth.setup({ username: 'owner.test', name: '운영자', password: member.password, setupKey: options.adminPassword })
    const student = await auth.signup(member, () => {})
    const newPassword = 'recovered-password-123456'
    await auth.resetPassword({ username: owner.user.username, newPassword })
    assert.equal(auth.session(owner.token), null)
    assert.ok(auth.session(student.token))
    assert.equal((await auth.login({ username: owner.user.username, password: newPassword })).user.role, 'admin')
    await assert.rejects(auth.resetPassword({ username: 'missing.user', newPassword }), { status: 404 })
  } finally { db.close() }
})

test('Discord verification is required, single use, and secrets are hashed at rest', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const auth = createAuth(db, options)
    const pending = await auth.register(member)
    await assert.rejects(auth.login({ username: member.username, password: member.password }), { status: 401 })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lms_users').get().n, 0)
    assert.equal(auth.status(pending.ticket).state, 'pending')
    assert.deepEqual(auth.preview(verify(pending.code)), { username: member.username })
    assert.equal(auth.status(pending.ticket).state, 'pending')
    auth.verify(verify(pending.code))
    assert.equal(auth.status(pending.ticket).state, 'verified')
    assert.throws(() => auth.verify(verify(pending.code)), { status: 410 })
    const login = await auth.login({ username: member.username.toUpperCase(), password: member.password })
    assert.equal(login.user.role, 'student')
    assert.equal(auth.session(login.token).discordId, member.discordId)
    const privateRows = JSON.stringify([
      db.prepare('SELECT * FROM lms_users').all(),
      db.prepare('SELECT * FROM lms_registrations').all(),
      db.prepare('SELECT * FROM lms_auth_sessions').all(),
    ])
    for (const secret of [member.password, pending.code.replaceAll('-', ''), pending.ticket, login.token]) assert.ok(!privateRows.includes(secret))
    assert.ok(!('password_hash' in login.user))
    await assert.rejects(auth.login({ username: member.username, password: 'incorrect' }), { status: 401 })
    auth.logout(login.token)
    assert.equal(auth.session(login.token), null)
  } finally { db.close() }
})

test('verification binds guild and Discord member; browsers cannot choose roles', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const auth = createAuth(db, options)
    await assert.rejects(auth.register({ ...member, role: 'admin' }))
    const pending = await auth.register(member)
    assert.throws(() => auth.verify(verify(pending.code, { discordId: '666456789012345678' })), { status: 403 })
    assert.throws(() => auth.verify(verify(pending.code, { guildId: '777456789012345678' })), { status: 403 })
    assert.equal(auth.status(pending.ticket).state, 'pending')
    assert.equal(auth.botAuthorized(`Bearer ${options.adminPassword}`), false)
    assert.equal(auth.botAuthorized(`Bearer ${options.botToken}`), true)
    const adminLogin = auth.adminLogin(options.adminPassword)
    assert.equal(auth.botAuthorized(`Bearer ${adminLogin.token}`), false)
    assert.equal(auth.session(options.botToken), null)
    auth.verify(verify(pending.code))
    await assert.rejects(auth.register(member), { status: 409 })
    await assert.rejects(auth.register({ ...member, username: 'new.name' }), { status: 409 })
    await assert.rejects(auth.register({ ...member, discordId: '666456789012345678' }), { status: 409 })
  } finally { db.close() }
})

test('expired and replaced codes fail; verification remains atomic for competing registrations', async () => {
  const db = new DatabaseSync(':memory:')
  let now = 1_000_000
  try {
    const auth = createAuth(db, { ...options, now: () => now })
    const original = await auth.register(member)
    assert.throws(() => auth.renew(original.ticket), { status: 429 })
    now += 10 * 60000
    assert.equal(auth.status(original.ticket).state, 'expired')
    assert.throws(() => auth.verify(verify(original.code)), { status: 410 })
    const renewed = auth.renew(original.ticket)
    assert.throws(() => auth.verify(verify(original.code)), { status: 410 })
    const competing = await auth.register({ ...member, discordId: '666456789012345678' })
    auth.verify(verify(renewed.code))
    assert.throws(() => auth.verify(verify(competing.code, { discordId: '666456789012345678' })), { status: 409 })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lms_users').get().n, 1)
    assert.equal(auth.status(competing.ticket).state, 'pending')
    const login = await auth.login({ username: member.username, password: member.password })
    now += 8 * 3600000
    assert.equal(auth.session(login.token), null)
    now += 24 * 3600000
    auth.cleanup()
    assert.throws(() => auth.status(original.ticket), { status: 404 })
  } finally { db.close() }
})

test('sessions and throttling persist across restarts; administrator password changes revoke old sessions', async () => {
  const db = new DatabaseSync(':memory:')
  let now = 1000
  try {
    const auth = createAuth(db, { ...options, now: () => now })
    const pending = await auth.register(member)
    auth.verify(verify(pending.code))
    const login = await auth.login({ username: member.username, password: member.password })
    const adminLogin = auth.adminLogin(options.adminPassword)
    auth.limit('test', 'ip', 1, 60000)
    const restarted = createAuth(db, { ...options, now: () => now })
    assert.equal(restarted.session(login.token).id, login.user.id)
    assert.equal(restarted.session(adminLogin.token).role, 'admin')
    assert.throws(() => restarted.limit('test', 'ip', 1, 60000), { status: 429 })
    const changed = createAuth(db, { ...options, adminPassword: 'a-different-admin-password', now: () => now })
    assert.equal(changed.session(adminLogin.token), null)
    now += 60000
    restarted.limit('test', 'ip', 1, 60000)
  } finally { db.close() }
})

test('signup fails closed without the dedicated bot configuration and rejects weak passwords', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const disabled = createAuth(db)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.botAuthorized(''), false)
    await assert.rejects(disabled.register(member), { status: 503 })
    assert.throws(() => disabled.adminLogin(''), { status: 401 })
    const auth = createAuth(db, options)
    await assert.rejects(auth.register({ ...member, password: 'short' }))
    await assert.rejects(auth.register({ ...member, username: 'x' }))
  } finally { db.close() }
})

test('student data uses verified identity and hides other students, courses, and drafts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'learningops-student-'))
  const { db } = createStore(join(directory, 'test.db'))
  try {
    const put = (kind, row) => db.prepare('INSERT INTO lms_records VALUES(?,?,?)').run(kind, row.id, JSON.stringify(row))
    put('courses', { id: 'c1', title: '본인 과정', status: '진행 중' })
    put('courses', { id: 'c2', title: '다른 과정', status: '진행 중' })
    put('learners', { id: 'u1', discordId: member.discordId, courseId: 'c1', status: '정상', name: '학생', email: 'private@example.com' })
    put('learners', { id: 'u2', discordId: '666456789012345678', courseId: 'c2', status: '정상', name: '다른 학생' })
    put('scores', { id: 's1', studentId: 'u1', courseId: 'c1', item: '내 점수', score: 80, maximum: 100 })
    put('scores', { id: 's2', studentId: 'u2', courseId: 'c2', item: '다른 학생 점수', score: 90, maximum: 100 })
    put('attendance', { id: 'a1', studentId: 'u1', courseId: 'c1', date: '2026-09-16', period: 1, status: '출석', reason: '운영자 메모' })
    const data = studentLearning(db, { discordId: member.discordId })
    assert.equal(data.courses[0].title, '본인 과정')
    assert.deepEqual(data.scores.map(row => row.item), ['내 점수'])
    for (const privateValue of ['다른 학생', '다른 과정', 'private@example.com', '운영자 메모']) assert.ok(!JSON.stringify(data).includes(privateValue))
    assert.deepEqual(studentLearning(db, { discordId: '777456789012345678' }).courses, [])
    db.prepare("UPDATE lms_records SET data=json_set(data,'$.status','비활성') WHERE kind='learners' AND id='u1'").run()
    assert.deepEqual(studentLearning(db, { discordId: member.discordId }).scores, [])
  } finally { db.close(); rmSync(directory, { recursive: true }) }
})
