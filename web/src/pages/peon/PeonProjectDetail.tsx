import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../../api";
import { Card } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { Markdown } from "../../components/RichText";
import { ProjectPageHeader } from "./ProjectPageHeader";
import { ProjectTabs } from "./ProjectTabs";
import { type ProjectDetail } from "./peonApi";
import { ProjectDocumentation } from "./ProjectDocumentation";

// author: Viktor

export function PeonProjectDetail() {
  const t = useT();
  const { base } = usePeon();
  const { key = "" } = useParams();

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailErr, setDetailErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetailErr(false);
    setDetail(null);
    api<ProjectDetail>(`${base}/projects/${encodeURIComponent(key)}`)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetailErr(true));
    return () => {
      alive = false;
    };
  }, [base, key]);

  return (
    <div className="space-y-3">
      <ProjectPageHeader />
      <ProjectTabs />

      {detailErr && <div className="font-mono text-xs text-blood">⚠ {t("error.loadFailed")}</div>}

      {detail && <>
        <Card className="overflow-hidden px-6 py-6 sm:px-8 sm:py-8">
          <article className="mx-auto max-w-3xl text-sm leading-relaxed text-bone-dim">
            <Markdown source={projectMarkdown(detail, key, t)} />
          </article>
        </Card>
        <ProjectDocumentation base={base} projectId={detail.projectId ?? null} />
      </>}
    </div>
  );
}

function inline(value: string | null | undefined): string {
  return (value || "—").replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1");
}

export function projectMarkdown(detail: ProjectDetail, key: string, t: ReturnType<typeof useT>): string {
  const metadata = detail.metadata?.trim() || `_${t("proj.notConfigured")}_`;
  return [
    `**${t("proj.key")}**  \`${inline(key)}\``,
    detail.scope ? `**${t("proj.scope")}**  ${inline(detail.scope)}` : null,
    `**${t("newProject.dir")}**  \`${inline(detail.dir)}\``,
    `## ${t("proj.metadata")}`,
    metadata,
  ].filter(Boolean).join("\n\n");
}
