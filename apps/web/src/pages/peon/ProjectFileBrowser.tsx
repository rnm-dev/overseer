import { useState } from "react";
import { useParams } from "react-router";
import { useT } from "../../i18n";
import { Card } from "../../ui";
import { usePeon } from "./context";
import { FileView, useFileContent } from "./FileView";
import { ProjectFileTree } from "./ProjectFiles";
import { ProjectTabs } from "./ProjectTabs";
import { ProjectPageHeader } from "./ProjectPageHeader";

export function ProjectFileBrowser() {
  const t = useT();
  const { key = "" } = useParams();
  const { peon, base } = usePeon();
  const filesBase = `${base}/projects/${encodeURIComponent(key)}/files`;
  const [selected, setSelected] = useState<{ path: string; size?: number } | null>(null);
  // A project tree is full of extensionless text (Dockerfile, LICENSE), so an
  // unknown type reads as text here rather than as an unsupported binary.
  const content = useFileContent({
    source: { kind: "project", base, projectKey: key, path: selected?.path ?? "" },
    size: selected?.size,
    fallback: "text",
    enabled: !!selected,
  });

  if (!peon.online) return <p className="font-mono text-sm text-ink-faint">{t("peon.offlineNote")}</p>;

  return (
    <div className="space-y-3">
      <ProjectPageHeader />
      <ProjectTabs />
      <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <Card className="flex max-h-[calc(100vh-10rem)] min-h-[28rem] flex-col overflow-hidden">
          <div className="border-b border-edge px-3 py-2.5 font-display text-xs font-semibold text-ink-muted">{t("session.files.title")}</div>
          <ProjectFileTree filesBase={filesBase} activePath={selected?.path} onOpenFile={(path, size) => setSelected({ path, size })} className="flex-1" />
        </Card>
        <Card className="flex max-h-[calc(100vh-10rem)] min-h-[28rem] flex-col overflow-hidden">
          {!selected ? <p className="grid flex-1 place-items-center p-6 text-center font-mono text-sm text-ink-faint">{t("proj.files.pick")}</p> : <>
            <div className="truncate border-b border-edge px-4 py-2.5 font-mono text-xs text-ink-muted">{selected.path}</div>
            <div className="min-h-0 flex-1 overflow-auto"><FileView content={content} /></div>
          </>}
        </Card>
      </div>
    </div>
  );
}
