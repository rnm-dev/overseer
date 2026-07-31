import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { ApiError } from "../../api";
import { Card } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { getProjectSkills, type ProjectSkill } from "./peonApi";
import { ProjectPageHeader } from "./ProjectPageHeader";
import { ProjectTabs } from "./ProjectTabs";

type SkillsState =
  | { kind: "loading" }
  | { kind: "ready"; skills: ProjectSkill[] }
  | { kind: "unsupported" }
  | { kind: "unknown" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

export function projectSkillsErrorKind(error: unknown): Exclude<SkillsState["kind"], "loading" | "ready"> {
  if (!(error instanceof ApiError)) return "error";
  if (error.status === 403 || error.status === 401) return "forbidden";
  if (error.status === 404 && error.code === "UNKNOWN_PROJECT") return "unknown";
  if (error.status === 404) return "unsupported";
  return "error";
}

function validSkill(value: unknown): value is ProjectSkill {
  if (!value || typeof value !== "object") return false;
  const skill = value as Partial<ProjectSkill>;
  return typeof skill.name === "string"
    && skill.name.trim().length > 0
    && typeof skill.description === "string"
    && (skill.path === undefined || skill.path === null || typeof skill.path === "string");
}

export function ProjectSkills() {
  const t = useT();
  const { key = "" } = useParams();
  const { peon, base } = usePeon();
  const [state, setState] = useState<SkillsState>({ kind: "loading" });

  useEffect(() => {
    if (!peon.online) return;
    let alive = true;
    setState({ kind: "loading" });
    getProjectSkills(base, key)
      .then((result) => {
        if (!alive) return;
        if (!result || !Array.isArray(result.skills) || !result.skills.every(validSkill)) {
          setState({ kind: "error", message: t("proj.skills.invalid") });
          return;
        }
        setState({ kind: "ready", skills: result.skills });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        const kind = projectSkillsErrorKind(error);
        setState(kind === "error"
          ? { kind, message: error instanceof Error ? error.message : t("error.loadFailed") }
          : { kind });
      });
    return () => { alive = false; };
  }, [base, key, peon.online, t]);

  return <div className="space-y-3">
    <ProjectPageHeader />
    <ProjectTabs />
    <Card className="overflow-hidden">
      <div className="border-b border-edge bg-surface-raised/40 px-5 py-3">
        <h2 className="font-display text-sm font-bold text-ink">{t("proj.skills.title")}</h2>
        <p className="mt-0.5 text-xs text-ink-faint">{t("proj.skills.hint")}</p>
      </div>
      <div className="p-5">
        {!peon.online && <p role="status" className="font-mono text-sm text-ink-faint">{t("peon.offlineNote")}</p>}
        {peon.online && state.kind === "loading" && <p role="status" aria-live="polite" className="font-mono text-sm text-ink-faint">{t("proj.skills.loading")}</p>}
        {peon.online && state.kind === "unsupported" && <p role="status" className="font-mono text-sm text-ink-faint">{t("proj.skills.unsupported")}</p>}
        {peon.online && state.kind === "unknown" && <p role="alert" className="border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-sm text-danger">⚠ {t("proj.skills.unknown")}</p>}
        {peon.online && state.kind === "forbidden" && <p role="alert" className="border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-sm text-danger">⚠ {t("proj.skills.forbidden")}</p>}
        {peon.online && state.kind === "error" && <p role="alert" className="border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-sm text-danger">⚠ {state.message}</p>}
        {peon.online && state.kind === "ready" && state.skills.length === 0 && <p role="status" className="font-mono text-sm text-ink-faint">{t("proj.skills.empty")}</p>}
        {peon.online && state.kind === "ready" && state.skills.length > 0 && (
          <ul className="grid gap-3 md:grid-cols-2" aria-label={t("proj.skills.title")}>
            {state.skills.map((skill) => <li key={`${skill.name}:${skill.path ?? ""}`} className="surface surface--subtle p-4">
              <h3 className="font-display text-sm font-bold text-ink">{skill.name}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">{skill.description}</p>
              {skill.path && <p className="mt-3 break-all font-mono text-[0.7rem] text-ink-faint">{skill.path}</p>}
            </li>)}
          </ul>
        )}
      </div>
    </Card>
  </div>;
}
