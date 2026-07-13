import { useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspace } from "../workspace";
import { Button, Logo } from "../ui";
import { useT } from "../i18n";
import { NewWorkspaceDialog } from "../components/NewWorkspaceDialog";
import { WorkspaceSection } from "../components/WorkspaceSection";

// author: Viktor
// The fleet dashboard (index): every peon in a grid, grouped by workspace. No
// sidebar — the account panel floats bottom-left (AppLayout → UserBox).
export function Dashboard() {
  const t = useT();
  const { groups } = useWorkspace();
  const [showNewWs, setShowNewWs] = useState(false);

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-6 pb-28 pt-7">
      <header className="mb-9 flex flex-wrap items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo size={28} />
          <span className="wordmark text-lg">Overseer</span>
        </Link>
        <Button size="sm" onClick={() => setShowNewWs(true)}>
          {t("nav.newWorkspace")}
        </Button>
      </header>

      {groups.length === 0 ? (
        <p className="warplate px-5 py-10 text-center font-mono text-sm text-bone-faint">{t("peons.empty")}</p>
      ) : (
        groups.map((g) => <WorkspaceSection key={g.workspace.id} workspace={g.workspace} peons={g.peons} />)
      )}

      {showNewWs && <NewWorkspaceDialog onClose={() => setShowNewWs(false)} />}
    </div>
  );
}
