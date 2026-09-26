import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { discordIdentitiesScenario } from './discord-identities-scenario.mjs';

test('Discord authentication cleanup releases ownership, protects scope and supports re-verification', async t => {
    const dir=mkdtempSync(join(tmpdir(),'discord-identities-'));
    const runtime=await createRuntime(join(dir,'test.db'),{NODE_ENV:'test',ADMIN_PASSWORD:'identity-test-bootstrap',LEARNINGOPS_AUTH_TOKEN:'test-token-123456789012345678901234567890'});
    t.after(()=>{runtime.close();rmSync(dir,{recursive:true,force:true});});
    const { owner, discordId, guildId, first } = await discordIdentitiesScenario(runtime);
    const login = await runtime.auth.login({username:first.user.username,password:'user-password-1234'});
    const before = (await runtime.discordIdentities.list(owner)).identities.find(row=>row.discordId===discordId);
    await runtime.store.db.exec("CREATE TRIGGER fail_identity_audit BEFORE INSERT ON lms_account_audit WHEN NEW.action='discord.identity.clear' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
    await assert.rejects(runtime.discordIdentities.remove(owner,discordId,{discordId,revision:before.revision}),/audit unavailable/);
    assert.equal((await runtime.auth.verificationState({discordId,guildId})).verified,true);
    assert.ok(await runtime.auth.session(login.token));
    assert.equal((await runtime.discordIdentities.list(owner)).identities.find(row=>row.discordId===discordId).revision,before.revision);
});
