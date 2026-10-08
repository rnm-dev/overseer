# Model selection

The Flutter and web composers distinguish an unfinished choice from the
conversation's accepted selection. Peon owns the accepted agent, model, and
reasoning effort. The client owns only the choices the operator is preparing
for another message.

## Choosing and inheriting

A new session starts with no explicit model or effort. The controls show the
Peon's advertised defaults, but displaying a default does not pin it into the
create request. Existing sessions inherit their own pinned values first and
then the defaults for their provider.

Selecting a named model or effort is always an explicit choice, including when
that option currently supplies the inherited value. Web composers offer only
concrete choices: the inherited option is selected directly, with no separate
reset row. When no concrete default is advertised, the closed control shows only its field label
and no menu option is marked selected. Peon settings retain their
nullable default choice. Flutter still offers a draft reset entry; it does not
clear a pin on the remote session. An A → B → A sequence remains explicit even
when session metadata is still catching up after the first change.

Model IDs and aliases name the same catalog option. A known session provider
must never fall back to another provider's options. An unknown model keeps its
identity instead of being relabeled as a catalog default. Neither client
invents a default from the first model in a list.

## Draft lifetime

Unsent agent, model, and effort choices persist with the existing draft,
including a draft that contains only a selection. They use the draft's existing
connection and session scope and follow its privacy cleanup. There is no
global history of last-used models or per-model preference matrix.

Flutter's Drift schema v15 adds nullable selection columns to
`composer_drafts`; existing text drafts keep their text and start without
explicit choices. Web stores the selection under the existing draft key's
`:selection` suffix.

A submitted command owns a snapshot of its choices. Its retry continues to use
that snapshot and its existing idempotency identity. Once accepted for delivery
or durable queuing, the submitted choices leave the editable draft. Acceptance
must not clear choices the operator changed while the request was in flight.
A failed submission retains the choices needed for retry.

The accepted session metadata supplies subsequent inherited choices. A queued
message's model remains part of that queued message until it runs; acceptance
into a queue does not rename the current invocation.

## Effective values and freshness

The effective model determines the effort list and its default. Per-model
effort lists are authoritative, including an empty list. Provider-wide efforts
are a compatibility fallback for catalogs without per-model lists. Changing
models preserves a valid explicit effort and clears an incompatible one.

The closed control and its open menu resolve the same effective values. The
working indicator describes the active session or invocation rather than the
operator's next-message draft.

Cached draft hydration does not wait for the model catalog. Catalog failures
preserve the last successful catalog and can be retried. Session metadata
reconciliation publishes accepted model and effort changes to the composer,
including changes made from another client.

Peon's catalog discovery and default markers are defined in
[agent model catalog discovery](../agent-model-catalog.md). Remote pinning and
turn execution are defined in [sessions and turns](../sessions-and-turns.md).
