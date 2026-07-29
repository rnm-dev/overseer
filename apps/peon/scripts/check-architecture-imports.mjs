#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs"];
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".tsx", ".js", ".mjs"]);
const FEATURE_MODULES = new Set(["projects", "settings", "sessions", "overseer", "armory", "agents", "files"]);
const COMPATIBILITY_SHIMS = new Set(["projectState", "projectCatalog", "projectService", "settings"]);
const GENERIC_BUCKETS = new Map([
  ["utils", "utils"],
  ["helper", "helper"],
  ["helpers", "helper"],
  ["manager", "manager"],
]);
const TRANSPORT_MODULES = new Set(["agentApi", "controlServer", "scopedMcp", "sessionMcpAuth"]);

/**
 * Parse source files and validate imports/exports for feature boundary violations.
 *
 * Rules:
 * - production consumers of feature modules must import through `<feature>/index`.
 * - production files in feature modules must not import transport modules.
 * - forbidden compatibility shim files must be absent from production imports.
 * - generic bucket names (`utils`, `helpers`, `manager`) are forbidden.
 */

/**
 * @typedef {{ path: string; line: number; reason: string }} ArchitectureViolation
 */

export function runArchitectureImportCheck(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const sourceRoot = path.join(rootDir, "src");
  const transportFiles = new Set(
    [...TRANSPORT_MODULES].flatMap((basename) => [
      path.join(sourceRoot, "daemon", `${basename}.ts`),
      path.join(sourceRoot, "daemon", `${basename}.mts`),
      path.join(sourceRoot, "daemon", `${basename}.js`),
      path.join(sourceRoot, "daemon", `${basename}.mjs`),
    ]),
  );

  /** @type {ArchitectureViolation[]} */
  const violations = [];

  /**
   * @param {string} dir
   * @returns {string[]}
   */
  const walkFiles = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    /** @type {string[]} */
    const out = [];

    for (const entry of entries) {
      if (entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        out.push(...walkFiles(full));
        continue;
      }

      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;

      out.push(full);
    }

    return out;
  };

  /**
   * @param {string} sourcePath
   * @returns {string | null}
   */
  const inferFeatureModule = (sourcePath) => {
    const relative = path.relative(sourceRoot, sourcePath).split(path.sep);
    const daemonIndex = relative.indexOf("daemon");
    if (daemonIndex === -1 || daemonIndex === relative.length - 1) return null;
    const feature = relative[daemonIndex + 1];
    return FEATURE_MODULES.has(feature) ? feature : null;
  };

  /**
   * @param {string} file
   * @param {string} importSpecifier
   * @returns {string | null}
   */
  const resolveImportTarget = (file, importSpecifier) => {
    if (!importSpecifier.startsWith(".")) return null;
    const stripped = importSpecifier.replace(/[?#].*$/, "");
    const maybeDir = path.resolve(path.dirname(file), stripped);
    const declaredExtension = path.extname(maybeDir);
    const extensionPriority = declaredExtension
      ? [declaredExtension, ...EXTENSIONS.filter((extension) => extension !== declaredExtension)]
      : EXTENSIONS;
    const uniqueExtensions = [...new Set(extensionPriority)];

    if (SOURCE_EXTENSIONS.has(declaredExtension)) {
      if (fs.existsSync(maybeDir) && fs.statSync(maybeDir).isFile()) {
        return maybeDir;
      }

      for (const ext of EXTENSIONS.filter((item) => item !== declaredExtension)) {
        const candidate = `${maybeDir.slice(0, -declaredExtension.length)}${ext}`;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }

      return null;
    }

    for (const ext of uniqueExtensions) {
      const candidate = `${maybeDir}${ext}`;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }

    if (fs.existsSync(maybeDir) && fs.statSync(maybeDir).isDirectory()) {
      for (const ext of EXTENSIONS) {
        const indexed = path.join(maybeDir, `index${ext}`);
        if (fs.existsSync(indexed) && fs.statSync(indexed).isFile()) {
          return indexed;
        }
      }
    }

    return null;
  };

  /**
   * @param {string} sourcePath
   * @param {number} pos
   * @param {number} end
   * @returns {number}
   */
  const lineNumber = (sourcePath, pos) => {
    const text = fs.readFileSync(sourcePath, "utf8");
    const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest);
    return source.getLineAndCharacterOfPosition(pos).line + 1;
  };

  /**
   * @param {string} sourcePath
   * @param {string} specifier
   * @param {number | undefined} line
   */
  const recordViolation = (sourcePath, specifier, reason, line) => {
    violations.push({
      path: path.relative(rootDir, sourcePath),
      line,
      reason: `${specifier} — ${reason}`,
    });
  };

  /**
   * @param {string} targetPath
   * @returns {boolean}
   */
  const isTransportPath = (targetPath) => {
    return transportFiles.has(targetPath);
  };

  /**
   * @param {string} targetPath
   */
  const isFeatureIndexPath = (targetPath) => {
    const targetFeature = inferFeatureModule(targetPath);
    if (!targetFeature) return false;
    return path.basename(targetPath, path.extname(targetPath)) === "index";
  };

  /**
   * @param {string} sourcePath
   * @param {string} targetPath
   */
  const isGenericBucketPath = (targetPath) => {
    const rel = path.relative(sourceRoot, targetPath);
    return rel.split(path.sep).some((segment) => {
      const normalized = path.basename(segment, path.extname(segment));
      return GENERIC_BUCKETS.has(normalized);
    });
  };

  /**
   * @param {string} sourcePath
   * @param {string} importPath
   */
  const isCompatibilityShim = (sourcePath, importPath) => {
    const rawBase = path.basename(importPath.replace(/[?#].*$/, "")).replace(path.extname(importPath), "");
    if (COMPATIBILITY_SHIMS.has(rawBase)) return true;

    const resolved = resolveImportTarget(sourcePath, importPath);
    if (!resolved) return false;
    const base = path.basename(resolved, path.extname(resolved));
    return COMPATIBILITY_SHIMS.has(base);
  };

  /**
   * @param {string} sourcePath
   * @param {ts.Node} node
   * @param {string} specifier
   */
  const evaluateSpecifier = (sourcePath, node, specifier) => {
    const line = lineNumber(sourcePath, node.pos);
    if (isCompatibilityShim(sourcePath, specifier)) {
      recordViolation(sourcePath, specifier, "forbidden compatibility shim import", line);
      return;
    }

    const targetPath = resolveImportTarget(sourcePath, specifier);
    if (!targetPath) return;

    if (!targetPath.startsWith(sourceRoot)) return;

    const sourceFeature = inferFeatureModule(sourcePath);
    const targetFeature = inferFeatureModule(targetPath);

    if (sourceFeature) {
      if (targetFeature && sourceFeature !== targetFeature && !isFeatureIndexPath(targetPath)) {
        recordViolation(
          sourcePath,
          specifier,
          `production imports from feature '${sourceFeature}' into '${targetFeature}' must use ${targetFeature}/index`,
          line,
        );
      }

      if (isTransportPath(targetPath)) {
        recordViolation(sourcePath, specifier, "feature modules cannot depend on transport internals", line);
      }

      if (sourceFeature && isGenericBucketPath(targetPath)) {
        const match = path.relative(sourceRoot, targetPath)
          .split(path.sep)
          .map((segment) => path.basename(segment, path.extname(segment)))
          .map((segment) => GENERIC_BUCKETS.get(segment))
          .find((segment) => segment !== undefined);
        recordViolation(sourcePath, specifier, `generic bucket '${match ?? "unknown"}' is forbidden`, line);
      }

      return;
    }

    if (targetFeature && !isFeatureIndexPath(targetPath)) {
      recordViolation(
        sourcePath,
        specifier,
        `production import into ${targetFeature} must use ${targetFeature}/index`,
        line,
      );
    }
  };

  /** @param {ts.Node} node */
  const visit = (sourcePath, node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      evaluateSpecifier(sourcePath, node.moduleSpecifier, node.moduleSpecifier.text);
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      evaluateSpecifier(sourcePath, node.moduleSpecifier, node.moduleSpecifier.text);
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression.kind === ts.SyntaxKind.StringLiteral
    ) {
      evaluateSpecifier(sourcePath, node.moduleReference.expression, node.moduleReference.expression.text);
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg)) {
        evaluateSpecifier(sourcePath, arg, arg.text);
      }
    }

    ts.forEachChild(node, (child) => visit(sourcePath, child));
  };

  for (const file of walkFiles(sourceRoot)) {
    const text = fs.readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    visit(file, ast);
  }

  return violations;
}

if (import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const args = process.argv.slice(2);
  let rootDir = process.cwd();

  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--root") {
      rootDir = path.resolve(args[i + 1]);
      break;
    }
  }

  const violations = runArchitectureImportCheck({ rootDir });
  if (violations.length > 0) {
    console.error("Architecture import guard failed: boundary violations detected.");
    for (const item of violations) {
      console.error(`${item.path}:${item.line} - ${item.reason}`);
    }
    process.exit(1);
  }

  console.log("Architecture import guard passed: no feature-boundary violations.");
}
