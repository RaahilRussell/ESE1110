import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createController } from '../apps/server/server.js';
import { SimulatorDriver } from '../packages/drivers/src/index.js';
import { LightingEngine } from '../packages/engine/src/index.js';

async function fixture(t: TestContext, options: Parameters<typeof createController>[0] = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'flashify-http-'));
  const driver = new SimulatorDriver();
  const controller = await createController({directory,driver,advertise:false,bootstrapToken:'local-setup-token',...options});
  const address = await controller.listen(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async()=>{await controller.close();await rm(directory,{recursive:true,force:true});});
  async function request(path:string, method='GET', data?:unknown, token?:string, headers:Record<string,string>={}) {
    const response = await fetch(base+path,{method,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(data!==undefined?{'content-type':'application/json'}:{}),...headers},body:data===undefined?undefined:typeof data==='string'?data:JSON.stringify(data)});
    const raw=await response.text(); let value:any;try{value=JSON.parse(raw);}catch{value=raw;}
    return {status:response.status,value,headers:response.headers};
  }
  const setup=await request('/api/auth/setup','POST',{pin:'314159',bootstrapToken:'local-setup-token'});assert.equal(setup.status,200);
  const token=setup.value.token as string;
  return {directory,controller,driver,base,request,token};
}
async function connect(base:string, t:TestContext) {
  const socket=new WebSocket(base.replace('http:','ws:')+'/ws');
  const messages:any[]=[]; socket.on('message',raw=>messages.push(JSON.parse(String(raw))));socket.on('error',()=>{});
  await once(socket,'open');t.after(()=>socket.terminate());
  async function message(predicate:(m:any)=>boolean) {const deadline=Date.now()+3000;while(Date.now()<deadline){const index=messages.findIndex(predicate);if(index>=0)return messages.splice(index,1)[0];await new Promise(r=>setTimeout(r,5));}throw new Error(`Expected websocket message; received ${JSON.stringify(messages)}`);}
  return {socket,message};
}
const configuration=()=>new LightingEngine({clock:{now:()=>0}}).exportConfiguration();

test('HTTP setup, auth, exclusive leases, heartbeat, expiry and logout use real routes',async t=>{
  let now=1000;const f=await fixture(t,{now:()=>now,leaseMs:1000});
  assert.equal((await f.request('/api/health')).value.setupRequired,false);
  assert.equal((await f.request('/api/state')).status,401);
  assert.equal((await f.request('/api/auth/setup','POST',{pin:'271828',bootstrapToken:'wrong'})).status,409);
  assert.equal((await f.request('/api/auth/login','POST',{pin:'271828'})).status,401);
  const second=(await f.request('/api/auth/login','POST',{pin:'314159'})).value.token;
  assert.equal((await f.request('/api/lease/acquire','POST',{},f.token)).status,200);
  assert.equal((await f.request('/api/lease/acquire','POST',{},second)).status,409);
  assert.equal((await f.request('/api/command','POST',{type:'master.set',id:'viewer',value:.5},second)).status,403);
  assert.equal((await f.request('/api/lease/heartbeat','POST',{},f.token)).status,200);
  now+=1001;assert.equal((await f.request('/api/lease/acquire','POST',{},second)).status,200);
  assert.equal((await f.request('/api/auth/logout','POST',{},second)).status,200);
  assert.equal((await f.request('/api/state','GET',undefined,second)).status,401);
  assert.equal((await f.request('/api/lease/acquire','POST',{},f.token)).status,200);
});

test('static allowlist denies secrets, source, dependencies and encoded traversal',async t=>{
  const f=await fixture(t);
  for(const path of ['/enhance.js','/enhance.css','/data/auth.json','/data/config.json','/.env','/.git/config','/package.json','/apps/server/auth.ts','/node_modules/zod/package.json','/%2e%2e/package.json','/%2fdata%2fauth.json'])assert.equal((await f.request(path)).status,404,path);
  const index=await f.request('/');assert.equal(index.status,200);assert.match(index.value,/<!doctype html>/i);
  assert.equal(index.headers.get('access-control-allow-origin'),null);
  assert.equal(index.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await f.request('/api/command/extra','POST',{},f.token)).status,404);
});

