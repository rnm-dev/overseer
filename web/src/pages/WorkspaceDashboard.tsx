import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, Navigate, useParams } from "react-router-dom";
import { WorkspaceSection } from "../components/WorkspaceSection";
import { useT } from "../i18n";
import { useWorkspace } from "../workspace";

export function WorkspaceDashboard() {
  const t = useT();
  const { workspaceId = "" } = useParams();
  const { current, groups, ready, setCurrent } = useWorkspace();
  const group = groups.find((item) => item.workspace.id === workspaceId);

  useEffect(() => {
    if (workspaceId && group && current?.id !== workspaceId) setCurrent(workspaceId);
  }, [current?.id, group, setCurrent, workspaceId]);

  if (!ready) return <div className="grid min-h-screen place-items-center"><div className="forge-spin" /></div>;
  if (!group) return <Navigate to="/" replace />;

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 pb-20 pt-5 sm:px-6 sm:pt-8">
      <Link to="/" className="mb-6 inline-flex items-center gap-2 text-xs text-bone-faint transition-colors hover:text-bone">
        <ArrowLeft size={14} aria-hidden="true" /> {t("workspace.back")}
      </Link>
      <WorkspaceSection workspace={group.workspace} peons={group.peons} />
    </main>
  );
}
