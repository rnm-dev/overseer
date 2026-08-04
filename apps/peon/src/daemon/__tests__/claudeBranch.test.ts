import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forkClaudeCodeSession } from "../agents/claudeCode.js";

test("Claude branching resumes the source with fork-session and a caller-owned new id", async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "peon-claude-branch-"));
  const command = path.join(temp, "claude");
  const argsPath = path.join(temp, "args.json");
  writeFileSync(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
const id = args[args.indexOf("--session-id") + 1];
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: id }) + "\\n");
`);
  chmodSync(command, 0o755);
  try {
    const result = await forkClaudeCodeSession({
      command,
      backendSessionId: "11111111-1111-4111-8111-111111111111",
      targetSessionId: "22222222-2222-4222-8222-222222222222",
      cwd: temp,
    });
    assert.equal(result.backendSessionId, "22222222-2222-4222-8222-222222222222");
    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    assert.deepEqual(args.slice(0, 2), ["-p", ""]);
    assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "11111111-1111-4111-8111-111111111111"]);
    assert.equal(args.includes("--fork-session"), true);
    assert.deepEqual(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2), ["--session-id", "22222222-2222-4222-8222-222222222222"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
