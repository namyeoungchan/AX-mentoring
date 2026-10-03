import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './runtime.mjs';
import { helpGuidesScenario } from './help-guides-scenario.mjs';

test('help documents enforce exact roles, workspace isolation, uploads and revoked access', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ax-help-'));
  const runtime = await createRuntime(join(dir, 'test.db'), { NODE_ENV: 'test' });
  t.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  await helpGuidesScenario(runtime);
});
