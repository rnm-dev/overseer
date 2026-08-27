import {
  REVERSE_COMMAND_OPERATIONS,
  type ReverseCommandOperation,
} from "@rnm-dev/protocol";
import type { ReverseCommandHandler } from "./reverseCommandChannel.js";

// The keys of the handler tables are what helloState() advertises, so a handler
// that is missing or misspelled does not fail loudly — it narrows the
// negotiated capability set, and Overseer quietly routes that operation over
// the legacy HTTP path instead. Typing every table against this list turns that
// class of drift into a build error.
export { REVERSE_COMMAND_OPERATIONS };
export type { ReverseCommandOperation };

// Operations Overseer may send that this daemon does not implement yet. Such an
// operation keeps taking the legacy HTTP route, and listing it here is what
// makes that a decision rather than an accident — the family tables below stop
// demanding a handler for it. Empty today: every operation is implemented.
export const DEFERRED_REVERSE_COMMAND_OPERATIONS = [] as const satisfies readonly ReverseCommandOperation[];

export type DeferredReverseCommandOperation = typeof DEFERRED_REVERSE_COMMAND_OPERATIONS[number];

// Operations this daemon handles that no current Overseer sends. A newer Peon
// is allowed to run ahead of the server it talks to; the pair is listed so the
// asymmetry stays deliberate rather than accumulating unnoticed.
export const PEON_ONLY_REVERSE_COMMAND_OPERATIONS = [] as const;

export type PeonOnlyReverseCommandOperation = typeof PEON_ONLY_REVERSE_COMMAND_OPERATIONS[number];

export type HandledReverseCommandOperation =
  | Exclude<ReverseCommandOperation, DeferredReverseCommandOperation>
  | PeonOnlyReverseCommandOperation;

// Every operation of one family, minus the deferred ones, plus this daemon's
// own. A family table typed with this cannot omit an operation and cannot
// invent one.
export type ReverseCommandHandlersFor<Prefix extends string> =
  Record<Extract<HandledReverseCommandOperation, `${Prefix}.${string}`>, ReverseCommandHandler>;
