import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";
import { Badge, Button, Card, Dialog } from "../../ui";
import {
  ArmoryActionGate,
  getArmoryOperation,
  installArmoryPackage,
  operationActive,
  setArmoryPackageEnabled,
  uninstallArmoryPackage,
  updateArmoryPackage,
  type ArmoryCatalogVersion,
  type ArmoryOperation,
  type InstalledPackage,
} from "./armoryApi";

const POLL_INTERVAL_MS = 1_000;
export const UNINSTALL_PRESERVATION_COPY = "This removes the package runtime. Credentials, managed home, configuration, and ownership metadata are preserved.";

function stateLabel(installed: InstalledPackage | null): string {
  if (!installed) return "Not installed";
  if (installed.state === "installing") return "Installing";
  if (installed.state === "removing") return "Uninstalling";
  if (installed.state === "error" || installed.lastError) return "Error";
  if (installed.state === "needs_configuration" || installed.configurationStatus === "missing") return "Needs configuration";
  if (installed.state === "verifying" || installed.configurationStatus === "unverified") return "Verifying";
  if (installed.configurationStatus === "invalid") return "Invalid configuration";
  return installed.enabled ? "Enabled" : "Disabled";
}

function stateTone(installed: InstalledPackage | null): "green" | "amber" | "red" | undefined {
  if (!installed) return undefined;
  if (installed.state === "error" || installed.lastError || installed.configurationStatus === "invalid") return "red";
  return installed.enabled ? "green" : "amber";
}

function operationName(operation: ArmoryOperation): string {
  if (operation.kind === "delete_configuration") return "Delete configuration";
  return operation.kind.charAt(0).toUpperCase() + operation.kind.slice(1);
}

