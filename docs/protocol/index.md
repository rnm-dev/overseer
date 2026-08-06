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

- [`armory-project-packages-v1`](armory-project-packages-v1/schema.json) —
  installed Armory packages, reusable typed profiles and project assignments;
  its product and migration rules are in [Armory project packages](../armory-project-packages.md).
