import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Bonjour } from 'bonjour-service';
import { z } from 'zod';
import { LightingEngine } from '../../packages/engine/src/index.js';
import { Command, Configuration, PatchedFixture } from '../../packages/protocol/src/index.js';
import { newDraft, canCommit, VirtualRoom, type VirtualLight, type WizardDraft } from '../../packages/engine/src/wizard.js';
import { SimulatorDriver, SacnDriver, type OutputDriver, type DriverConfig } from '../../packages/drivers/src/index.js';
import { Auth, AuthError } from './auth.js';
import { AtomicStore } from './persistence.js';

const LIMIT = 64 * 1024;
const root = fileURLToPath(new URL('../..', import.meta.url));
const steps = ['welcome','pin','room','output','type','mode','address','set-on-light','test','color-check','name-place','groups','presets','music','review','done'] as const;
const DraftSchema = z.object({ id: z.string().min(1).max(128), ownerSessionId: z.string().max(128), step: z.enum(steps), roomName: z.string().trim().min(1).max(40), output: z.object({ kind: z.enum(['simulator','sacn','artnet','usb-dmx']), target: z.string().max(255).optional() }).strict(), fixtures: z.array(PatchedFixture).max(512), completedTests: z.array(z.string().max(128)).max(512), checkedItems: z.array(z.string().max(128)).max(512), warnings: z.array(z.string().max(500)).max(512), revision: z.number().int().positive(), startedAt: z.string().max(64) }).strict();
const StateSchema = z.object({ configuration: Configuration, draft: DraftSchema.nullable(), output: z.object({ kind: z.enum(['simulator', 'sacn']), target: z.string().optional(), cid: z.string().uuid() }).strict() }).strict();
type State = z.infer<typeof StateSchema>;
type Options = { directory?: string; now?: () => number; driver?: OutputDriver; bootstrapToken?: string; sessionMs?: number; leaseMs?: number; tickMs?: number; advertise?: boolean; staticRoot?: string; virtualLights?: VirtualLight[] };
const assets = new Map([['/', ['index.html','text/html']], ['/index.html',['index.html','text/html']], ['/app.js',['app.js','text/javascript']], ['/styles.css',['styles.css','text/css']]]);
function send(res: ServerResponse, status: number, value: unknown, mime = 'application/json') {
  res.writeHead(status, { 'content-type': `${mime}; charset=utf-8`, 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(Buffer.isBuffer(value) ? value : mime === 'application/json' ? JSON.stringify(value) : String(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length']) > LIMIT) throw new AuthError(413, 'TOO_LARGE', 'Body exceeds 64 KiB.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > LIMIT) throw new AuthError(413,'TOO_LARGE','Body exceeds 64 KiB.'); chunks.push(b); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AuthError(400,'VALIDATION','Expected a JSON body.'); }
}
const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];

export async function createController(options: Options = {}) {
  const now = options.now ?? (() => performance.now());
  const auth = new Auth(options.directory ?? resolve(process.env.FLASHIFY_DATA_DIR ?? process.env.DATA_DIR ?? 'data'), now, options.sessionMs, options.leaseMs);
  await auth.init(); if (options.bootstrapToken && auth.setupRequired) auth.bootstrapToken = options.bootstrapToken;
  const engine = new LightingEngine({ clock: { now } });
  const store = new AtomicStore<State>(options.directory ?? resolve(process.env.FLASHIFY_DATA_DIR ?? process.env.DATA_DIR ?? 'data'), 'config.json', v => StateSchema.parse(v), { resetCorrupt: true });
  let state = await store.load(() => ({ configuration: { ...engine.exportConfiguration(), fixtures: [], scenes: [], cues: [], master: 0 }, draft: null, output: { kind:'simulator', cid: randomUUID() } }));
  engine.applyConfiguration(state.configuration);
  const warnings: string[] = store.recovered ? [`Configuration recovered${store.quarantined ? `; damaged data preserved as ${store.quarantined}` : ' from backup'}. Review the patch before output.`] : [];
  // Recovery always starts dark, including when a valid backup was available.
  if (store.recovered) engine.dispatch({ type:'blackout.set', id:randomUUID(), on:true });
  let driver = options.driver ?? (state.output.kind === 'sacn' ? new SacnDriver() : new SimulatorDriver());
  const driverConfig = (output: State['output']): DriverConfig => ({ id: `${output.kind}-1`, kind: output.kind, universe:1, name:'Flashify', cid:output.cid, target: output.target ? {ip:output.target} : {multicast:true} });
  try { await driver.open(driverConfig(state.output)); } catch (error) { warnings.push(`Output unavailable: ${String(error)}`); }
  const virtualRoom = new VirtualRoom(options.virtualLights ?? [{id:'physical-left',actualAddress:1,channelCount:4,powered:true,cabled:true,colorOrder:'rgb'},{id:'physical-right',actualAddress:5,channelCount:4,powered:true,cabled:true,colorOrder:'rgb'}]);
  let frame: Uint8Array = new Uint8Array(512); let closed = false;
  let probe: { sessionId:string; fixtureId:string; expiresAt:number; fingerprint:string; frame:Uint8Array } | undefined;
  let transactions = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> { const pending = transactions.then(operation); transactions = pending.then(() => {}, () => {}); return pending; }
  function snapshot() { const value = engine.snapshot(); value.controller.driver = driver.kind; return value; }
  function tick() { if (closed) return; auth.sweep(); frame = new Uint8Array(engine.tick()); if (probe && probe.expiresAt > now() && auth.role(probe.sessionId) === 'operator' && !engine.snapshot().blackout) { const fixture = state.draft?.fixtures.find(f => f.id === probe!.fixtureId); const mode = state.configuration.profiles.find(p => p.id === fixture?.profileId)?.modes.find(m => m.id === fixture?.modeId); if (fixture && mode) for (let slot = fixture.address - 1; slot < fixture.address - 1 + mode.channelCount; slot++) frame[slot] = probe.frame[slot]; } try { driver.send(1, frame); } catch { if (!warnings.includes('Driver send failed.')) warnings.push('Driver send failed.'); } }
  const sockets = new Map<WebSocket, { token?: string; sessionId?: string; helloTimer: ReturnType<typeof setTimeout> }>();
  const wsSend = (socket: WebSocket, value: unknown) => { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < LIMIT * 4) socket.send(JSON.stringify(value)); else if (socket.bufferedAmount >= LIMIT * 4) socket.close(1013,'Slow consumer'); };
  function broadcast() { for (const [socket, session] of sockets) if (session.token) { try { auth.authenticate(session.token); wsSend(socket, {type:'state',revision:engine.snapshot().revision,snapshot:snapshot()}); } catch { socket.close(1008,'Session expired'); } } }
  const seen = new Map<string, { payload:string; result:unknown }>();
  function remember(key:string,payload:string,result:unknown) { seen.set(key,{payload,result}); if(seen.size>2048)seen.delete(seen.keys().next().value!); }
  async function dispatch(sessionId: string, input: unknown) {
    const command = Command.parse(input); if (command.type !== 'blackout.set') auth.operator(sessionId);
    const key = createHash('sha256').update(`${sessionId}:${command.id}`).digest('hex'); const payload = JSON.stringify(command);
    const cached = seen.get(key); if (cached) { if (cached.payload !== payload) throw new AuthError(409,'ID_REUSED','Command ID was already used for a different command.'); return cached.result; }
    const persistent = ['scene.upsert','scene.save','scene.delete','cue.upsert','cue.delete','master.set'].includes(command.type);
    // Validate persistent commands against a detached engine before touching live playback.
    if (persistent) {
      const candidate = new LightingEngine({clock:{now}, configuration:engine.exportConfiguration()});
      // scene.save captures the actual live values rather than defaults from a detached engine.
      const planned = command.type === 'scene.save' ? {type:'scene.upsert' as const,id:key,scene:{id:command.sceneId,name:command.name,builtin:false,values:engine.snapshot().fixtures,clearOthers:command.clearOthers,revision:(engine.exportConfiguration().scenes.find(s=>s.id===command.sceneId)?.revision ?? 0)+1}} : {...command,id:key};
      const validation = candidate.dispatch(planned);
      if (!validation.ok) { remember(key,payload,validation); return validation; }
      const next = {...state, configuration:candidate.exportConfiguration()};
      await store.save(next); state = next;
      const result = engine.dispatch(planned); remember(key,payload,result); broadcast(); return result;
    }
    const result = engine.dispatch({...command,id:key}); remember(key,payload,result);
    if (seen.size > 2048) seen.delete(seen.keys().next().value!);
    tick(); broadcast(); return result;
  }
  const patchIdentity=(fixture:z.infer<typeof PatchedFixture>|undefined)=>fixture && JSON.stringify([fixture.profileId,fixture.modeId,fixture.universe,fixture.address,fixture.enabled]);
  async function saveDraft(sessionId:string, input:unknown) {
    auth.operator(sessionId);
    const parsed = DraftSchema.parse(input && typeof input === 'object' && 'draft' in input ? input.draft : input);
    if (state.draft && parsed.id !== state.draft.id) throw new AuthError(409,'DRAFT_CONFLICT','Resume the current draft.');
    if (state.draft && parsed.revision !== state.draft.revision) throw new AuthError(409,'REVISION_CONFLICT','Reload the latest draft.');
    const draft = {...parsed, ownerSessionId:sessionId, revision:parsed.revision+1, completedTests:state.draft?.completedTests.filter(id=>patchIdentity(state.draft?.fixtures.find(f=>f.id===id))===patchIdentity(parsed.fixtures.find(f=>f.id===id))) ?? []};
    const next = {...state,draft}; await store.save(next); state=next; probe=undefined; return draft;
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? 'GET';
    if (path === '/api/health' && method === 'GET') return send(res,200,{ok:true,protocolVersion:1,serverVersion:'0.2.0',setupRequired:auth.setupRequired});
    if (path === '/api/auth/setup' || path === '/api/auth/login') {
      if (method !== 'POST') throw new AuthError(405,'METHOD','Use POST.');
      auth.rateLimit(req.socket.remoteAddress ?? 'unknown');
      const input = z.object({pin:z.string().regex(/^\d{6,12}$/),bootstrapToken:z.string().max(128).optional()}).strict().parse(await body(req));
      return send(res,200,path.endsWith('setup') ? await auth.bootstrap(input.pin,input.bootstrapToken ?? '') : await auth.login(input.pin));
    }
    if (path.startsWith('/api/')) {
      const token = bearer(req); const session = auth.authenticate(token);
      if (path === '/api/auth/logout' && method === 'POST') { auth.revoke(token!); probe=undefined; broadcast(); return send(res,200,{ok:true}); }
      if (path === '/api/lease/acquire' && method === 'POST') return send(res,200,auth.acquire(session.id));
      if (path === '/api/lease/heartbeat' && method === 'POST') return send(res,200,auth.heartbeat(session.id));
      if (path === '/api/lease/release' && method === 'POST') {auth.release(session.id); probe=undefined; tick();return send(res,200,{ok:true,role:'viewer'});}
      if (path === '/api/state' && method === 'GET') return send(res,200,snapshot());
      if (path === '/api/config' && method === 'GET') {res.setHeader('etag', `"${engine.snapshot().revision}"`);return send(res,200,engine.exportConfiguration());}
      if (path === '/api/frames' && method === 'GET') return send(res,200,{universe:1,frame:Array.from(frame),virtualLights:virtualRoom.decode(frame)});
      if (path === '/api/diagnostics' && method === 'GET') return send(res,200,{firmware:'Flashify server 0.2.0',tickHz:40,driver:{id:driver.id,kind:driver.kind,...driver.status()},warnings,role:auth.role(session.id),lease:auth.lease,wizard:state.draft && {draftId:state.draft.id,step:state.draft.step}});
      if (path === '/api/command' && method === 'POST') {const input=await body(req); const result=await serial(()=>dispatch(session.id,input));return send(res,(result as {ok:boolean}).ok?200:409,result);}
      if (path === '/api/config' && method === 'PUT') {
        const input=await body(req);
        const wrapped=!!input && typeof input==='object' && 'configuration' in input;
        const config=Configuration.parse(wrapped ? (input as {configuration:unknown}).configuration : input);
        const expected=wrapped ? (input as {revision?:unknown}).revision : req.headers['if-match']?.replaceAll('"','');
        if(expected===undefined)throw new AuthError(428,'REVISION_REQUIRED','Provide configuration revision or If-Match from GET /api/config.');
        return serial(async()=>{auth.operator(session.id);if(Number(expected)!==engine.snapshot().revision)throw new AuthError(409,'REVISION_CONFLICT','Reload the latest configuration.');const next={...state,configuration:config};await store.save(next);state=next;const result=engine.applyConfiguration(config);tick();broadcast();send(res,200,{...result,snapshot:snapshot()});});
      }
      if (path === '/api/patch/validate' && method === 'POST') {const input=await body(req);Configuration.parse(input);return send(res,200,{ok:true});}
      if (path === '/api/wizard' && method === 'GET') {
        if (!state.draft) await serial(async()=>{if (!state.draft) { const next={...state,draft:newDraft(session.id)};await store.save(next);state=next; }});
        return send(res,200,state.draft);
      }
      if (path === '/api/wizard' && method === 'PUT') {const input=await body(req);return send(res,200,await serial(()=>saveDraft(session.id,input)));}
      if (path === '/api/wizard/test' && method === 'POST') {
        const input=z.object({fixtureId:z.string().max(128),result:z.enum(['flashed','nothing','different','multiple']).optional(),color:z.enum(['red','green','blue']).optional()}).strict().parse(await body(req));
        return serial(async()=>{
          auth.operator(session.id); const draft=state.draft;
          if (!draft || draft.ownerSessionId!==session.id) throw new AuthError(403,'DRAFT_OWNER','Save the draft as the current operator first.');
          const fixture=draft.fixtures.find(f=>f.id===input.fixtureId); const mode=state.configuration.profiles.find(p=>p.id===fixture?.profileId)?.modes.find(m=>m.id===fixture?.modeId);
          if (!fixture || !mode) throw new AuthError(400,'PROFILE_INVALID','Choose a valid fixture mode.');
          if (!input.result) {
            if(input.color && !mode.channels.some(c=>c.attribute===input.color))throw new AuthError(400,'UNSUPPORTED','This mode does not have the requested colour channel.');
            const trial=Configuration.parse({...state.configuration,fixtures:[fixture],scenes:[],cues:[]});
            const testEngine=new LightingEngine({clock:{now},configuration:trial});
            const values=Object.fromEntries(mode.channels.filter(c=>['red','green','blue','white','dimmer'].includes(c.attribute)).map(c=>[c.attribute,input.color && c.attribute!==input.color && c.attribute!=='dimmer'?0:.15]));
            testEngine.dispatch({type:'fixture.set',id:randomUUID(),fixtureId:fixture.id,values,fadeMs:0,takeover:true});
            testEngine.dispatch({type:'master.set',id:randomUUID(),value:1});
            probe={sessionId:session.id,fixtureId:fixture.id,expiresAt:now()+1000,fingerprint:JSON.stringify(fixture),frame:testEngine.tick()};tick();
            return send(res,200,{ok:true,fixtureId:fixture.id,expiresAt:probe.expiresAt,requiresObservation:true});
          }
          if (!probe || probe.fixtureId!==fixture.id || probe.sessionId!==session.id || probe.fingerprint!==JSON.stringify(fixture) || now()>probe.expiresAt+30000) throw new AuthError(409,'PROBE_REQUIRED','Run a light test before recording the observation.');
          const completedTests=draft.completedTests.filter(id=>id!==fixture.id);if(input.result==='flashed')completedTests.push(fixture.id);
          const next={...state,draft:{...draft,completedTests,revision:draft.revision+1}};await store.save(next);state=next;probe=undefined;tick();return send(res,200,{ok:true,result:input.result,draft:state.draft});
        });
      }
      if (path === '/api/wizard/commit' && method === 'POST') {
        const input=z.object({revision:z.number().int().positive()}).strict().parse(await body(req));
        return serial(async()=>{
          auth.operator(session.id); const draft=state.draft;
          if (!draft || draft.ownerSessionId!==session.id) throw new AuthError(403,'DRAFT_OWNER','Save the draft as the current operator first.');
          if(input.revision!==draft.revision)throw new AuthError(409,'REVISION_CONFLICT','Reload the latest draft.');
          if(!draft.checkedItems.includes('commit-reviewed'))throw new AuthError(400,'REVIEW_REQUIRED','Confirm that you reviewed the patch before committing.');
          const untested=draft.fixtures.filter(f=>f.enabled&&!draft.completedTests.includes(f.id));
          if(untested.length&&!draft.checkedItems.includes('allow-untested'))throw new AuthError(400,'UNTESTED_FIXTURES','Test every enabled light or explicitly acknowledge untested fixtures.');
          const check=canCommit(draft,state.configuration.profiles);if(!check.ok)throw new AuthError(400,'VALIDATION',check.errors.join(' '));
          if(!['simulator','sacn'].includes(draft.output.kind))throw new AuthError(400,'UNSUPPORTED','Only simulator and sACN output are implemented.');
          // Retain scenes/cues when addresses or names change; prune only deleted fixtures and unsupported attributes.
          const scenes=state.configuration.scenes.map(scene=>({...scene,values:Object.fromEntries(Object.entries(scene.values).flatMap(([id,attrs])=>{
            const fixture=draft.fixtures.find(f=>f.id===id);const mode=state.configuration.profiles.find(p=>p.id===fixture?.profileId)?.modes.find(m=>m.id===fixture?.modeId);
            if(!fixture||!mode)return [];
            const values=Object.fromEntries(Object.entries(attrs).filter(([attr])=>mode.channels.some(c=>c.attribute===attr)||(attr==='dimmer'&&mode.channels.some(c=>['red','green','blue','white','amber','uv'].includes(c.attribute)))));
            return [[id,values]];
          }))}));
          const changedScenes=JSON.stringify(scenes)!==JSON.stringify(state.configuration.scenes);
          const configuration=Configuration.parse({...state.configuration,roomName:draft.roomName,fixtures:draft.fixtures,scenes,cues:state.configuration.cues});
          const output:State['output']={kind:draft.output.kind as 'simulator'|'sacn',target:draft.output.target,cid:state.output.cid};
          const next={configuration,draft:{...draft,step:'done' as const,revision:draft.revision+1},output};
          const replacement=options.driver ?? (output.kind==='sacn'?new SacnDriver():new SimulatorDriver());
          if(replacement!==driver)await replacement.open(driverConfig(output));
          try {await store.save(next);}catch(error){if(replacement!==driver)await replacement.close();throw error;}
          state=next;engine.applyConfiguration(configuration);probe=undefined;if(untested.length)warnings.push(`${untested.length} fixture(s) committed without a passed light test; physical output is unverified.`);if(changedScenes)warnings.push('Re-patch removed deleted fixture values or unsupported attributes from saved scenes; review your shows.');
          if(replacement!==driver){const previous=driver;driver=replacement;await previous.close().catch(()=>warnings.push('Previous output failed to close.'));}
          tick();broadcast();return send(res,200,{ok:true,revision:engine.snapshot().revision,snapshot:snapshot(),draft:state.draft});
        });
      }
      throw new AuthError(404,'NOT_FOUND','Unknown API route.');
    }
    if(method!=='GET' && method!=='HEAD')throw new AuthError(405,'METHOD','Use GET.');
    // Exact paths only: never turn request paths into filesystem paths.
    const asset=assets.get(path);if(!asset)throw new AuthError(404,'NOT_FOUND','Not found.');
    try {const content=await readFile(join(options.staticRoot ?? root,...[asset[0]]));send(res,200,method==='HEAD'?Buffer.alloc(0):content,asset[1]);}catch{throw new AuthError(404,'NOT_FOUND','Not found.');}
  }
  const server=createServer((req,res)=>{void route(req,res).catch(error=>{if(res.headersSent)return res.end();const status=error instanceof AuthError?error.status:error instanceof z.ZodError?400:500;send(res,status,{error:{code:error instanceof AuthError?error.code:status===400?'VALIDATION':'PERSISTENCE_OR_SERVER_ERROR',message:status===500?'Operation failed; no success was acknowledged.':String(error.message)}});});});
  server.requestTimeout=10000;server.headersTimeout=10000;
  const wss=new WebSocketServer({noServer:true,maxPayload:LIMIT});
  server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'){socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
  wss.on('connection',socket=>{
    const connection:{token?:string;sessionId?:string;helloTimer:ReturnType<typeof setTimeout>}={helloTimer:setTimeout(()=>socket.close(1008,'Send authenticated hello'),5000)};sockets.set(socket,connection);
    socket.on('error',()=>{});
    socket.on('close',()=>{clearTimeout(connection.helloTimer);sockets.delete(socket);if(probe?.sessionId===connection.sessionId)probe=undefined;});
    socket.on('message',raw=>{void serial(async()=>{
      let id:unknown;
      try {
        const message=JSON.parse(String(raw));id=typeof message?.id==='string'?message.id:undefined;
        if(!connection.token){const hello=z.object({type:z.literal('hello'),token:z.string().max(128),protocolVersion:z.literal(1)}).strict().parse(message);const session=auth.authenticate(hello.token);connection.token=hello.token;connection.sessionId=session.id;clearTimeout(connection.helloTimer);wsSend(socket,{type:'welcome',serverVersion:'0.2.0',protocolVersion:1,role:auth.role(session.id),sessionId:session.id});wsSend(socket,{type:'state',revision:engine.snapshot().revision,snapshot:snapshot()});return;}
        const session=auth.authenticate(connection.token);
        if(message.type==='ping'){wsSend(socket,{type:'pong',id,serverTime:now()});return;}
        if(message.type==='heartbeat'){wsSend(socket,{type:'ack',id,ok:true,...auth.heartbeat(session.id)});return;}
        const result=await dispatch(session.id,message);wsSend(socket,{type:'ack',id,...(result as object)});
      } catch(error) { wsSend(socket,{type:!connection.token?'error':'ack',id,ok:false,error:{code:error instanceof AuthError?error.code:error instanceof z.ZodError?'VALIDATION':'SERVER_ERROR',message:error instanceof AuthError?error.message:'Message failed.'}});if(!connection.token)socket.close(1008,'Authentication required'); }
    });});
  });
  const interval=setInterval(()=>{tick();broadcast();},options.tickMs ?? 25);interval.unref();
  let bonjour:Bonjour|undefined;
  async function listen(port=0,host='127.0.0.1'){
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});});
    const address=server.address();if(!address || typeof address==='string')throw new Error('No listening address');
    if(options.advertise!==false && host!=='127.0.0.1' && host!=='localhost' && host!=='::1') {try{bonjour=new Bonjour({},(error: Error)=>warnings.push(`Discovery unavailable: ${error.message}`));bonjour.publish({name:`Flashify ${state.configuration.roomName}`,type:'flashify',port:address.port,txt:{protocol:'1',path:'/ws'}});}catch(error){warnings.push(`Discovery unavailable: ${String(error)}`);}}
    return address;
  }
  async function close(){if(closed)return;closed=true;clearInterval(interval);for(const [socket,connection]of sockets){clearTimeout(connection.helloTimer);socket.terminate();}await transactions;engine.dispatch({type:'blackout.set',id:randomUUID(),on:true});try{driver.send(1,engine.tick());}catch{}await driver.close();if(bonjour){await new Promise<void>(resolve=>bonjour!.unpublishAll(()=>{bonjour!.destroy();resolve();}));}await new Promise<void>(resolve=>wss.close(()=>resolve()));if(server.listening)await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
  return {server,wss,engine,auth,get driver(){return driver;},tick,listen,close};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const controller=await createController();
  const address=await controller.listen(Number(process.env.PORT ?? 4173),process.env.HOST ?? '127.0.0.1');
  console.log(`Flashify server listening on http://${process.env.HOST ?? '127.0.0.1'}:${address.port}`);
  if(controller.auth.setupRequired)console.log(`Flashify setup token: ${controller.auth.bootstrapToken}`);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void controller.close().then(()=>process.exit(0));});
}
