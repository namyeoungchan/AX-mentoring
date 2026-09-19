import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './runtime.mjs';
import { attendancePresenceScenario } from './attendance-presence-scenario.mjs';
test('web and Discord share immutable entry/exit times, preserve corrections and enforce student/round scope', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'attendance-presence-'));
    const runtime = await createRuntime(join(dir, 'test.db'), { NODE_ENV: 'test' });
    t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
    await attendancePresenceScenario(runtime);
});
