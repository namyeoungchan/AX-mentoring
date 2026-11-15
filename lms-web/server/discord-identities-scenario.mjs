import assert from 'node:assert/strict';

export async function discordIdentitiesScenario(runtime, administrator) {
    const { store, auth, workspaces, discordIdentities } = runtime, db = store.db;
    const owner = administrator || (await auth.setup({username:'identity.owner',name:'관리자',password:'owner-password-1234',setupKey:'identity-test-bootstrap'})).user;
    const guildId='123456789012345678', discordId='223456789012345678', orphanId='323456789012345678';
    const workspace=await workspaces.create({name:'인증 관리 검증',guildId});
    const other=await workspaces.create({name:'인증 관리 다른 서버',guildId:'423456789012345678'});
    const first=await auth.signup({username:'identity.first',name:'기존 계정',password:'user-password-1234'},()=>{});
    const second=await auth.signup({username:'identity.second',name:'새 계정',password:'user-password-1234'},()=>{});
    for (const user of [first.user,second.user]) await db.prepare("INSERT INTO lms_workspace_members VALUES(?,?,'student',1)").run(workspace.id,user.id);
    await db.prepare("INSERT INTO lms_workspace_members VALUES(?,?,'student',1)").run(other.id,first.user.id);
    await auth.verify({code:(await auth.issueVerification(first.user,guildId)).code,discordId,guildId});
    await auth.verify({code:(await auth.issueVerification(first.user,other.guildIds[0])).code,discordId,guildId:other.guildIds[0]});
    const blockedCode=(await auth.issueVerification(second.user,guildId)).code;
    await assert.rejects(auth.verify({code:blockedCode,discordId,guildId}),{status:409});
    await db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run(workspace.id,'deleted-user',guildId,orphanId,1);
    await db.prepare('INSERT INTO lms_staff_connections VALUES(?,?,?)').run(workspace.id,'deleted-user',orphanId);
    await db.prepare('INSERT INTO lms_staff_connections VALUES(?,?,?)').run(workspace.id,first.user.id,orphanId);
    await db.prepare('INSERT INTO lms_onboarding_members VALUES(?,?,1,1)').run(guildId,orphanId);
    await db.prepare("INSERT INTO lms_member_sync VALUES(?,?,'v','ready','',1)").run(guildId,orphanId);
    await db.prepare('INSERT INTO lms_member_retry VALUES(?,?)').run(guildId,orphanId);
    const target=(await workspaces.open(workspace.id)).db;
    await target.prepare('INSERT INTO lms_records VALUES(?,?,?)').run('scores','retained',JSON.stringify({id:'retained',score:90,studentId:'retained-student'}));
    const list=()=>discordIdentities.list(owner);
    let data=await list();
    const orphan=data.identities.find(row=>row.discordId===orphanId), linked=data.identities.find(row=>row.discordId===discordId);
    assert.equal(orphan.state,'orphan'); assert.equal(orphan.orphanCount,3);
    assert.equal(linked.account.username,first.user.username);
    assert.equal(linked.records.filter(row=>row.kind==='verification').length,2);
    for(const secret of ['ticket_hash','code_hash','password_hash',blockedCode]) assert.ok(!JSON.stringify(data).includes(secret));
    await assert.rejects(discordIdentities.list({...first.user,role:'admin'}),{status:403});
    await assert.rejects(discordIdentities.remove(first.user,orphanId,{discordId:orphanId,revision:orphan.revision}),{status:403});
    await assert.rejects(discordIdentities.remove(owner,orphanId,{discordId,revision:orphan.revision}),{status:422});
    // A new proof after a preview must prevent deleting the unseen state.
    await db.prepare('UPDATE lms_workspace_verifications SET verified_at=2 WHERE discord_id=?').run(orphanId);
    await assert.rejects(discordIdentities.remove(owner,orphanId,{discordId:orphanId,revision:orphan.revision}),{status:409});
    const fresh=(await list()).identities.find(row=>row.discordId===orphanId);
    await discordIdentities.remove(owner,orphanId,{discordId:orphanId,revision:fresh.revision});
    assert.ok(!(await list()).identities.some(row=>row.discordId===orphanId));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_onboarding_members WHERE discord_id=?').get(orphanId)).n,0);
    assert.equal((await auth.verificationState({guildId,discordId})).verified,true);
    assert.ok(await auth.session(first.token), 'cleaning stale references must not sign out the account with a different current Discord identity');
    await discordIdentities.remove(owner,discordId,{discordId,revision:linked.revision});
    assert.equal(await auth.session(first.token),null);
    assert.ok(await auth.session(second.token));
    assert.ok(await db.prepare('SELECT id FROM lms_users WHERE id=?').get(first.user.id));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_workspace_members WHERE user_id=?').get(first.user.id)).n,2);
    assert.equal((await auth.verificationState({guildId,discordId})).verified,false);
    assert.equal((await auth.verificationState({guildId:other.guildIds[0],discordId})).verified,false);
    assert.equal((await target.prepare("SELECT data FROM lms_records WHERE id='retained'").get()).data,JSON.stringify({id:'retained',score:90,studentId:'retained-student'}));
    await auth.verify({code:(await auth.issueVerification(second.user,guildId)).code,discordId,guildId});
    assert.equal((await auth.verificationState({guildId,discordId})).verified,true);
    data=await list(); assert.equal(data.identities.find(row=>row.discordId===discordId).account.id,second.user.id);
    await assert.rejects(discordIdentities.remove(owner,discordId,{discordId,revision:linked.revision}),{status:409});
    // Account deletion also clears legacy proofs whose user id no longer matches.
    await db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,?)').run(other.id,'another-deleted-user',other.guildIds[0],discordId,1);
    await auth.deleteAccount(owner,second.user.id,{username:second.user.username});
    assert.ok(!(await list()).identities.some(row=>row.discordId===discordId));
    await auth.verify({code:(await auth.issueVerification(first.user,guildId)).code,discordId,guildId});
    assert.equal((await auth.verificationState({guildId,discordId})).verified,true);
    const audits=await db.prepare("SELECT * FROM lms_account_audit WHERE action='discord.identity.clear'").all();
    assert.equal(audits.length,2);
    assert.ok(audits.every(row=>row.actor_id===owner.id));
    const pendingId='523456789012345678';
    await auth.register({username:'identity.pending',name:'가입 중',password:'pending-password-1234',discordId:pendingId},guildId);
    const pending=(await list()).identities.find(row=>row.discordId===pendingId);
    assert.equal(pending.state,'pending');
    assert.equal(pending.orphanCount,0,'live legacy registration is not an orphan');
    await workspaceDiscordIdentitiesScenario(runtime, owner);
    return { owner, discordId, guildId, first, workspace };
}