test('HTTP rejects oversized JSON before parsing; WS max payload closes with 1009',async t=>{
  const f=await fixture(t);const oversized=JSON.stringify({pin:'314159',padding:'x'.repeat(65536)});
  assert.equal((await f.request('/api/auth/login','POST',oversized)).status,413);
  assert.equal((await f.request('/api/command','POST',oversized,f.token)).status,413);
  const ws=await connect(f.base,t);const closed=once(ws.socket,'close');ws.socket.send('x'.repeat(65537));assert.equal((await closed)[0],1009);
});

test('WS requires hello and returns authenticated session, heartbeat, scoped dedup and expiry',async t=>{
  let now=1000;const f=await fixture(t,{now:()=>now,sessionMs:10000,leaseMs:5000});
  const rejected=await connect(f.base,t);const closing=once(rejected.socket,'close');rejected.socket.send(JSON.stringify({type:'ping',id:'before-hello'}));assert.equal((await closing)[0],1008);
  const ws=await connect(f.base,t);ws.socket.send(JSON.stringify({type:'hello',token:f.token,protocolVersion:1}));
  const welcome=await ws.message(m=>m.type==='welcome');assert.ok(welcome.sessionId);assert.equal(welcome.role,'viewer');await ws.message(m=>m.type==='state');
  await f.request('/api/lease/acquire','POST',{},f.token);
  ws.socket.send(JSON.stringify({type:'heartbeat',id:'heartbeat'}));assert.equal((await ws.message(m=>m.id==='heartbeat')).ok,true);
  const command={type:'master.set',id:'shared-id',value:.41};ws.socket.send(JSON.stringify(command));const first=await ws.message(m=>m.type==='ack'&&m.id===command.id);assert.equal(first.ok,true);
  ws.socket.send(JSON.stringify(command));assert.deepEqual(await ws.message(m=>m.type==='ack'&&m.id===command.id),first);
  assert.equal((await f.request('/api/command','POST',{...command,value:.7},f.token)).value.error.code,'ID_REUSED');
  const second=(await f.request('/api/auth/login','POST',{pin:'314159'})).value.token;
  await f.request('/api/lease/release','POST',{},f.token);await f.request('/api/lease/acquire','POST',{},second);
  assert.equal((await f.request('/api/command','POST',{...command,value:.8},second)).value.ok,true);
  assert.equal(f.controller.engine.snapshot().master,.8);
  const closed=once(ws.socket,'close');now+=10001;ws.socket.send(JSON.stringify({type:'ping',id:'expired'}));
  const expired=await ws.message(m=>m.id==='expired');assert.equal(expired.error.code,'UNAUTHORIZED');ws.socket.terminate();await closed;
});

test('real timer sends engine frames, preserves blackout and clean shutdown closes driver',async t=>{
  const f=await fixture(t);await f.request('/api/lease/acquire','POST',{},f.token);
  const cfg=configuration();cfg.master=1;
  assert.equal((await f.request('/api/config','PUT',cfg,f.token,{'if-match':String(f.controller.engine.snapshot().revision)})).status,200);
  assert.equal((await f.request('/api/command','POST',{type:'fixture.set',id:'red',fixtureId:'left',values:{red:1,green:0,blue:0,white:0},fadeMs:0,takeover:true},f.token)).value.ok,true);
  await new Promise(r=>setTimeout(r,60));assert.equal(f.driver.latest[0],255);assert.ok(f.driver.history.length>=2);
  const frames=await f.request('/api/frames','GET',undefined,f.token);assert.equal(frames.value.frame[0],255);assert.equal(frames.value.frame.length,512);
  const observer=(await f.request('/api/auth/login','POST',{pin:'314159'})).value.token;
  assert.equal((await f.request('/api/command','POST',{type:'blackout.set',id:'panic',on:true},observer)).value.ok,true);
  assert.ok(f.driver.latest.every(v=>v===0));
  await f.controller.close();await f.controller.close();assert.equal(f.driver.status().status,'down');assert.ok(f.driver.latest.every(v=>v===0));
});

