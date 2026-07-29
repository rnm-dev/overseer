import { randomUUID } from "node:crypto";
import { settings } from "./settings/index.js";

// The stable identity this peon reports to the overseer, shared by the outbound
// registrar (peonRegistrar) and the inbound recruitment endpoint (agentApi.ts's
// /enroll). It lives here — rather than on either of those — so /enroll can
// return the *same* peonId the very next register will use without importing the
// registrar (which would close an import cycle, since the registrar imports from
// agentApi).
//
// Generated + persisted on first use so it survives restarts; the overseer
// dedupes a peon across reconnects by it.
export function ensurePeonId(): string {
  const existing = settings.get().peonId.trim();
  if (existing) return existing;
  const id = randomUUID();
  settings.update({ peonId: id });
  return id;
}
