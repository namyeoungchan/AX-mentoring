import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { announcementsScenario } from './announcements-scenario.mjs';

test('workspace admins manage main banners and popups shown to members by role and date', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'announcements-'));
    const runtime = await createRuntime(join(dir, 'test.db'), { NODE_ENV: 'test' });
    t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
    await announcementsScenario(runtime);
});