test('failed persistent command never changes live state or acknowledges success; retry recovers',async t=>{
  const f=await fixture(t);await f.request('/api/lease/acquire','POST',{},f.token);const before=f.controller.engine.snapshot();
  await rename(join(f.directory,'config.json'),join(f.directory,'preserved.json'));await mkdir(join(f.directory,'config.json'));
  const command={type:'master.set',id:'write-failure',value:.62};
  const result=await f.request('/api/command','POST',command,f.token);assert.equal(result.status,500);assert.equal(f.controller.engine.snapshot().master,before.master);assert.equal(f.controller.engine.snapshot().revision,before.revision);
  await rm(join(f.directory,'config.json'),{recursive:true});await rename(join(f.directory,'preserved.json'),join(f.directory,'config.json'));
  assert.equal((await f.request('/api/command','POST',command,f.token)).value.ok,true);
  const disk=JSON.parse(await readFile(join(f.directory,'config.json'),'utf8'));assert.equal(JSON.parse(disk.payload).configuration.master,.62);
});

test('wizard state and configuration commit atomically; stale saves and changed probe evidence rejected',async t=>{
  let now=0;const f=await fixture(t,{now:()=>now});await f.request('/api/lease/acquire','POST',{},f.token);
  const draft=(await f.request('/api/wizard','GET',undefined,f.token)).value;draft.fixtures=configuration().fixtures;draft.roomName='Integration room';draft.step='review';draft.checkedItems=['commit-reviewed','allow-untested'];
  const saved=(await f.request('/api/wizard','PUT',draft,f.token)).value;
  assert.equal((await f.request('/api/wizard','PUT',draft,f.token)).status,409);
  assert.equal((await f.request('/api/wizard/test','POST',{fixtureId:'left'},f.token)).status,200);
  now=1200;f.controller.tick();assert.ok(f.driver.latest.every(v=>v===0));
  const observation=await f.request('/api/wizard/test','POST',{fixtureId:'left',result:'flashed'},f.token);assert.equal(observation.status,200);
  assert.ok(observation.value.draft.completedTests.includes('left'));
  const edited={...observation.value.draft,fixtures:observation.value.draft.fixtures.map((v:any)=>v.id==='left'?{...v,address:20}:v)};
  await f.request('/api/wizard/test','POST',{fixtureId:'left'},f.token);
  const changed=await f.request('/api/wizard','PUT',edited,f.token);assert.equal(changed.status,200);
  assert.equal((await f.request('/api/wizard/test','POST',{fixtureId:'left',result:'flashed'},f.token)).status,409);
  assert.equal((await f.request('/api/wizard/commit','POST',{revision:saved.revision},f.token)).status,409);
  const committed=await f.request('/api/wizard/commit','POST',{revision:changed.value.revision},f.token);assert.equal(committed.status,200);
  const disk=JSON.parse(JSON.parse(await readFile(join(f.directory,'config.json'),'utf8')).payload);
  assert.equal(disk.draft.step,'done');assert.equal(disk.configuration.roomName,'Integration room');assert.equal(disk.configuration.fixtures[0].address,20);
});

