window.flashifyToast = window.flashifyToast || (message => { const el = document.querySelector('#toast'); if (!el) return; el.textContent = message; el.classList.add('is-visible'); setTimeout(() => el.classList.remove('is-visible'), 2400); });
const designIntensity = document.querySelector('#design-intensity');
if (designIntensity) designIntensity.addEventListener('input', event => {
  document.querySelector('#design-intensity-value').textContent = `${event.target.value}%`;
  document.querySelectorAll('.stage-light').forEach(light => { light.style.opacity = Number(event.target.value) / 100; });
});
const universeGrid = document.querySelector('#universe-grid');
if (universeGrid) universeGrid.innerHTML = Array.from({ length: 64 }, (_, index) => `<span class="universe-cell ${index < 4 ? 'occupied' : ''}" title="DMX slot ${index + 1}">${index + 1}</span>`).join('');
document.querySelector('#save-as-scene')?.addEventListener('click', () => window.flashifyToast?.('Look saved as a new scene'));
document.querySelector('#advanced-toggle')?.addEventListener('click', event => { event.currentTarget.textContent = event.currentTarget.textContent.includes('Show') ? 'Hide advanced channels' : 'Show advanced channels'; window.flashifyToast?.('Advanced channel view toggled'); });
document.querySelectorAll('.light-pills button, .group-select button').forEach(button => button.addEventListener('click', () => { button.parentElement.querySelectorAll('button').forEach(item => item.classList.remove('selected')); button.classList.add('selected'); }));
let musicRunning = false; let meterTimer;
document.querySelector('#music-toggle')?.addEventListener('click', () => { musicRunning = !musicRunning; document.querySelector('#music-toggle').textContent = musicRunning ? 'Stop Pulse' : 'Start Pulse'; document.querySelector('#music-hearing').textContent = musicRunning ? 'Hearing sound · simulator' : 'Source ready · simulator'; window.flashifyToast?.(musicRunning ? 'Pulse music started' : 'Pulse music stopped'); clearInterval(meterTimer); if (musicRunning) meterTimer = setInterval(() => { const rms = (.25 + Math.random() * .68).toFixed(2); const bass = (.2 + Math.random() * .75).toFixed(2); document.querySelector('#rms-value').textContent = rms; document.querySelector('#bass-value').textContent = bass; document.querySelector('#meter-fill').style.height = `${Number(rms) * 100}%`; }, 180); });
document.querySelector('#wizard-next')?.addEventListener('click', event => { window.flashifyToast?.('Draft saved · next step is Add lights'); event.currentTarget.textContent = 'Draft saved · add lights →'; });
let flashifySocket;
if (window.location.protocol !== 'file:' && 'WebSocket' in window) {
  flashifySocket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);
  flashifySocket.addEventListener('open', () => { document.querySelectorAll('.sync-label').forEach(item => { item.innerHTML = '<span class="connection-dot"></span>Connected to controller'; }); });
  flashifySocket.addEventListener('message', event => { try { const message = JSON.parse(event.data); if (message.type === 'state') document.body.dataset.revision = message.revision; } catch {} });
}
window.flashifySend = (type, body = {}) => { if (!flashifySocket || flashifySocket.readyState !== WebSocket.OPEN) return; flashifySocket.send(JSON.stringify({ type, id: crypto.randomUUID(), ...body })); };
document.querySelector('#blackout-button')?.addEventListener('click', () => window.flashifySend('blackout.set', { on: document.querySelector('#blackout-button').classList.contains('is-on') }));
document.querySelector('#master-range')?.addEventListener('change', event => window.flashifySend('master.set', { value: Number(event.target.value) / 100 }));
document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => window.flashifySend('scene.activate', { sceneId: button.dataset.scene.toLowerCase().replaceAll(' ', '-'), fadeMs: 3000, groupIds: [] })));
document.querySelector('#go-button')?.addEventListener('click', () => window.flashifySend('show.go'));
document.querySelector('#back-button')?.addEventListener('click', () => window.flashifySend('show.back'));
document.querySelector('#stop-button')?.addEventListener('click', () => window.flashifySend('show.stop'));
document.querySelector('#music-toggle')?.addEventListener('click', () => window.flashifySend(musicRunning ? 'music.start' : 'music.stop'));
