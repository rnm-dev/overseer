import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '../..');
const runtime = path.join(desktop, 'src-tauri/runtime');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'peon-desktop-pack-'));
const nodeVersion = '22.22.0';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run staging with npm run stage -w @rnm-dev/peon-desktop');
function run(args, cwd = root) {
  execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' });
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
try {
  run(['pack', '-w', '@rnm-dev/peon', '--pack-destination', temporary]);
  const peon = JSON.parse(await readFile(path.join(root, 'apps/peon/package.json'), 'utf8'));
  const archive = path.join(temporary, `rnm-dev-peon-${peon.version}.tgz`);
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'peon-desktop-runtime', private: true, version: '0.1.0' }));
  // The CLI/service package intentionally does not advertise Windows support,
  // while this desktop bundle uses its dedicated Windows entry point. Allow
  // that private staging install without weakening the published OS metadata.
  run(['install', ...(process.platform === 'win32' ? ['--force'] : []), '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', archive], runtime);
  // Dependency metadata must not contain the temporary build-machine path.
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: 'peon-desktop-runtime', private: true, version: '0.1.0' }));
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
  const expected = sums.split('\n').find(line => line.endsWith('  win-x64/node.exe'))?.split(' ')[0];
  if (!expected) throw new Error('Node checksum is missing');
  const bytes = await download(`${base}/win-x64/node.exe`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) throw new Error('Node checksum mismatch');
  await writeFile(path.join(runtime, 'node.exe'), bytes);
  await writeFile(path.join(runtime, 'NODE-LICENSE.txt'), await download(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`));
  await writeFile(path.join(runtime, 'versions.json'), JSON.stringify({ desktop: '0.1.0', peon: peon.version, node: nodeVersion, architecture: 'x64', nodeSha256: sha256 }, null, 2) + '\n');
  console.log(`Staged Node ${nodeVersion} + Peon ${peon.version} for Windows x64.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
