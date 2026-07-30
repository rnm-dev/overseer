import assert from "node:assert/strict";
import test from "node:test";
import { buildNewSessionRequest } from "./newSessionRequest";

test("builds a new session request from the composer values", () => {
  assert.deepEqual(buildNewSessionRequest({
    prompt: "  inspect the project  ",
    projectKey: "app",
    dir: "/path/to/app",
    agent: "codex",
    model: "gpt-5",
    reasoningEffort: "high",
  }), {
    prompt: "inspect the project",
    projectKey: "app",
    dir: "/path/to/app",
    agent: "codex",
    model: "gpt-5",
    reasoningEffort: "high",
  });
});

test("uses an attachment placeholder and omits empty optional values", () => {
  assert.deepEqual(buildNewSessionRequest({
    prompt: "",
    projectKey: "",
    dir: " ",
    agent: "",
    model: "",
    reasoningEffort: "",
    attachments: [{
      type: "file",
      path: "uploads/draft/file.txt",
      transferId: "123e4567-e89b-42d3-a456-426614174000",
      size: 4,
      sha256: "a".repeat(64),
    }],
  }), {
    prompt: "(see attachments)",
    attachments: [{
      type: "file",
      path: "uploads/draft/file.txt",
      transferId: "123e4567-e89b-42d3-a456-426614174000",
      size: 4,
      sha256: "a".repeat(64),
    }],
  });
});
