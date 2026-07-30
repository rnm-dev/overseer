import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ReverseCommandChannel,
  type ReverseCommandHandler,
} from "../overseer/socket/channels/reverseCommandChannel.js";
import { ReverseCommandLedger } from "../overseer/socket/reverseCommandLedger.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";

const peonId = "f4de920f-e33e-4cf5-97d0-3a75e9266090";
const commandId = "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
const sessionId = "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5";
const authority = "authority-a";
const frame: PeonSocketFrame = {
  type: "command",
  protocol: 1,
  capability: "reverse-command-v1",
  commandId,
  operation: "test.effect",
  target: { peonId, sessionId },
  actor: { userId: "b169219d-45f6-4f42-b78f-3fb931dac7ee", email: "operator@example.com" },
  payload: {},
  expected: null,
  requestedAt: 1_784_912_400_000,
};

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// The channel unrefs its retry timers so a daemon is never held alive by a
// pending republication alone. A test that awaits such a retry has nothing else
// keeping the loop open, so the runner would see it drain mid-await and cancel
// the test; this holds the loop for exactly as long as the wait.
function holdEventLoop(): () => void {
  const timer = setInterval(() => {}, 5);
  return () => clearInterval(timer);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("accepts only after admission, executes once, and durably replays duplicate results", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-channel-"));
  const sent: PeonSocketFrame[] = [];
  const durable: PeonSocketFrame[] = [];
  let effects = 0;
  const sender: PeonSocketSender = {
    durable: true,
    authority,
    generation: 1,
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
    assert.equal(durable[0]?.result, null);
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
    authority,
    generation: 1,
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
    assert.ok(sent.filter((message) => message.code === "COMMAND_ID_REUSED").every((message) => message.result === null));
    assert.equal(disconnects.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconnect negotiation deduplicates queued commands and CAS prevents terminal revival", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-reconnect-"));
  const blocker = deferred();
  let queuedEffects = 0;
  const sender: PeonSocketSender = {
    durable: true,
    authority,
    generation: 1,
    send: () => true,
    sendBinary: () => false,
    sendDurable: () => ({ accepted: true, epoch: "epoch", cursor: randomUUID(), messageId: randomUUID() }),
    disconnect: (reason) => assert.fail(reason),
  };
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger: new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") }),
      maxConcurrency: 1,
      handlers: {
        "test.block": { validate: () => null, execute: () => blocker.promise.then(() => ({ status: "applied", code: "OK" })) },
        "test.queued": { validate: () => null, execute: () => { queuedEffects += 1; return { status: "applied", code: "OK" }; } },
      },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive({ ...frame, operation: "test.block" }, sender);
    channel.receive({
      ...frame,
      commandId: "118f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      operation: "test.queued",
    }, sender);
    channel.disconnected(false);
    channel.negotiated(true, {}, sender);
    channel.negotiated(true, {}, sender);
    blocker.resolve();
    await tick();
    await tick();
    assert.equal(queuedEffects, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("async completion stays with its admitting authority across replacement", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-authority-"));
  const effect = deferred();
  const ledger = new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") });
  const oldDurable: PeonSocketFrame[] = [];
  const replacementDurable: PeonSocketFrame[] = [];
  const sender = (senderAuthority: string, generation: number, durable: PeonSocketFrame[]): PeonSocketSender => ({
    durable: true,
    authority: senderAuthority,
    generation,
    send: () => true,
    sendBinary: () => false,
    sendDurable: (message) => {
      durable.push(message);
      return { accepted: true, epoch: "epoch", cursor: `${senderAuthority}-cursor`, messageId: crypto.randomUUID() };
    },
    disconnect: (reason) => assert.fail(reason),
  });
  const oldSender = sender(authority, 1, oldDurable);
  const replacement = sender("authority-b", 2, replacementDurable);
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger,
      handlers: {
        "test.effect": { validate: () => null, execute: () => effect.promise.then(() => ({ status: "applied", code: "OK" })) },
      },
    });
    channel.started(oldSender);
    channel.negotiated(true, {}, oldSender);
    channel.receive(frame, oldSender);
    await tick();
    channel.disconnected(true);
    channel.negotiated(true, {}, replacement);
    effect.resolve();
    await tick();
    assert.equal(replacementDurable.length, 0);
    assert.equal(ledger.get(commandId)?.state, "terminal");
    assert.equal(ledger.get(commandId)?.authority, authority);
    channel.disconnected(true);
    channel.negotiated(true, {}, oldSender);
    assert.equal(oldDurable.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reverse commands require durable delivery negotiation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-durable-"));
  let effects = 0;
  const disconnects: string[] = [];
  const sender: PeonSocketSender = {
    durable: false,
    authority,
    generation: 1,
    send: () => true,
    sendBinary: () => false,
    sendDurable: () => ({ accepted: false, code: "PERSIST_FAILED", error: "disabled" }),
    disconnect: (reason) => { disconnects.push(reason); },
  };
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger: new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") }),
      handlers: { "test.effect": { validate: () => null, execute: () => { effects += 1; return { status: "applied", code: "OK" }; } } },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive(frame, sender);
    await tick();
    assert.equal(effects, 0);
    assert.ok(disconnects.some((reason) => reason.includes("durable-delivery-v1")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal publication retries outbox pressure and cursor-bind persistence failure", { timeout: 1_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-publish-"));
  const ledger = new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") });
  let durableAttempts = 0;
  let bindAttempts = 0;
  let resolveBound!: () => void;
  const bound = new Promise<void>((resolve) => { resolveBound = resolve; });
  const bind = ledger.bindResultCursor.bind(ledger);
  ledger.bindResultCursor = (...args) => {
    bindAttempts += 1;
    const persisted = bindAttempts > 1 && bind(...args);
    if (persisted) resolveBound();
    return persisted;
  };
  const sender: PeonSocketSender = {
    durable: true,
    authority,
    generation: 1,
    send: () => true,
    sendBinary: () => false,
    sendDurable: () => {
      durableAttempts += 1;
      if (durableAttempts === 1) return { accepted: false, code: "OUTBOX_FULL", error: "full" };
      return { accepted: true, epoch: "epoch", cursor: "cursor", messageId: "message" };
    },
    disconnect: (reason) => assert.fail(reason),
  };
  const release = holdEventLoop();
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger,
      publicationRetryBaseMs: 1,
      publicationRetryMaxMs: 2,
      handlers: { "test.effect": { validate: () => null, execute: () => ({ status: "applied", code: "OK" }) } },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive(frame, sender);
    await bound;
    assert.ok(durableAttempts >= 3);
    assert.ok(bindAttempts >= 2);
    assert.equal(ledger.get(commandId)?.resultCursor, "cursor");
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal ledger persistence retries without executing the effect twice", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-terminal-retry-"));
  const ledger = new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") });
  const markTerminal = ledger.markTerminal.bind(ledger);
  let terminalAttempts = 0;
  let effects = 0;
  const durable: PeonSocketFrame[] = [];
  ledger.markTerminal = (...args) => {
    terminalAttempts += 1;
    return terminalAttempts > 1 && markTerminal(...args);
  };
  const sender: PeonSocketSender = {
    durable: true,
    authority,
    generation: 1,
    send: () => true,
    sendBinary: () => false,
    sendDurable: (message) => {
      durable.push(message);
      return { accepted: true, epoch: "epoch", cursor: "cursor", messageId: "message" };
    },
    disconnect: (reason) => assert.fail(reason),
  };
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger,
      publicationRetryBaseMs: 1,
      publicationRetryMaxMs: 2,
      handlers: {
        "test.effect": {
          validate: () => null,
          execute: () => {
            effects += 1;
            return { status: "applied", code: "OK" };
          },
        },
      },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive(frame, sender);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(effects, 1);
    assert.ok(terminalAttempts >= 2);
    assert.equal(ledger.get(commandId)?.state, "terminal");
    assert.equal(durable.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid session.cancel handler tuples fail closed to schema-valid INTERNAL", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-result-contract-"));
  const durable: PeonSocketFrame[] = [];
  const sender: PeonSocketSender = {
    durable: true,
    authority,
    generation: 1,
    send: () => true,
    sendBinary: () => false,
    sendDurable: (message) => {
      durable.push(message);
      return { accepted: true, epoch: "epoch", cursor: "cursor", messageId: "message" };
    },
    disconnect: (reason) => assert.fail(reason),
  };
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger: new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") }),
      handlers: {
        "session.cancel": {
          priority: "critical",
          validate: () => null,
          execute: () => ({ status: "applied", code: "OK", result: { sessionId, sessionStatus: "running" } }),
        },
      },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive({ ...frame, operation: "session.cancel" }, sender);
    await tick();
    assert.equal(durable.length, 1);
    assert.equal(durable[0]?.status, "failed");
    assert.equal(durable[0]?.code, "INTERNAL");
    assert.equal(durable[0]?.result, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual validation matches actor, timestamp, and target schema constraints", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-schema-"));
  let effects = 0;
  const sent: PeonSocketFrame[] = [];
  const sender: PeonSocketSender = {
    durable: true,
    authority,
    generation: 1,
    send: (message) => { sent.push(message); return true; },
    sendBinary: () => false,
    sendDurable: () => ({ accepted: true, epoch: "epoch", cursor: "cursor", messageId: "message" }),
    disconnect: (reason) => assert.fail(reason),
  };
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger: new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") }),
      handlers: { "test.effect": { validate: () => null, execute: () => { effects += 1; return { status: "applied", code: "OK" }; } } },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive({ ...frame, actor: { userId: "b169219d-45f6-4f42-b78f-3fb931dac7ee", email: "x" } }, sender);
    channel.receive({ ...frame, commandId: "118f4f0c-9f30-7a61-bf1a-66d2582bdb4a", requestedAt: -1 }, sender);
    channel.receive({
      ...frame,
      commandId: "218f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      target: { peonId, packageId: "../invalid-package" },
    }, sender);
    await tick();
    assert.equal(effects, 0);
    assert.equal(sent.filter((message) => message.code === "BAD_COMMAND").length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("critical cancel uses its reserved lane while normal capacity is saturated", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-command-critical-"));
  const normal = deferred();
  let cancelEffects = 0;
  const sender: PeonSocketSender = {
    durable: true,
    authority,
    generation: 1,
    send: () => true,
    sendBinary: () => false,
    sendDurable: () => ({ accepted: true, epoch: "epoch", cursor: randomUUID(), messageId: randomUUID() }),
    disconnect: (reason) => assert.fail(reason),
  };
  try {
    const channel = new ReverseCommandChannel({
      peonId: () => peonId,
      ledger: new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") }),
      maxConcurrency: 1,
      perSessionConcurrency: 1,
      handlers: {
        "test.normal": { priority: "normal", validate: () => null, execute: () => normal.promise.then(() => ({ status: "applied", code: "OK" })) },
        "session.cancel": { priority: "critical", validate: () => null, execute: () => { cancelEffects += 1; return { status: "applied", code: "OK" }; } },
      },
    });
    channel.started(sender);
    channel.negotiated(true, {}, sender);
    channel.receive({ ...frame, operation: "test.normal" }, sender);
    await tick();
    channel.receive({
      ...frame,
      commandId: "118f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      operation: "session.cancel",
    }, sender);
    await tick();
    assert.equal(cancelEffects, 1);
    normal.resolve();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
