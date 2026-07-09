import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../api";
import { Button, Card, Input, Label } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { ModelSelect, modelLabel, useModels } from "./models";

// author: Viktor

interface Settings {
  name?: string | null;
  fileTransferRoot?: string | null;
  heartbeatIntervalMs?: number | null;
  aiDefaultModel?: string | null;
}

export function PeonSettings() {
  const t = useT();
  const navigate = useNavigate();
  const { peon, base, reload } = usePeon();
  const { catalog, supported: modelsSupported } = useModels(base);

  const [form, setForm] = useState<Settings | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Connectivity — overseer-side registry data (how the overseer dials this peon).
  // Editable regardless of online state; that's exactly when a bad address is fixed.
  const [address, setAddress] = useState(peon.address);
  const [port, setPort] = useState(String(peon.controlPort));
  const [connSaving, setConnSaving] = useState(false);
  const [connSaved, setConnSaved] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  async function saveConnection() {
    setConnSaving(true);
    setConnSaved(false);
    setConnError(null);
    try {
      await api(base, { method: "PATCH", body: JSON.stringify({ address: address.trim(), controlPort: Number(port) }) });
      setConnSaved(true);
      reload();
    } catch (err) {
      setConnError(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setConnSaving(false);
    }
  }

  useEffect(() => {
    if (!peon.online) return;
    let alive = true;
    api<Settings>(`${base}/settings`)
      .then((s) => alive && setForm(s))
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setUnsupported(true);
        else setLoadError(err instanceof Error ? err.message : t("error.loadFailed"));
      });
    return () => {
      alive = false;
    };
  }, [base, peon.online]);

  function patch(key: keyof Settings, value: string) {
    setForm((f) => ({ ...(f ?? {}), [key]: key === "heartbeatIntervalMs" ? (value ? Number(value) : null) : value }) as Settings);
    setSaved(false);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setSaved(false);
    try {
      await api(`${base}/settings`, { method: "PATCH", body: JSON.stringify(form) });
      setSaved(true);
      reload();
    } catch {
      /* keep form; next edit clears the saved flag */
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api(base, { method: "DELETE" });
      navigate("/");
    } catch {
      setDeleting(false);
    }
  }

  const portInvalid = !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535;

  return (
    <div className="space-y-8">
      <Card className="space-y-5 px-5 py-5">
        <div>
          <h3 className="font-display text-sm font-bold text-bone">{t("peon.conn.title")}</h3>
          <p className="mt-1 font-mono text-xs text-bone-dim">{t("peon.conn.hint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label>{t("peon.conn.address")}</Label>
          <Input value={address} onChange={(e) => { setAddress(e.target.value); setConnSaved(false); }} placeholder="100.64.0.3" />
        </div>
        <div className="space-y-1.5">
          <Label>{t("peon.conn.port")}</Label>
          <Input type="number" value={port} onChange={(e) => { setPort(e.target.value); setConnSaved(false); }} placeholder="4570" />
        </div>
        <div className="font-mono text-xs text-bone-faint">
          {t("peon.conn.reaches")}: {peon.baseUrl}
          {peon.connectionPinned && <span className="ml-2 text-fel">⌾ {t("peon.conn.pinned")}</span>}
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={saveConnection} disabled={connSaving || !address.trim() || portInvalid}>
            {connSaving ? t("peon.settings.saving") : t("peon.settings.save")}
          </Button>
          {connSaved && <span className="font-mono text-xs text-fel-bright">⚡ {t("peon.settings.saved")}</span>}
          {connError && <span className="font-mono text-xs text-blood">⚠ {connError}</span>}
        </div>
      </Card>

      {peon.online && !unsupported && form && (
        <Card className="space-y-5 px-5 py-5">
          <div className="space-y-1.5">
            <Label>{t("peon.settings.name")}</Label>
            <Input value={form.name ?? ""} onChange={(e) => patch("name", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("peon.settings.fileRoot")}</Label>
            <Input value={form.fileTransferRoot ?? ""} onChange={(e) => patch("fileTransferRoot", e.target.value)} placeholder="/srv/peon/files" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("peon.settings.heartbeat")}</Label>
            <Input type="number" value={form.heartbeatIntervalMs ?? ""} onChange={(e) => patch("heartbeatIntervalMs", e.target.value)} placeholder="5000" />
          </div>
          {modelsSupported && catalog && catalog.providers.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t("peon.settings.aiDefaultModel")}</Label>
              <ModelSelect
                catalog={catalog}
                value={form.aiDefaultModel ?? ""}
                onChange={(v) => { setForm((f) => ({ ...(f ?? {}), aiDefaultModel: v || null })); setSaved(false); }}
                defaultLabel={catalog.defaultModel ? t("model.peonDefault", { name: modelLabel(catalog, catalog.defaultModel) ?? catalog.defaultModel }) : t("model.default")}
                className="w-full"
              />
              <p className="font-mono text-xs text-bone-faint">{t("peon.settings.aiDefaultModelHint")}</p>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? t("peon.settings.saving") : t("peon.settings.save")}
            </Button>
            {saved && <span className="font-mono text-xs text-fel-bright">⚡ {t("peon.settings.saved")}</span>}
          </div>
        </Card>
      )}

      {loadError && <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {loadError}</p>}
      {(unsupported || !peon.online) && <p className="font-mono text-sm text-bone-faint">{peon.online ? t("peon.unsupported") : t("peon.offlineNote")}</p>}

      {/* Danger zone — deletion moved here from the list row. */}
      <div>
        <h3 className="mb-3 rune text-sm text-blood">{t("peon.settings.danger")}</h3>
        <Card className="flex flex-wrap items-center justify-between gap-4 border-blood/30 px-5 py-4">
          <p className="font-mono text-xs text-bone-dim">{t("peon.settings.deleteHint")}</p>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-blood">{t("peon.settings.deleteConfirm")}</span>
              <Button variant="iron" size="sm" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                {t("action.cancel")}
              </Button>
              <button className="btn btn-sm !border-blood/50 !text-blood hover:!bg-blood/10" onClick={remove} disabled={deleting}>
                {deleting ? t("peon.settings.deleting") : t("peon.settings.delete")}
              </button>
            </div>
          ) : (
            <button className="btn btn-sm !border-blood/50 !text-blood hover:!bg-blood/10" onClick={() => setConfirmDelete(true)}>
              {t("peon.settings.delete")}
            </button>
          )}
        </Card>
      </div>
    </div>
  );
}
