const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { view: 'wizard', snapshot: null, draft: null, diagnostics: null, token: sessionStorage.getItem('flashify-token'), sessionId: null, operator: false, fresh: false, busy: false, setupRequired: false, selected: new Set(), socket: null, generation: 0, lastState: 0, pending: new Map() };
const steps = ['welcome','pin','room','output','type','mode','address','set-on-light','test','color-check','name-place','groups','presets','music','review','done'];
let retryTimer;
let autosaveTimer;
let editVersion = 0;
let savedEditVersion = 0;
function notice(message = '') { $('#notice').textContent = message; $('#notice').hidden = !message; }
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('is-visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('is-visible'), 3500); }
function errorText(data) { return data?.error?.message ?? data?.message ?? 'The controller rejected this request.'; }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(state.token ? {Authorization:`Bearer ${state.token}`} : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000), keepalive: path === '/api/wizard' && method === 'PUT' });
  const data = await response.json();
  if (!response.ok || data.ok === false) { if (response.status === 401 && !path.startsWith('/api/auth/')) signOut(); throw new Error(errorText(data)); }
  return data;
}
async function action(work) { if (state.busy) return; state.busy = true; notice(); controls(); try { await work(); } catch (error) { notice(error.message); } finally { state.busy = false; controls(); } }
function controls() {
  const enabled = state.operator && state.fresh && !state.busy;
  $$('[data-control]').forEach(el => el.disabled = !enabled);
  $('#blackout-button').disabled = !state.token || !state.fresh || !!state.blackoutPending;
  $('#wizard-back').disabled = !enabled || !state.draft || steps.indexOf(state.draft.step) === 0;
  $('#take-control').hidden = !state.token || state.operator;
  $('#take-control').disabled = !state.fresh || state.busy;
  $('#release-control').hidden = !state.operator;
  $('#logout').hidden = !state.token;
  $('#lease-status').textContent = !state.token ? 'Signed out' : !state.fresh ? 'Reconnecting · controls unavailable' : state.operator ? 'Operator control' : 'Viewer · take control to edit';
  $('#stale-banner').hidden = state.fresh;
  $('#connection-status').textContent = state.fresh ? 'Connected to controller' : 'Not connected';
  $('#connection-dot').classList.toggle('is-connected', state.fresh);
}
function paintView() { const name = state.view; $$('.nav-item').forEach(el => { const selected = el.dataset.view === name; el.classList.toggle('is-active',selected); if (selected) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); }); $$('.view').forEach(el => el.classList.toggle('is-visible',el.id === `${name}-view`)); $('#page-title').textContent = name === 'wizard' ? 'Setup' : name[0].toUpperCase()+name.slice(1); }
function view(name) { state.view = name; paintView(); if (name === 'diagnostics' && state.token) action(refreshDiagnostics); }
$$('.nav-item').forEach(el => el.onclick = () => view(el.dataset.view));
function invalidate() { state.fresh = false; state.operator = false; for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Connection lost. The result is unknown; reconnect before retrying.')); } state.pending.clear(); controls(); }
function signOut() { state.generation++; clearTimeout(retryTimer); state.socket?.close(); state.token = null; sessionStorage.removeItem('flashify-token'); state.snapshot = null; state.draft = null; state.sessionId = null; invalidate(); $('#workspace').hidden = true; $('#auth-panel').hidden = false; $('#pin').value = ''; $('#bootstrap-token').value = ''; checkHealth().catch(error => notice(error.message)); }
async function checkHealth() { const health = await api('/api/health'); state.setupRequired = health.setupRequired; $('#bootstrap-label').hidden = !health.setupRequired; $('#bootstrap-token').required = !!health.setupRequired; $('#auth-copy').textContent = health.setupRequired ? 'Create a controller PIN using the setup token printed by the local server.' : 'Sign in with your controller PIN.'; $('#login-button').textContent = health.setupRequired ? 'Set up controller' : 'Sign in'; $('#login-button').disabled = false; }
$('#auth-form').onsubmit = event => { event.preventDefault(); action(async () => { const result = await api(state.setupRequired ? '/api/auth/setup' : '/api/auth/login', 'POST', {pin:$('#pin').value, ...(state.setupRequired ? {bootstrapToken:$('#bootstrap-token').value} : {})}); state.token = result.token; state.sessionId = result.sessionId; sessionStorage.setItem('flashify-token', result.token); $('#pin').value = ''; $('#bootstrap-token').value = ''; await connect(); }); };
$('#logout').onclick = () => action(async () => { await api('/api/auth/logout', 'POST', {}); signOut(); });
$('#take-control').onclick = () => action(async () => { await api('/api/lease/acquire', 'POST', {}); state.operator = true; await loadDraft(); });
$('#release-control').onclick = () => action(async () => { await api('/api/lease/release', 'POST', {}); state.operator = false; });
async function connect() {
  const generation = ++state.generation;
  const snapshot = await api('/api/state'); applySnapshot(snapshot);
  $('#workspace').hidden = false; $('#auth-panel').hidden = true;
  await loadDraft(); view(state.view);
  state.socket?.close();
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); state.socket = socket;
  socket.onopen = () => socket.send(JSON.stringify({type:'hello', token:state.token, protocolVersion:1}));
  socket.onmessage = event => { if (generation !== state.generation) return; try { const message = JSON.parse(event.data); if (message.type === 'welcome') { state.sessionId = message.sessionId; state.operator = message.role === 'operator'; controls(); } if (message.type === 'state') applySnapshot(message.snapshot); if (message.type === 'ack') { const pending = state.pending.get(message.id); if (pending) { clearTimeout(pending.timer); state.pending.delete(message.id); message.ok ? pending.resolve(message) : pending.reject(new Error(errorText(message))); } } } catch (error) { notice(`Invalid controller message: ${error.message}`); } };
  socket.onclose = () => { if (generation !== state.generation) return; invalidate(); scheduleReconnect(); };
  socket.onerror = () => socket.close();
}
function scheduleReconnect() { clearTimeout(retryTimer); if (state.token) retryTimer = setTimeout(() => connect().catch(error => { invalidate(); notice(error.message); scheduleReconnect(); }),1500); }
function command(type, payload = {}) {
  if ((!state.operator && type !== 'blackout.set') || !state.fresh || state.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Take operator control with a live connection first.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { state.pending.delete(id); reject(new Error('No acknowledgement received. Result unknown; refresh before retrying.')); }, 7000); state.pending.set(id, {resolve,reject,timer}); state.socket.send(JSON.stringify({type,id,...payload})); });
}
setInterval(async () => { if (!state.token) return; if (state.operator) { try { await api('/api/lease/heartbeat', 'POST', {}); } catch (error) { state.operator = false; notice(error.message); controls(); } } }, 4000);
setInterval(() => { if (state.fresh && Date.now() - state.lastState >= 1800) { state.fresh = false; controls(); } },100);
function applySnapshot(snapshot) { if (!snapshot?.configuration || !Number.isInteger(snapshot.revision)) throw new Error('Controller snapshot is missing its authoritative configuration.'); if (state.snapshot && snapshot.revision < state.snapshot.revision) return; state.snapshot = snapshot; state.fresh = true; state.lastState = Date.now(); render(); }
function render() {
  const s = state.snapshot, config = s.configuration; paintView();
  $('#room-name').textContent = config.roomName; $('#output-label').textContent = `${s.controller.driver} output`; $('#revision-label').textContent = `Controller revision ${s.revision}`;
  $('#master-value').textContent = `${Math.round(s.master * 100)}%`; if (document.activeElement !== $('#master-range')) $('#master-range').value = Math.round(s.master * 100);
  $('#blackout-button').textContent = s.blackout ? 'Release blackout' : 'Activate blackout'; $('#blackout-button').classList.toggle('is-on', s.blackout);
  const signature = JSON.stringify([config,s.activeSceneId]);
  if (signature !== render.signature) { render.signature = signature; renderConfiguration(config); }
  $('#show-status').textContent = `${s.mode} · ${s.show.phase}`; $('#current-cue-name').textContent = config.cues.find(c => c.id === s.show.currentCueId)?.name ?? 'No active cue';
  $$('#cue-list [data-cue-id]').forEach(el => el.classList.toggle('is-current', el.dataset.cueId === s.show.currentCueId));
  $('#config-json').textContent = JSON.stringify(config,null,2); controls();
}
function renderConfiguration(config) {
  $('#scene-grid').innerHTML = config.scenes.length ? config.scenes.map(scene => `<div><button class="scene-card ${scene.id === state.snapshot.activeSceneId ? 'is-active' : ''}" data-control data-scene="${escape(scene.id)}"><strong>${escape(scene.name)}</strong><small>Revision ${scene.revision}</small></button><button data-control data-delete-scene="${escape(scene.id)}">Delete ${escape(scene.name)}</button></div>`).join('') : '<p>No saved scenes. Save a look after setup.</p>';
  $$('[data-scene]').forEach(el => el.onclick = () => action(async () => { await command('scene.activate',{sceneId:el.dataset.scene,fadeMs:fadeMs()}); toast('Scene activation acknowledged.'); }));
  $$('[data-delete-scene]').forEach(el => el.onclick = () => action(async () => { const scene = state.snapshot.configuration.scenes.find(scene => scene.id === el.dataset.deleteScene); if (!window.confirm(`Delete scene “${scene?.name ?? ''}”? This removes the saved look from the controller.`)) return; await command('scene.delete',{sceneId:el.dataset.deleteScene}); toast('Scene deletion acknowledged.'); }));
  const groups = [...new Set(config.fixtures.flatMap(f => f.groupIds))];
  $('#groups-list').innerHTML = groups.map(id => `<form class="group-row" data-group="${escape(id)}"><strong>${escape(id)}</strong><label>Level %<input type="number" min="0" max="100" required value="100"></label><button data-control>Apply supported intensity</button></form>`).join('') || '<p>No configured groups.</p>';
  $$('[data-group]').forEach(form => form.onsubmit = event => { event.preventDefault(); action(async () => { await command('group.set',{groupId:form.dataset.group,values:{dimmer:Number(form.querySelector('input').value)/100},fadeMs:fadeMs()}); toast('Group update acknowledged.'); }); });
  $('#design-fixtures').innerHTML = config.fixtures.map(f => `<label class="fixture-pick"><input type="checkbox" data-fixture="${escape(f.id)}" ${state.selected.has(f.id) ? 'checked' : ''}>${escape(f.name)} · U${f.universe} / ${f.address}${f.enabled ? '' : ' (disabled)'}</label>`).join('') || '<p>Add lights in Setup.</p>';
  $$('[data-fixture]').forEach(el => el.onchange = () => { el.checked ? state.selected.add(el.dataset.fixture) : state.selected.delete(el.dataset.fixture); renderAttributes(); }); renderAttributes();
  $('#cue-list').innerHTML = config.cues.map(c => `<li class="cue-row" data-cue-id="${escape(c.id)}"><strong>${escape(c.name)}</strong><span>${escape(config.scenes.find(s => s.id === c.sceneId)?.name)} · ${c.fadeMs/1000}s</span><button data-control data-edit-cue="${escape(c.id)}">Edit</button><button data-control data-delete-cue="${escape(c.id)}">Delete</button></li>`).join('') || '<li>No cues saved.</li>';
  $$('[data-delete-cue]').forEach(el => el.onclick = () => action(() => command('cue.delete',{cueId:el.dataset.deleteCue})));
  $$('[data-edit-cue]').forEach(el => el.onclick = () => editCue(config.cues.find(c => c.id === el.dataset.editCue)));
}
function renderAttributes() {
  const config = state.snapshot.configuration;
  const fixtures = config.fixtures.filter(f => state.selected.has(f.id) && f.enabled);
  $('#selection-summary').textContent = `${fixtures.length} enabled fixtures selected`;
  const attributes = fixtures.map(f => config.profiles.find(p => p.id === f.profileId)?.modes.find(m => m.id === f.modeId)?.channels.map(c => c.attribute) ?? []).reduce((common,attrs) => common === null ? attrs : common.filter(a => attrs.includes(a)),null) ?? [];
  $('#attribute-controls').innerHTML = attributes.map(attr => `<label>${escape(attr)} %<input data-attribute="${escape(attr)}" type="number" min="0" max="100" step="0.1" required value="0"></label>`).join('') || '<p>Select fixtures with shared supported attributes.</p>';
}
function fadeMs() { const value = Number($('#fade-seconds').value); if (!Number.isFinite(value) || value < 0 || value > 600) throw new Error('Fade must be between 0 and 600 seconds.'); return Math.round(value*1000); }
$('#master-range').onchange = () => action(async () => { const value = Number($('#master-range').value)/100; $('#master-range').value = Math.round(state.snapshot.master*100); await command('master.set',{value}); });
$('#blackout-button').onclick = async () => { if (!state.token || !state.fresh || state.blackoutPending) return; state.blackoutPending = true; controls(); try { await command('blackout.set',{on:!state.snapshot.blackout}); } catch(error) { notice(error.message); } finally { state.blackoutPending = false; controls(); } };
$('#design-form').onsubmit = event => { event.preventDefault(); action(async () => { const inputs = $$('[data-attribute]'); if (!state.selected.size || !inputs.length) throw new Error('Select fixtures with supported attributes.'); const values = Object.fromEntries(inputs.map(el => [el.dataset.attribute,Number(el.value)/100])); for (const fixtureId of state.selected) await command('fixture.set',{fixtureId,values,fadeMs:fadeMs()}); toast('Fixture updates acknowledged.'); }); };
for (const [id,type] of [['go-button','show.go'],['back-button','show.back'],['stop-button','show.stop']]) $(`#${id}`).onclick = () => action(() => command(type));
function dialog(title, fields, submit) { $('#edit-title').textContent = title; $('#edit-fields').innerHTML = fields; $('#edit-error').textContent = ''; $('#edit-dialog').showModal(); $('#edit-form').onsubmit = event => { event.preventDefault(); action(async () => { try { await submit(new FormData($('#edit-form'))); $('#edit-dialog').close(); } catch(error) { $('#edit-error').textContent = error.message; throw error; } }); }; }
$('#edit-cancel').onclick = () => $('#edit-dialog').close();
function saveScene() { dialog('Save current look','<label>Scene name<input name="name" required maxlength="80"></label>',async data => { await command('scene.save',{sceneId:crypto.randomUUID(),name:data.get('name'),clearOthers:true}); toast('Scene save acknowledged.'); }); }
$('#new-scene').onclick = saveScene; $('#save-as-scene').onclick = saveScene;
function editCue(cue) { dialog(cue ? 'Edit cue' : 'Add cue',`<label>Cue name<input name="name" value="${escape(cue?.name)}" required maxlength="80"></label><label>Scene<select name="sceneId">${state.snapshot.configuration.scenes.map(s => `<option value="${escape(s.id)}" ${s.id === cue?.sceneId ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}</select></label><label>Fade seconds<input type="number" name="fade" min="0" max="600" step="0.1" required value="${(cue?.fadeMs ?? 3000)/1000}"></label>`,async data => { await command('cue.upsert',{cue:{id:cue?.id ?? crypto.randomUUID(),name:data.get('name'),sceneId:data.get('sceneId'),fadeMs:Math.round(Number(data.get('fade'))*1000)}}); }); }
$('#add-cue').onclick = () => editCue();
$('#export-button').onclick = () => { if (!state.snapshot) return; const url = URL.createObjectURL(new Blob([JSON.stringify(state.snapshot.configuration,null,2)],{type:'application/json'})); const link = document.createElement('a'); link.href = url; link.download = 'flashify-configuration.json'; link.click(); URL.revokeObjectURL(url); };
async function refreshDiagnostics() { state.diagnostics = await api('/api/diagnostics'); $('#diagnostics-json').textContent = JSON.stringify(state.diagnostics,null,2); $('#diagnostic-summary').textContent = `Controller report received at ${new Date().toLocaleTimeString()}. Hardware status is limited to driver-reported evidence.`; }
$('#refresh-diagnostics').onclick = () => action(refreshDiagnostics);
async function loadDraft() { state.draft = await api('/api/wizard'); renderWizard(); }
$('#reload-draft').onclick = () => action(loadDraft);
function field(label, id, value, extra = '') { return `<label>${escape(label)}<input id="${id}" value="${escape(value)}" ${extra}></label>`; }
function check(id,label) { return `<label class="check"><input type="checkbox" data-check="${escape(id)}" ${(state.draft.checkedItems ?? []).includes(id) ? 'checked' : ''}>${escape(label)}</label>`; }
function renderWizard() {
  const draft = state.draft; if (!draft) return;
  const fixtures = draft.fixtures, profiles = state.snapshot.configuration.profiles;
  $('#draft-status').textContent = `Saved draft ${draft.id} · revision ${draft.revision} · ${draft.step}`;
  $('#wizard-steps').innerHTML = steps.map(step => `<span class="step-tab ${step === draft.step ? 'is-current' : ''}" ${step === draft.step ? 'aria-current="step"' : ''}>${escape(step.replaceAll('-',' '))}</span>`).join('');
  let content = `<h2>${escape(draft.step.replaceAll('-',' '))}</h2>`;
  const fixtureRows = (kind) => fixtures.map(f => { const profile = profiles.find(p => p.id === f.profileId); return `<fieldset data-draft-fixture="${escape(f.id)}"><legend>${escape(f.name)}</legend>${kind === 'mode' ? `<label>Mode<select data-fixture-field="modeId">${(profile?.modes ?? []).map(m => `<option value="${escape(m.id)}" ${m.id === f.modeId ? 'selected' : ''}>${escape(m.name)} · ${m.channelCount} channels</option>`).join('')}</select></label>` : kind === 'address' ? `<label>Start address<input data-fixture-field="address" type="number" min="1" max="512" value="${f.address}" required></label><p>Universe 1 · ${escape(profile?.model)}</p>` : kind === 'name-place' ? `<label>Light name<input data-fixture-field="name" value="${escape(f.name)}" maxlength="32" required></label>` : `<label>Group IDs, comma separated<input data-fixture-field="groupIds" value="${escape(f.groupIds.join(', '))}"></label>`}</fieldset>`; }).join('') || '<p>No lights in this draft. Go back to Type to add one.</p>';
  switch(draft.step) {
    case 'welcome': content += '<p>Resume this saved room setup. Changes affect live output only after an acknowledged commit. Take operator control to save or continue.</p>'; break;
    case 'pin': content += '<p>Your PIN was configured during secure sign-in. PINs and setup tokens are never saved in room drafts.</p>'; break;
    case 'room': content += field('Room name','wizard-room',draft.roomName,'required maxlength="40"'); break;
    case 'output': content += `<label>Output driver<select id="wizard-output">${['simulator','sacn'].map(kind => `<option ${draft.output.kind === kind ? 'selected' : ''}>${kind}</option>`).join('')}</select></label>${field('Output target (if applicable)','wizard-target',draft.output.target ?? '')}<p>Only drivers available on the controller can be committed. Simulator output does not verify physical lights.</p>`; break;
    case 'type': content += `<label>Fixture profile<select id="wizard-profile">${profiles.map(p => `<option value="${escape(p.id)}">${escape(p.manufacturer)} · ${escape(p.model)}</option>`).join('')}</select></label><button id="wizard-add" data-control>Add light to draft</button><ul>${fixtures.map(f => `<li>${escape(f.name)} · ${escape(profiles.find(p => p.id === f.profileId)?.model)} <button data-remove-fixture="${escape(f.id)}" data-control>Remove</button></li>`).join('')}</ul>`; break;
    case 'mode': case 'address': case 'name-place': case 'groups': content += fixtureRows(draft.step); break;
    case 'set-on-light': content += '<p>Set each physical light to the exact mode and start address below. Check power and cabling before probing.</p>' + fixtures.map(f => check(`set:${f.id}`,`${f.name}: U1 address ${f.address}, mode ${f.modeId}`)).join(''); break;
    case 'test': content += '<p>Run a bounded test, then report what you observed. An acknowledged probe alone does not prove a physical light responded.</p>' + fixtures.map(f => `<fieldset><legend>${escape(f.name)}</legend><button data-test-fixture="${escape(f.id)}" data-control>Test ${escape(f.name)}</button><label>Observed result<select data-test-result="${escape(f.id)}"><option value="flashed">Expected light flashed</option><option value="nothing">Nothing happened</option><option value="different">Different light / wrong mode</option><option value="multiple">Multiple lights responded</option></select></label><button data-observe-fixture="${escape(f.id)}" data-control>Record observation</button><p>${draft.completedTests.includes(f.id) ? 'Passed test recorded by controller' : 'No passed test recorded'}</p></fieldset>`).join(''); break;
    case 'color-check': content += '<p>Preview each supported color and observe the actual light. If colors differ, correct the profile and repeat the test. Simulator output does not verify physical hardware.</p>' + fixtures.map(f => { const mode = profiles.find(p => p.id === f.profileId)?.modes.find(m => m.id === f.modeId); const colors = ['red','green','blue'].filter(color => mode?.channels.some(channel => channel.attribute === color)); return `<fieldset><legend>${escape(f.name)}</legend>${colors.map(color => `<button data-color-fixture="${escape(f.id)}" data-color="${color}" data-control>Preview ${color} on ${escape(f.name)}</button>`).join('')}${check(`color:${f.id}`, colors.length ? `${f.name}: observed colors match the selected profile` : `${f.name}: reviewed the non-RGB mode`)}</fieldset>`; }).join(''); break;
    case 'presets': content += '<p>Saved presets are stored in the controller configuration. After committing, use Looks → Save current values as scene to add presets from actual fixture values.</p>' + check('presets-reviewed','I reviewed how scenes will be saved'); break;
    case 'music': content += '<p>Music requires an explicit audio source; no browser microphone or simulated audio is started during setup.</p>' + check('music-reviewed','Keep music off until an audio source is configured'); break;
    case 'review': content += '<p>Review the saved patch and test evidence before applying this configuration.</p><pre>' + escape(JSON.stringify({roomName:draft.roomName,output:draft.output,fixtures:draft.fixtures,completedTests:draft.completedTests,warnings:draft.warnings},null,2)) + '</pre>' + check('commit-reviewed','I reviewed this configuration and want to apply it') + (draft.fixtures.some(f => f.enabled && !draft.completedTests.includes(f.id)) ? check('allow-untested','I understand some lights have not passed a test; apply this configuration with untested lights') : '') + '<button id="wizard-commit" class="primary-button" data-control>Commit room configuration</button>'; break;
    case 'done': content += '<p>Room setup is committed. The live workspace uses the controller configuration.</p><button id="wizard-open-looks">Open Looks</button>'; break;
  }
  $('#wizard-content').innerHTML = content;
  $('#wizard-back').disabled = state.busy || !state.operator || !state.fresh || steps.indexOf(draft.step) === 0;
  $('#wizard-next').hidden = ['review','done'].includes(draft.step); $('#wizard-save').hidden = draft.step === 'done';
  $('#wizard-add')?.addEventListener('click',() => action(async () => { const profile = profiles.find(p => p.id === $('#wizard-profile').value); if (!profile) throw new Error('Select an available controller profile.'); const mode = profile.modes[0]; const occupied = new Set(fixtures.filter(f => f.enabled).flatMap(f => { const m = profiles.find(p => p.id === f.profileId)?.modes.find(m => m.id === f.modeId); return Array.from({length:m?.channelCount ?? 0},(_,i) => f.address+i); })); let address = 1; while (address+mode.channelCount-1 <= 512 && Array.from({length:mode.channelCount},(_,i) => address+i).some(a => occupied.has(a))) address++; if (address+mode.channelCount-1 > 512) throw new Error('No free address range for this light.'); await persistDraft({...draft,fixtures:[...fixtures,{id:crypto.randomUUID(),name:`Light ${fixtures.length+1}`,profileId:profile.id,modeId:mode.id,universe:1,address,groupIds:[],enabled:true}]}); }));
  $$('[data-remove-fixture]').forEach(el => el.onclick = () => action(() => persistDraft({...draft,fixtures:fixtures.filter(f => f.id !== el.dataset.removeFixture)})));
  $$('[data-test-fixture]').forEach(el => el.onclick = () => action(async () => { const result = await api('/api/wizard/test','POST',{fixtureId:el.dataset.testFixture}); if (result.draft) state.draft = result.draft; toast('Controller acknowledged the bounded probe. Record your observation.'); renderWizard(); }));
  $$('[data-observe-fixture]').forEach(el => el.onclick = () => action(async () => { const fixtureId = el.dataset.observeFixture; const result = await api('/api/wizard/test','POST',{fixtureId,result:$$('[data-test-result]').find(el => el.dataset.testResult === fixtureId).value}); state.draft = result.draft ?? await api('/api/wizard'); renderWizard(); }));
  $('#wizard-commit')?.addEventListener('click',() => action(async () => { const draft = collectDraft(); if (!draft.checkedItems.includes('commit-reviewed')) throw new Error('Review and confirm the configuration first.'); if (draft.fixtures.some(f => f.enabled && !draft.completedTests.includes(f.id)) && !draft.checkedItems.includes('allow-untested')) throw new Error('Test all enabled lights or explicitly accept the untested-light warning.'); await persistDraft(draft); const result = await api('/api/wizard/commit','POST',{revision:state.draft.revision}); state.draft = result.draft ?? await api('/api/wizard'); if (result.snapshot) applySnapshot(result.snapshot); else applySnapshot(await api('/api/state')); renderWizard(); toast('Configuration commit acknowledged.'); }));
  $$('[data-color-fixture]').forEach(el => el.onclick = () => action(async () => { await api('/api/wizard/test','POST',{fixtureId:el.dataset.colorFixture,color:el.dataset.color}); toast(`${el.dataset.color} probe acknowledged. Observe the actual light before confirming.`); }));
  $('#wizard-open-looks')?.addEventListener('click',() => view('looks')); controls();
}
function collectDraft() {
  const draft = structuredClone(state.draft);
  if ($('#wizard-room')) draft.roomName = $('#wizard-room').value.trim();
  if ($('#wizard-output')) { draft.output = {kind:$('#wizard-output').value,...($('#wizard-target').value.trim() ? {target:$('#wizard-target').value.trim()} : {})}; }
  $$('[data-draft-fixture]').forEach(row => { const fixture = draft.fixtures.find(f => f.id === row.dataset.draftFixture); row.querySelectorAll('[data-fixture-field]').forEach(input => { const key = input.dataset.fixtureField; fixture[key] = key === 'address' ? Number(input.value) : key === 'groupIds' ? [...new Set(input.value.split(',').map(s => s.trim()).filter(Boolean))] : input.value.trim(); }); });
  $$('[data-check]').forEach(el => { draft.checkedItems = draft.checkedItems.filter(id => id !== el.dataset.check); if (el.checked) draft.checkedItems.push(el.dataset.check); }); return draft;
}
async function persistDraft(draft, repaint = true) { clearTimeout(autosaveTimer); const version = editVersion; const result = await api('/api/wizard','PUT',draft); state.draft = result.draft ?? result; savedEditVersion = version; if (repaint && version === editVersion) renderWizard(); else $('#draft-status').textContent = `Saved draft ${state.draft.id} · revision ${state.draft.revision} · ${state.draft.step}${version === editVersion ? '' : ' · unsaved edits'}`; if (version !== editVersion) queueAutosave(); }
function validateStep(draft) {
  const invalid = [...$('#wizard-content').querySelectorAll('input,select')].find(input => !input.checkValidity());
  if (invalid) { invalid.reportValidity(); throw new Error('Complete the required fields before continuing.'); }
  if (['type','mode','address','set-on-light','test','color-check','name-place','groups','presets','music','review'].includes(draft.step) && !draft.fixtures.some(f => f.enabled)) throw new Error('Add at least one enabled light before continuing.');
  if (draft.step === 'set-on-light' && draft.fixtures.filter(f => f.enabled).some(f => !draft.checkedItems.includes(`set:${f.id}`))) throw new Error('Confirm the physical mode and address for every enabled light.');
  if (draft.step === 'color-check' && draft.fixtures.filter(f => f.enabled).some(f => !draft.checkedItems.includes(`color:${f.id}`))) throw new Error('Confirm the color order for every enabled light.');
  if (draft.step === 'test' && draft.fixtures.filter(f => f.enabled).some(f => !draft.completedTests.includes(f.id))) throw new Error('Run a controller probe and record a passed observation for every enabled light before continuing.');
}
function queueAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { if (!state.operator || !state.fresh || !state.draft || state.draft.step === 'done') return; if (state.busy) { queueAutosave(); return; } action(() => persistDraft(collectDraft(),false)); },350);
}
$('#wizard-content').addEventListener('input',event => { if (!event.target.matches('#wizard-room,#wizard-target,#wizard-output,[data-fixture-field],[data-check]')) return; editVersion++; $('#draft-status').textContent = 'Unsaved changes · saving to controller…'; queueAutosave(); });
$('#wizard-content').addEventListener('change',() => { if (editVersion !== savedEditVersion) queueAutosave(); });
window.addEventListener('pagehide',() => { if (state.token && state.operator && state.fresh && !state.busy && state.draft && editVersion !== savedEditVersion) { void api('/api/wizard','PUT',collectDraft()).catch(() => {}); } });
$('#wizard-save').onclick = () => action(async () => { await persistDraft(collectDraft()); toast('Draft saved by controller.'); });
$('#wizard-next').onclick = () => action(async () => { const draft = collectDraft(); validateStep(draft); draft.step = steps[Math.min(steps.length-1,steps.indexOf(draft.step)+1)]; await persistDraft(draft); });
$('#wizard-back').onclick = () => action(async () => { const draft = collectDraft(); draft.step = steps[Math.max(0,steps.indexOf(draft.step)-1)]; await persistDraft(draft); });
$('#frame-universe').innerHTML = '<option value="1">1</option>';
async function refreshFrame() { if (!state.token || !state.fresh || !$('#design-view').classList.contains('is-visible')) return; try { const data = await api('/api/frames'); $('#frame-status').textContent = `Controller output · universe ${data.universe} · ${data.frame.length} channels`; $('#universe-grid').innerHTML = data.frame.map((value,i) => `<span title="Channel ${i+1}">${value}</span>`).join(''); } catch(error) { $('#frame-status').textContent = error.message; } }
setInterval(refreshFrame,1500);
controls();
if (state.token) connect().catch(error => { invalidate(); notice(error.message); scheduleReconnect(); }); else checkHealth().catch(error => notice(error.message));
window.addEventListener('online',() => { if (state.token) scheduleReconnect(); else checkHealth().catch(error => notice(error.message)); });
