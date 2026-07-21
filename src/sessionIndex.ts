// Compatibility facade. New code imports the sessions module public API from
// `modules/sessions/index.ts`; existing callers can migrate independently.
export * from "./modules/sessions/index.js";
