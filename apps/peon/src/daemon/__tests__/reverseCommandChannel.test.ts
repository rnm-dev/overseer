import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  projectArchiveHandler,
  ReverseCommandChannel,
  type ReverseCommandHandler,
} from "../overseer/socket/channels/reverseCommandChannel.js";
import { ReverseCommandLedger } from "../overseer/socket/reverseCommandLedger.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";
import { ProjectService, ProjectStore } from "../projects/index.js";

const peonId = "f4de920f-e33e-4cf5-97d0-3a75e9266090";
const commandId = "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
const sessionId = "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5";
const frame: PeonSocketFrame = {
  type: "command",
  protocol: 1,
  capability: "reverse-command-v1",
  commandId,
  operation: "test.effect",
  target: { peonId, sessionId },
  actor: { userId: "b169219d-45f6-4f42-b78f-3fb931dac7ee", email: "operator@example.com" },
  payload: {},
  requestedAt: 1_784_912_400_000,
};

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("accepts only after admission, executes once, and durably replays duplicate results", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-channel-"));
  const sent: PeonSocketFrame[] = [];
  const durable: PeonSocketFrame[] = [];
  let effects = 0;
  const sender: PeonSocketSender = {
    durable: true,
    send: (message) => { sent.push(message); return true; },
    sendBinary: () => false,
    sendDurable: (message) => {
      durable.push(message);
      return { accepted: true, epoch: "epoch", cursor: "cursor", messageId: "message" };
    },
    disconnect: (reason) => assert.fail(reason),
  };
  const handler: ReverseCommandHandler = {
    validate: () => null,
    execute: () => { effects += 1; return { status: "applied", code: "OK" }; },
  };
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger: new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") }),
      handlers: { "test.effect": handler },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive(frame, sender);
    await tick();
    channel.receive(frame, sender);
    await tick();
    assert.equal(effects, 1);
    assert.equal(sent.filter((message) => message.type === "command_accepted").length, 2);
    assert.equal(sent.at(-1)?.replayed, true);
    assert.equal(durable.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects command-id reuse and fences a mismatched Peon identity", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-fence-"));
  const sent: PeonSocketFrame[] = [];
  const disconnects: string[] = [];
  const sender: PeonSocketSender = {
    durable: true,
    send: (message) => { sent.push(message); return true; },
    sendBinary: () => false,
    sendDurable: () => ({ accepted: true, epoch: "epoch", cursor: "cursor", messageId: "message" }),
    disconnect: (reason) => { disconnects.push(reason); },
  };
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger: new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") }),
      handlers: { "test.effect": { validate: () => null, execute: () => ({ status: "applied", code: "OK" }) } },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive(frame, sender);
    await tick();
    channel.receive({ ...frame, payload: { changed: true } }, sender);
    channel.receive({ ...frame, commandId: "028f4f0c-9f30-7a61-bf1a-66d2582bdb4a", target: { peonId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sessionId } }, sender);
    assert.ok(sent.some((message) => message.code === "COMMAND_ID_REUSED"));
    assert.equal(disconnects.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archives and unarchives a project by immutable id through reverse commands", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-project-command-"));
  const sent: PeonSocketFrame[] = [];
  const durable: PeonSocketFrame[] = [];
  const sender: PeonSocketSender = {
    durable: true,
    send: (message) => { sent.push(message); return true; },
    sendBinary: () => false,
    sendDurable: (message) => {
      durable.push(message);
      return { accepted: true, epoch: "epoch", cursor: `${durable.length}`, messageId: `message-${durable.length}` };
    },
    disconnect: (reason) => assert.fail(reason),
  };
  try {
    const projects = new ProjectService(new ProjectStore(path.join(directory, "projects.json")), {
      list: () => [],
      renameProjectKey: () => 0,
      start: () => ({ id: "onboarding" }),
      rename: () => undefined,
    });
    const project = projects.create({ label: "Archived", dir: path.join(directory, "project") });
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger: new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") }),
      handlers: {
        "project.archive": projectArchiveHandler(projects, true),
        "project.unarchive": projectArchiveHandler(projects, false),
      },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive({
      ...frame,
      commandId: "118f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      operation: "project.archive",
      target: { peonId, projectId: project.projectId },
    }, sender);
    await tick();
    assert.equal(typeof projects.detail(project.key).archivedAt, "number");
    assert.equal(durable.at(-1)?.status, "applied");

    channel.receive({
      ...frame,
      commandId: "218f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      operation: "project.unarchive",
      target: { peonId, projectId: project.projectId },
    }, sender);
    await tick();
    assert.equal(projects.detail(project.key).archivedAt, null);
    assert.equal(durable.at(-1)?.status, "applied");
    assert.equal(sent.filter((message) => message.type === "command_accepted").length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
