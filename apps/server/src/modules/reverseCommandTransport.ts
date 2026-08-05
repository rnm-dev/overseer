import {
  getPeonConnection,
  peonConnectionVersion,
  peonConnectionSupports,
  peonConnectionSupportsCommand,
} from "./fleet/index.js";
import {
  runSelectedTransport,
  reverseRolloutPolicyFromEnv,
  selectPeonTransport,
  type PeonTransportPolicy,
  type PeonTransportReason,
  type ReverseRolloutPolicy,
} from "./transportSelection.js";
import { markReverseOperationSubmissionWired } from "./reverseRolloutReadiness.js";
import {
  REVERSE_COMMAND_CAPABILITY,
  type ReverseCommandOperation,
} from "./reverseCommands/index.js";

export interface ReverseCommandTransportUnavailable {
  status: 503;
  body: {
    error: "Peon transport is unavailable";
    code: "REVERSE_TRANSPORT_UNAVAILABLE";
    reason: PeonTransportReason;
  };
}

export function reverseCommandTransportUnavailable(
  reason: PeonTransportReason,
): ReverseCommandTransportUnavailable {
  return {
    status: 503,
    body: {
      error: "Peon transport is unavailable",
      code: "REVERSE_TRANSPORT_UNAVAILABLE",
      reason,
    },
  };
}

interface ReverseCommandTransportInput<T> {
  peonId: string;
  operation: ReverseCommandOperation;
  capability?: string;
  policy?: PeonTransportPolicy;
  rollout?: ReverseRolloutPolicy;
  acceptedReverseCommand?: boolean;
  reverse: () => Promise<T>;
  legacy: () => Promise<T>;
}

export function runReverseCommandTransport<T>(
  input: ReverseCommandTransportInput<T> & {
    unavailable: (reason: PeonTransportReason) => Promise<T>;
  },
): Promise<T>;
export function runReverseCommandTransport<T>(
  input: ReverseCommandTransportInput<T> & {
    unavailable?: undefined;
  },
): Promise<T | ReverseCommandTransportUnavailable>;
export async function runReverseCommandTransport<T>(
  input: ReverseCommandTransportInput<T> & {
    unavailable?: (reason: PeonTransportReason) => Promise<T>;
  },
): Promise<T | ReverseCommandTransportUnavailable> {
  const socket = getPeonConnection(input.peonId);
  const capability = input.capability ?? REVERSE_COMMAND_CAPABILITY;
  const selection = selectPeonTransport({
    connected: Boolean(socket),
    familyNegotiated: Boolean(socket
      && peonConnectionSupports(socket, capability)),
    operationNegotiated: Boolean(socket
      && peonConnectionSupportsCommand(socket, input.operation)),
    policy: input.policy,
    capability,
    peonId: input.peonId,
    peonVersion: socket ? peonConnectionVersion(socket) : undefined,
    rollout: input.rollout ?? reverseRolloutPolicyFromEnv(),
    acceptedReverseCommand: input.acceptedReverseCommand,
  });
  markReverseOperationSubmissionWired();
  return runSelectedTransport<T | ReverseCommandTransportUnavailable>(selection, {
    reverse: input.reverse,
    legacy: input.legacy,
    unavailable: input.unavailable
      ?? (async (reason) => reverseCommandTransportUnavailable(reason)),
  });
}
