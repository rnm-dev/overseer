import assert from "node:assert/strict";
import test from "node:test";
import {
  loadFixture,
  NoInboundTopology,
  runCapabilityMatrix,
  TopologyViolation,
} from "../src/index.js";

test("the stable current slice keeps the complete file plane on Fleet HTTP mesh", () => {
  const matrix = runCapabilityMatrix(loadFixture("capability-matrix-v1.json"));
  const current = matrix.cells.find((cell) => cell.peon === "current" && cell.overseer === "current");
  assert.ok(current?.passed);

  const topology = new NoInboundTopology({ peonFleetPortBlocked: true });
  topology.openConnection({ initiator: "peon", target: "overseer", channel: "control" });
  for (const [surface, route] of Object.entries(current.routes)) topology.exercise(surface, route);
  assert.equal(topology.assertNoInboundAttempts(), true);
  assert.equal(current.routes["absolute-folder-picker"], "legacy-http");
  assert.equal(current.routes["project-directory"], "legacy-http");
  assert.equal(current.routes["project-file-read"], "legacy-http");
  assert.equal(current.routes["project-file-upload"], "legacy-http");
});

test("an Overseer dial or legacy fallback fails the NAT/no-inbound assertion", () => {
  const topology = new NoInboundTopology({ peonFleetPortBlocked: true });
  assert.throws(
    () => topology.openConnection({ initiator: "overseer", target: "peon", channel: "4570" }),
    (error) => error instanceof TopologyViolation && error.code === "INBOUND_PEON_DIAL",
  );
  assert.throws(() => topology.assertNoInboundAttempts(), TopologyViolation);

  const legacy = new NoInboundTopology({ peonFleetPortBlocked: true });
  assert.throws(() => legacy.exercise("session-catalog", "legacy-http"), TopologyViolation);
});

test("the retired transfer channel is rejected", () => {
  const topology = new NoInboundTopology({ peonFleetPortBlocked: false });
  assert.throws(
    () => topology.openConnection({ initiator: "peon", target: "overseer", channel: "file-transfer" }),
    /unknown reverse channel/,
  );
});