export function ArmoryLifecyclePanel({ base, packageId, installed, versions = [], latestVersion = null, updateAvailable = false, onRefresh }: {
  base: string;
  packageId: string;
  installed: InstalledPackage | null;
  versions?: ArmoryCatalogVersion[];
  latestVersion?: string | null;
  updateAvailable?: boolean | null;
  onRefresh: () => Promise<unknown>;
}) {
  const [operation, setOperation] = useState<ArmoryOperation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [selectedVersion, setSelectedVersion] = useState(latestVersion ?? versions[0]?.version ?? "");
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const refreshRef = useRef(onRefresh);
  const actionGate = useRef(new ArmoryActionGate());
  refreshRef.current = onRefresh;

  useEffect(() => {
    const gate = actionGate.current;
    gate.clear();
    setOperation(null);
    setError(null);
    setSubmitting(false);
    setUninstallOpen(false);
    return () => gate.clear();
  }, [base, packageId]);

  useEffect(() => {
    if (latestVersion) setSelectedVersion((current) => current || latestVersion);
  }, [latestVersion]);

  useEffect(() => {
    const operationId = installed?.activeOperationId;
    if (!operationId || operation?.id === operationId) return;
    let alive = true;
    getArmoryOperation(base, operationId).then(({ operation: current }) => {
      if (alive) { setOperation(current); setError(null); }
    }).catch((reason) => { if (alive) setError(reason); });
    return () => { alive = false; };
  }, [base, installed?.activeOperationId, operation?.id, retryAttempt]);

  useEffect(() => {
    if (!operation || !operationActive(operation)) return;
    const activeOperation = operation;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await getArmoryOperation(base, activeOperation.id);
        if (!alive) return;
        setOperation(response.operation);
        setError(null);
        if (operationActive(response.operation)) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        else await refreshRef.current();
      } catch (reason) { if (alive) setError(reason); }
    };
    timer = window.setTimeout(poll, activeOperation.status === "queued" ? 400 : POLL_INTERVAL_MS);
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [base, operation, retryAttempt]);

  const configured = installed?.configurationStatus === "verified" || installed?.configurationStatus === "not_required";
  const transient = installed?.state === "installing" || installed?.state === "removing" || installed?.state === "verifying";
  const busy = submitting || transient || operationActive(operation) || Boolean(installed?.activeOperationId && !operation);
  const enableReason = !configured
    ? "Complete and verify configuration before enabling."
    : installed?.state === "error" || installed?.configurationStatus === "invalid"
      ? "Resolve the package error before enabling."
      : null;

  const begin = async (action: "install" | "update" | "uninstall" | "enable" | "disable") => {
    if (busy) return;
    const actionToken = actionGate.current.begin();
    if (actionToken === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = action === "install"
        ? await installArmoryPackage(base, packageId, selectedVersion && selectedVersion !== latestVersion ? selectedVersion : null)
        : action === "update"
          ? await updateArmoryPackage(base, packageId, latestVersion)
        : action === "uninstall"
          ? await uninstallArmoryPackage(base, packageId)
          : await setArmoryPackageEnabled(base, packageId, action === "enable");
      if (!actionGate.current.current(actionToken)) return;
      setOperation(response.operation);
      setUninstallOpen(false);
      if (!operationActive(response.operation)) await onRefresh();
    } catch (reason) {
      if (actionGate.current.current(actionToken)) setError(reason);
    } finally {
      if (actionGate.current.finish(actionToken)) setSubmitting(false);
    }
  };

  const apiError = error as Partial<ApiError> | null;
  const failed = operation?.status === "failure" || operation?.status === "needs_human";

  return <Card className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-lg font-bold text-bone">Package lifecycle</h2><Badge tone={stateTone(installed)}>{stateLabel(installed)}</Badge></div>
        <p className="mt-2 text-sm text-bone-dim">{!installed ? "Choose a version and install it on this Peon." : installed.enabled ? "This package is active on the Peon." : configured ? "Configuration is ready, but the package is not active." : "Complete and verify configuration before enabling this package."}</p>
      </div>
      {!installed ? <div className="flex flex-wrap items-end gap-2">
        {versions.length > 1 && <label className="block"><span className="mb-1 block font-mono text-[0.68rem] text-bone-faint">Version</span><select className="field !w-auto !py-2 text-sm" value={selectedVersion} disabled={busy} onChange={(event) => setSelectedVersion(event.target.value)}>{versions.map((version) => <option key={version.version} value={version.version}>{version.version}{version.version === latestVersion ? " (latest)" : ""}</option>)}</select></label>}
        <Button type="button" disabled={busy || !latestVersion} title={!latestVersion ? "No installable catalog version is available." : undefined} onClick={() => void begin("install")}>{submitting ? "Submitting…" : selectedVersion && selectedVersion !== latestVersion ? `Install ${selectedVersion}` : "Install latest"}</Button>
      </div> : <div className="flex flex-wrap gap-2">
        {updateAvailable === true && latestVersion && <Button type="button" disabled={busy} onClick={() => void begin("update")}>{submitting ? "Submitting…" : `Update to ${latestVersion}`}</Button>}
        <Button type="button" variant="iron" disabled={busy} className="!border-blood/40 !text-blood hover:!bg-blood/10" onClick={() => setUninstallOpen(true)}>Uninstall</Button>
        <Button type="button" variant={installed.enabled ? "iron" : undefined} disabled={busy || (!installed.enabled && Boolean(enableReason))} title={!installed.enabled && enableReason ? enableReason : undefined} onClick={() => void begin(installed.enabled ? "disable" : "enable")}>{submitting ? "Submitting…" : installed.enabled ? "Disable package" : "Enable package"}</Button>
      </div>}
    </div>

    {installed && <dl className="mt-5 grid gap-4 border-t border-iron-700 pt-4 sm:grid-cols-3">
      <div><dt className="font-mono text-xs text-bone-faint">Runtime</dt><dd className="mt-1 text-sm text-bone">{installed.enabled ? "Enabled" : "Disabled"}</dd></div>
      <div><dt className="font-mono text-xs text-bone-faint">Package state</dt><dd className="mt-1 text-sm capitalize text-bone">{installed.state.replace(/_/g, " ")}</dd></div>
      <div><dt className="font-mono text-xs text-bone-faint">Configuration</dt><dd className="mt-1 text-sm capitalize text-bone">{installed.configurationStatus.replace(/_/g, " ")}</dd></div>
    </dl>}

    {operation && <div className={`mt-4 border-l-2 px-3 py-2 text-sm ${failed ? "border-blood bg-blood/5 text-blood" : operation.status === "success" ? "border-fel bg-fel/5 text-fel-bright" : "border-forge bg-forge/5 text-ember"}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2"><span>{operationName(operation)}: {operation.status.replace(/_/g, " ")} · {operation.phase.replace(/_/g, " ")}</span>{operation.progress !== null && <span className="font-mono text-xs">{Math.max(0, Math.min(100, operation.progress))}%</span>}</div>
      {operation.progress !== null && <div className="mt-2 h-1 overflow-hidden rounded bg-iron-800" aria-label={`${operationName(operation)} progress`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, operation.progress))}><div className="h-full bg-current transition-[width]" style={{ width: `${Math.max(0, Math.min(100, operation.progress))}%` }} /></div>}
      {operation.message && <p className="mt-1 text-xs opacity-80">{operation.message}</p>}
      {operation.errorCode && <p className="mt-1 font-mono text-xs">{operation.errorCode}</p>}
    </div>}
    {Boolean(error) && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 border-l-2 border-blood bg-blood/5 px-3 py-2 text-sm text-blood"><span>{error instanceof Error ? error.message : "Package action failed."}{apiError?.code ? ` (${apiError.code})` : ""}</span><Button type="button" size="sm" variant="iron" onClick={() => { setError(null); setRetryAttempt((value) => value + 1); void onRefresh(); }}>Retry status</Button></div>}

    {uninstallOpen && installed && <Dialog title="Uninstall package?" onClose={() => setUninstallOpen(false)} dismissible={!busy}>
      <p className="text-sm text-bone-dim">{UNINSTALL_PRESERVATION_COPY}</p>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="iron" disabled={busy} onClick={() => setUninstallOpen(false)}>Cancel</Button><Button type="button" className="!border-blood/50 !text-blood hover:!bg-blood/10" variant="iron" disabled={busy} onClick={() => void begin("uninstall")}>{submitting ? "Uninstalling…" : "Confirm uninstall"}</Button></div>
    </Dialog>}
  </Card>;
}
