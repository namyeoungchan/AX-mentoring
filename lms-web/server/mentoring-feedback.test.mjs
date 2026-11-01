import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { mentoringFeedbackScenario } from './mentoring-feedback-scenario.mjs';

test('mentoring end-time requests and replies are durable, recipient-bound and workspace-scoped', async t => {
    const dir=mkdtempSync(join(tmpdir(),'mentoring-feedback-'));
    let runtime=await createRuntime(join(dir,'test.db'),{NODE_ENV:'test'});
    t.after(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true});});
    const result = await mentoringFeedbackScenario(runtime);
    await runtime.close();
    runtime = await createRuntime(join(dir,'test.db'),{NODE_ENV:'test'});
    const feedback = await runtime.mentoringFeedback.read(result.workspaceId,'1',{id:'admin',username:'operator',role:'admin'});
    const response = feedback.requests.find(r=>r.role==='mentor').responses.find(r=>r.id===result.editedId);
    assert.equal(response.content,'최종 보완 기록');
    assert.equal(response.revision,2);
});
