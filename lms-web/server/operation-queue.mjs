import { performance } from 'node:perf_hooks'
import { ApiError } from './store.mjs'

// The executor owns its backend; admission control and diagnostics are DB-neutral.
export function createOperationQueue(execute, { concurrency = 2, maxPending = 64, perWorkspace = 16, queueTimeoutMs = 5000 } = {}) {
  for (const value of [concurrency, maxPending, perWorkspace, queueTimeoutMs]) if (!Number.isInteger(value) || value < 1) throw new Error('Invalid operation queue limit')
  const pending = [], slots = new Set(), writers = new Set()
  const totals = { completed: 0, failed: 0, rejected: 0, expired: 0, maxWaitMs: 0, maxRunMs: 0 }
  let closed = false
  const unavailable = () => new ApiError(503, '데이터 처리 요청이 밀려 있습니다. 잠시 후 다시 시도하세요.')
  function drain() {
    while (slots.size < concurrency) {
      const index = pending.findIndex(job => job.readOnly || !writers.has(job.key))
      if (index < 0) return
      const [job] = pending.splice(index, 1)
      clearTimeout(job.timer)
      const started = performance.now()
      totals.maxWaitMs = Math.max(totals.maxWaitMs, started - job.queued)
      let slot = 0
      while (slots.has(slot)) slot++
      slots.add(slot)
      if (!job.readOnly) writers.add(job.key)
      Promise.resolve().then(() => execute(job.value, slot)).then(result => {
        totals.completed++; job.resolve(result)
      }, error => { totals.failed++; job.reject(error) }).finally(() => {
        totals.maxRunMs = Math.max(totals.maxRunMs, performance.now() - started)
        slots.delete(slot)
        if (!job.readOnly) writers.delete(job.key)
        drain()
      })
    }
  }
  function run(key, readOnly, value) {
    if (closed || pending.length >= maxPending || pending.filter(job => job.key === key).length >= perWorkspace) {
      totals.rejected++; return Promise.reject(unavailable())
    }
    return new Promise((resolve, reject) => {
      const job = { key, readOnly, value, resolve, reject, queued: performance.now() }
      job.timer = setTimeout(() => {
        const index = pending.indexOf(job)
        if (index < 0) return
        pending.splice(index, 1); totals.expired++; reject(unavailable())
      }, queueTimeoutMs)
      pending.push(job)
      drain()
    })
  }
  return { run,
    stats: () => ({ active: slots.size, queued: pending.length, concurrency, maxPending, perWorkspace, queueTimeoutMs, ...totals }),
    close() {
      closed = true
      for (const job of pending.splice(0)) { clearTimeout(job.timer); job.reject(unavailable()) }
    },
  }
}
