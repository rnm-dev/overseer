import {
  runSelectedTransport,
  selectPeonTransport,
  transportTelemetrySnapshot,
  type PeonTransportReason,
} from "./transportSelection.js";
import { reverseCommandMetricsSnapshot } from "./reverseCommands/index.js";
import {
  reverseRolloutEvidence,
  type ReverseRolloutEvidence,
} from "./reverseRolloutEvidence.js";
import { reverseTransportMetricsSnapshot } from "./reverseTransportMetrics.js";

const wiredSurfaces = new Set<ReverseRolloutSurface>();

export function markReverseOperationSubmissionWired(): void {
  wiredSurfaces.add("operation-submission");
}

export type ReverseRolloutSurface =
  | "command-status-reconciliation"
  | "operation-submission";

export interface ReverseRolloutReadiness {
  ready: boolean;
  reverseOnlyDefaultAllowed: boolean;
  evidence: Readonly<ReverseRolloutEvidence>;
  local: {
    wiredSurfaces: Readonly<Record<ReverseRolloutSurface, boolean>>;
    transport: ReturnType<typeof transportTelemetrySnapshot>;
    commandLifecycle: ReturnType<typeof reverseCommandMetricsSnapshot>;
    transportSignals: ReturnType<typeof reverseTransportMetricsSnapshot>;
  };
  operationalGates: {
    productionEvidence: boolean;
    productionTelemetry: boolean;
    noInboundSoak: boolean;
    rollbackExercise: boolean;
    securityApproval: boolean;
    conformanceApproval: boolean;
    deterministicLocalSoak: boolean;
  };
  dashboard: readonly ReverseRolloutDashboardPanel[];
  alerts: readonly ReverseRolloutAlert[];
  blockers: readonly string[];
}

export interface ReverseRolloutDashboardPanel {
  code:
    | "transport-selection"
    | "callback-attempts"
    | "command-lifecycle"
    | "transfer-negotiation"
    | "production-acceptance";
  source: "process-counter" | "reviewed-evidence";
  available: boolean;
}

export interface ReverseRolloutAlert {
  code:
    | "production-evidence-missing"
    | "security-approval-missing"
    | "operation-submission-unwired"
    | "capable-callback-observed";
  severity: "blocker" | "critical";
  active: boolean;
}

export interface ReverseOnlyGateInput {
  operationSubmissionWired: boolean;
  conformanceApproved: boolean;
  deterministicLocalSoakPassed: boolean;
  securityApproved: boolean;
  productionEvidence: boolean;
  productionTelemetry: boolean;
  noInboundSoak: boolean;
  rollbackExercise: boolean;
}

export function evaluateReverseOnlyDefault(input: ReverseOnlyGateInput): boolean {
  return Object.values(input).every((gate) => gate === true);
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
  const operationSubmissionWired = wiredSurfaces.has("operation-submission");
  const transport = transportTelemetrySnapshot();
  const capableCallbackObserved =
    transport.callbackAttempts["reverse-capability-authoritative"] > 0;
  const gates: ReverseOnlyGateInput = {
    operationSubmissionWired,
    conformanceApproved: reverseRolloutEvidence.conformance.approved,
    deterministicLocalSoakPassed: reverseRolloutEvidence.deterministicLocalSoak.passed,
    securityApproved: reverseRolloutEvidence.security.approved,
    productionEvidence: reverseRolloutEvidence.production.evidence,
    productionTelemetry: reverseRolloutEvidence.production.telemetry,
    noInboundSoak: reverseRolloutEvidence.production.noInboundSoak,
    rollbackExercise: reverseRolloutEvidence.production.rollbackExercise,
  };
  const reverseOnlyDefaultAllowed = evaluateReverseOnlyDefault(gates);
  return {
    ready: reverseOnlyDefaultAllowed,
    reverseOnlyDefaultAllowed,
    evidence: reverseRolloutEvidence,
    local: {
      wiredSurfaces: {
        "command-status-reconciliation": wiredSurfaces.has("command-status-reconciliation"),
        "operation-submission": operationSubmissionWired,
      },
      transport,
      commandLifecycle: reverseCommandMetricsSnapshot(),
      transportSignals: reverseTransportMetricsSnapshot(),
    },
    operationalGates: {
      productionEvidence: reverseRolloutEvidence.production.evidence,
      productionTelemetry: reverseRolloutEvidence.production.telemetry,
      noInboundSoak: reverseRolloutEvidence.production.noInboundSoak,
      rollbackExercise: reverseRolloutEvidence.production.rollbackExercise,
      securityApproval: reverseRolloutEvidence.security.approved,
      conformanceApproval: reverseRolloutEvidence.conformance.approved,
      deterministicLocalSoak: reverseRolloutEvidence.deterministicLocalSoak.passed,
    },
    dashboard: [
      { code: "transport-selection", source: "process-counter", available: true },
      { code: "callback-attempts", source: "process-counter", available: true },
      { code: "command-lifecycle", source: "process-counter", available: true },
      { code: "transfer-negotiation", source: "process-counter", available: true },
      {
        code: "production-acceptance",
        source: "reviewed-evidence",
        available: reverseRolloutEvidence.production.evidence,
      },
    ],
    alerts: [
      {
        code: "production-evidence-missing",
        severity: "blocker",
        active: !reverseRolloutEvidence.production.evidence,
      },
      {
        code: "security-approval-missing",
        severity: "blocker",
        active: !reverseRolloutEvidence.security.approved,
      },
      {
        code: "operation-submission-unwired",
        severity: "blocker",
        active: !operationSubmissionWired,
      },
      {
        code: "capable-callback-observed",
        severity: "critical",
        active: capableCallbackObserved,
      },
    ],
    blockers: [
      ...(!operationSubmissionWired
        ? ["operation submission call sites are not fully wired through rollout selection"]
        : []),
      ...(!reverseRolloutEvidence.production.telemetry
        ? ["production telemetry has not proved zero capable-Peon callbacks"]
        : []),
      ...(!reverseRolloutEvidence.production.noInboundSoak
        ? ["the sustained production no-inbound soak has not run"]
        : []),
      ...(!reverseRolloutEvidence.production.rollbackExercise
        ? ["rollback after accepted admission has not been exercised in production"]
        : []),
      ...(!reverseRolloutEvidence.security.approved
        ? ["security cutover approval is not recorded"]
        : []),
      ...(capableCallbackObserved
        ? ["a callback attempt was observed after reverse capability became authoritative"]
        : []),
    ],
  };
}

export function resetReverseRolloutReadinessForTest(): void {
  wiredSurfaces.clear();
}
