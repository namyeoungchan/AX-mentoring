import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { createOperationQueue } from './operation-queue.mjs'

test('writes serialize per workspace while reads and other workspaces use available workers',async()=>{
  const started=[],finish=new Map()
  const queue=createOperationQueue((id,slot)=>new Promise(resolve=>{started.push([id,slot]);finish.set(id,resolve)}),{concurrency:3})
  const a=queue.run('a',false,'a1'),b=queue.run('a',false,'a2'),read=queue.run('a',true,'read'),other=queue.run('b',false,'b1')
  await setImmediate()
  assert.deepEqual(started.map(row=>row[0]),['a1','read','b1'])
  assert.equal(new Set(started.map(row=>row[1])).size,3)
  finish.get('a1')('done');await a;await setImmediate()
  assert.equal(started[3][0],'a2')
  for(const id of ['a2','read','b1']) finish.get(id)()
  await Promise.all([b,read,other]);await setImmediate()
  assert.equal(queue.stats().completed,4)
  assert.equal(queue.stats().active,0)
  queue.close()
})

test('bounded queues reject excess work and expire queued work without executing it',async()=>{
  let finish,executions=0
  const queue=createOperationQueue(()=>{executions++;return new Promise(resolve=>{finish=resolve})},{concurrency:1,maxPending:2,perWorkspace:1,queueTimeoutMs:30})
  const running=queue.run('a',false,1)
  const expired=assert.rejects(queue.run('a',false,2),{status:503})
  await assert.rejects(queue.run('a',false,3),{status:503})
  const otherExpired=assert.rejects(queue.run('b',false,4),{status:503})
  await assert.rejects(queue.run('c',false,5),{status:503})
  await Promise.all([expired,otherExpired])
  assert.equal(executions,1)
  finish();await running;await setImmediate()
  assert.equal(queue.stats().expired,2)
  queue.close()
  await assert.rejects(queue.run('a',true,6),{status:503})
})

test('executor failures release the writer and closing rejects all queued jobs',async()=>{
  let fail
  const queue=createOperationQueue(()=>new Promise((_,reject)=>{fail=reject}),{concurrency:1})
  const running=assert.rejects(queue.run('a',false,1),/worker failed/)
  const queued=assert.rejects(queue.run('a',false,2),{status:503})
  await setImmediate();queue.close();fail(new Error('worker failed'))
  await Promise.all([running,queued]);await setImmediate()
  assert.equal(queue.stats().active,0)
  assert.equal(queue.stats().queued,0)
})
