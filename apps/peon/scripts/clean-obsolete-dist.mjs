import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const sourceRoot = path.join(rootDir, "src", "daemon");
const distRoot = path.join(rootDir, "dist", "daemon");
const extSet = new Set([".ts", ".mts", ".tsx", ".js", ".mjs"]);

/**
 * Build expected dist daemon entries from current source tree.
 */
const walkSourceFiles = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...walkSourceFiles(full));
      continue;
    }

    if (entry.isFile() && extSet.has(path.extname(entry.name))) {
      files.push(full);
    }
  }

  return files;
};

/** @param {string} root
 *  @returns {string[]}
 */
const walkDist = (root) => {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDist(full));
      continue;
    }

    files.push(full);
  }

  return files;
};

const expectedDistFiles = new Set(
  walkSourceFiles(sourceRoot).map((file) => {
    const relative = path.relative(sourceRoot, file);
    return path.join(distRoot, relative.replace(/\.[^.]+$/, ".js"));
  }),
);

if (!fs.existsSync(distRoot)) {
  process.exit(0);
}

const obsolete = walkDist(distRoot).filter((distFile) => {
  if (path.extname(distFile) !== ".js") return false;
  return !expectedDistFiles.has(distFile);
});

for (const file of obsolete) {
  fs.unlinkSync(file);
}

if (obsolete.length > 0) {
  console.log(`Removed ${obsolete.length} obsolete dist artifact(s):`);
  for (const file of obsolete) {
    const relative = path.relative(rootDir, file);
    console.log(`- ${relative}`);
  }
}
