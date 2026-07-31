import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ApiError } from "../../api";
import { Button, Card, ConfirmationDialog, Input, Label } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { PathInput } from "./PathInput";
import { ProjectPageHeader } from "./ProjectPageHeader";
import { ProjectQuickLinksEditor } from "./ProjectQuickLinks";
import { ProjectTabs } from "./ProjectTabs";
import { deleteProject, getProjectSettings, projectMetadataValue, projectRoute, updateProjectSettings, type ProjectSettings as Settings } from "./peonApi";

interface ProjectForm { key: string; name: string; dir: string; metadata: string }

export function ProjectSettings() {
  const t = useT();
  const navigate = useNavigate();
  const { key = "" } = useParams();
  const { peon, base, isOwner } = usePeon();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<ProjectForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    setLoadError(null);
    getProjectSettings(base, key)
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setForm({ key: next.key, name: next.name, dir: next.dir, metadata: next.metadata ?? "" });
      })
      .catch((error) => alive && setLoadError(error instanceof Error ? error.message : t("error.loadFailed")));
    return () => { alive = false; };
  }, [base, isOwner, key, t]);

  if (!isOwner) return <Navigate to={projectRoute(peon.peonId, key)} replace />;
  async function save() {
    if (!peon.online || !form || saving || !form.key.trim() || !form.name.trim() || !form.dir.trim()) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const updated = await updateProjectSettings(base, key, {
        key: form.key.trim(),
        name: form.name.trim(),
        dir: form.dir.trim(),
        metadata: projectMetadataValue(form.metadata),
      });
      setSettings(updated);
      setForm({ key: updated.key, name: updated.name, dir: updated.dir, metadata: updated.metadata ?? "" });
      setSaved(true);
      navigate(`${projectRoute(peon.peonId, updated.key)}/settings`, { replace: true });
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : t("error.generic"));
    } finally {
      setSaving(false);
    }
  }

  // The peon unregisters the project and the overseer drops its cached copy;
  // the directory stays on disk. A peon busy running a session against it
  // refuses with 409, and that refusal is what the operator is shown.
  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(base, key);
      navigate(`/peons/${encodeURIComponent(peon.peonId)}/sessions`, { replace: true });
    } catch (error) {
      setDeleteError(error instanceof ApiError ? error.message : t("error.generic"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return <div className="space-y-3">
    <ProjectPageHeader name={settings?.name} />
    <ProjectTabs />
    {!peon.online && <p className="font-mono text-xs text-ink-faint">{t("peon.offlineNote")}</p>}
    {loadError && <p role="alert" className="border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-xs text-danger">⚠ {loadError}</p>}
    {form && <Card className="overflow-hidden">
      <div className="border-b border-edge bg-surface-raised/40 px-5 py-3">
        <h2 className="font-display text-sm font-bold text-ink">{t("proj.settings")}</h2>
        <p className="mt-0.5 text-xs text-ink-faint">{t("proj.settingsHint")}</p>
      </div>
      <div className="grid gap-4 p-5 md:grid-cols-2">
        <div className="space-y-1.5"><Label>{t("proj.key")}</Label><Input value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} /></div>
        <div className="space-y-1.5"><Label>{t("newProject.label")}</Label><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
        <div className="space-y-1.5 md:col-span-2"><Label>{t("newProject.dir")}</Label><PathInput base={base} value={form.dir} onChange={(dir) => setForm({ ...form, dir })} browseRoot={settings?.dir || form.dir} browseBase={`${base}/projects/${encodeURIComponent(key)}/files`} /></div>
        <div className="space-y-1.5 md:col-span-2"><Label>{t("proj.metadata")}</Label><textarea className="field min-h-32 resize-y" rows={7} value={form.metadata} onChange={(event) => setForm({ ...form, metadata: event.target.value })} /></div>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-edge px-5 py-3">
        {saveError && <p role="alert" className="mr-auto font-mono text-xs text-danger">⚠ {saveError}</p>}
        {saved && <span className="mr-auto font-mono text-xs text-accent-strong">⚡ {t("peon.settings.saved")}</span>}
        <Button onClick={() => void save()} disabled={!peon.online || saving || !form.key.trim() || !form.name.trim() || !form.dir.trim()}>{saving ? t("proj.saving") : t("proj.save")}</Button>
      </div>
    </Card>}
    {settings && (
      <ProjectQuickLinksEditor
        base={base}
        projectKey={key}
        online={peon.online}
        links={settings.quickLinks ?? []}
      />
    )}
    <div className="pt-3">
      <h3 className="mb-3 rune text-sm text-danger">{t("proj.danger")}</h3>
      <Card className="flex flex-wrap items-center justify-between gap-4 border-danger/30 px-5 py-4">
        <div className="min-w-0">
          <p className="font-mono text-xs text-ink-muted">{t("proj.deleteHint")}</p>
          {deleteError && <p role="alert" className="mt-2 font-mono text-xs text-danger">⚠ {deleteError}</p>}
        </div>
        <button
          className="btn btn-sm !border-danger/50 !text-danger hover:!bg-danger/10 disabled:opacity-40"
          disabled={!peon.online || deleting}
          onClick={() => setConfirmDelete(true)}
        >
          {t("proj.delete")}
        </button>
      </Card>
    </div>
    {confirmDelete && <ConfirmationDialog
      title={t("proj.deleteConfirm", { name: settings?.name || key })}
      confirmLabel={t("proj.delete")}
      pendingLabel={t("proj.deleting")}
      pending={deleting}
      onClose={() => setConfirmDelete(false)}
      onConfirm={() => void remove()}
    />}
  </div>;
}
