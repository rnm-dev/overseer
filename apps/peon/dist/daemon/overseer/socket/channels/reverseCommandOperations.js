// This daemon's statement of the reverse-command-v1 operation set. Overseer
// keeps the same list in its reverseCommandTypes.ts; packages/protocol
// (OVSR-239) will collapse the two into one artifact, and until then
// @rnm-dev/protocol-conformance asserts that they still agree.
//
// The keys of the handler tables are what helloState() advertises, so a handler
// that is missing or misspelled does not fail loudly — it narrows the
// negotiated capability set, and Overseer quietly routes that operation over
// the legacy HTTP path instead. Typing every table against this list turns that
// class of drift into a build error.
export const REVERSE_COMMAND_OPERATIONS = [];
// Operations Overseer may send that this daemon does not implement yet. Such an
// operation keeps taking the legacy HTTP route, and listing it here is what
// makes that a decision rather than an accident — the family tables below stop
// demanding a handler for it. Empty today: every operation is implemented.
export const DEFERRED_REVERSE_COMMAND_OPERATIONS = [];
// Operations this daemon handles that no current Overseer sends. A newer Peon
// is allowed to run ahead of the server it talks to; the pair is listed so the
// asymmetry stays deliberate rather than accumulating unnoticed.
export const PEON_ONLY_REVERSE_COMMAND_OPERATIONS = [];
