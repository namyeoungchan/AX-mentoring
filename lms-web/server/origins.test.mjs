import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuredOrigins } from './origins.mjs'

test('actual Render URL remains allowed when the configured service name is stale', () => {
  const origins = configuredOrigins({ production: true, allowedOrigins: 'https://ax-lms.onrender.com, https://namyeoungchan.github.io/', renderExternalUrl: 'https://asanax-learningops-web.onrender.com' })
  assert.ok(origins.has('https://asanax-learningops-web.onrender.com'))
  assert.ok(origins.has('https://namyeoungchan.github.io'))
  for (const origin of ['null', 'https://attacker.onrender.com', 'https://asanax-learningops-web.onrender.com.attacker.example', 'https://namyeoungchan.github.io.attacker.example', 'http://localhost:5173']) assert.equal(origins.has(origin), false)
})

test('production without explicit origins trusts only the platform supplied URL; local defaults stay development-only', () => {
  assert.deepEqual([...configuredOrigins({ production: true })], [])
  assert.deepEqual([...configuredOrigins({ production: true, renderExternalUrl: 'https://actual.onrender.com' })], ['https://actual.onrender.com'])
  assert.ok(configuredOrigins().has('http://127.0.0.1:5173'))
})

test('configuration normalizes URL origins and rejects wildcards, paths and credentials', () => {
  assert.deepEqual([...configuredOrigins({ production: true, allowedOrigins: ' https://WEB.example:443/,https://web.example ' })], ['https://web.example'])
  for (const value of ['*', 'null', 'https://web.example/path', 'https://web.example/#login', 'https://web.example?x=1', 'https://user:password@web.example', 'http://web.example', 'https://*.example']) {
    assert.throws(() => configuredOrigins({ allowedOrigins: value }), /ALLOWED_ORIGINS/)
  }
})
