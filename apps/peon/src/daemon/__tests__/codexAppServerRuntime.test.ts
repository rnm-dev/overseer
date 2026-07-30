import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  CodexAppServerError,
  CodexAppServerRuntime,
  MIN_CODEX_APP_SERVER_VERSION,
  type CodexAppServerHealth,
  type CodexAppServerNotification,
} from "../agents/runtimes/codexAppServerRuntime.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fakeCodexAppServer.mjs");

function runtime(overrides: ConstructorParameters<typeof CodexAppServerRuntime>[0] = { command: process.execPath }) {
  return new CodexAppServerRuntime({
    command: process.execPath,
    args: [fixture],
    versionArgs: [fixture, "--version"],
    requestTimeoutMs: 3_000,
    restartInitialDelayMs: 10,
    restartMaxDelayMs: 20,
    restartStabilityMs: 50,
    ...overrides,
  });
}

async function waitForHealth(instance: CodexAppServerRuntime, predicate: (health: CodexAppServerHealth) => boolean, timeoutMs = 3_000) {
  const current = instance.getHealth();
  if (predicate(current)) return current;
  return new Promise<CodexAppServerHealth>((resolve, reject) => {
    const timer = setTimeout(() => {
      instance.off("health", onHealth);
      reject(new Error(`timed out waiting for runtime health; current=${JSON.stringify(instance.getHealth())}`));
    }, timeoutMs);
    const onHealth = (health: CodexAppServerHealth) => {
      if (!predicate(health)) return;
      clearTimeout(timer);
      instance.off("health", onHealth);
      resolve(health);
    };
    instance.on("health", onHealth);
  });
}