test('corrupt configuration quarantines and starts dark with warning; corrupt auth fails closed',async t=>{
  const f=await fixture(t);await f.controller.close();await writeFile(join(f.directory,'config.json'),'{corrupt');await rm(join(f.directory,'config.json.bak'),{force:true});
  const recovered=await createController({directory:f.directory,advertise:false});t.after(()=>recovered.close());await recovered.listen();
  assert.equal(recovered.engine.snapshot().blackout,true);assert.equal(recovered.engine.snapshot().configuration.fixtures.length,0);
  assert.ok((await readdir(f.directory)).some(file=>file.startsWith('config.json.corrupt-')));
  const login=await fetch(`http://127.0.0.1:${(recovered.server.address() as {port:number}).port}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:'314159'})});
  const recoveredToken=(await login.json()).token;
  const diagnostics=await fetch(`http://127.0.0.1:${(recovered.server.address() as {port:number}).port}/api/diagnostics`,{headers:{authorization:`Bearer ${recoveredToken}`}});
  assert.ok((await diagnostics.json()).warnings.some((warning:string)=>warning.includes('damaged data preserved')));
  await recovered.close();await writeFile(join(f.directory,'auth.json'),'{corrupt');
  await assert.rejects(()=>createController({directory:f.directory,advertise:false}),/authentication is locked/);
  await rm(join(f.directory,'auth.json'));
  await assert.rejects(()=>createController({directory:f.directory,advertise:false}),/authentication is locked/);
});

test('configuration PUT requires current revision; re-patch preserves cues and scenes with pruned-value warning',async t=>{
  const f=await fixture(t);await f.request('/api/lease/acquire','POST',{},f.token);
  const cfg=configuration();cfg.cues=[{id:'cue-1',name:'House cue',sceneId:'house',fadeMs:500}];
  assert.equal((await f.request('/api/config','PUT',cfg,f.token)).status,428);
  const current=await f.request('/api/config','GET',undefined,f.token);const etag=current.headers.get('etag')!;
  const update=await f.request('/api/config','PUT',cfg,f.token,{'if-match':etag});assert.equal(update.status,200);
  assert.equal((await f.request('/api/config','PUT',cfg,f.token,{'if-match':etag})).status,409);
  const draft=(await f.request('/api/wizard','GET',undefined,f.token)).value;
  draft.fixtures=[{...cfg.fixtures[0],address:40}];draft.checkedItems=['commit-reviewed','allow-untested'];draft.step='review';
  const saved=(await f.request('/api/wizard','PUT',draft,f.token)).value;
  assert.equal((await f.request('/api/wizard/commit','POST',{revision:saved.revision},f.token)).status,200);
  const result=(await f.request('/api/config','GET',undefined,f.token)).value;
  assert.equal(result.cues[0].sceneId,'house');assert.equal(result.scenes[0].values.left.red,.85);assert.equal(result.scenes[0].values.right,undefined);
  const diagnostics=(await f.request('/api/diagnostics','GET',undefined,f.token)).value;
  assert.ok(diagnostics.warnings.some((warning:string)=>warning.includes('removed deleted fixture values')));
});

test('wizard commit enforces explicit reviewed and untested acknowledgments; metadata preserves evidence',async t=>{
  const f=await fixture(t);await f.request('/api/lease/acquire','POST',{},f.token);
  let draft=(await f.request('/api/wizard','GET',undefined,f.token)).value;draft.fixtures=[configuration().fixtures[0]];draft.step='review';
  draft=(await f.request('/api/wizard','PUT',draft,f.token)).value;
  assert.equal((await f.request('/api/wizard/commit','POST',{revision:draft.revision},f.token)).value.error.code,'REVIEW_REQUIRED');
  draft.checkedItems=['commit-reviewed'];draft=(await f.request('/api/wizard','PUT',draft,f.token)).value;
  assert.equal((await f.request('/api/wizard/commit','POST',{revision:draft.revision},f.token)).value.error.code,'UNTESTED_FIXTURES');
  await f.request('/api/wizard/test','POST',{fixtureId:'left',color:'red'},f.token);
  assert.ok(f.driver.latest[0]>0);assert.equal(f.driver.latest[1],0);assert.equal(f.driver.latest[2],0);assert.equal(f.driver.latest[3],0);
  draft=(await f.request('/api/wizard/test','POST',{fixtureId:'left',result:'flashed'},f.token)).value.draft;
  draft.fixtures[0].name='Renamed light';draft.fixtures[0].groupIds=['front'];
  draft=(await f.request('/api/wizard','PUT',draft,f.token)).value;
  assert.deepEqual(draft.completedTests,['left']);
  assert.equal((await f.request('/api/wizard/commit','POST',{revision:draft.revision},f.token)).status,200);
});
