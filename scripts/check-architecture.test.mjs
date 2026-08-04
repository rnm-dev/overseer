import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const repositoryRoot = new URL('..', import.meta.url).pathname;
const checker = join(repositoryRoot, 'scripts/check-architecture.mjs');
const emptyPolicy = {
  genericFileNames: ['utils.ts', 'helpers.ts', 'common.ts', 'manager.ts'],
  allowedGenericFiles: [],
  allowedBoundaryViolations: [],
  allowedRuntimeCycleComponents: [],
  allowedRootDomainFiles: ['index.ts']
};

function fixture(files, policy = emptyPolicy) {
  const root = mkdtempSync(join(tmpdir(), 'overseer-architecture-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, 'apps/server/src', path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const policyPath = join(root, 'architecture-policy.json');
    writeFileSync(policyPath, JSON.stringify(policy));
    try {
      return { passed: true, output: execFileSync(process.execPath, [checker], { encoding: 'utf8', env: { ...process.env, ARCHITECTURE_CHECK_ROOT: root, ARCHITECTURE_CHECK_POLICY: policyPath }, stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (error) {
      return { passed: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts public module entry-point imports', () => {
  const result = fixture({
    'modules/auth/index.ts': 'export const authenticate = () => true;\n',
    'modules/sessions/session.ts': "import { authenticate } from '../auth/index.js';\nexport const session = authenticate();\n"
  });
  assert.equal(result.passed, true, result.output);
});

test('rejects cross-module internal imports', () => {
  const result = fixture({
    'modules/auth/index.ts': 'export {};\n',
    'modules/auth/private.ts': 'export const privateValue = true;\n',
    'modules/sessions/session.ts': "import { privateValue } from '../auth/private.js';\nexport const session = privateValue;\n"
  });
  assert.equal(result.passed, false);
  assert.match(result.output, /imports internal module file/);
});

test('rejects module imports of root compatibility facades', () => {
  const result = fixture({
    'db.ts': 'export const db = {};\n',
    'modules/sessions/session.ts': "import { db } from '../../db.js';\nexport const session = db;\n"
  }, { ...emptyPolicy, allowedRootDomainFiles: ['db.ts'] });
  assert.equal(result.passed, false);
  assert.match(result.output, /imports root compatibility facade/);
});

test('rejects runtime dependency cycles but permits type-only cycles', () => {
  const runtime = fixture({
    'modules/sessions/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
    'modules/sessions/b.ts': "import { a } from './a.js';\nexport const b = a;\n"
  });
  assert.equal(runtime.passed, false);
  assert.match(runtime.output, /runtime dependency cycle/);

  const typeOnly = fixture({
    'modules/sessions/a.ts': "import type { B } from './b.js';\nexport type A = { b: B };\n",
    'modules/sessions/b.ts': "import type { A } from './a.js';\nexport type B = { a: A };\n"
  });
  assert.equal(typeOnly.passed, true, typeOnly.output);
});

test('rejects new root domain files and generic filenames', () => {
  const result = fixture({
    'newDomain.ts': 'export const newDomain = true;\n',
    'modules/sessions/utils.ts': 'export const value = true;\n'
  });
  assert.equal(result.passed, false);
  assert.match(result.output, /root-level domain implementation/);
  assert.match(result.output, /generic filename/);
});
