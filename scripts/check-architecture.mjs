#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, normalize, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const repositoryRoot = resolve(process.env.ARCHITECTURE_CHECK_ROOT ?? resolve(import.meta.dirname, '..'));
const serverSource = join(repositoryRoot, 'apps/server/src');
const policyPath = process.env.ARCHITECTURE_CHECK_POLICY ?? join(repositoryRoot, 'scripts/architecture-policy.json');
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'];
const testSuffix = /(?:\.test|\.spec)\.[cm]?tsx?$/;
const genericNames = new Set(policy.genericFileNames);

function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return sourceExtensions.some((extension) => entry.name.endsWith(extension)) && !testSuffix.test(entry.name) ? [path] : [];
  });
}

function sourcePath(path) {
  return relative(repositoryRoot, path).split(sep).join('/');
}

function moduleName(path) {
  const parts = relative(join(serverSource, 'modules'), path).split(sep);
  return parts.length > 1 && parts[0] !== '..' ? parts[0] : null;
}

function isInside(path, directory) {
  const pathFromDirectory = relative(join(serverSource, directory), path);
  return pathFromDirectory !== '' && !pathFromDirectory.startsWith(`..${sep}`) && pathFromDirectory !== '..';
}

function isInfrastructureFile(path) {
  return isInside(path, 'infrastructure');
}

function isAppOrTransportFile(path) {
  return ['app', 'routes', 'adapters'].some((directory) => isInside(path, directory));
}

function resolveImport(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(from, '..', specifier);
  const sourceCandidate = candidate.replace(/\.m?js$/, '');
  const candidates = [candidate, sourceCandidate, ...sourceExtensions.map((extension) => candidate + extension), ...sourceExtensions.map((extension) => sourceCandidate + extension), ...sourceExtensions.map((extension) => join(candidate, `index${extension}`))];
  return candidates.find(existsSync) ?? null;
}

function importsFor(path) {
  const text = readFileSync(path, 'utf8');
  const imports = [];
  const expression = /(^|\n)\s*import\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|(^|\n)\s*export\s+(type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of text.matchAll(expression)) {
    const isTypeOnly = Boolean(match[2] || match[5]);
    const specifier = match[3] ?? match[6];
    const target = resolveImport(path, specifier);
    if (target) imports.push({ target, isTypeOnly, specifier });
  }
  return imports;
}

function runtimeCycles(files, graph) {
  const indices = new Map();
  const lowlinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let index = 0;
  function visit(node) {
    indices.set(node, index);
    lowlinks.set(node, index++);
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowlinks.set(node, Math.min(lowlinks.get(node), lowlinks.get(target)));
      } else if (onStack.has(target)) {
        lowlinks.set(node, Math.min(lowlinks.get(node), indices.get(target)));
      }
    }
    if (lowlinks.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || (graph.get(node) ?? []).includes(node)) components.push(component.map(sourcePath).sort());
    }
  }
  for (const file of files) if (!indices.has(file)) visit(file);
  return components;
}

const files = listSourceFiles(serverSource);
const errors = [];
const graph = new Map(files.map((file) => [file, []]));

for (const file of files) {
  const currentModule = moduleName(file);
  for (const imported of importsFor(file)) {
    const targetModule = moduleName(imported.target);
    const boundary = `${sourcePath(file)} -> ${sourcePath(imported.target)}`;
    if (targetModule && targetModule !== currentModule && sourcePath(imported.target) !== `apps/server/src/modules/${targetModule}/index.ts` && !policy.allowedBoundaryViolations.includes(boundary)) {
      errors.push(`${sourcePath(file)} imports internal module file ${sourcePath(imported.target)}; import modules/${targetModule}/index.ts instead.`);
    }
    if (currentModule && !targetModule && relative(serverSource, imported.target).split(sep).length === 1 && !policy.allowedBoundaryViolations.includes(boundary)) {
      errors.push(`${sourcePath(file)} imports root compatibility facade ${sourcePath(imported.target)} from inside modules/.`);
    }
    if (isInfrastructureFile(file) && targetModule) {
      errors.push(`${sourcePath(file)} imports product module ${sourcePath(imported.target)}; infrastructure must not depend on product modules.`);
    }
    if (currentModule && isAppOrTransportFile(imported.target)) {
      errors.push(`${sourcePath(file)} imports route, adapter, or app composition ${sourcePath(imported.target)}; modules must not depend on app composition or transports.`);
    }
    if (!imported.isTypeOnly && graph.has(imported.target)) graph.get(file).push(imported.target);
  }
}

for (const component of runtimeCycles(files, graph)) {
  if (!policy.allowedRuntimeCycleComponents.some((allowed) => allowed.length === component.length && allowed.every((entry, index) => entry === component[index]))) {
    errors.push(`runtime dependency cycle: ${component.join(' -> ')}`);
  }
}

for (const entry of readdirSync(serverSource, { withFileTypes: true })) {
  if (!entry.isFile() || !sourceExtensions.some((extension) => entry.name.endsWith(extension)) || testSuffix.test(entry.name)) continue;
  if (!policy.allowedRootDomainFiles.includes(entry.name)) errors.push(`root-level domain implementation ${sourcePath(join(serverSource, entry.name))} is not an explicitly allowlisted legacy facade.`);
}

for (const file of files) {
  if (genericNames.has(file.split(sep).at(-1)) && !policy.allowedGenericFiles.includes(sourcePath(file))) {
    errors.push(`generic filename ${sourcePath(file)} is forbidden; choose an ownership-specific name.`);
  }
}

if (errors.length > 0) {
  console.error('Architecture fitness check failed:\n' + errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Architecture fitness check passed (${files.length} production TypeScript files scanned).`);
}
