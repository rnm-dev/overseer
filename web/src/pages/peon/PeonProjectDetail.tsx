import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, getToken } from "../../api";
import { Badge, Button, Card, Input, Label, MenuItem, PageHeader } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { HighlightedCode, Markdown, languageForPath } from "../../components/RichText";
import { parseSetupCommand, type SetupSessionNavigationState } from "./setupSessionCommand";
import { PathInput } from "./PathInput";
import { encodeProjectPath, formatFileSize, ProjectFileTree } from "./ProjectFiles";

// author: Viktor

interface Detail {
  key?: string;
  label?: string;
  scope?: string;
  dir?: string;
  info?: string;
  setup?: string | null;
  publication?: string | null;
  isSetUp?: boolean;
  integrationKey?: string | null;
  integrationLabel?: string | null;
}
interface Integration { key: string; label: string; authenticated?: boolean }
interface ProjectForm { label: string; dir: string; integrationKey: string; info: string; setup: string; publication: string }
interface Viewer {
  path: string;
  loading?: boolean;
  text?: string;
  image?: string;
  note?: string;
}

const MAX_VIEW_BYTES = 1_000_000;
const TEXT_CAP = 400_000;
const isImageName = (n: string) => /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(n);
const toForm = (detail: Detail): ProjectForm => ({
  label: detail.label ?? "",
  dir: detail.dir ?? "",
  integrationKey: detail.integrationKey ?? "",
  info: detail.info ?? "",
  setup: detail.setup ?? "",
  publication: detail.publication ?? "",
});

