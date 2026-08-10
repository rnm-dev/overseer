// Compatibility names remain exported from the sessions module while the
// implementation is authority-neutral and shared by every resource kind.
export {
  observeResourceSyncEvent as observeSessionCatalogEvent,
  observeResourceSyncDuration as observeSessionCatalogDuration,
  resourceSyncObservabilitySnapshot as sessionCatalogObservabilitySnapshot,
  resetResourceSyncObservabilityForTest as resetSessionCatalogObservabilityForTest,
} from "../resourceSync/index.js";
