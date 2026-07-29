import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, ApiError } from "../../api";
import { Badge, Button, Card, ConfirmationDialog, Input, Label } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { AgentSelect, defaultEffortIdFor, effortsForModel, ModelSelect, ReasoningEffortSelect, providerForAgent, useModels } from "./models";
import { PathInput } from "./PathInput";
import { PeonArmory } from "./PeonArmory";
import { buildSettingsPayload, resolveDefaultModel, resolveDefaultReasoningEffort } from "./settingsModel";
import { peonSettingsPath, peonSettingsTabFromPath, SOUL_EDITOR_ROWS } from "./settingsNavigation";
import { savePeonSoul, soulExcerpt } from "./peonApi";
import { CliUpdatesPanel } from "./CliUpdatesPanel";
import { RouteTabs } from "../../components/RouteTabs";

// author: Viktor

interface Settings {
  name?: string | null;
  fileTransferRoot?: string | null;
  heartbeatIntervalMs?: number | null;
  aiDefaultModel?: string | null;
  aiDefaultReasoningEffort?: string | null;
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
  const location = useLocation();
  const navigate = useNavigate();
  const { peon, base, reload, isOwner } = usePeon();
  const { catalog, supported: modelsSupported } = useModels(base);

  const [form, setForm] = useState<Settings | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [soul, setSoul] = useState<string | null>(null);
  const [soulDraft, setSoulDraft] = useState("");
  const [soulLoaded, setSoulLoaded] = useState(false);
  const [soulSaving, setSoulSaving] = useState(false);
  const [soulSaved, setSoulSaved] = useState(false);
  const [soulError, setSoulError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState<PeonStatus | null>(null);
  const [updatePhase, setUpdatePhase] = useState<"idle" | "installing" | "restarting" | "complete">("idle");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Connectivity — overseer-side registry data (how the overseer dials this peon).
  // Editable regardless of online state; that's exactly when a bad address is fixed.
  const [address, setAddress] = useState(peon.baseUrl);
  const [connSaving, setConnSaving] = useState(false);
  const [connSaved, setConnSaved] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  async function saveConnection() {
    setConnSaving(true);
    setConnSaved(false);
    setConnError(null);
    try {
      await api(base, { method: "PATCH", body: JSON.stringify({ publicUrl: address.trim() }) });
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
    api<Settings & { soul?: unknown }>(`${base}/settings`)
      .then((settings) => {
        if (!alive) return;
        const nextSoul = typeof settings.soul === "string" && settings.soul !== "" ? settings.soul : null;
        const regularSettings = { ...settings };
        delete regularSettings.soul;
        setForm(regularSettings);
        setSoul(nextSoul);
        setSoulDraft(nextSoul ?? "");
        setSoulLoaded(true);
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setUnsupported(true);
        else setLoadError(err instanceof Error ? err.message : t("error.loadFailed"));
      });
    return () => {
      alive = false;
    };
  }, [base, peon.online, t]);

  async function persistSoul(value: string) {
    setSoulSaving(true);
    setSoulSaved(false);
    setSoulError(null);
    try {
      const savedSoul = await savePeonSoul(base, value);
      setSoul(savedSoul);
      setSoulDraft(savedSoul ?? "");
      setSoulSaved(true);
    } catch (error) {
      setSoulError(error instanceof Error ? error.message : t("error.generic"));
    } finally {
      setSoulSaving(false);
    }
  }

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

  async function checkForUpdate() {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      setStatus(await api<PeonStatus>(`${base}/control/check-update`, { method: "POST" }));
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : t("error.generic"));
    } finally {
      setCheckingUpdate(false);
    }
  }

  function patch(key: keyof Settings, value: string) {
    setForm((f) => ({ ...(f ?? {}), [key]: key === "heartbeatIntervalMs" ? (value ? Number(value) : null) : value }) as Settings);
    setSaved(false);
    setSaveError(null);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const provider = providerForAgent(catalog, form.defaultAgent ?? catalog?.defaultAgent ?? catalog?.providers[0]?.agent);
      const payload = buildSettingsPayload(form, provider, catalog !== null);
      const savedSettings = await api<Settings & { soul?: unknown }>(`${base}/settings`, { method: "PATCH", body: JSON.stringify(payload) });
      const regularSettings = { ...savedSettings };
      delete regularSettings.soul;
      setForm(regularSettings);
      setSaved(true);
      reload();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : t("error.generic"));
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

  const defaultAgent = catalog
    ? form?.defaultAgent ?? catalog.defaultAgent ?? catalog.providers[0]?.agent
    : undefined;
  const defaultAgentProvider = providerForAgent(catalog, defaultAgent);
  const defaultModel = resolveDefaultModel(defaultAgentProvider, form?.aiDefaultModel) ?? "";
  const effortOptions = effortsForModel(defaultAgentProvider, defaultModel);
  const defaultReasoningEffort = resolveDefaultReasoningEffort(defaultAgentProvider, defaultModel, form?.aiDefaultReasoningEffort) ?? "";
  const updating = updatePhase === "installing" || updatePhase === "restarting";
  const tab = peonSettingsTabFromPath(location.pathname);
  const settingsPath = peonSettingsPath(peon.peonId);

  if (!isOwner) return <p className="font-mono text-sm text-bone-faint">{t("ownerOnly")}</p>;

  return (
    <div className="space-y-8">
      <RouteTabs
        ariaLabel={t("peon.settings.tabs")}
        tabs={[
          { to: settingsPath, label: t("peon.settings.tab.general"), end: true },
          { to: `${settingsPath}/agent`, label: t("peon.settings.tab.agent") },
          { to: `${settingsPath}/armory`, label: t("peon.settings.tab.armory") },
        ]}
      />

      {tab === "general" && <>
      {(peon.online || updating) && status && (
        <Card className="space-y-4 px-5 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-display text-sm font-bold text-bone">{t("peon.update.title")}</h3>
              <p className="mt-1 font-mono text-xs text-bone-dim">
                {status.updateAvailable ? t("peon.update.available") : t("peon.update.current")}
              </p>
            </div>
            {status.updateAvailable ? (
              <Button onClick={installUpdate} disabled={updating}>
                {updatePhase === "installing" ? t("peon.update.installing") : updatePhase === "restarting" ? t("peon.update.restarting") : t("peon.update.install")}
              </Button>
            ) : (
              <Button onClick={checkForUpdate} disabled={checkingUpdate || updating}>
                {checkingUpdate ? t("peon.update.checking") : t("peon.update.checkNow")}
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
      <CliUpdatesPanel base={base} online={peon.online} />
      <Card className="space-y-5 px-5 py-5">
        <div>
          <h3 className="font-display text-sm font-bold text-bone">{t("peon.conn.title")}</h3>
          <p className="mt-1 font-mono text-xs text-bone-dim">{t("peon.conn.hint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label>{t("peon.conn.address")}</Label>
          <Input value={address} onChange={(e) => { setAddress(e.target.value); setConnSaved(false); }} placeholder="http://peon.example:4570" />
        </div>
        <div className="font-mono text-xs text-bone-faint">
          {t("peon.conn.reaches")}: {peon.baseUrl}
          {(peon.addressSource === "paired" || peon.addressSource === "manual") && <span className="ml-2 text-fel">⌾ {t("peon.conn.pinned")}</span>}
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={saveConnection} disabled={connSaving || !address.trim()}>
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
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? t("peon.settings.saving") : t("peon.settings.save")}
            </Button>
            {saved && <span className="font-mono text-xs text-fel-bright">⚡ {t("peon.settings.saved")}</span>}
            {saveError && <span className="font-mono text-xs text-blood">⚠ {saveError}</span>}
          </div>
        </Card>
      )}

      {loadError && <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {loadError}</p>}
      {(unsupported || !peon.online) && <p className="font-mono text-sm text-bone-faint">{peon.online ? t("peon.unsupported") : t("peon.offlineNote")}</p>}

      <div>
        <h3 className="mb-3 rune text-sm text-blood">{t("peon.settings.danger")}</h3>
        <Card className="flex flex-wrap items-center justify-between gap-4 border-blood/30 px-5 py-4">
          <p className="font-mono text-xs text-bone-dim">{t("peon.settings.deleteHint")}</p>
          <button className="btn btn-sm !border-blood/50 !text-blood hover:!bg-blood/10" onClick={() => setConfirmDelete(true)}>
            {t("peon.settings.delete")}
          </button>
        </Card>
      </div>
      {confirmDelete && <ConfirmationDialog title={t("peon.settings.deleteConfirm")} confirmLabel={t("peon.settings.delete")} pendingLabel={t("peon.settings.deleting")} pending={deleting} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
      </>}

      {tab === "agent" && <>
        {peon.online && !unsupported && form && modelsSupported && catalog && catalog.providers.length > 0 && (
          <Card className="space-y-5 px-5 py-5">
            {catalog.providers.length > 1 && (
            <div className="space-y-1.5">
              <Label>{t("peon.settings.defaultAgent")}</Label>
              <AgentSelect
                catalog={catalog}
                value={defaultAgent ?? ""}
                onChange={(v) => {
                  const provider = providerForAgent(catalog, v);
                  setForm((f) => {
                    const model = resolveDefaultModel(provider, f?.aiDefaultModel);
                    return {
                      ...(f ?? {}),
                      defaultAgent: v,
                      aiDefaultModel: model,
                      // Effort ids are agent-scoped; keeping one across a switch
                      // would show a value the new provider never accepts.
                      aiDefaultReasoningEffort: resolveDefaultReasoningEffort(provider, model, f?.aiDefaultReasoningEffort),
                    };
                  });
                  setSaved(false);
                }}
                className="w-full"
              />
              <p className="font-mono text-xs text-bone-faint">{t("peon.settings.defaultAgentHint")}</p>
            </div>
            )}
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
            {/* Hidden entirely for models that take no effort — an empty picker
                would read as a broken control rather than an absent capability. */}
            {effortOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t("peon.settings.aiDefaultReasoningEffort")}</Label>
              <ReasoningEffortSelect
                provider={defaultAgentProvider}
                model={defaultModel}
                value={defaultReasoningEffort}
                onChange={(v) => { setForm((f) => ({ ...(f ?? {}), aiDefaultReasoningEffort: v || null })); setSaved(false); }}
                defaultLabel={t("peon.settings.aiDefaultReasoningEffortAuto")}
                defaultId={defaultEffortIdFor(effortOptions)}
                inlineLabel={false}
                className="w-full"
              />
              <p className="font-mono text-xs text-bone-faint">{t("peon.settings.aiDefaultReasoningEffortHint")}</p>
            </div>
            )}
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? t("peon.settings.saving") : t("peon.settings.save")}
            </Button>
            {saved && <span className="font-mono text-xs text-fel-bright">⚡ {t("peon.settings.saved")}</span>}
            {saveError && <span className="font-mono text-xs text-blood">⚠ {saveError}</span>}
          </div>
        </Card>
        )}

        {peon.online && !unsupported && form && soulLoaded && (
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="font-display text-sm font-bold text-bone">{t("peon.soul.title")}</h3>
              <Badge tone={soul === null ? "neutral" : "green"}>{t(soul === null ? "peon.soul.unconfigured" : "peon.soul.configured")}</Badge>
            </div>
            <Card className="space-y-4 px-5 py-5">
              {soul !== null && <p className="font-mono text-sm text-bone-dim">{soulExcerpt(soul)}</p>}
              <div className="space-y-1.5">
                <label htmlFor="peon-soul" className="block font-display text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-bone-dim">
                  {t("peon.soul.editor")}
                </label>
                <textarea
                  id="peon-soul"
                  className="field min-h-80 w-full resize-y font-mono text-sm"
                  rows={SOUL_EDITOR_ROWS}
                  value={soulDraft}
                  placeholder={t("peon.soul.placeholder")}
                  onChange={(event) => {
                    setSoulDraft(event.target.value);
                    setSoulSaved(false);
                    setSoulError(null);
                  }}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void persistSoul(soulDraft)} disabled={soulSaving || soulDraft === (soul ?? "")}>
                  {soulSaving ? t("peon.soul.saving") : t("peon.soul.save")}
                </Button>
                <Button variant="ghost" onClick={() => void persistSoul("")} disabled={soulSaving || (soul === null && soulDraft === "")}>
                  {t("peon.soul.clear")}
                </Button>
                {soulSaved && <span role="status" className="font-mono text-xs text-fel-bright">⚡ {t("peon.soul.saved")}</span>}
                {soulError && <span role="alert" className="font-mono text-xs text-blood">⚠ {soulError}</span>}
              </div>
            </Card>
          </div>
        )}

        {loadError && <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {loadError}</p>}
        {(unsupported || !peon.online) && <p className="font-mono text-sm text-bone-faint">{peon.online ? t("peon.unsupported") : t("peon.offlineNote")}</p>}
      </>}

      {tab === "armory" && <PeonArmory />}
    </div>
  );
}
