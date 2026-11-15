import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { mentoringExportScenario } from './mentoring-export-scenario.mjs';

test('ended sessions record actual time and admins export per-mentor workbooks', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'mentoring-export-'));
    const runtime = await createRuntime(join(dir, 'test.db'), { NODE_ENV: 'test' });
    t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
    await mentoringExportScenario(runtime);
});
