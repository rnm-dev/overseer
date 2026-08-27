# @rnm-dev/protocol

Canonical, versioned wire artifacts shared by Overseer applications.

- `PROTOCOL.md` is the human-readable Overseer ↔ Peon contract.
- `reverse-command-v1/schema.json` is the normative JSON Schema.
- `reverse-command-v1/fixtures.json` supplies golden contract metadata.
- `src/generated/reverseCommandV1.ts` is generated from the schema and fixtures.

Run `npm run generate` after changing the schema or fixtures. `npm run verify`
fails when the generated TypeScript is stale.
