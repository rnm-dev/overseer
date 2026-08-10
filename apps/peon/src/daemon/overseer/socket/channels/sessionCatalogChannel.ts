import { CatalogProducerChannel } from "./catalogProducerChannel.js";
import {
  SESSION_CATALOG_CAPABILITY,
  SessionCatalogError,
  sessionCatalog,
  type SessionCatalog,
  type SessionCatalogEvent,
  type SessionCatalogPage,
} from "../../../sessions/index.js";

export class SessionCatalogChannel extends CatalogProducerChannel<SessionCatalogPage, SessionCatalogEvent> {
  constructor(catalog: SessionCatalog = sessionCatalog) {
    super({
      capability: SESSION_CATALOG_CAPABILITY,
      prefix: "session_catalog",
      label: "session catalog",
      catalog,
      start: () => catalog.start(),
      pageFrame: (page) => ({ type: "session_catalog_snapshot_page", ...page }),
      eventFrame: (event, epoch) => ({ type: "session_catalog_event", epoch, ...event }),
      eventOptions: (event, epoch) => {
        const sessionId = "session" in event ? event.session.id : event.deletedSessionId;
        return {
          dedupeKey: `session-catalog:${epoch}:${event.seq}`,
          coalesceKey: `session-summary:${sessionId}`,
        };
      },
      error: (error) => error instanceof SessionCatalogError ? { code: error.code, message: error.message } : null,
    });
  }
}
