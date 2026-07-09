import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, json } from "../../api";
import { Button, Dialog, Label } from "../../ui";
import { useT } from "../../i18n";
import { ModelSelect, modelLabel, useModels } from "./models";

// author: Viktor

interface Project {
  key: string;
  path?: string | null;
}

export function NewSessionDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { peonId = "" } = useParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectKey, setProjectKey] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(""); // "" ⇒ follow the peon's default
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { catalog, supported: modelsSupported } = useModels(base);

  useEffect(() => {
    let alive = true;
    api<{ projects: Project[] }>(`${base}/projects`)
      .then((r) => {
        if (!alive) return;
        setProjects(r.projects ?? []);
        setProjectKey(r.projects?.[0]?.key ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base]);

  async function start() {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: { prompt: string; projectKey?: string; dir?: string; model?: string } = { prompt: prompt.trim() };
      if (model) body.model = model;
      if (projectKey) {
        body.projectKey = projectKey;
        // Pass the project's dir too: the peon can't always resolve a projectKey to a
        // path (aggregated keys have no stored dir) and would fall back to $HOME.
        const dir = projects.find((p) => p.key === projectKey)?.path;
        if (dir) body.dir = dir;
      }
      const res = await api<{ id?: string; session?: { id?: string } }>(`${base}/sessions`, json(body));
      onClose();
      const id = res.id ?? res.session?.id;
      if (id) navigate(`/peons/${peonId}/sessions/${id}`);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "AGENT_UNAVAILABLE" ? t("newSession.agentUnavailable") : err instanceof ApiError ? err.message : t("error.generic"));
      setSubmitting(false);
    }
  }

  return (
    <Dialog title={t("newSession.title")} onClose={onClose}>
      <div className="space-y-4">
        {projects.length > 0 && (
          <div className="space-y-1.5">
            <Label>{t("newSession.project")}</Label>
            <select className="warp-select w-full" value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key}
                </option>
              ))}
            </select>
          </div>
        )}
        {modelsSupported && catalog && catalog.providers.length > 0 && (
          <div className="space-y-1.5">
            <Label>{t("newSession.model")}</Label>
            <ModelSelect
              catalog={catalog}
              value={model}
              onChange={setModel}
              defaultLabel={catalog.defaultModel ? t("model.peonDefault", { name: modelLabel(catalog, catalog.defaultModel) ?? catalog.defaultModel }) : t("model.default")}
              className="w-full"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label>{t("newSession.prompt")}</Label>
          <textarea
            className="field min-h-[7rem] w-full resize-none"
            rows={5}
            autoFocus
            value={prompt}
            placeholder={t("newSession.promptPlaceholder")}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
            }}
          />
        </div>
        {error && <p className="font-mono text-xs text-blood">⚠ {error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="iron" onClick={onClose} disabled={submitting}>
            {t("action.cancel")}
          </Button>
          <Button onClick={start} disabled={submitting || !prompt.trim()}>
            {submitting ? t("newSession.starting") : t("newSession.start")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
