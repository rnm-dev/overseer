import { CatalogProducerChannel } from "./catalogProducerChannel.js";
import { SESSION_CATALOG_CAPABILITY, SessionCatalogError, sessionCatalog, } from "../../../sessions/index.js";
export class SessionCatalogChannel extends CatalogProducerChannel {
    constructor(catalog = sessionCatalog) {
        super({
            capability: SESSION_CATALOG_CAPABILITY,
            prefix: "session_catalog",
            label: "session catalog",
            catalog,
            start: () => catalog.start(),
            pageFrame: (page) => ({ type: "session_catalog_snapshot_page", ...page }),
            eventFrame: (event, epoch) => ({ type: "session_catalog_event", epoch, ...event }),
            // No coalesceKey: Overseer applies catalog events only in exact seq
            // order, so replacing an unsent event with a newer seq leaves a gap and
            // forces a full resnapshot. The outbox limit bounds an offline backlog;
            // past it, journal replay or a snapshot takes over.
            eventOptions: (event, epoch) => ({ dedupeKey: `session-catalog:${epoch}:${event.seq}` }),
            error: (error) => error instanceof SessionCatalogError ? { code: error.code, message: error.message } : null,
        });
    }
}
