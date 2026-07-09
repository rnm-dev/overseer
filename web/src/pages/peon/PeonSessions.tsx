import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { Badge, Button, Card } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { NewSessionDialog } from "./NewSessionDialog";

// author: Viktor

interface Session {
  id: string;
  status?: string | null;
  title?: string | null;
  prompt?: string | null;
  projectKey?: string | null;
  dir?: string | null;
  lastMessagePreview?: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
}

function ago(ms?: number | null): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function statusTone(status?: string | null): "green" | "amber" | "red" | "neutral" {
  return status === "running" ? "green" : status === "needs_human" ? "amber" : status === "failure" || status === "failed" || status === "error" ? "red" : "neutral";
}

export function PeonSessions() {
  const t = useT();
  const { peon, base } = usePeon();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (!peon.online) return;
    let alive = true;
    const pull = () => api<{ sessions: Session[] }>(`${base}/sessions`).then((r) => alive && setSessions(r.sessions ?? [])).catch(() => {});
    pull();
    const timer = window.setInterval(pull, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [base, peon.online]);

  if (!peon.online) return <p className="font-mono text-sm text-bone-faint">{t("peon.offlineNote")}</p>;

  const ordered = [...sessions].sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0));

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowNew(true)}>
          {t("newSession.new")}
        </Button>
      </div>
      <Card>
      {ordered.length === 0 ? (
        <p className="p-8 text-center font-mono text-sm text-bone-faint">{t("sessions.empty")}</p>
      ) : (
        <ul className="divide-y divide-iron-800">
          {ordered.map((s) => {
            const time = ago(s.lastActivityAt ?? s.startedAt);
            const showBadge = s.status && s.status !== "completed";
            return (
              <li key={s.id}>
                <Link to={s.id} className="flex items-start justify-between gap-3 px-5 py-4 transition-colors hover:bg-fel/[0.03]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate font-display text-sm font-medium text-bone">{s.title || s.prompt || t("session.untitled")}</div>
                      {s.projectKey && <span className="flex-none rounded bg-iron-800 px-1.5 py-0.5 font-mono text-[0.7rem] text-bone-dim" title={t("session.project")}>{s.projectKey}</span>}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-bone-faint">{s.lastMessagePreview || s.dir || "—"}</div>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1">
                    {time && <span className="font-mono text-[0.7rem] text-bone-dim">{time}</span>}
                    {showBadge && <Badge tone={statusTone(s.status)}>{s.status!.replace(/_/g, " ")}</Badge>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      </Card>
      {showNew && <NewSessionDialog base={base} onClose={() => setShowNew(false)} />}
    </div>
  );
}
