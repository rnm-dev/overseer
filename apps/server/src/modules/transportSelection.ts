export type PeonTransport = "reverse" | "legacy" | "unavailable";

export type PeonTransportReason =
  | "reverse-capability-authoritative"
  | "reverse-routing-disabled"
  | "reverse-rollout-disabled"
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

export type ReverseRolloutStage = "off" | "allowlist" | "cohort" | "default";

export interface ReverseCapabilityRollout {
  stage: ReverseRolloutStage;
  minimumVersion?: string;
  cohortPercent?: number;
  allowlistedPeonIds?: ReadonlySet<string>;
}

export interface ReverseRolloutPolicy {
  capabilities: ReadonlyMap<string, ReverseCapabilityRollout>;
}

export interface TransportTelemetrySnapshot {
  selections: Readonly<Record<PeonTransport, number>>;
  reasons: Readonly<Record<PeonTransportReason, number>>;
  callbackAttempts: Readonly<Record<PeonTransportReason, number>>;
}

const callbackAttempts = new Map<PeonTransportReason, number>();
const selections = new Map<PeonTransport, number>();
const selectionReasons = new Map<PeonTransportReason, number>();

const CAPABILITY_NAME = /^[a-z][a-z0-9-]{0,63}-v[1-9][0-9]*$/;
const VERSION = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/;

function counts<T extends string>(keys: readonly T[], values: ReadonlyMap<T, number>): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, values.get(key) ?? 0])) as Record<T, number>;
}

const transports: readonly PeonTransport[] = ["reverse", "legacy", "unavailable"];
const reasons: readonly PeonTransportReason[] = [
  "reverse-capability-authoritative",
  "reverse-routing-disabled",
  "reverse-rollout-disabled",
  "legacy-mixed-version-fallback",
  "reverse-capability-incomplete",
];

export function legacyCallbackAttemptCounts(): Readonly<Record<PeonTransportReason, number>> {
  return {
    "reverse-capability-authoritative": callbackAttempts.get("reverse-capability-authoritative") ?? 0,
    "reverse-routing-disabled": callbackAttempts.get("reverse-routing-disabled") ?? 0,
    "reverse-rollout-disabled": callbackAttempts.get("reverse-rollout-disabled") ?? 0,
    "legacy-mixed-version-fallback": callbackAttempts.get("legacy-mixed-version-fallback") ?? 0,
    "reverse-capability-incomplete": callbackAttempts.get("reverse-capability-incomplete") ?? 0,
  };
}

export function resetLegacyCallbackAttemptCountsForTest(): void {
  callbackAttempts.clear();
}

export function transportTelemetrySnapshot(): TransportTelemetrySnapshot {
  return {
    selections: counts(transports, selections),
    reasons: counts(reasons, selectionReasons),
    callbackAttempts: counts(reasons, callbackAttempts),
  };
}

export function resetTransportTelemetryForTest(): void {
  callbackAttempts.clear();
  selections.clear();
  selectionReasons.clear();
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = VERSION.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(actual: string | undefined, minimum: string | undefined): boolean {
  if (!minimum) return true;
  if (!actual) return false;
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return true;
}

function cohortBucket(capability: string, peonId: string): number {
  // FNV-1a gives a stable, non-secret cohort assignment without emitting the
  // Peon ID as a metric label. It is selection, not a security boundary.
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(`${capability}\0${peonId}`, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export function capabilityRolloutAllows(input: {
  capability: string;
  peonId: string;
  peonVersion?: string;
  rollout?: ReverseRolloutPolicy;
}): boolean {
  const rule = input.rollout?.capabilities.get(input.capability);
  // No rollout policy means the pre-OVSR-152 behavior remains unchanged.
  if (!rule) return true;
  if (!CAPABILITY_NAME.test(input.capability)) return false;
  if (!versionAtLeast(input.peonVersion, rule.minimumVersion)) return false;
  if (rule.stage === "off") return false;
  if (rule.stage === "default") return true;
  if (rule.allowlistedPeonIds?.has(input.peonId)) return true;
  if (rule.stage === "allowlist") return false;
  const percent = Math.max(0, Math.min(100, Math.floor(rule.cohortPercent ?? 0)));
  return cohortBucket(input.capability, input.peonId) < percent;
}

export function reverseRolloutPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReverseRolloutPolicy {
  const capabilities = new Map<string, ReverseCapabilityRollout>();
  for (const entry of (env.OVERSEER_REVERSE_CAPABILITY_ROLLOUT ?? "").split(",")) {
    const [capability, stage, minimumVersion, percent] = entry.split(":").map((part) => part.trim());
    if (!capability && !stage) continue;
    if (!CAPABILITY_NAME.test(capability)
      || !["off", "allowlist", "cohort", "default"].includes(stage)
      || (minimumVersion && !parseVersion(minimumVersion))
      || (percent && (!/^\d{1,3}$/.test(percent) || Number(percent) > 100))) {
      // Malformed entries fail closed for that named capability. Invalid names
      // are ignored because they can never match a negotiated capability.
      if (CAPABILITY_NAME.test(capability)) capabilities.set(capability, { stage: "off" });
      continue;
    }
    const allowlistedPeonIds = new Set(
      (env[`OVERSEER_REVERSE_ALLOWLIST_${capability.toUpperCase().replace(/-/g, "_")}`] ?? "")
        .split(";").map((value) => value.trim()).filter(Boolean),
    );
    capabilities.set(capability, {
      stage: stage as ReverseRolloutStage,
      ...(minimumVersion ? { minimumVersion } : {}),
      ...(percent ? { cohortPercent: Number(percent) } : {}),
      ...(allowlistedPeonIds.size ? { allowlistedPeonIds } : {}),
    });
  }
  return { capabilities };
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
  capability?: string;
  peonId?: string;
  peonVersion?: string;
  rollout?: ReverseRolloutPolicy;
}): PeonTransportSelection {
  const policy = input.policy ?? transportPolicyFromEnv();
  const rolloutAllowed = !input.capability || (!!input.peonId && capabilityRolloutAllows({
    capability: input.capability,
    peonId: input.peonId,
    peonVersion: input.peonVersion,
    rollout: input.rollout,
  }));
  const reverseReady = input.connected && input.familyNegotiated
    && input.operationNegotiated && rolloutAllowed;

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
  if (input.connected && input.familyNegotiated && input.operationNegotiated && !rolloutAllowed) {
    return policy.legacyCallbackFallbackEnabled
      ? { transport: "legacy", reason: "reverse-rollout-disabled", callbackAllowed: true }
      : { transport: "unavailable", reason: "reverse-rollout-disabled", callbackAllowed: false };
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
  selections.set(selection.transport, (selections.get(selection.transport) ?? 0) + 1);
  selectionReasons.set(selection.reason, (selectionReasons.get(selection.reason) ?? 0) + 1);
  if (selection.transport === "reverse") return handlers.reverse();
  if (selection.transport === "legacy") {
    callbackAttempts.set(selection.reason, (callbackAttempts.get(selection.reason) ?? 0) + 1);
    return handlers.legacy();
  }
  return handlers.unavailable(selection.reason);
}
