import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './runtime.mjs';
import { courseManagementScenario } from './course-management-scenario.mjs';

test('course management ignores unrelated bot changes and protects concurrent course edits and schedules', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'course-management-'));
    const runtime = await createRuntime(join(dir, 'test.db'), { NODE_ENV: 'test' });
    t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
    await courseManagementScenario(runtime);
});
