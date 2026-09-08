const { invoke } = window.__TAURI__.core;
const $ = id => document.getElementById(id);
let current = { running: false };
let loaded = false;
let pending = false;
let expiresAt = 0;

function errorText(error) {
  const value = String(error);
  return ({
    SESSION_BUSY: 'A coding session is running. Let it finish or confirm stopping it.',
    BAD_REQUEST: 'Check the connection details and executable paths.',
    REQUEST_FAILED: 'Peon could not complete this request. Check the values and try again.',
  })[value] || value;
}
function showError(error) { $('error').hidden = !error; $('error').textContent = error ? errorText(error) : ''; }
const call = (method, params) => invoke('desktop', { method, params });

function render(state) {
  current = state;
  $('start').hidden = state.running;
  $('restart').disabled = !state.running;
  $('enroll').disabled = !state.running;
  $('status-title').textContent = !state.running ? 'Peon is stopped' : state.activeSessions ? `${state.activeSessions} session${state.activeSessions === 1 ? '' : 's'} running` : 'Peon is ready';
  $('status-detail').textContent = !state.running ? 'Start Peon to connect this computer.' : !state.enrolled ? 'Connect this computer to Overseer below.' : state.revoked ? 'Overseer rejected this connection. Check enrollment.' : state.connected ? 'Connected to Overseer. Fleet access also requires a reachable mesh address.' : 'Waiting for the Overseer connection…';
  if (state.running && !loaded) {
    for (const id of ['name', 'overseerUrl', 'publicControlUrl', 'defaultAgent', 'agentCommand', 'codexCommand']) $(id).value = state[id] || '';
    $('setup').open = !state.enrolled;
    loaded = true;
  }
  if (state.enrolled) { $('pairing').hidden = true; $('phrase').value = ''; expiresAt = 0; }
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
$('open').onclick = () => act(() => invoke('open_overseer', { url: $('overseerUrl').value.trim() || current.overseerUrl || '' }));
$('settings').onsubmit = event => { event.preventDefault(); void act(async () => {
  const params = Object.fromEntries(['name', 'overseerUrl', 'publicControlUrl'].map(id => [id, $(id).value.trim()]));
  render(await call('configure', params));
}); };
$('agents').onsubmit = event => { event.preventDefault(); void act(async () => {
  const params = Object.fromEntries(['defaultAgent', 'agentCommand', 'codexCommand'].map(id => [id, $(id).value.trim()]));
  render(await call('configure', params));
}); };
$('enroll').onclick = () => act(async () => {
  const result = await call('enroll');
  $('phrase').value = result.phrase;
  expiresAt = result.expiresAt;
  $('pairing').hidden = false;
  $('phrase').focus(); $('phrase').select();
});
$('autostart').onchange = () => act(async () => {
  try { $('autostart').checked = await invoke('startup', { enabled: $('autostart').checked }); }
  catch (error) { $('autostart').checked = !$('autostart').checked; throw error; }
});
$('refresh-logs').onclick = () => act(async () => { $('logs').textContent = (await call('logs')).join('\n') || 'No events yet.'; });
window.__TAURI__.event.listen('quit-requested', () => act(() => stopOrRestart('quit')));
setInterval(async () => {
  if (expiresAt) {
    const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
    $('expiry').textContent = seconds > 0 ? `Expires in ${Math.ceil(seconds / 60)} minute(s).` : 'Expired. Generate a new phrase.';
    if (seconds <= 0) { $('phrase').value = ''; expiresAt = 0; }
  }
  if (pending) return;
  try { render(await call('status')); } catch (error) { showError(error); }
}, 5000);
void act(async () => {
  try { $('autostart').checked = await invoke('startup'); } catch { $('autostart').disabled = true; }
  try { render(await call('start')); }
  catch (error) { render({ running: false }); throw error; }
});
