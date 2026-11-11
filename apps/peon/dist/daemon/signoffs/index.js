import path from "node:path";
import { sessions, setTurnSettledHook } from "../sessions/index.js";
import { stateDir } from "../runtime/xdgPaths.js";
import { SignoffCatalog } from "./catalog.js";
import { SignoffService } from "./service.js";
import { SignoffStore } from "./store.js";
export * from "./model.js";
export * from "./service.js";
export * from "./catalog.js";
export { SignoffStore } from "./store.js";
const sessionPort = {
    get: (id) => sessions.get(id),
    enqueue: (sessionId, prompt, author, commandId) => {
        sessions.enqueue(sessionId, prompt, [], undefined, author, undefined, undefined, commandId);
    },
    setSettledState: (sessionId, state) => {
        sessions.setSettledState(sessionId, state);
    },
};
export const signoffs = new SignoffService(new SignoffStore(path.join(stateDir(), "signoffs")), sessionPort);
export const signoffCatalog = new SignoffCatalog(signoffs);
let started = false;
/**
 * Boot order matters: load sign-offs (closing interrupted executions) before
 * sessions are restored, so a turn settled during session recovery already
 * sees them; reconcile orphans only after sessions are back.
 */
export function startSignoffs() {
    if (started)
        return;
    started = true;
    signoffs.restore();
    setTurnSettledHook((record) => signoffs.onTurnSettled(record));
    sessions.on("delete", (sessionId) => signoffs.onSessionDeleted(sessionId));
}
export function reconcileSignoffOrphans() {
    signoffs.reconcileOrphans();
}
