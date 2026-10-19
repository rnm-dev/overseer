import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { api } from "../../shared/api";
import { useT } from "../../shared/i18n";
import type { PeonContext } from "../fleet/context";
import type { IndexedSessionLite } from "./sessionList";

// Peon sessions index: jump to the operator's most recent session, else prompt.
export function PeonSessionsEmpty() {
  const t = useT();
  const navigate = useNavigate();
  const { peon, wsId } = useOutletContext<PeonContext>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      peonId: peon.peonId,
      mine: "true",
      limit: "1",
      offset: "0",
    });
    api<{ sessions: IndexedSessionLite[] }>(`/workspaces/${encodeURIComponent(wsId)}/sessions?${query}`)
      .then((result) => {
        if (!active) return;
        const sessionId = result.sessions?.[0]?.sessionId;
        if (sessionId) navigate(encodeURIComponent(sessionId), { replace: true });
        else setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [navigate, peon.peonId, wsId]);

  if (loading) return <div className="grid min-h-[55vh] place-items-center"><div className="loading-spinner" /></div>;
  return (
    <div className="grid min-h-[55vh] place-items-center text-center">
      <div>
        <h1 className="font-display text-xl font-bold text-ink">{t("peon.tab.sessions")}</h1>
        <p className="mt-2 font-mono text-sm text-ink-faint">{t("sessions.choose")}</p>
      </div>
    </div>
  );
}
