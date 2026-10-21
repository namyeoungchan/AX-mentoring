import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { mentoringActivitiesScenario } from './mentoring-activities-scenario.mjs';

test('manual mentoring records enforce ownership, roles, scope, retries and edits without booking side effects', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'mentoring-activities-'));
    const runtime = await createRuntime(join(dir, 'test.db'), { NODE_ENV: 'test' });
    t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
    await mentoringActivitiesScenario(runtime);
});
