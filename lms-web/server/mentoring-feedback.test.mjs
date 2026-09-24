import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { mentoringFeedbackScenario } from './mentoring-feedback-scenario.mjs';

test('mentoring end-time requests and replies are durable, recipient-bound and workspace-scoped', async t => {
    const dir=mkdtempSync(join(tmpdir(),'mentoring-feedback-'));
    const runtime=await createRuntime(join(dir,'test.db'),{NODE_ENV:'test'});
    t.after(()=>{runtime.close();rmSync(dir,{recursive:true,force:true});});
    await mentoringFeedbackScenario(runtime);
});
