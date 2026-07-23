import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../../api";
import { useT } from "../../i18n";
import { usePeon } from "./context";
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

      {detail && <ProjectDocumentation base={base} projectId={detail.projectId ?? null} />}
    </div>
  );
}
