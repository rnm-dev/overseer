import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, json } from "../../api";
import { Badge, Button, Dialog, Input, Label } from "../../ui";
import { useT } from "../../i18n";
import { PathInput } from "./PathInput";

// author: Viktor

interface Integration {
  key: string;
  label: string;
  authenticated?: boolean;
}
interface CatalogProject {
  key: string;
  label?: string;
  scope?: string;
  suggestedDir?: string;
  imported?: boolean;
}

const tab = (active: boolean) =>
  `-mb-px border-b-2 px-3 py-2 font-display text-[0.72rem] font-bold uppercase tracking-[0.1em] transition-colors ${
    active ? "border-fel text-fel-bright" : "border-transparent text-bone-dim hover:text-bone"
  }`;

export function NewProjectDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { peonId = "" } = useParams();
  const [mode, setMode] = useState<"manual" | "import">("manual");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manual
  const [label, setLabel] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [suggestedKey, setSuggestedKey] = useState("");
  const [info, setInfo] = useState("");

  // Import
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [integrationKey, setIntegrationKey] = useState("");
  const [catalog, setCatalog] = useState<CatalogProject[] | null>(null);
  const [pickedKey, setPickedKey] = useState("");

  // Suggest key/dir from the label (debounced).
  useEffect(() => {
    if (mode !== "manual" || !label.trim()) return;
    const timer = window.setTimeout(() => {
      api<{ key?: string; dir?: string }>(`${base}/projects/suggest-dir?label=${encodeURIComponent(label.trim())}`)
        .then((r) => {
          setSuggestedKey(r.key ?? "");
          if (!dirTouched) setDir(r.dir ?? "");
        })
        .catch(() => {});
    }, 350);
    return () => window.clearTimeout(timer);
  }, [label, mode, base, dirTouched]);

  useEffect(() => {
    api<{ integrations?: Integration[] }>(`${base}/integrations`)
      .then((r) => setIntegrations(r.integrations ?? []))
      .catch(() => {});
  }, [base]);

  useEffect(() => {
    if (!integrationKey) return;
    let alive = true;
    setCatalog(null);
    setPickedKey("");
    api<{ projects?: CatalogProject[] }>(`${base}/integrations/${encodeURIComponent(integrationKey)}/projects`)
      .then((r) => alive && setCatalog(r.projects ?? []))
      .catch(() => alive && setCatalog([]));
    return () => {
      alive = false;
    };
  }, [integrationKey, base]);

  function fail(err: unknown) {
    setError(err instanceof ApiError && err.code === "PROJECT_EXISTS" ? t("newProject.exists") : err instanceof ApiError ? err.message : t("error.generic"));
    setSubmitting(false);
  }
  function done(key?: string) {
    onClose();
    if (key) navigate(`/peons/${peonId}/projects/${encodeURIComponent(key)}`);
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "manual") {
        const res = await api<{ key?: string }>(`${base}/projects`, json({ label: label.trim(), dir: dir.trim() || undefined, info: info.trim() || undefined }));
        done(res.key ?? suggestedKey);
      } else {
        const res = await api<{ key?: string }>(`${base}/projects/import`, json({ integrationKey, projectKey: pickedKey, dir: dir.trim() || undefined }));
        done(res.key ?? pickedKey);
      }
    } catch (err) {
      fail(err);
    }
  }

  const canSubmit = mode === "manual" ? !!label.trim() : !!pickedKey;

  return (
    <Dialog title={t("newProject.title")} onClose={onClose}>
      <div className="mb-4 flex gap-1 border-b border-iron-800">
        <button className={tab(mode === "manual")} onClick={() => setMode("manual")}>
          {t("newProject.manual")}
        </button>
        <button className={tab(mode === "import")} onClick={() => setMode("import")}>
          {t("newProject.import")}
        </button>
      </div>

      {mode === "manual" ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("newProject.label")}</Label>
            <Input value={label} autoFocus onChange={(e) => setLabel(e.target.value)} placeholder="My Project" />
            {suggestedKey && <div className="font-mono text-[0.7rem] text-bone-faint">key: {suggestedKey}</div>}
          </div>
          <div className="space-y-1.5">
            <Label>{t("newProject.dir")}</Label>
            <PathInput
              base={base}
              value={dir}
              onChange={(next) => {
                setDir(next);
                setDirTouched(true);
              }}
              placeholder="/home/peon/Projects/…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("newProject.info")}</Label>
            <textarea className="field min-h-[4rem] w-full resize-none" rows={3} value={info} onChange={(e) => setInfo(e.target.value)} />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {integrations.length === 0 ? (
            <p className="font-mono text-xs text-bone-faint">{t("newProject.noIntegrations")}</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>{t("newProject.integration")}</Label>
                <select className="warp-select w-full" value={integrationKey} onChange={(e) => setIntegrationKey(e.target.value)}>
                  <option value="">—</option>
                  {integrations.map((i) => (
                    <option key={i.key} value={i.key} disabled={i.authenticated === false}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </div>
              {integrationKey &&
                (catalog === null ? (
                  <div className="forge-spin" />
                ) : catalog.length === 0 ? (
                  <p className="font-mono text-xs text-bone-faint">{t("newProject.noCatalog")}</p>
                ) : (
                  <div className="max-h-56 divide-y divide-iron-800 overflow-y-auto rounded border border-iron-800">
                    {catalog.map((p) => (
                      <button
                        key={p.key}
                        disabled={p.imported}
                        onClick={() => {
                          setPickedKey(p.key);
                          setDir(p.suggestedDir ?? "");
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                          pickedKey === p.key ? "bg-fel/10" : "hover:bg-fel/[0.04]"
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-bone">{p.label || p.key}</span>
                          <span className="block truncate font-mono text-[0.7rem] text-bone-faint">
                            {p.key}
                            {p.scope ? ` · ${p.scope}` : ""}
                          </span>
                        </span>
                        {p.imported && <Badge tone="neutral">{t("newProject.imported")}</Badge>}
                      </button>
                    ))}
                  </div>
                ))}
              {pickedKey && (
                <div className="space-y-1.5">
                  <Label>{t("newProject.dir")}</Label>
                  <PathInput base={base} value={dir} onChange={setDir} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {error && <p className="mt-3 font-mono text-xs text-blood">⚠ {error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="iron" onClick={onClose} disabled={submitting}>
          {t("action.cancel")}
        </Button>
        <Button onClick={submit} disabled={submitting || !canSubmit}>
          {submitting ? t("newProject.creating") : mode === "manual" ? t("newProject.create") : t("newProject.importBtn")}
        </Button>
      </div>
    </Dialog>
  );
}
