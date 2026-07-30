export type PeonTransport = "reverse" | "legacy" | "unavailable";

export type PeonTransportReason =
  | "reverse-capability-authoritative"
  | "reverse-routing-disabled"
  | "legacy-mixed-version-fallback"
  | "reverse-capability-incomplete";

export interface PeonTransportSelection {
  transport: PeonTransport;
  reason: PeonTransportReason;
  callbackAllowed: boolean;
}

export interface PeonTransportPolicy {
  reverseRoutingEnabled: boolean;
  legacyCallbackFallbackEnabled: boolean;
}

const callbackAttempts = new Map<PeonTransportReason, number>();

export function legacyCallbackAttemptCounts(): Readonly<Record<PeonTransportReason, number>> {
  return {
    "reverse-capability-authoritative": callbackAttempts.get("reverse-capability-authoritative") ?? 0,
    "reverse-routing-disabled": callbackAttempts.get("reverse-routing-disabled") ?? 0,
    "legacy-mixed-version-fallback": callbackAttempts.get("legacy-mixed-version-fallback") ?? 0,
    "reverse-capability-incomplete": callbackAttempts.get("reverse-capability-incomplete") ?? 0,
  };
}

export function resetLegacyCallbackAttemptCountsForTest(): void {
  callbackAttempts.clear();
}

export function transportPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PeonTransportPolicy {
  return {
    // Reverse routing is already the released per-capability path. This switch is
    // the emergency rollback: it restores the legacy route without deleting it.
    reverseRoutingEnabled: env.OVERSEER_REVERSE_ROUTING !== "0",
    // Keep mixed-version fleets working until OVSR-150/151/152 have passed.
    // Setting this to 0 is a later rollout gate, not the current default.
    legacyCallbackFallbackEnabled: env.OVERSEER_LEGACY_CALLBACK_FALLBACK !== "0",
  };
}

export function selectPeonTransport(input: {
  connected: boolean;
  familyNegotiated: boolean;
  operationNegotiated: boolean;
  policy?: PeonTransportPolicy;
}): PeonTransportSelection {
  const policy = input.policy ?? transportPolicyFromEnv();
  const reverseReady = input.connected && input.familyNegotiated && input.operationNegotiated;

  if (policy.reverseRoutingEnabled && reverseReady) {
    return {
      transport: "reverse",
      reason: "reverse-capability-authoritative",
      callbackAllowed: false,
    };
  }
  if (!policy.reverseRoutingEnabled && reverseReady) {
    return policy.legacyCallbackFallbackEnabled
      ? { transport: "legacy", reason: "reverse-routing-disabled", callbackAllowed: true }
      : { transport: "unavailable", reason: "reverse-routing-disabled", callbackAllowed: false };
  }
  if (input.connected && input.familyNegotiated && !input.operationNegotiated) {
    return policy.legacyCallbackFallbackEnabled
      ? { transport: "legacy", reason: "reverse-capability-incomplete", callbackAllowed: true }
      : { transport: "unavailable", reason: "reverse-capability-incomplete", callbackAllowed: false };
  }
  return policy.legacyCallbackFallbackEnabled
    ? { transport: "legacy", reason: "legacy-mixed-version-fallback", callbackAllowed: true }
    : { transport: "unavailable", reason: "legacy-mixed-version-fallback", callbackAllowed: false };
}

export async function runSelectedTransport<T>(
  selection: PeonTransportSelection,
  handlers: {
    reverse: () => Promise<T>;
    legacy: () => Promise<T>;
    unavailable: (reason: PeonTransportReason) => Promise<T>;
  },
): Promise<T> {
  if (selection.transport === "reverse") return handlers.reverse();
  if (selection.transport === "legacy") {
    callbackAttempts.set(selection.reason, (callbackAttempts.get(selection.reason) ?? 0) + 1);
    return handlers.legacy();
  }
  return handlers.unavailable(selection.reason);
}