async function workspaceDiscordIdentitiesScenario({ store: { db }, auth, workspaces, discordIdentities }, owner) {
    const guildId='623456789012345678', otherGuild='723456789012345678', discordId='823456789012345678', orphanId='923456789012345678';
    const workspace=await workspaces.create({name:'워크스페이스 인증 권한',guildId});
    const other=await workspaces.create({name:'인증 비공개 서버',guildId:otherGuild});
    const admin=await auth.signup({username:'scoped.admin',name:'워크스페이스 관리자',password:'scoped-password-1234'},()=>{});
    const member=await auth.signup({username:'scoped.member',name:'로컬 계정',password:'scoped-password-1234'},()=>{});
    const replacement=await auth.signup({username:'scoped.new',name:'재인증 계정',password:'scoped-password-1234'},()=>{});
    for(const [user,role] of [[admin.user,'admin'],[member.user,'student'],[replacement.user,'student']])
        await db.prepare('INSERT INTO lms_workspace_members VALUES(?,?,?,1)').run(workspace.id,user.id,role);
    const list=()=>discordIdentities.list(admin.user,workspace.id);
    const row=async id=>(await list()).identities.find(value=>value.discordId===id);
    const clear=before=>discordIdentities.remove(admin.user,before.discordId,{discordId:before.discordId,revision:before.revision},workspace.id);
    await assert.rejects(discordIdentities.list(admin.user),{status:403});
    await assert.rejects(discordIdentities.list(admin.user,other.id),{status:403});
    await assert.rejects(discordIdentities.list({...member.user,role:'admin'},workspace.id),{status:403});
    await db.prepare("UPDATE lms_workspace_members SET role='instructor' WHERE user_id=?").run(member.user.id);
    await assert.rejects(discordIdentities.list(member.user,workspace.id),{status:403});
    await db.prepare("UPDATE lms_workspace_members SET role='student' WHERE user_id=?").run(member.user.id);
    await auth.verify({code:(await auth.issueVerification(member.user,guildId)).code,discordId,guildId});
    const local=await row(discordId); assert.equal(local.canUnlink,true);
    // A second membership after preview must prevent the previously offered global unlink.
    await db.prepare("INSERT INTO lms_workspace_members VALUES(?,?,'student',1)").run(other.id,member.user.id);
    await assert.rejects(clear(local),{status:409});
    await auth.verify({code:(await auth.issueVerification(member.user,otherGuild)).code,discordId,guildId:otherGuild});
    for(const [ws,guild] of [[workspace,guildId],[other,otherGuild]]) {
        await db.prepare('INSERT INTO lms_workspace_verifications VALUES(?,?,?,?,1)').run(ws.id,'deleted-scoped',guild,orphanId);
        await db.prepare('INSERT INTO lms_onboarding_members VALUES(?,?,1,1)').run(guild,orphanId);
        await db.prepare("INSERT INTO lms_member_sync VALUES(?,?,'v','ready','',1)").run(guild,orphanId);
        await db.prepare('INSERT INTO lms_member_retry VALUES(?,?)').run(guild,orphanId);
    }
    const scoped=await list();
    assert.ok(!JSON.stringify(scoped).includes(other.name));
    assert.ok(!JSON.stringify(scoped).includes(otherGuild));
    assert.ok(!JSON.stringify(scoped).includes(other.id));
    assert.equal((await row(discordId)).canUnlink,false);
    const globalOrphan=(await discordIdentities.list(owner)).identities.find(value=>value.discordId===orphanId);
    await assert.rejects(discordIdentities.remove(admin.user,orphanId,{discordId:orphanId,revision:globalOrphan.revision}),{status:403});
    await clear(await row(orphanId));
    assert.equal(await row(orphanId),undefined);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lms_workspace_verifications WHERE discord_id=? AND workspace_id=?').get(orphanId,other.id)).n,1);
    for(const table of ['lms_onboarding_members','lms_member_sync','lms_member_retry']) {
        assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE discord_id=? AND guild_id=?`).get(orphanId,guildId)).n,0);
        assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE discord_id=? AND guild_id=?`).get(orphanId,otherGuild)).n,1);
    }
    // Scoped cleanup retains a shared account's login and other server proof.
    await clear(await row(discordId));
    assert.ok(await auth.session(member.token));
    assert.equal((await auth.verificationState({guildId,discordId})).verified,false);
    assert.equal((await auth.verificationState({guildId:otherGuild,discordId})).verified,true);
    await assert.rejects(discordIdentities.remove(admin.user,orphanId,{discordId:orphanId,revision:globalOrphan.revision},workspace.id),{status:404});
    // Once only this workspace owns the account, it can release the global ID.
    await db.prepare('DELETE FROM lms_workspace_members WHERE workspace_id=? AND user_id=?').run(other.id,member.user.id);
    await db.prepare('DELETE FROM lms_workspace_verifications WHERE workspace_id=? AND user_id=?').run(other.id,member.user.id);
    await db.prepare('DELETE FROM lms_registrations WHERE workspace_id=? AND user_id=?').run(other.id,member.user.id);
    await auth.verify({code:(await auth.issueVerification(member.user,guildId)).code,discordId,guildId});
    assert.equal((await row(discordId)).canUnlink,true);
    await clear(await row(discordId));
    assert.equal(await auth.session(member.token),null);
    assert.ok(await db.prepare('SELECT 1 FROM lms_workspace_members WHERE workspace_id=? AND user_id=?').get(workspace.id,member.user.id));
    await auth.verify({code:(await auth.issueVerification(replacement.user,guildId)).code,discordId,guildId});
    assert.equal((await auth.verificationState({guildId,discordId})).verified,true);
    // A platform administrator cannot be disconnected by a workspace administrator.
    await db.prepare("UPDATE lms_users SET platform_role='admin',is_super_admin=1 WHERE id=?").run(replacement.user.id);
    assert.equal((await row(discordId)).canUnlink,false);
    await clear(await row(discordId));
    assert.ok(await auth.session(replacement.token));
    assert.equal((await db.prepare('SELECT discord_id FROM lms_users WHERE id=?').get(replacement.user.id)).discord_id,discordId);
    await db.prepare("UPDATE lms_users SET platform_role='student',is_super_admin=0 WHERE id=?").run(replacement.user.id);
    const before=await row(discordId);
    await db.prepare("UPDATE lms_workspace_members SET role='student' WHERE workspace_id=? AND user_id=?").run(workspace.id,admin.user.id);
    await assert.rejects(clear(before),{status:403});
    const audits=await db.prepare('SELECT * FROM lms_account_audit WHERE actor_id=?').all(admin.user.id);
    assert.equal(audits.length,4);
    assert.ok(audits.every(value=>value.action===`discord.identity.clear:${workspace.id}`));
}
