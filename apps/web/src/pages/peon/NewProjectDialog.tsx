import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "../../api";
import { Button, Dialog, Input, Label } from "../../ui";
import { useT } from "../../i18n";
import { PathInput } from "./PathInput";
import { createPeonFolderSource } from "./peonFolders";
import { createProject, projectMetadataValue, projectRoute } from "./peonApi";

// author: Viktor

export function NewProjectDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { peonId = "" } = useParams();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [suggestedKey, setSuggestedKey] = useState("");
  const [metadata, setMetadata] = useState("");
  // Browse the Peon's whole filesystem from `/`, not just its file-transfer root.
  const folderSource = useMemo(() => createPeonFolderSource(base), [base]);

  // Suggest key/dir from the label (debounced).
  useEffect(() => {
    if (!label.trim()) return;
    const timer = window.setTimeout(() => {
      api<{ key?: string; dir?: string }>(`${base}/projects/suggest-dir?label=${encodeURIComponent(label.trim())}`)
        .then((r) => {
          setSuggestedKey(r.key ?? "");
          if (!dirTouched) setDir(r.dir ?? "");
        })
        .catch(() => {});
    }, 350);
    return () => window.clearTimeout(timer);
  }, [label, base, dirTouched]);

  function fail(err: unknown) {
    setError(err instanceof ApiError && err.code === "PROJECT_EXISTS" ? t("newProject.exists") : err instanceof ApiError ? err.message : t("error.generic"));
    setSubmitting(false);
  }
  function done(key?: string) {
    onClose();
    if (key) navigate(projectRoute(peonId, key));
  }

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createProject(base, { label: label.trim(), dir: dir.trim() || undefined, metadata: projectMetadataValue(metadata) });
      done(res.key ?? suggestedKey);
    } catch (err) {
      fail(err);
    }
  }

  return (
    <Dialog title={t("newProject.title")} onClose={onClose}>
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
            folderSource={folderSource}
            value={dir}
            onChange={(next) => {
              setDir(next);
              setDirTouched(true);
            }}
            placeholder="/home/peon/Projects/…"
          />
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <Label>{t("proj.metadata")}</Label>
        <textarea className="field min-h-24 w-full resize-y" rows={5} value={metadata} onChange={(e) => setMetadata(e.target.value)} />
      </div>

      {error && <p className="mt-3 font-mono text-xs text-blood">⚠ {error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="iron" onClick={onClose} disabled={submitting}>
          {t("action.cancel")}
        </Button>
        <Button onClick={submit} disabled={submitting || !label.trim()}>
          {submitting ? t("newProject.creating") : t("newProject.create")}
        </Button>
      </div>
    </Dialog>
  );
}
