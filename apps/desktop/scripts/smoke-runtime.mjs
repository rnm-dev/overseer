import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'peon-desktop-smoke-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
await mkdir(path.join(temporary, 'config/.peon'), { recursive: true });
await writeFile(path.join(temporary, 'config/.peon/settings.json'), JSON.stringify({
  settingsDefaultsVersion: 2, listenAddress: `127.0.0.1:${port}`,
  agentCommand: path.join(temporary, 'missing-claude'), codexCommand: path.join(temporary, 'missing-codex'),
}));
let child;
try {
  for (let run = 0; run < 2; run++) {
    child = spawn(process.execPath, [path.join(desktop, 'src-tauri/runtime/node_modules/@rnm-dev/peon/dist/desktop/peon.js')], {
      env: { ...process.env, XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_STATE_HOME: path.join(temporary, 'state'), XDG_DATA_HOME: path.join(temporary, 'data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exit = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    const pending = new Map();
    let id = 0;
    lines.on('line', line => {
      const response = JSON.parse(line);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    });
    child.stderr.resume();
    async function request(method, params) {
      const requestId = ++id;
      let timeout;
      try {
        return await Promise.race([
          new Promise(resolve => { pending.set(requestId, resolve); child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n'); }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000); }),
        ]);
      } finally { clearTimeout(timeout); }
    }
    const hello = await request('initialize', { protocol: 1 });
    assert.equal(hello.result?.protocol, 1, JSON.stringify(hello));
    assert.equal(hello.result.pid, child.pid);
    assert.equal(hello.result.enrolled, false);
    assert.equal(hello.result.activeSessions, 0);
    if (run === 1) assert.equal(hello.result.name, 'Desktop smoke');
    assert.equal((await request('configure', { name: 'Desktop smoke' })).result.name, 'Desktop smoke');
    assert.equal((await request('configure', { overseerToken: 'must-not-save' })).error, 'BAD_REQUEST');
    const phrase = await request('enroll');
    assert.equal(typeof phrase.result.phrase, 'string');
    assert.ok(phrase.result.expiresAt > Date.now());
    const snapshot = await request('status');
    assert.equal(JSON.stringify(snapshot).includes(phrase.result.phrase), false);
    const http = await fetch(`http://127.0.0.1:${port}/api/v1/control/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(http.status, 409);
    assert.equal((await http.json()).code, 'DESKTOP_MANAGED');
    assert.equal((await request('shutdown')).result.stopping, true);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 6000);
    const [code] = await exit;
    clearTimeout(timeout);
    assert.equal(code, 0);
    lines.close();
  }
  console.log('Packaged Peon: handshake, settings persistence, enrollment, redaction, update refusal and graceful shutdown passed (host Node).');
} finally {
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  await rm(temporary, { recursive: true, force: true });
}
