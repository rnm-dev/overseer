# Peon task: fix Codex outcome schema for `expectsOutcome` sessions

## Problem

Peon cannot start a Codex session when `expectsOutcome: true`. The session is
accepted and persisted, but the first model request fails before the agent can
reason, use a tool, or inspect the project.

This blocks project setup and verification workflows because those sessions
require a terminal outcome.

Observed on Peon `Kanat` on 2026-07-13 with:

- agent: `codex`
- model: `gpt-5.6-sol`
- reasoning effort: `medium`
- `expectsOutcome: true`
- session: `a70d7e7e-d601-4ce2-8c00-784d630ce1d5`

The Peon session was recorded as completed with `turnCount: 0`, zero input and
output tokens, and this failure:

```text
invalid_request_error / invalid_json_schema
Invalid schema for response_format 'codex_output_schema': In context=(),
'required' is required to be supplied and to be an array including every key
in properties. Missing 'previewPath'.
```

A follow-up on the same session produced the identical error. Ordinary Codex
sessions with `expectsOutcome: false` continue to work on the same Peon, so this
is isolated to the structured terminal-outcome path rather than authentication,
connectivity, or model availability.

## Root cause

The JSON schema sent by the Peon Codex adapter as `codex_output_schema` declares
`previewPath` under `properties` but does not include it in the root `required`
array. The model API's strict structured-output validation requires every
declared property to be listed in `required`.

If `previewPath` is semantically optional, represent that in a way accepted by
strict structured outputs: keep it required and allow `null` (or remove it from
the response schema entirely if it is not part of the outcome contract). Do not
silently make all additional properties permissive to bypass validation.

## Required change

1. Locate the outcome/structured-output schema used by the Codex runner when a
   session has `expectsOutcome: true`.
2. Make the root schema valid for strict structured output:
   - provide a `required` array;
   - include every key declared in root `properties`, including `previewPath`;
   - use explicit nullable types for fields that may have no value;
   - retain `additionalProperties: false` if the current contract is strict.
3. Audit nested objects in the same schema. Every object schema must follow the
   same all-properties-required rule; optional values must be represented as
   nullable rather than omitted from `required`.
4. Keep the normalized Peon outcome contract backward compatible. Existing
   consumers must continue receiving the expected `result`, `summary`, and
   preview-path data/nullability.
5. Ensure follow-ups and resumed backend sessions use the corrected schema too,
   not only the initial turn.

This should be fixed in Peon's Codex adapter/schema builder. Overseer should not
rewrite schemas or downgrade `expectsOutcome` to work around it.

## Regression tests

Add automated coverage proving that:

1. The generated `codex_output_schema` passes strict JSON Schema validation and
   every object's `required` array contains every key in its `properties` map.
2. A Codex session with `expectsOutcome: true` reaches the model/runner instead
   of completing at turn zero with `invalid_json_schema`.
3. A successful outcome with a preview path is parsed and persisted correctly.
4. A successful outcome without a preview uses the contract's explicit null
   representation and is parsed and persisted correctly.
5. `success`, `failure`, and `needs_human` terminal results remain supported.
6. A follow-up/resume on an outcome-producing Codex session uses the valid
   schema and can complete normally.
7. Codex sessions with `expectsOutcome: false` are unchanged.
8. Claude Code outcome-producing sessions remain unchanged.

Prefer a unit test against the schema builder plus an adapter-level test that
captures the request passed to Codex. The adapter test should assert the full
schema invariant rather than checking only `previewPath`, so adding another
optional property cannot reintroduce this class of failure.

## Acceptance criteria

- Starting project setup with Codex no longer fails with
  `invalid_json_schema`.
- The agent performs at least one real turn and can use tools before returning a
  normalized terminal outcome.
- A setup session can return `success`, `failure`, or `needs_human` with
  `previewPath` populated or explicitly null as allowed by the contract.
- A follow-up to the same session does not reproduce the schema error.
- All new and existing Peon runner/session tests pass.

## Manual verification

After deploying the fix, start a setup or verification session through Overseer
with Codex selected and `expectsOutcome: true`. Confirm in the transcript that:

1. initialization is followed by assistant/tool activity rather than an
   immediate error result;
2. the session records non-zero turn/token activity;
3. the final Peon session outcome is normalized and visible in Overseer; and
4. sending a follow-up does not return `invalid_json_schema`.
