import { CatalogProducerChannel } from "./catalogProducerChannel.js";
import { PROJECT_CATALOG_CAPABILITY, ProjectCatalogError, projectCatalog, } from "../../../projects/index.js";
const PROJECT_CATALOG_ACK_RETRY_MS = 10_000;
export class ProjectCatalogChannel extends CatalogProducerChannel {
    constructor(catalog = projectCatalog, ackRetryMs = PROJECT_CATALOG_ACK_RETRY_MS) {
        super({
            capability: PROJECT_CATALOG_CAPABILITY,
            prefix: "project_catalog",
            label: "project catalog",
            catalog,
            pageFrame: (page) => ({ type: "project_catalog_snapshot_page", ...page }),
            eventFrame: (event, epoch) => ({ type: "project_catalog_event", epoch, ...event }),
            eventOptions: (event, epoch) => ({ dedupeKey: `project-catalog:${epoch}:${event.seq}` }),
            error: (error) => error instanceof ProjectCatalogError ? { code: error.code, message: error.message } : null,
            acknowledgementFailure: "project catalog acknowledgement persistence failed",
            acknowledgementRejected: "project catalog acknowledgement was rejected",
            retry: { delayMs: ackRetryMs },
        });
    }
}
