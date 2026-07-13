# Peon task: make the saved default model provider-aware

## Problem

Peon advertises both Claude Code and Codex models from `GET /api/v1/models`, and
allows `defaultAgent: "codex"`, but `PATCH /api/v1/settings` still validates
`aiDefaultModel` as a Claude-only value.

Reproduced on Kanat:

```http
PATCH /api/v1/settings
Content-Type: application/json

{
  "defaultAgent": "codex",
  "aiDefaultModel": "gpt-5.6-sol"
}
```

returns:

```json
{
  "error": "aiDefaultModel must be a known model alias or claude-* id",
  "code": "BAD_REQUEST"
}
```

`{"defaultAgent":"codex"}` succeeds, but this only permits Codex's built-in
catalog default; an operator cannot persist another advertised Codex model.
`aiDefaultModel: null` is also currently rejected.

## Required behavior

Make the saved default model valid for the saved default provider, rather than
hard-coding Claude model validation.

1. Treat `defaultAgent` and `aiDefaultModel` as a pair:
   - `defaultAgent: "claude-code"` accepts the advertised Claude model IDs and
     aliases.
   - `defaultAgent: "codex"` accepts the advertised Codex model IDs and aliases.
   - Unknown providers or models still return `400 BAD_REQUEST` with a stable
     error code.

2. Validate PATCH requests against the atomically merged candidate settings.
   A request that changes both fields must validate `aiDefaultModel` against the
   new `defaultAgent`, not the previously saved provider. Do not partially write
   either field when validation fails.

3. Support `aiDefaultModel: null` as “use this provider's catalog default.” If a
   PATCH changes only `defaultAgent` and the previously saved model belongs to a
   different provider, normalize the model to `null` (or the new provider's
   canonical default ID) instead of leaving an incompatible cross-provider pair.

4. `GET /api/v1/settings` must return the effective persisted provider/model
   pair without rewriting Codex values as Claude values.

5. Model resolution for new sessions and resumed sessions must follow this
   precedence:
   - request/turn model override, when valid for the selected agent;
   - session model, when valid for the selected agent;
   - saved `aiDefaultModel`, only when it belongs to the selected/default agent;
   - that provider's advertised catalog default.

   An explicit session `agent` that differs from the global `defaultAgent` must
   never inherit a model from the other provider.

6. Keep existing Claude settings backward compatible, including aliases such as
   `sonnet`, `opus`, and `haiku`. Persist a canonical ID if that is Peon's normal
   settings convention, but accept advertised aliases at the API boundary.

7. Make `GET /api/v1/models` consistent with settings:
   - `defaultAgent` reflects the saved provider.
   - For the default provider, the model carrying `default: true` reflects the
     effective saved model (or the provider's built-in default when the setting
     is null).
   - Do not mark a model from a different provider as the global effective
     default.

## Tests

Add regression coverage for at least:

- atomically saving `{defaultAgent:"codex", aiDefaultModel:"gpt-5.4"}`;
- saving a Codex model alias if the catalog exposes one;
- rejecting a Claude model paired with Codex and vice versa;
- no partial write after a rejected two-field PATCH;
- switching only `defaultAgent` normalizes an incompatible old model;
- `aiDefaultModel:null` selects the provider catalog default;
- existing Claude model IDs and aliases continue to work;
- session creation with no explicit agent/model uses the saved pair;
- an explicit non-default agent with no model uses its own provider default;
- `/models` and `/settings` agree after changing the saved provider/model.

## Acceptance check

This request must return `200`, survive a Peon restart, and be reflected by both
`GET /api/v1/settings` and `GET /api/v1/models`:

```json
{
  "defaultAgent": "codex",
  "aiDefaultModel": "gpt-5.4"
}
```

Starting a session without `agent` or `model` must then run Codex with
`gpt-5.4`. Switching the settings back to Claude/Sonnet must work in one PATCH
without first clearing either field.
