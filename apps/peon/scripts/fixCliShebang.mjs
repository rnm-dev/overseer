#!/usr/bin/env node
// tsc preserves a source file's original shebang verbatim in its emitted output. Source
// peon.ts's shebang (`#!/usr/bin/env -S node --import tsx`) is only correct for running the
// TS source directly via tsx — the compiled dist/cli/peon.js the packed `bin` now points at
// has no tsx dependency, and `--import tsx` resolves relative to the *caller's* cwd (not the
// script's location), which breaks the CLI entirely when run from outside this package's tree.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "peon.js");
const contents = readFileSync(file, "utf8");
writeFileSync(file, contents.replace(/^#!.*\n/, "#!/usr/bin/env node\n"));
chmodSync(file, 0o755);
