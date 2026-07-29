# Overseer task: edit a Peon's soul

Add a **Soul** section to the Peon overview. Show whether a soul is configured, display a short plain-text excerpt, and provide a multiline Markdown editor.

The Peon control API is ready:

- Read `soul: string | null` from `GET /api/v1/settings`.
- Save with the partial request `PATCH /api/v1/settings { "soul": "..." }`.
- Send an empty string to clear it; treat a missing field from older Peons as unconfigured.
- Surface Peon's `BAD_REQUEST` response when saving fails.

Do not send or overwrite unrelated settings. Add tests for loading, saving, clearing, an older Peon response, and a failed save.
