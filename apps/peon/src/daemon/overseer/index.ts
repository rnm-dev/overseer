export { PeonSocketSupervisor, PeonSocketPool, peonSocket, peonSocketUrl } from "./socket/peonSocket.js";
export type { PeonSocketState, PeonSocketPoolState } from "./socket/peonSocket.js";
export type {
  PeonSocketDurableResult,
  PeonSocketDurableOptions,
  PeonSocketFrame,
  PeonSocketSender,
  PeonSocketChannel,
} from "./socket/peonSocketProtocol.js";
export { PeonSocketOutbox, type PeonSocketOutboxStatus } from "./socket/peonSocketOutbox.js";
export {
  createPeonRegistrar,
  peonRegistrar,
  registrationPayload,
  type PeonRegistrar,
} from "./peonRegistrar.js";
export { PeonSocketMultiplexer } from "./socket/peonSocketProtocol.js";
export { PEON_SOCKET_MAX_FRAME_BYTES } from "./socket/peonSocketProtocol.js";
export { PEON_SOCKET_DURABLE_DELIVERY_CAPABILITY } from "./socket/peonSocketOutbox.js";
export {
  REVERSE_COMMAND_CAPABILITY,
  REVERSE_COMMAND_MAX_BYTES,
  ReverseCommandChannel,
  sessionCancelHandler,
  type ReverseCommandChannelOptions,
  type ReverseCommandExecution,
  type ReverseCommandHandler,
  type ValidCommand,
} from "./socket/channels/reverseCommandChannel.js";
export {
  ReverseCommandLedger,
  type ReverseCommandAdmission,
  type ReverseCommandLedgerOptions,
  type ReverseCommandRecord,
  type ReverseCommandState,
} from "./socket/reverseCommandLedger.js";
export {
  armoryCommandHandlers,
  type ArmoryReverseServices,
} from "./socket/channels/armoryCommandHandlers.js";
