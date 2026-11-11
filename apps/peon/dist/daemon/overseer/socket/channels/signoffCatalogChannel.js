import { CatalogProducerChannel } from "./catalogProducerChannel.js";
import { SIGNOFF_CATALOG_CAPABILITY, SignoffCatalogError, signoffCatalog, } from "../../../signoffs/index.js";
export class SignoffCatalogChannel extends CatalogProducerChannel {
    constructor(catalog = signoffCatalog) {
        super({
            capability: SIGNOFF_CATALOG_CAPABILITY,
            prefix: "signoff_catalog",
            label: "sign-off catalog",
            catalog,
            start: () => catalog.start(),
            pageFrame: (page) => ({ type: "signoff_catalog_snapshot_page", ...page }),
            eventFrame: (event, epoch) => ({ type: "signoff_catalog_event", epoch, ...event }),
            // Exact seq order, as for the session catalog: never coalesce.
            eventOptions: (event, epoch) => ({ dedupeKey: `signoff-catalog:${epoch}:${event.seq}` }),
            error: (error) => error instanceof SignoffCatalogError ? { code: error.code, message: error.message } : null,
        });
    }
}