describe("Codex app-server runtime", () => {
  it("initializes once and correlates concurrent responses without crossover", async () => {
    const instance = runtime();
    try {
      await instance.start();
      assert.equal(instance.getHealth().status, "healthy");
      assert.equal(instance.getHealth().version, "0.144.5");
      assert.deepEqual(instance.getHealth().capabilities, { experimentalApi: false });
      const [slow, fast] = await Promise.all([
        instance.request<{ value: string }>("test/echo", { value: "slow", delay: 30 }),
        instance.request<{ value: string }>("test/echo", { value: "fast", delay: 0 }),
      ]);
      assert.equal(slow.value, "slow");
      assert.equal(fast.value, "fast");
      assert.equal(instance.getHealth().pendingRequests, 0);
    } finally {
      await instance.stop();
    }
  });

  it("routes notifications by thread and turn identity", async () => {
    const instance = runtime();
    const all: CodexAppServerNotification[] = [];
    const threads: CodexAppServerNotification[] = [];
    const turns: CodexAppServerNotification[] = [];
    try {
      await instance.start();
      instance.onNotification((event) => all.push(event));
      instance.onThreadNotification("thread-a", (event) => threads.push(event));
      const routed = new Promise<void>((resolve) => instance.onTurnNotification("turn-a", (event) => {
        turns.push(event);
        resolve();
      }));
      await instance.request("test/route", { threadId: "thread-a", turnId: "turn-a" });
      await routed;
      assert.deepEqual(all.map((event) => event.method), ["turn/started"]);
      assert.equal(threads.length, 1);
      assert.equal(turns.length, 1);
      assert.equal(turns[0].threadId, "thread-a");
    } finally {
      await instance.stop();
    }
  });

  it("handles server-initiated requests without blocking the transport", async () => {
    const instance = runtime();
    try {
      await instance.start();
      instance.registerRequestHandler("approval/request", async (params) => ({ decision: "denied", params }));
      const response = new Promise<CodexAppServerNotification>((resolve) => {
        const unsubscribe = instance.onNotification((notification) => {
          if (notification.method !== "test/serverResponse") return;
          unsubscribe();
          resolve(notification);
        });
      });
      await instance.request("test/serverRequest", { command: "dangerous" });
      const notification = await response;
      assert.deepEqual(notification.params, {
        id: "server-request-1",
        result: { decision: "denied", params: { command: "dangerous" } },
      });
    } finally {
      await instance.stop();
    }
  });

  it("reports deterministic timeout and overload errors", async () => {
    const instance = runtime({ command: process.execPath, maxPendingRequests: 1 });
    try {
      await instance.start();
      const hanging = instance.request("test/hang", undefined, 100);
      await assert.rejects(instance.request("test/echo", { value: "blocked" }), (error: unknown) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.equal(error.code, "overloaded");
        return true;
      });
      await assert.rejects(hanging, (error: unknown) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.equal(error.code, "request_timeout");
        return true;
      });
    } finally {
      await instance.stop();
    }
  });

  it("ignores a late response to an expired request without restarting", async () => {
    const instance = runtime();
    try {
      await instance.start();
      const generation = instance.getHealth().generation;
      await assert.rejects(instance.request("test/late", undefined, 40), (error: unknown) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.equal(error.code, "request_timeout");
        return true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(instance.getHealth().status, "healthy");
      assert.equal(instance.getHealth().generation, generation);
    } finally {
      await instance.stop();
    }
  });

  it("fails an unavailable executable with an actionable spawn error", async () => {
    const instance = runtime({ command: path.join(path.dirname(fixture), "missing-codex-binary") });
    await assert.rejects(instance.start(), (error: unknown) => {
      assert.ok(error instanceof CodexAppServerError);
      assert.equal(error.code, "spawn_failed");
      assert.match(error.message, /version probe/i);
      return true;
    });
    await instance.stop();
  });

  it("bounds outbound payloads and keeps the runtime usable", async () => {
    const instance = runtime({ command: process.execPath, maxPayloadBytes: 512 });
    try {
      await instance.start();
      await assert.rejects(instance.request("test/echo", { value: "x".repeat(1_000) }), (error: unknown) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.equal(error.code, "overloaded");
        return true;
      });
      assert.deepEqual(await instance.request("test/echo", { usable: true }), { usable: true });
    } finally {
      await instance.stop();
    }
  });

  it("rejects incompatible versions before spawning app-server", async () => {
    const instance = runtime({ command: process.execPath, env: { FAKE_CODEX_VERSION: "0.143.9" } });
    await assert.rejects(instance.start(), (error: unknown) => {
      assert.ok(error instanceof CodexAppServerError);
      assert.equal(error.code, "incompatible_version");
      assert.match(error.message, new RegExp(`requires >=${MIN_CODEX_APP_SERVER_VERSION.replaceAll(".", "\\.")}`));
      return true;
    });
    assert.equal(instance.getHealth().status, "incompatible");
    await assert.rejects(instance.start(), (error: unknown) => {
      assert.ok(error instanceof CodexAppServerError);
      assert.equal(error.code, "incompatible_version");
      return true;
    });
    await instance.stop();
  });

  it("fails malformed protocol, restarts, and fences the replaced generation", async () => {
    const instance = runtime();
    instance.on("runtimeError", () => {});
    try {
      await instance.start();
      const originalGeneration = instance.getHealth().generation;
      await assert.rejects(instance.request("test/malformed"), (error: unknown) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.equal(error.code, "protocol_error");
        return true;
      });
      const recovered = await waitForHealth(instance, (health) => health.status === "healthy" && health.generation > originalGeneration);
      assert.equal(recovered.pendingRequests, 0);
      assert.deepEqual(await instance.request("test/echo", { recovered: true }), { recovered: true });
    } finally {
      await instance.stop();
    }
  });

  it("recovers after unexpected process exit with bounded restart", async () => {
    const instance = runtime();
    instance.on("runtimeError", () => {});
    try {
      await instance.start();
      const originalGeneration = instance.getHealth().generation;
      await assert.rejects(instance.request("test/crash"), (error: unknown) => {
        assert.ok(error instanceof CodexAppServerError);
        assert.equal(error.code, "runtime_exited");
        return true;
      });
      await waitForHealth(instance, (health) => health.status === "healthy" && health.generation > originalGeneration);
      assert.deepEqual(await instance.request("test/echo", { alive: true }), { alive: true });
    } finally {
      await instance.stop();
    }
  });

  it("drops a server-request callback from a replaced runtime generation", async () => {
    const instance = runtime();
    instance.on("runtimeError", () => {});
    let handlerCompleted = false;
    instance.registerRequestHandler("approval/slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      handlerCompleted = true;
      return { decision: "denied" };
    });
    try {
      await instance.start();
      const originalGeneration = instance.getHealth().generation;
      await instance.request("test/serverRequestAndCrash", {});
      await waitForHealth(instance, (health) => health.status === "healthy" && health.generation > originalGeneration);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(handlerCompleted, true);
      assert.equal(instance.getHealth().status, "healthy");
      assert.deepEqual(await instance.request("test/echo", { generation: "new" }), { generation: "new" });
    } finally {
      await instance.stop();
    }
  });

  it("stops a persistent crash loop after the configured restart budget", async () => {
    const instance = runtime({
      command: process.execPath,
      env: { FAKE_EXIT_AFTER_INITIALIZED: "1" },
      maxRestartAttempts: 2,
      restartStabilityMs: 1_000,
    });
    instance.on("runtimeError", () => {});
    try {
      await instance.start();
      const failed = await waitForHealth(instance, (health) => health.status === "failed", 2_000);
      assert.equal(failed.restartAttempts, 3);
      assert.equal(failed.generation, 3);
      assert.equal(failed.lastError?.code, "runtime_exited");
    } finally {
      await instance.stop();
    }
  });

  it("remains stopped after terminating the child process", async () => {
    const instance = runtime();
    await instance.start();
    await instance.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(instance.getHealth().status, "stopped");
  });
});
