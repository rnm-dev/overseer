import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../api";
import { Button, Card, Input, Label } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { AgentSelect, ModelSelect, providerForAgent, useModels } from "./models";
import { PathInput } from "./PathInput";
import { buildSettingsPayload, resolveDefaultModel } from "./settingsModel";

// author: Viktor

interface Settings {
  name?: string | null;
  fileTransferRoot?: string | null;
  heartbeatIntervalMs?: number | null;
  aiDefaultModel?: string | null;
  defaultAgent?: string | null;
}

interface PeonStatus {
  updateAvailable?: boolean;
  updateLocalSha?: string | null;
  updateRemoteSha?: string | null;
  updateCheckedAt?: number | null;
  updateCheckError?: string | null;
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
  const [status, setStatus] = useState<PeonStatus | null>(null);
  const [updatePhase, setUpdatePhase] = useState<"idle" | "installing" | "restarting" | "complete">("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!peon.online) return;
    let alive = true;
    api<PeonStatus>(`${base}/status`)
      .then((next) => alive && setStatus(next))
      .catch(() => {});
    return () => { alive = false; };
  }, [base, peon.online]);

  // Updating restarts the peon, so its ordinary online state can briefly drop.
  // Keep checking until the new revision is serving instead of making the short
  // POST request the only progress indication.
  useEffect(() => {
    if (updatePhase !== "restarting") return;
    let alive = true;
    let timer: number | undefined;

    const check = async () => {
      try {
        const next = await api<PeonStatus>(`${base}/status`);
        if (!alive) return;
        setStatus(next);
        if (!next.updateAvailable) {
          setUpdatePhase("complete");
          reload();
          return;
        }
      } catch {
        // A connection failure is expected while the peon restarts.
      }
      if (alive) timer = window.setTimeout(check, 2000);
    };

    timer = window.setTimeout(check, 1000);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [base, reload, updatePhase]);

  async function installUpdate() {
    setUpdatePhase("installing");
    setUpdateError(null);
    try {
      await api(`${base}/control/update`, { method: "POST" });
      setUpdatePhase("restarting");
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : t("error.generic"));
      setUpdatePhase("idle");
    }
  }

  function patch(key: keyof Settings, value: string) {
    setForm((f) => ({ ...(f ?? {}), [key]: key === "heartbeatIntervalMs" ? (value ? Number(value) : null) : value }) as Settings);
    setSaved(false);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setSaved(false);
    try {
      const provider = providerForAgent(catalog, form.defaultAgent ?? catalog?.defaultAgent ?? catalog?.providers[0]?.agent);
      const payload = buildSettingsPayload(form, provider, catalog !== null);
      const savedSettings = await api<Settings>(`${base}/settings`, { method: "PATCH", body: JSON.stringify(payload) });
      setForm(savedSettings);
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
  const defaultAgent = catalog
    ? form?.defaultAgent ?? catalog.defaultAgent ?? catalog.providers[0]?.agent
    : undefined;
  const defaultAgentProvider = providerForAgent(catalog, defaultAgent);
  const defaultModel = resolveDefaultModel(defaultAgentProvider, form?.aiDefaultModel) ?? "";
  const updating = updatePhase === "installing" || updatePhase === "restarting";

  return (
    <div className="space-y-8">
      {(peon.online || updating) && status && (
        <Card className="space-y-4 px-5 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-display text-sm font-bold text-bone">{t("peon.update.title")}</h3>
              <p className="mt-1 font-mono text-xs text-bone-dim">
                {status.updateAvailable ? t("peon.update.available") : t("peon.update.current")}
              </p>
            </div>
            {status.updateAvailable && (
              <Button onClick={installUpdate} disabled={updating}>
                {updatePhase === "installing" ? t("peon.update.installing") : updatePhase === "restarting" ? t("peon.update.restarting") : t("peon.update.install")}
              </Button>
            )}
          </div>
          {updating && (
            <div role="status" aria-live="polite" className="flex items-center gap-3 border-l-2 border-fel bg-fel/5 px-3 py-3 font-mono text-xs text-fel-bright">
              <span className="block h-4 w-4 flex-none animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
              {updatePhase === "installing" ? t("peon.update.installingDetail") : t("peon.update.restartingDetail")}
            </div>
          )}
          {updatePhase === "complete" && (
            <p role="status" aria-live="polite" className="border-l-2 border-fel bg-fel/5 px-3 py-3 font-mono text-xs text-fel-bright">
              ⚡ {t("peon.update.complete")}
            </p>
          )}
          {(status.updateLocalSha || status.updateRemoteSha || status.updateCheckedAt) && (
            <div className="space-y-1 font-mono text-xs text-bone-faint">
              {status.updateLocalSha && <p>{t("peon.update.local")}: {status.updateLocalSha}</p>}
              {status.updateRemoteSha && <p>{t("peon.update.remote")}: {status.updateRemoteSha}</p>}
              {status.updateCheckedAt && <p>{t("peon.update.checked")}: {new Date(status.updateCheckedAt).toLocaleString()}</p>}
            </div>
          )}
          {(status.updateCheckError || updateError) && (
            <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-xs text-blood">
              ⚠ {updateError ?? status.updateCheckError}
            </p>
          )}
        </Card>
      )}
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
            <PathInput base={base} value={form.fileTransferRoot ?? ""} onChange={(value) => patch("fileTransferRoot", value)} placeholder="/srv/peon/files" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("peon.settings.heartbeat")}</Label>
            <Input type="number" value={form.heartbeatIntervalMs ?? ""} onChange={(e) => patch("heartbeatIntervalMs", e.target.value)} placeholder="5000" />
          </div>
          {modelsSupported && catalog && catalog.providers.length > 1 && (
            <div className="space-y-1.5">
              <Label>{t("peon.settings.defaultAgent")}</Label>
              <AgentSelect
                catalog={catalog}
                value={defaultAgent ?? ""}
                onChange={(v) => {
                  const provider = providerForAgent(catalog, v);
                  setForm((f) => ({
                    ...(f ?? {}),
                    defaultAgent: v,
                    aiDefaultModel: resolveDefaultModel(provider, f?.aiDefaultModel),
                  }));
                  setSaved(false);
                }}
                className="w-full"
              />
              <p className="font-mono text-xs text-bone-faint">{t("peon.settings.defaultAgentHint")}</p>
            </div>
          )}
          {modelsSupported && catalog && catalog.providers.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t("peon.settings.aiDefaultModel")}</Label>
              <ModelSelect
                provider={defaultAgentProvider}
                value={defaultModel}
                onChange={(v) => { setForm((f) => ({ ...(f ?? {}), aiDefaultModel: v || null })); setSaved(false); }}
                allowClear={false}
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
