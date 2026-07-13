import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api";
import { Card, MenuItem, PageHeader } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { NewProjectDialog } from "./NewProjectDialog";

// author: Viktor

interface Project {
  key: string;
  path?: string | null;
  sessionCount?: number;
  activeCount?: number;
  lastActivityMs?: number;
}

export function PeonProjects() {
  const t = useT();
  const { peon, base } = usePeon();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (!peon.online) return;
    let alive = true;
    api<{ projects: Project[] }>(`${base}/projects`)
      .then((r) => alive && setProjects(r.projects ?? []))
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setUnsupported(true);
        else setError(err instanceof Error ? err.message : t("error.loadFailed"));
      });
    return () => {
      alive = false;
    };
  }, [base, peon.online]);

  if (!peon.online) return <p className="font-mono text-sm text-bone-faint">{t("peon.offlineNote")}</p>;
  if (unsupported) return <p className="font-mono text-sm text-bone-faint">{t("peon.unsupported")}</p>;
  if (error) return <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {error}</p>;
  if (!projects) return <div className="forge-spin" />;

  return (
    <div className="space-y-3">
      <PageHeader
        title={t("peon.tab.projects")}
        menuLabel={t("session.menu")}
        menu={(close) => (
          <MenuItem
            onClick={() => {
              close();
              setShowNew(true);
            }}
          >
            {t("newProject.new")}
          </MenuItem>
        )}
      />
      <Card>
      {projects.length === 0 ? (
        <p className="p-8 text-center font-mono text-sm text-bone-faint">{t("peon.projects.empty")}</p>
      ) : (
        <ul className="divide-y divide-iron-800">
          {projects.map((p) => (
            <li key={p.key}>
              <Link to={encodeURIComponent(p.key)} className="flex items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-fel/[0.03]">
                <div className="min-w-0">
                  <div className="truncate font-display text-sm font-medium text-bone">{p.key}</div>
                  {p.path && <div className="mt-0.5 truncate font-mono text-xs text-bone-faint">{p.path}</div>}
                </div>
                <div className="flex flex-none items-center gap-3 font-mono text-[0.7rem] text-bone-dim">
                  {(p.activeCount ?? 0) > 0 && <span className="text-forge">{t("peon.projects.active", { n: p.activeCount ?? 0 })}</span>}
                  <span>{t("peon.projects.sessions", { n: p.sessionCount ?? 0 })}</span>
                  <span className="text-fel-bright" aria-hidden>›</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      </Card>
      {showNew && <NewProjectDialog base={base} onClose={() => setShowNew(false)} />}
    </div>
  );
}
