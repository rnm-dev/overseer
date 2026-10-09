# Protocol contracts

This directory is the repository's canonical home for machine-readable wire
contracts that are shared by more than one Overseer application. The schemas
and golden fixtures are normative documentation and executable test inputs;
they are not fetched or loaded by production services at runtime.

Applications and conformance tests read these files directly from the checkout.
A contract-specific capability version governs wire compatibility. Its schema
identifier is a stable URN and does not imply a network dependency or a
separately published package.

## Contracts

- [`project-directory-watch-v1`](project-directory-watch-v1/schema.json) — on-demand directory invalidations; lifecycle and limits are in [live directory updates](../project-directory-watch.md).

- [`armory-project-packages-v1`](armory-project-packages-v1/schema.json) —
  installed Armory packages, reusable typed profiles and project assignments;
  its product and migration rules are in [Armory project packages](../armory-project-packages.md).
- [`armory-package-operations-v1`](armory-package-operations-v1/schema.json) —
  compatibility and diagnosis checks, aggregate usage and drain state; lifecycle
  rules are in [Armory package runtime operations](../armory-package-operations.md).
- [`selected-text-replies-v1`](selected-text-replies-v1/schema.json) —
  the durable `replyTo` shape, source-event rules, lifecycle behavior and
  mixed-version contract for selected transcript text; product details are in
  [Selected-text replies](../selected-text-replies.md).
- [`context-only-messages-v1`](context-only-messages-v1/schema.json) — durable
  participant messages, structured stable-identity mentions, next-turn
  delivery and separate human attention; product details are in
  [Context-only participant messages](../context-only-participant-messages.md).
