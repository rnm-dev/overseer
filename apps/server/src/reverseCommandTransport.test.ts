import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import {
  claimPeonConnection,
  releasePeonConnection,
} from "./peonConnections.js";
import {
  runReverseCommandTransport,
  type ReverseCommandTransportUnavailable,
} from "./modules/reverseCommandTransport.js";
import { REVERSE_COMMAND_CAPABILITY } from "./modules/reverseCommands/index.js";

const reverseOnly = {
  reverseRoutingEnabled: true,
  legacyCallbackFallbackEnabled: false,
};

test("production reverse transport refuses every callback when legacy fallback is disabled", async () => {
  let reverse = 0;
  let legacy = 0;
  const result = await runReverseCommandTransport({
    peonId: "offline-peon",
    operation: "runtime.stats",
    policy: reverseOnly,
    reverse: async () => { reverse += 1; return "reverse"; },
    legacy: async () => { legacy += 1; return "legacy"; },
  });
  assert.equal((result as ReverseCommandTransportUnavailable).status, 503);
  assert.equal((result as ReverseCommandTransportUnavailable).body.code, "REVERSE_TRANSPORT_UNAVAILABLE");
  assert.equal(reverse, 0);
  assert.equal(legacy, 0);
});

test("routing rollback and rollout denial select exactly one policy-authorized branch", async () => {
  const peonId = "transport-canary";
  const socket = { readyState: 1 } as WebSocket;
  claimPeonConnection(
    peonId,
    socket,
    [REVERSE_COMMAND_CAPABILITY],
    ["runtime.stats"],
    0,
    "2.4.0",
  );
  try {
    let reverse = 0;
    let legacy = 0;
    const unavailable = await runReverseCommandTransport({
      peonId,
      operation: "runtime.stats",
      policy: { reverseRoutingEnabled: false, legacyCallbackFallbackEnabled: false },
      reverse: async () => { reverse += 1; return "reverse"; },
      legacy: async () => { legacy += 1; return "legacy"; },
    });
    assert.equal((unavailable as ReverseCommandTransportUnavailable).body.reason, "reverse-routing-disabled");
    assert.equal(reverse, 0);
    assert.equal(legacy, 0);

    const rolledBack = await runReverseCommandTransport({
      peonId,
      operation: "runtime.stats",
      policy: { reverseRoutingEnabled: true, legacyCallbackFallbackEnabled: true },
      rollout: {
        valid: true,
        capabilities: new Map([[REVERSE_COMMAND_CAPABILITY, { stage: "off" }]]),
      },
      reverse: async () => { reverse += 1; return "reverse"; },
      legacy: async () => { legacy += 1; return "legacy"; },
    });
    assert.equal(rolledBack, "legacy");
    assert.equal(reverse, 0);
    assert.equal(legacy, 1);

    const versionAllowed = await runReverseCommandTransport({
      peonId,
      operation: "runtime.stats",
      policy: reverseOnly,
      rollout: {
        valid: true,
        capabilities: new Map([[
          REVERSE_COMMAND_CAPABILITY,
          { stage: "default", minimumVersion: "2.4.0" },
        ]]),
      },
      reverse: async () => { reverse += 1; return "reverse"; },
      legacy: async () => { legacy += 1; return "legacy"; },
    });
    assert.equal(versionAllowed, "reverse");
    assert.equal(reverse, 1);
    assert.equal(legacy, 1);
  } finally {
    releasePeonConnection(peonId, socket);
  }
});

test("accepted reverse authority reconciles after rollback without a legacy effect", async () => {
  let reverse = 0;
  let legacy = 0;
  const result = await runReverseCommandTransport({
    peonId: "reconciling-peon",
    operation: "session.metadata.patch",
    acceptedReverseCommand: true,
    policy: { reverseRoutingEnabled: false, legacyCallbackFallbackEnabled: false },
    reverse: async () => { reverse += 1; return "reconciled"; },
    legacy: async () => { legacy += 1; return "legacy"; },
  });
  assert.equal(result, "reconciled");
  assert.equal(reverse, 1);
  assert.equal(legacy, 0);
});
