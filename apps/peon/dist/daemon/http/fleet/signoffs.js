import { SignoffError } from "../../signoffs/index.js";
import { fail } from "./error.js";
const STATUSES = new Set([
    "pending", "changes_requested", "approved", "executing", "done", "partly_done",
    "failed", "rejected", "withdrawn", "superseded", "interrupted",
]);
function failSignoff(res, error) {
    if (error instanceof SignoffError)
        return fail(res, error.status, error.code, error.message);
    throw error;
}
function queryString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function attachSignoffRoutes(router, service) {
    router.get("/signoffs", (req, res) => {
        const rawStatus = queryString(req.query.status);
        const status = rawStatus?.split(",").map((value) => value.trim()).filter(Boolean);
        const unknown = status?.filter((value) => !STATUSES.has(value));
        if (unknown?.length)
            return fail(res, 400, "BAD_REQUEST", `unknown status: ${unknown.join(", ")}`);
        res.json({
            signoffs: service.list({
                status: status,
                projectKey: queryString(req.query.projectKey),
                sessionId: queryString(req.query.sessionId),
            }),
        });
    });
    router.get("/signoffs/:id", (req, res) => {
        try {
            res.json(service.get(req.params.id));
        }
        catch (error) {
            failSignoff(res, error);
        }
    });
    router.post("/signoffs/:id/events", (req, res) => {
        const body = (req.body ?? {});
        // The operator is the forwarded Peon-Actor; an explicit body field wins so
        // Overseer can name the deciding member even on a shared token.
        const operatorId = queryString(body.operatorId) ?? req.actor ?? "";
        if (!operatorId)
            return fail(res, 400, "BAD_REQUEST", "operatorId (or a Peon-Actor header) is required");
        try {
            const result = service.decide(req.params.id, {
                requestId: body.requestId,
                kind: body.kind,
                baseSeq: body.baseSeq,
                operatorId,
                optionId: body.optionId,
                message: body.message,
                assigneeIds: body.assigneeIds,
            });
            res.status(result.replayed ? 200 : 201).json(result);
        }
        catch (error) {
            failSignoff(res, error);
        }
    });
}
