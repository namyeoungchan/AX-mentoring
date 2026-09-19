import { spawn } from 'node:child_process'
import { ApiError } from './store.mjs'

// One sequential JSON-lines worker per slot. Workers hold no idle DB connections.
export function createPythonStorageExecutor({ python, script, timeoutMs = 25000, env = {} }) {
  const workers = new Map()
  let starts = 0
  const unavailable = () => new ApiError(503, '웹 데이터 처리기가 응답하지 않습니다. 잠시 후 다시 시도하세요.')
  function start(slot) {
    const child = spawn(python, [script, '--serve'], { windowsHide: true, env: { ...process.env, ...env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const worker = { child, current: null, output: '' }
    workers.set(slot, worker); starts++
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      worker.output += chunk
      if (worker.output.length > 64 * 1024 * 1024) { child.kill(); return }
      const newline = worker.output.indexOf('\n')
      if (newline < 0 || !worker.current) return
      const line = worker.output.slice(0, newline)
      worker.output = worker.output.slice(newline + 1)
      let response
      try { response = JSON.parse(line) } catch { child.kill(); return }
      const current = worker.current
      // A timed-out child must exit before its queue slot/writer lock is released.
      if (current.timedOut) return
      clearTimeout(current.timer); worker.current = null
      if (response.ok) current.resolve(response.result)
      else {
        if (response.error === 'assignment_course_required') { current.reject(new ApiError(422, '과제를 생성할 학습 과정을 선택하세요. 과정이 없다면 먼저 등록하세요.')); return }
        const stale = response.error === 'stale_revision', busy = response.error === 'storage_busy'
        current.reject(new ApiError(stale ? 409 : busy ? 503 : 422, stale ? '다른 작업으로 데이터가 변경되었습니다. 새로고침하세요.' : busy ? '데이터 저장소가 사용 중입니다. 잠시 후 다시 시도하세요.' : '입력 값이나 데이터 연결 관계를 확인하세요.'))
      }
    })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', () => {}) // close follows both failed spawn and normal exit.
    child.on('close', () => {
      if (workers.get(slot) === worker) workers.delete(slot)
      if (worker.current) { clearTimeout(worker.current.timer); worker.current.reject(unavailable()); worker.current = null }
    })
    return worker
  }
  return {
    execute(value, slot) {
      const worker = workers.get(slot) || start(slot)
      return new Promise((resolve, reject) => {
        if (worker.current) return reject(unavailable())
        const current = { resolve, reject, timedOut: false }
        current.timer = setTimeout(() => { current.timedOut = true; worker.child.kill() }, timeoutMs)
        worker.current = current
        worker.child.stdin.write(JSON.stringify(value) + '\n')
      })
    },
    stats: () => ({ workers: workers.size, workerStarts: starts, executionTimeoutMs: timeoutMs }),
    close() { for (const worker of workers.values()) worker.child.kill() },
  }
}
