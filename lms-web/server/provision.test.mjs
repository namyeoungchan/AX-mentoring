import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createProvision } from './provision.mjs'

const guildId = '123456789012345678'
const token = 'test-provision-token-12345678901234567890'
const input = () => ({ guildId, name: '교육 서버', autoApply: true, revision: '', channels: [
  { id: 'cat', name: '학습', type: 'category', parentId: '' },
  { id: 'text', name: 'Question', type: 'text', parentId: 'cat' },
  { id: 'voice', name: '멘토링 음성', type: 'voice', parentId: 'cat' },
] })
const guilds = [{ id: guildId, name: '교육 서버', manageChannels: true }]
const success = job => ({ id: job.id, claim: job.claim, success: true, errorCode: null, results: job.plan.channels.map((item, i) => ({ id: item.id, discordId: String(223456789012345678n + BigInt(i)), action: 'created' })) })

test('bot join queues only the matching server, claims once, and records applied channels', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const provision = createProvision(db, { token })
    const saved = provision.save(input())
    assert.equal(saved.channels[1].name, 'question')
    assert.equal(provision.poll({ guilds: [{ ...guilds[0], id: '999456789012345678' }] }).job, null)
    const { job } = provision.poll({ guilds })
    assert.equal(job.plan.guildId, guildId)
    assert.equal(provision.poll({ guilds }).job, null)
    assert.throws(() => provision.save(saved), { status: 409 })
    assert.throws(() => provision.enqueue(guildId, saved.revision), { status: 409 })
    assert.throws(() => provision.complete({ ...success(job), claim: '0'.repeat(64) }), { status: 409 })
    assert.throws(() => provision.complete({ ...success(job), results: [] }), { status: 422 })
    provision.complete(success(job))
    assert.equal(provision.read().jobs[0].state, 'succeeded')
    assert.equal(provision.read().jobs[0].results.length, 3)
    assert.ok(!JSON.stringify(provision.read()).includes(job.claim))
    assert.equal(provision.poll({ guilds }).job, null)
    assert.throws(() => provision.complete(success(job)), { status: 409 })
  } finally { db.close() }
})

test('failed and expired jobs require an explicit retry; old claims cannot complete new jobs', () => {
  const db = new DatabaseSync(':memory:')
  let now = 1000
  try {
    const provision = createProvision(db, { token, now: () => now })
    const saved = provision.save(input())
    const first = provision.poll({ guilds }).job
    provision.complete({ id: first.id, claim: first.claim, success: false, errorCode: 'forbidden', results: [] })
    assert.equal(provision.poll({ guilds }).job, null)
    provision.enqueue(guildId, saved.revision)
    const second = provision.poll({ guilds }).job
    now += 300000
    assert.equal(provision.read().jobs[0].state, 'failed')
    assert.throws(() => provision.complete(success(second)), { status: 409 })
    assert.equal(provision.poll({ guilds }).job, null)
    assert.equal(provision.read().guilds[0].connected, true)
    now += 90000
    assert.equal(provision.read().guilds[0].connected, false)
  } finally { db.close() }
})

test('manual configuration waits for a request and validates revisions and hierarchy', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const provision = createProvision(db, { token })
    assert.equal(provision.authorized(`Bearer ${token}`), true)
    assert.equal(provision.authorized('Bearer unrelated-key'), false)
    const bad = input(); bad.channels[1].parentId = 'missing'
    assert.throws(() => provision.save(bad))
    const duplicate = input(); duplicate.channels.push({ ...duplicate.channels[1], id: 'other' })
    assert.throws(() => provision.save(duplicate))
    const nested = input(); nested.channels[0].parentId = 'cat'
    assert.throws(() => provision.save(nested))
    const saved = provision.save({ ...input(), autoApply: false })
    assert.equal(provision.poll({ guilds }).job, null)
    assert.throws(() => provision.save(input()), { status: 409 })
    assert.throws(() => provision.enqueue(guildId, ''), { status: 409 })
    provision.enqueue(guildId, saved.revision)
    assert.ok(provision.poll({ guilds }).job)
  } finally { db.close() }
})
