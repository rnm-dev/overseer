const { invoke } = window.__TAURI__.core;
const $ = id => document.getElementById(id);
let current = { running: false };
let loaded = false;
let pending = false;
let expiresAt = 0;
let pairingArmed = false;

function errorText(error) {
  const value = String(error);
  return ({
    SESSION_BUSY: 'A coding session is running. Let it finish or confirm stopping it.',
    EADDRINUSE: 'Peon cannot start because TCP port 4570 is already in use. Stop the other Peon or port proxy, then try again.',
    EACCES: 'Peon cannot use TCP port 4570. On Windows this usually means a port proxy or reserved port already owns it.',
    BAD_REQUEST: 'Check the connection details and executable paths.',
    REQUEST_FAILED: 'Peon could not complete this request. Check the values and try again.',
  })[value] || value;
}
function showError(error) { $('error').hidden = !error; $('error').textContent = error ? errorText(error) : ''; }
const call = (method, params) => invoke('desktop', { method, params });

function render(state) {
  current = state;
  const needsPairing = !state.enrolled || state.revoked;
  $('start').hidden = state.running;
  $('restart').disabled = !state.running;
  $('enroll').disabled = !state.running;
  $('connect').hidden = !needsPairing;
  $('open').hidden = needsPairing || !state.overseerUrl;
  $('status-title').textContent = !state.running ? 'Peon is stopped' : state.activeSessions ? `${state.activeSessions} session${state.activeSessions === 1 ? '' : 's'} running` : 'Peon is ready';
  $('status-detail').textContent = !state.running ? 'Start Peon to connect this computer.' : !state.enrolled ? 'Use the URL and one-time phrase below.' : state.revoked ? 'Overseer rejected this connection. Generate a new pairing phrase to reconnect.' : state.connected ? 'Connected to Overseer.' : 'Paired. Waiting for Overseer…';
  if (state.running && !loaded) {
    for (const id of ['defaultAgent', 'agentCommand', 'codexCommand']) $(id).value = state[id] || '';
    loaded = true;
  }
  if (state.pairingUrl) $('pairingUrl').value = state.pairingUrl;
  if (state.enrolled && !state.revoked) { $('phrase').value = ''; expiresAt = 0; pairingArmed = false; }
}
async function act(fn) {
  if (pending) return;
  pending = true;
  document.body.setAttribute('aria-busy', 'true');
  showError(null);
  try { await fn(); } catch (error) { showError(error); }
  finally { pending = false; document.body.removeAttribute('aria-busy'); }
}
async function stopOrRestart(method) {
  try { render(await call(method)); }
  catch (error) {
    if (String(error) !== 'SESSION_BUSY') throw error;
    if (window.confirm('A coding session is running. Stop its current work and continue?')) render(await call(method, { force: true }));
  }
}
$('start').onclick = () => act(async () => render(await call('start')));
$('restart').onclick = () => act(() => stopOrRestart('restart'));
$('quit').onclick = () => act(() => stopOrRestart('quit'));
$('open').onclick = () => act(() => invoke('open_overseer', { url: current.overseerUrl || '' }));
$('agents').onsubmit = event => { event.preventDefault(); void act(async () => {
  const params = Object.fromEntries(['defaultAgent', 'agentCommand', 'codexCommand'].map(id => [id, $(id).value.trim()]));
  render(await call('configure', params));
}); };
async function armPairing() {
  const result = await call('enroll');
  $('phrase').value = result.phrase;
  $('pairingUrl').value = result.url || current.pairingUrl || '';
  expiresAt = result.expiresAt;
  pairingArmed = true;
  updateExpiry();
}
$('enroll').onclick = () => act(armPairing);
for (const button of document.querySelectorAll('[data-copy]')) button.onclick = () => act(async () => {
  const input = $(button.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); }
  catch { input.focus(); input.select(); document.execCommand('copy'); }
  const previous = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = previous; }, 1200);
});
$('autostart').onchange = () => act(async () => {
  try { $('autostart').checked = await invoke('startup', { enabled: $('autostart').checked }); }
  catch (error) { $('autostart').checked = !$('autostart').checked; throw error; }
});
$('refresh-logs').onclick = () => act(async () => { $('logs').textContent = (await call('logs')).join('\n') || 'No events yet.'; });
window.__TAURI__.event.listen('quit-requested', () => act(() => stopOrRestart('quit')));
setInterval(async () => {
  updateExpiry();
  if (pending) return;
  try { render(await call('status')); } catch (error) { showError(error); }
}, 5000);
function updateExpiry() {
  if (!expiresAt) return;
  const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
  $('expiry').textContent = seconds > 0 ? `Single-use phrase · expires in ${Math.ceil(seconds / 60)} minute(s)` : 'Phrase expired. Generate a new one.';
  if (seconds <= 0) { $('phrase').value = ''; expiresAt = 0; pairingArmed = false; }
}
void act(async () => {
  try { $('autostart').checked = await invoke('startup'); } catch { $('autostart').disabled = true; }
  try {
    const state = await call('start');
    render(state);
    if ((!state.enrolled || state.revoked) && !pairingArmed) await armPairing();
  }
  catch (error) { render({ running: false }); throw error; }
});
