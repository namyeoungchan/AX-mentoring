import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from './runtime.mjs';
import { createVimeo, embedDomains, safeUploadUrl } from './vimeo.mjs';
import { courseVideosScenario } from './course-videos-scenario.mjs';

test('course video lifecycle, upload idempotency and workspace/course/owner authorization', async t => {
  const dir = mkdtempSync(join(tmpdir(),'course-videos-'));
  const runtime = await createRuntime(join(dir,'test.db'),{NODE_ENV:'test'});
  t.after(()=>{runtime.close();rmSync(dir,{recursive:true,force:true});});
  await courseVideosScenario(runtime);
});

test('Vimeo scopes, private creation, exact domain restriction, safe errors and TUS URL', async () => {
  const calls = [], token = 'secret-server-token';
  let scope = 'public private upload';
  const fetcher = async (url,options) => {
    assert.equal(options.headers.Authorization,`Bearer ${token}`);
    calls.push({url,method:options.method,body:options.body && JSON.parse(options.body)});
    if (url.endsWith('/oauth/verify')) return Response.json({scope});
    if (url.includes('/privacy/domains?')) return Response.json({data:[{domain:'untrusted.example'}]});
    if (options.method === 'POST') return Response.json({uri:'/videos/42',upload:{upload_link:'https://files.tus.vimeo.com/one'}});
    return new Response(null,{status:204});
  };
  const v = createVimeo({VIMEO_ACCESS_TOKEN:token,VIMEO_EMBED_DOMAINS:'school.example'},fetcher);
  await assert.rejects(v.verify(),{status:503}); assert.equal(calls.length,1);
  scope += ' edit'; await v.verify();
  await v.create({title:'test',description:'',size:100}); await v.protect('42');
  assert.deepEqual(calls.find(c=>c.method==='POST').body.privacy,{view:'nobody',embed:'whitelist',download:false});
  assert.ok(calls.some(c=>c.method==='DELETE'&&c.url.endsWith('/untrusted.example')));
  assert.ok(calls.some(c=>c.method==='PUT'&&c.url.endsWith('/school.example')));
  await v.publish('42',true); assert.equal(calls.at(-1).body.privacy.view,'disable');
  await v.publish('42',false); assert.equal(calls.at(-1).body.privacy.view,'nobody');
  const failure = createVimeo({VIMEO_ACCESS_TOKEN:token},async()=>Response.json({error:token},{status:403}));
  await assert.rejects(failure.read('42'),error=>error.status===502&&!error.message.includes(token));
  assert.deepEqual(embedDomains({NODE_ENV:'production',ALLOWED_ORIGINS:'https://school.example',RENDER_EXTERNAL_URL:'https://school.onrender.com'}),['school.example','school.onrender.com']);
  assert.throws(()=>embedDomains({VIMEO_EMBED_DOMAINS:'*.example.com'}));
  assert.equal(safeUploadUrl('https://evil-vimeo.com/upload'),false);
  assert.equal(safeUploadUrl('https://files.tus.vimeo.com/upload'),true);
});
