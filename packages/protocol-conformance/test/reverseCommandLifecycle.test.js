import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandLifecycleError,
  ReverseCommandLifecycleHarness,
  loadFixture,
} from "../src/index.js";

const fixture = loadFixture("reverse-command-lifecycle-v1.json");

function command(suffix = "") {
  return {
    ...structuredClone(fixture.command),
    commandId: suffix ? `018f4f0c-9f30-7a61-bf1a-66d2582bd${suffix.padStart(3, "0")}` : fixture.command.commandId,
  };
}

test("all published command lifecycle crash points converge to one effect and one commit", () => {
  assert.deepEqual(fixture.crashPoints, [
    "before_admission",
    "after_admission_before_accepted",
    "after_accepted_before_effect",
    "after_effect_before_terminal_persist",
    "after_effect_before_result_delivery",
    "after_result_commit_before_ack",
  ]);

  for (const [index, crashPoint] of fixture.crashPoints.entries()) {
    const harness = new ReverseCommandLifecycleHarness();
    const current = command(String(index + 1));
    let accepted = harness.submit(current, crashPoint === "before_admission" ? "drop" : "deliver");

    if (crashPoint === "before_admission") {
      harness.reconnect("overseer");
      accepted = harness.submit(current);
    } else if (crashPoint === "after_admission_before_accepted") {
      harness.deliverAccepted(accepted, "drop");
      harness.reconnect("peon");
      accepted = harness.submit(current);
      assert.equal(accepted.replayed, true);
    } else {
      harness.deliverAccepted(accepted);
      if (crashPoint === "after_accepted_before_effect") harness.reconnect("peon");
    }

    harness.deliverAccepted(accepted);
    let cursor = harness.execute(current.commandId, {
      fault: crashPoint === "after_effect_before_terminal_persist" ? "after-effect" : "deliver",
    });
    if (crashPoint === "after_effect_before_terminal_persist") {
      assert.equal(cursor, null);
      harness.reconnect("peon");
      assert.equal(harness.reconcile(current.commandId).state, "running");
      cursor = harness.execute(current.commandId);
    }
    if (crashPoint === "after_effect_before_result_delivery") harness.reconnect("peon");
    if (crashPoint === "after_result_commit_before_ack") {
      assert.equal(harness.deliverResult(cursor, "duplicate", "drop"), true);
      harness.reconnect("overseer");
    }
    harness.reconcile(current.commandId);
    harness.deliverResult(cursor, "duplicate");

    assert.deepEqual(harness.state(current.commandId), {
      peon: "terminal",
      overseer: "terminal",
      effects: 1,
      audits: 1,
      browserEvents: 1,
      projectionEffects: 1,
      acknowledgedCursor: 1,
    }, crashPoint);
  }
});

test("held stale accepted/result frames are generation fenced and replay reconciles", () => {
  const harness = new ReverseCommandLifecycleHarness();
  const current = command("20");
  const accepted = harness.submit(current);
  harness.transport.send(accepted, { fault: "hold" });
  const cursor = harness.execute(current.commandId);
  harness.results.sendCursor(cursor, "hold");
  harness.reconnect("overseer");

  for (const envelope of harness.transport.releaseHeld("reverse")) {
    assert.equal(harness.transport.accepts(envelope), false);
  }
  assert.equal(harness.state(current.commandId).overseer, "created");
  assert.equal(harness.reconcile(current.commandId).state, "terminal");
  assert.equal(harness.deliverResult(cursor), true);
  assert.equal(harness.state(current.commandId).effects, 1);
});

test("same ID changed request, bounds, and torn durable records fail closed", () => {
  const harness = new ReverseCommandLifecycleHarness({ maxCommands: 1 });
  const current = command("30");
  harness.submit(current);
  assert.throws(
    () => harness.submit({ ...current, payload: { changed: true } }),
    (error) => error instanceof CommandLifecycleError && error.code === "COMMAND_ID_REUSED",
  );
  assert.throws(
    () => harness.submit(command("31")),
    (error) => error instanceof CommandLifecycleError && error.code === "COMMAND_REGISTRY_FULL",
  );

  harness.peon.corrupt(current.commandId);
  harness.overseer.corrupt(current.commandId);
  harness.peon.recover();
  harness.overseer.recover();
  assert.deepEqual(harness.state(current.commandId), {
    peon: "unknown",
    overseer: "unknown",
    effects: 0,
    audits: 0,
    browserEvents: 0,
    projectionEffects: 0,
    acknowledgedCursor: 0,
  });
});
