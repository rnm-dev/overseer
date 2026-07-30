import {
  runSelectedTransport,
  selectPeonTransport,
  transportTelemetrySnapshot,
  type PeonTransportReason,
} from "./transportSelection.js";
import { reverseCommandMetricsSnapshot } from "./reverseCommands/index.js";

const wiredSurfaces = new Set<ReverseRolloutSurface>();

export type ReverseRolloutSurface =
  | "command-status-reconciliation"
  | "operation-submission";

export interface ReverseRolloutReadiness {
  ready: false;
  local: {
    wiredSurfaces: Readonly<Record<ReverseRolloutSurface, boolean>>;
    transport: ReturnType<typeof transportTelemetrySnapshot>;
    commandLifecycle: ReturnType<typeof reverseCommandMetricsSnapshot>;
  };
  operationalGates: {
    productionTelemetry: false;
    noInboundSoak: false;
    rollbackExercise: false;
    securityApproval: false;
    conformanceApproval: false;
  };
  blockers: readonly string[];
}

export async function runAcceptedReverseReconciliation<T>(
  reverse: () => Promise<T>,
): Promise<T> {
  wiredSurfaces.add("command-status-reconciliation");
  const selection = selectPeonTransport({
    connected: false,
    familyNegotiated: false,
    operationNegotiated: false,
    acceptedReverseCommand: true,
  });
  return runSelectedTransport(selection, {
    reverse,
    legacy: () => {
      throw new Error("accepted reverse authority cannot execute a legacy callback");
    },
    unavailable: (reason: PeonTransportReason) => {
      throw new Error(`accepted reverse authority unexpectedly unavailable: ${reason}`);
    },
  });
}

// This is a process-local, redacted diagnostic input for operators/exporters,
// not production acceptance evidence. All dimensions are fixed allowlists.
export function reverseRolloutReadinessSnapshot(): ReverseRolloutReadiness {
  return {
    ready: false,
    local: {
      wiredSurfaces: {
        "command-status-reconciliation": wiredSurfaces.has("command-status-reconciliation"),
        "operation-submission": wiredSurfaces.has("operation-submission"),
      },
      transport: transportTelemetrySnapshot(),
      commandLifecycle: reverseCommandMetricsSnapshot(),
    },
    operationalGates: {
      productionTelemetry: false,
      noInboundSoak: false,
      rollbackExercise: false,
      securityApproval: false,
      conformanceApproval: false,
    },
    blockers: [
      "operation submission call sites are not fully wired through rollout selection",
      "production telemetry has not proved zero capable-Peon callbacks",
      "the sustained no-inbound soak has not run",
      "rollback after accepted admission has not been exercised in production",
      "security and conformance cutover approval is not recorded",
    ],
  };
}

export function resetReverseRolloutReadinessForTest(): void {
  wiredSurfaces.clear();
}
