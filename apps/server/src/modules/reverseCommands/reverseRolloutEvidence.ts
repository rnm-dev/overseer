export interface ReverseRolloutEvidence {
  conformance: {
    approved: boolean;
    sourceTask: "OVSR-151";
    reviewCommit: string;
    conformanceTestsPassed: number;
    realPeonTestsPassed: number;
  };
  deterministicLocalSoak: {
    passed: boolean;
    mode: "deterministic-local";
    configuredDurationMs: number;
    virtualTicks: number;
    peakQueued: number;
    reconnects: number;
    productionEvidence: false;
  };
  security: {
    approved: boolean;
  };
  production: {
    evidence: false;
    telemetry: boolean;
    noInboundSoak: boolean;
    rollbackExercise: boolean;
  };
}

// Reviewed, bounded evidence only. This deliberately excludes raw diagnostics,
// identifiers, payloads and error text. Local conformance is not production proof.
export const reverseRolloutEvidence: Readonly<ReverseRolloutEvidence> = {
  conformance: {
    approved: true,
    sourceTask: "OVSR-151",
    reviewCommit: "e3c9c71",
    conformanceTestsPassed: 49,
    realPeonTestsPassed: 75,
  },
  deterministicLocalSoak: {
    passed: true,
    mode: "deterministic-local",
    configuredDurationMs: 60_000,
    virtualTicks: 60_208,
    peakQueued: 214,
    reconnects: 64,
    productionEvidence: false,
  },
  security: {
    approved: false,
  },
  production: {
    evidence: false,
    telemetry: false,
    noInboundSoak: false,
    rollbackExercise: false,
  },
};