export function PeonProjectDetail() {
  const t = useT();
  const navigate = useNavigate();
  const { peon, base } = usePeon();
  const { key = "", peonId = "" } = useParams();
  const filesBase = `${base}/projects/${encodeURIComponent(key)}/files`;
  const [acting, setActing] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);

  // Setup composes a session; Peon deliberately does not create it until the
  // operator has reviewed and submitted the returned command attributes.
  async function runSetup() {
    if (acting) return;
    setActing(true);
    setActErr(null);
    try {
      const response = await api<unknown>(`${base}/projects/${encodeURIComponent(key)}/setup`, { method: "POST" });
      const command = parseSetupCommand(response);
      if (!command.ok) {
        setActErr(command.error);
        setActing(false);
        return;
      }
      const state: SetupSessionNavigationState = {
        setupSession: command.attributes,
        returnTo: `/peons/${peonId}/projects/${encodeURIComponent(key)}`,
      };
      navigate(`/peons/${peonId}/sessions/new`, { state });
    } catch (err) {
      setActErr(err instanceof ApiError ? err.message : t("error.loadFailed"));
      setActing(false);
    }
  }

  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailErr, setDetailErr] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ProjectForm | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const imgUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetailErr(false);
    api<Detail>(`${base}/projects/${encodeURIComponent(key)}`)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetailErr(true));
    return () => {
      alive = false;
    };
  }, [base, key]);

  useEffect(() => {
    api<{ integrations?: Integration[] }>(`${base}/integrations`)
      .then((r) => setIntegrations(r.integrations ?? []))
      .catch(() => setIntegrations([]));
  }, [base]);

  function startEditing() {
    if (!detail) return;
    setForm(toForm(detail));
    setSaveErr(null);
    setEditing(true);
  }

  async function saveProject() {
    if (!form || saving || !form.label.trim() || !form.dir.trim()) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const updated = await api<Detail>(`${base}/projects/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify({
          label: form.label.trim(),
          dir: form.dir.trim(),
          integrationKey: form.integrationKey || null,
          info: form.info || null,
          setup: form.setup || null,
          publication: form.publication || null,
        }),
      });
      setDetail(updated);
      setEditing(false);
    } catch (err) {
      setSaveErr(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setSaving(false);
    }
  }

  const revokeImg = () => {
    if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current);
    imgUrlRef.current = null;
  };
  useEffect(() => revokeImg, []);

  const openFile = useCallback(
    async (filePath: string, size?: number) => {
      revokeImg();
      const image = isImageName(filePath);
      if (!image && typeof size === "number" && size > MAX_VIEW_BYTES) {
        setViewer({ path: filePath, note: t("proj.files.tooLarge", { size: formatFileSize(size) }) });
        return;
      }
      setViewer({ path: filePath, loading: true });
      try {
        const token = getToken();
        const res = await fetch(`/api${filesBase}/${encodeProjectPath(filePath)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
        if (!res.ok) {
          setViewer({ path: filePath, note: res.status === 404 || res.status === 401 ? t("peon.unsupported") : t("error.loadFailed") });
          return;
        }
        const ct = res.headers.get("content-type") || "";
        if (ct.startsWith("image/") || image) {
          const url = URL.createObjectURL(await res.blob());
          imgUrlRef.current = url;
          setViewer({ path: filePath, image: url });
        } else {
          const raw = await res.text();
          setViewer({ path: filePath, text: raw.length > TEXT_CAP ? raw.slice(0, TEXT_CAP) + "\n\n…truncated…" : raw });
        }
      } catch {
        setViewer({ path: filePath, note: t("error.loadFailed") });
      }
    },
    [filesBase, t],
  );

  if (!peon.online) return <p className="font-mono text-sm text-bone-faint">{t("peon.offlineNote")}</p>;

  return (
    <div className="space-y-3">
      <PageHeader
        title={detail?.label || key}
        backTo=".."
        backLabel={t("proj.back")}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="iron" size="sm" onClick={startEditing} disabled={!detail || editing}>{t("proj.edit")}</Button>
            <Link to={`/peons/${peonId}/sessions/new?project=${encodeURIComponent(key)}`} className="btn btn-sm">{t("newSession.new")}</Link>
          </div>
        }
        menuLabel={t("session.menu")}
        meta={
          <>
            <span className="flex-none font-mono text-xs text-bone-faint">{key}</span>
            {detail?.scope && <span className="flex-none rounded bg-iron-800 px-1.5 py-0.5 font-mono text-[0.7rem] text-bone-dim">{detail.scope}</span>}
          </>
        }
        menu={(close) => (
          <>
            <MenuItem
              onClick={() => {
                close();
                runSetup();
              }}
              disabled={acting}
            >
              {acting ? t("proj.settingUp") : t("proj.setup")}
            </MenuItem>
          </>
        )}
      />

      {detailErr && <div className="font-mono text-xs text-blood">⚠ {t("error.loadFailed")}</div>}
      {actErr && <div className="font-mono text-xs text-blood">⚠ {actErr}</div>}

      {editing && form ? (
        <Card className="overflow-hidden">
          <div className="border-b border-iron-800 bg-iron-900/40 px-5 py-3">
            <h2 className="font-display text-sm font-bold text-bone">{t("proj.settings")}</h2>
            <p className="mt-0.5 text-xs text-bone-faint">{t("proj.settingsHint")}</p>
          </div>
          <div className="grid gap-4 p-5 md:grid-cols-2">
            <div className="space-y-1.5"><Label>{t("newProject.label")}</Label><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
            <div className="space-y-1.5">
              <Label>{t("newProject.dir")}</Label>
              <PathInput
                base={base}
                value={form.dir}
                onChange={(dir) => setForm({ ...form, dir })}
                browseRoot={detail?.dir || form.dir}
                browseBase={`${base}/projects/${encodeURIComponent(key)}/files`}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>{t("newProject.integration")}</Label>
              <select className="warp-select w-full" value={form.integrationKey} onChange={(e) => setForm({ ...form, integrationKey: e.target.value })}>
                <option value="">{t("proj.noIntegration")}</option>
                {form.integrationKey && !integrations.some((i) => i.key === form.integrationKey) && <option value={form.integrationKey}>{form.integrationKey}</option>}
                {integrations.map((i) => <option key={i.key} value={i.key} disabled={i.authenticated === false}>{i.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5 md:col-span-2"><Label>{t("proj.info")}</Label><textarea className="field min-h-24 resize-y" value={form.info} onChange={(e) => setForm({ ...form, info: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>{t("proj.setupCommand")}</Label><textarea className="field min-h-32 resize-y" value={form.setup} onChange={(e) => setForm({ ...form, setup: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>{t("proj.publication")}</Label><textarea className="field min-h-32 resize-y" value={form.publication} onChange={(e) => setForm({ ...form, publication: e.target.value })} /></div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-iron-800 px-5 py-3">
            {saveErr && <p className="mr-auto font-mono text-xs text-blood">⚠ {saveErr}</p>}
            <Button variant="iron" onClick={() => setEditing(false)} disabled={saving}>{t("action.cancel")}</Button>
            <Button onClick={saveProject} disabled={saving || !form.label.trim() || !form.dir.trim()}>{saving ? t("proj.saving") : t("proj.save")}</Button>
          </div>
        </Card>
      ) : detail && (
        <Card className="overflow-hidden">
          <div className="grid divide-y divide-iron-800 md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="p-5">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge tone={detail.isSetUp ? "green" : "amber"}>{detail.isSetUp ? t("proj.ready") : t("proj.notSetUp")}</Badge>
                <span className="font-mono text-[0.7rem] text-bone-faint">{detail.integrationLabel || detail.integrationKey || t("proj.noIntegration")}</span>
              </div>
              <DetailValue label={t("newProject.dir")} value={detail.dir} mono />
              <DetailValue label={t("proj.info")} value={detail.info} />
            </div>
            <div className="grid divide-y divide-iron-800">
              <CommandValue label={t("proj.setupCommand")} value={detail.setup} empty={t("proj.notConfigured")} />
              <CommandValue label={t("proj.publication")} value={detail.publication} empty={t("proj.notConfigured")} />
            </div>
          </div>
        </Card>
      )}

      {/* browser + viewer */}
      <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <Card className="flex max-h-[70vh] min-h-[16rem] flex-col overflow-hidden">
          <div className="border-b border-iron-800 px-3 py-2 font-mono text-xs text-bone-dim">{t("session.files.title")}</div>
          <ProjectFileTree filesBase={filesBase} activePath={viewer?.path} onOpenFile={openFile} className="flex-1" />
        </Card>

        {/* viewer */}
        <Card className="flex max-h-[70vh] min-h-[16rem] flex-col overflow-hidden">
          {!viewer ? (
            <p className="grid flex-1 place-items-center p-6 text-center font-mono text-sm text-bone-faint">{t("proj.files.pick")}</p>
          ) : (
            <>
              <div className="truncate border-b border-iron-800 px-4 py-2 font-mono text-xs text-bone-dim">{viewer.path}</div>
              <div className="min-h-0 flex-1 overflow-auto">
                {viewer.loading ? (
                  <div className="p-4">
                    <div className="forge-spin" />
                  </div>
                ) : viewer.note ? (
                  <p className="p-4 font-mono text-xs text-bone-faint">{viewer.note}</p>
                ) : viewer.image ? (
                  <div className="p-4">
                    <img src={viewer.image} alt="" className="max-w-full rounded" />
                  </div>
                ) : languageForPath(viewer.path) === "markdown" ? (
                  <article className="mx-auto max-w-4xl p-5 text-sm leading-relaxed text-bone"><Markdown source={viewer.text ?? ""} /></article>
                ) : (
                  <HighlightedCode source={viewer.text ?? ""} language={languageForPath(viewer.path)} className="min-h-full rounded-none border-0" />
                )}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function DetailValue({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return <div className="mb-4 last:mb-0"><div className="mb-1 font-display text-[0.6rem] font-bold uppercase tracking-[0.16em] text-bone-faint">{label}</div><div className={`${mono ? "font-mono text-xs" : "whitespace-pre-wrap text-sm leading-relaxed"} break-words text-bone-dim`}>{value || "—"}</div></div>;
}

function CommandValue({ label, value, empty }: { label: string; value?: string | null; empty: string }) {
  return <div className="min-h-24 p-5"><div className="mb-2 font-display text-[0.6rem] font-bold uppercase tracking-[0.16em] text-bone-faint">{label}</div>{value ? <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-bone-dim">{value}</pre> : <span className="text-xs italic text-bone-faint">{empty}</span>}</div>;
}
