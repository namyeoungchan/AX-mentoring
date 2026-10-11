import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { mentoringCoordinationScenario } from './mentoring-coordination-scenario.mjs';

test('approved mentoring changes require participant agreement and preserve holds, expiry, history and notifications', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'mentoring-coordination-'));
    const runtime = await createRuntime(join(dir, 'test.db'), { NODE_ENV: 'test' });
    t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
    await mentoringCoordinationScenario(runtime);
});
