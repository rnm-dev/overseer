import { useEffect } from "react";
import { useT } from "../../shared/i18n";
import { sessionDisplayTitle, type SessionLite } from "../sessions/sessionList";
import type { PeonView } from "./context";

const WORKING_TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Keep browser tabs identifiable when several peons/sessions are open. While
// the selected session is running, animate a small spinner so background work
// remains visible even when this tab is not focused.
export function useWorkingTitle(peon: PeonView | null, sessions: SessionLite[], sid: string) {
  const t = useT();
  useEffect(() => {
    if (!peon) return;
    const previousTitle = document.title;
    const peonName = peon.name || peon.hostname || t("peons.unnamed");
    const session = sid ? sessions.find((item) => item.id === sid) : undefined;
    const sessionName = session ? sessionDisplayTitle(session, t("session.untitled")) : null;
    const baseTitle = sessionName ? `${peonName} — ${sessionName} · Overseer` : `${peonName} · Overseer`;
    let frame = 0;
    const update = () => {
      document.title = session?.status === "running" ? `${WORKING_TITLE_FRAMES[frame++ % WORKING_TITLE_FRAMES.length]} ${baseTitle}` : baseTitle;
    };
    update();
    const timer = session?.status === "running" ? window.setInterval(update, 250) : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.title = previousTitle;
    };
  }, [peon, sessions, sid, t]);
}
