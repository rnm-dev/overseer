import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { CheckCircle2, Pencil } from "lucide-react";
import { ApiError, api } from "../../api";
import { Badge, Button, Card, Dialog } from "../../ui";
import {
  clearAcceptedTransientValues,
  deleteArmoryConfiguration,
  getArmoryOperation,
  operationActive,
  submitArmoryConfiguration,
  validateArmoryConfiguration,
  type ArmoryConfiguration,
  type ArmoryConfigurationField,
  type ArmoryOperation,
  type ConfigurationErrors,
  type InstalledPackage,
} from "./armoryApi";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 160;

function statusPresentation(status: InstalledPackage["configurationStatus"]): { label: string; detail: string; tone: "neutral" | "green" | "red" | "amber" } {
  if (status === "missing") return { label: "Missing", detail: "Configuration is required before this package can become ready.", tone: "amber" };
  if (status === "unverified") return { label: "Unverified", detail: "Configuration exists but has not passed verification.", tone: "amber" };
  if (status === "verified") return { label: "Verified", detail: "Configuration is ready and has passed verification.", tone: "green" };
  if (status === "invalid") return { label: "Invalid", detail: "The latest configure or verification attempt failed.", tone: "red" };
  return { label: "Not required", detail: "No configuration is required for this package.", tone: "neutral" };
}

function FieldControl({ field, value, error, configured, disabled, onValue }: {
  field: ArmoryConfigurationField;
  value: string;
  error?: string;
  configured: boolean;
  disabled: boolean;
  onValue: (value: string) => void;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [field.help ? helpId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const common = { id, disabled, required: field.required, "aria-describedby": describedBy, "aria-invalid": Boolean(error) };
  const fileInput = useRef<HTMLInputElement>(null);
  const hasBadges = configured;

  useEffect(() => { if (!value && fileInput.current) fileInput.current.value = ""; }, [value]);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) { onValue(""); return; }
    try { onValue(await file.text()); }
    catch { onValue(""); }
  };

  return (
    <div className="grid gap-2 border-b border-iron-800 pb-5 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-6">
      <div>
        <label htmlFor={id} className="font-display text-xs font-bold text-bone">{field.label}{field.required && <span className="ml-1 text-ember" aria-label="required">*</span>}</label>
        {field.help && <p id={helpId} className="mt-1.5 text-xs leading-relaxed text-bone-dim">{field.help}</p>}
      </div>
      <div className="min-w-0">
        <div className="relative">
          {field.type === "select" ? (
            <select {...common} className={`field w-full ${hasBadges ? "pr-44" : ""}`} value={value} onChange={(event) => onValue(event.target.value)}>
              <option value="">Select…</option>
              {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : field.type === "file" ? (
            <input {...common} ref={fileInput} className={`field w-full file:mr-3 file:border-0 file:bg-iron-800 file:px-3 file:py-1 file:text-bone ${hasBadges ? "pr-40" : ""}`} type="file" onChange={(event) => void readFile(event)} />
          ) : (
            <input {...common} className={`field w-full ${hasBadges ? "pr-40" : ""}`} type={field.type === "secret" ? "password" : "text"} value={value} onChange={(event) => onValue(event.target.value)} pattern={field.validation?.pattern} maxLength={field.validation?.maxLength} />
          )}
          {hasBadges && <div className={`pointer-events-none absolute top-1/2 flex -translate-y-1/2 gap-1.5 ${field.type === "select" ? "right-8" : "right-3"}`}><Badge>Configured</Badge></div>}
        </div>
        {field.validation && <p className="mt-1 font-mono text-[0.68rem] text-bone-faint">{field.validation.maxLength !== undefined ? `Maximum ${field.validation.maxLength} characters. ` : ""}{field.validation.pattern ? "A package-defined format is required." : ""}</p>}
        {error && <p id={errorId} role="alert" className="mt-1 text-xs text-blood">{error}</p>}
      </div>
    </div>
  );
}

function OperationProgress({ operation, pollingError, onRetry }: { operation: ArmoryOperation; pollingError: unknown; onRetry: () => void }) {
  const progress = operation.progress === null ? null : Math.max(0, Math.min(100, operation.progress));
  const failed = operation.status === "failure" || operation.status === "needs_human";
  return (
    <Card className={`p-4 ${failed ? "border-blood/50" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-display text-sm font-bold text-bone">{operation.kind === "configure" ? "Configure and verify" : "Delete configuration"}</h3><Badge tone={operation.status === "success" ? "green" : failed ? "red" : "amber"}>{operation.status.replace(/_/g, " ")}</Badge></div>
      <p className="mt-2 font-mono text-xs text-bone-dim">Phase: {operation.kind === "configure" ? "configuration" : operation.phase || "waiting"}</p>
      {operation.kind !== "configure" && operation.message && <p className="mt-2 text-sm text-bone-dim">{operation.message}</p>}
      {progress !== null && <div className="mt-3"><progress className="h-2 w-full accent-fel" max={100} value={progress} aria-label="Operation progress" /><p className="mt-1 text-right font-mono text-[0.68rem] text-bone-faint">{progress}%</p></div>}
      {operation.kind !== "configure" && operation.errorCode && <p className="mt-2 font-mono text-xs text-blood">Error code: {operation.errorCode}</p>}
      {Boolean(pollingError) && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-l-2 border-blood bg-blood/5 p-3 text-sm text-blood"><span>Status polling was interrupted. The operation was not resubmitted.</span><Button type="button" size="sm" variant="iron" onClick={onRetry}>Retry status</Button></div>}
    </Card>
  );
}

export function ArmoryConfigurationPanel({ base, packageId, installed, schema, schemaError, onRetrySchema, onRefresh }: {
  base: string;
  packageId: string;
  installed: InstalledPackage | null;
  schema: ArmoryConfiguration | null;
  schemaError: unknown;
  onRetrySchema: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<ConfigurationErrors>({});
  const [hostConfirmed, setHostConfirmed] = useState(false);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [operation, setOperation] = useState<ArmoryOperation | null>(null);
  const [pollingError, setPollingError] = useState<unknown>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [recoveryError, setRecoveryError] = useState<unknown>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [includeHost, setIncludeHost] = useState(false);
  const [deleteHostConfirmed, setDeleteHostConfirmed] = useState(false);
  const pollController = useRef<AbortController | null>(null);
  const recoveryController = useRef<AbortController | null>(null);
  const pollAttempts = useRef(0);

  // The component is keyed by Peon/package in its parent. Cleanup additionally
  // clears transient secrets/file contents and aborts any active status request.
  useEffect(() => () => {
    pollController.current?.abort();
    recoveryController.current?.abort();
  }, []);

  // Also scrub the form if it becomes unavailable without unmounting this
  // component (for example, after an install-state refresh).
  useEffect(() => {
    if (!installed || !schema || schema.fields.length === 0) {
      setValues({});
      setErrors({});
      setHostConfirmed(false);
    }
  }, [installed, schema]);

  useEffect(() => {
    const operationId = installed?.activeOperationId;
    if (!operationId || operation?.id === operationId) return;
    const controller = new AbortController();
    recoveryController.current = controller;
    getArmoryOperation(base, operationId, (path) => api(path, { signal: controller.signal }))
      .then((response) => { if (!controller.signal.aborted) { pollAttempts.current = 0; setOperation(response.operation); setPollingError(null); setRecoveryError(null); if (!operationActive(response.operation)) void onRefresh(); } })
      .catch((error) => { if (!controller.signal.aborted) setRecoveryError(error); });
    return () => controller.abort();
  }, [base, installed?.activeOperationId, onRefresh, operation?.id, recoveryAttempt]);

  useEffect(() => {
    if (!operationActive(operation) || pollingError) return;
    const initialDelay = operation?.status === "queued" ? 500 : POLL_INTERVAL_MS;
    let alive = true;
    let timer: number | undefined;
    const check = async () => {
      if (!alive || !operation) return;
      if (++pollAttempts.current > MAX_POLL_ATTEMPTS) {
        setPollingError(new Error("Operation status polling timed out."));
        return;
      }
      const controller = new AbortController();
      pollController.current = controller;
      try {
        const response = await getArmoryOperation(base, operation.id, (path) => api(path, { signal: controller.signal }));
        if (!alive) return;
        setOperation(response.operation);
        if (operationActive(response.operation)) timer = window.setTimeout(check, POLL_INTERVAL_MS);
        else {
          if (response.operation.status === "success") { setValues({}); setEditing(false); }
          setHostConfirmed(false);
          setDeleteOpen(false);
          setIncludeHost(false);
          setDeleteHostConfirmed(false);
          await onRefresh();
        }
      } catch (error) {
        if (alive && !controller.signal.aborted) setPollingError(error);
      }
    };
    timer = window.setTimeout(check, initialDelay);
    return () => { alive = false; if (timer !== undefined) window.clearTimeout(timer); pollController.current?.abort(); };
  }, [base, onRefresh, operation, pollAttempt, pollingError]);

  if (!installed) return <section><h2 className="mb-3 font-display text-lg font-bold text-bone">Configuration</h2><Card className="p-5 text-sm text-bone-dim">Install this package before configuring it.</Card></section>;
  const status = statusPresentation(installed.configurationStatus);
  const configured = installed.configurationStatus === "verified";
  const operationConflict = requestError instanceof ApiError && requestError.code === "OPERATION_IN_PROGRESS";
  const busy = submitting || operationActive(operation) || operationConflict;

  const submit = async () => {
    if (!schema || busy) return;
    const nextErrors = validateArmoryConfiguration(schema, values);
    if (schema.hostWrites.length && !hostConfirmed) nextErrors.$hostWrites = "Confirm the declared host-write paths before continuing.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setSubmitting(true); setRequestError(null);
    try {
      const response = await submitArmoryConfiguration(base, packageId, values, hostConfirmed);
      pollAttempts.current = 0;
      setOperation(response.operation);
      setPollingError(null);
      // Accepted secrets and file contents leave UI memory immediately. Other
      // values remain only until terminal refresh so ordinary fields can be seen.
      setValues((current) => clearAcceptedTransientValues(schema, current));
      if (!operationActive(response.operation)) {
        if (response.operation.status === "success") { setValues({}); setEditing(false); }
        await onRefresh();
      }
    } catch (error) {
      setRequestError(error); // Peon error objects never include submitted values.
    } finally { setSubmitting(false); }
  };

  const remove = async () => {
    if (busy || (includeHost && !deleteHostConfirmed)) return;
    setSubmitting(true); setRequestError(null);
    try {
      const response = await deleteArmoryConfiguration(base, packageId, includeHost);
      pollAttempts.current = 0;
      setOperation(response.operation); setPollingError(null); setValues({});
      if (!operationActive(response.operation)) await onRefresh();
    } catch (error) { setRequestError(error); }
    finally { setSubmitting(false); }
  };

  return (
    <section className="space-y-4">
      {(!configured || editing || operationActive(operation)) && <><div className="flex flex-wrap items-center gap-3"><h2 className="font-display text-lg font-bold text-bone">Configuration</h2><Badge tone={status.tone}>{status.label}</Badge></div><p className="text-sm text-bone-dim">{status.detail}</p></>}
      {Boolean(schemaError) && <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-blood bg-blood/5 p-3 text-sm text-blood"><span>{schemaError instanceof Error ? schemaError.message : "Configuration schema could not be loaded."}{schemaError instanceof ApiError ? ` (${schemaError.code})` : ""}</span><Button type="button" size="sm" variant="iron" onClick={onRetrySchema}>Retry</Button></div>}
      {Boolean(recoveryError) && !operation && <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-blood bg-blood/5 p-3 text-sm text-blood"><span>Existing operation status could not be loaded. No configuration was resubmitted.</span><Button type="button" size="sm" variant="iron" onClick={() => { setRecoveryError(null); setRecoveryAttempt((value) => value + 1); }}>Retry status</Button></div>}
      {!schema && !schemaError && <Card className="p-5"><div className="forge-spin" aria-label="Loading configuration schema" /></Card>}
      {schema && schema.fields.length === 0 && installed.configurationStatus === "not_required" && <Card className="p-5 text-sm text-bone-dim">No configuration required.</Card>}
      {schema && schema.fields.length > 0 && configured && !editing && !operationActive(operation) && <Card className="relative overflow-hidden border-fel/35 bg-fel/[0.04] p-6 shadow-[inset_0_1px_0_rgba(149,201,103,0.08),0_0_32px_rgba(86,136,55,0.07)]">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-fel-bright/70 to-transparent" aria-hidden />
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-fel/35 bg-fel/10 text-fel-bright shadow-[0_0_20px_rgba(143,239,63,0.08)]"><CheckCircle2 size={23} strokeWidth={2.2} aria-hidden /></div>
            <h3 className="self-center font-display text-lg font-bold text-bone">Configuration verified</h3>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
            <Button type="button" variant="iron" onClick={() => setEditing(true)}><span className="inline-flex items-center gap-2"><Pencil size={14} aria-hidden />Edit</span></Button>
            <Button type="button" variant="ghost" aria-haspopup="dialog" onClick={() => setDeleteOpen(true)}>Delete</Button>
          </div>
        </div>
      </Card>}
      {schema && schema.fields.length > 0 && (!configured || editing || operationActive(operation)) && <Card className="p-5"><form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(); }} autoComplete="off">
        {schema.fields.map((field) => <FieldControl key={field.id} field={field} value={values[field.id] ?? ""} error={errors[field.id]} configured={schema.configured[field.id] === true} disabled={busy} onValue={(value) => { setValues((current) => ({ ...current, [field.id]: value })); setErrors((current) => { const next = { ...current }; delete next[field.id]; return next; }); }} />)}
        {schema.hostWrites.length > 0 && <Card className="border-forge/50 bg-forge/[0.03] p-4"><h3 className="font-display text-sm font-bold text-ember">Host writes</h3><p className="mt-2 text-sm text-bone-dim">This package may write outside its managed Armory home at these exact paths:</p><ul className="mt-2 space-y-1 font-mono text-xs text-bone">{schema.hostWrites.map((path) => <li key={path} className="break-all">{path}</li>)}</ul><label className="mt-3 flex items-start gap-2 text-sm text-bone"><input type="checkbox" className="mt-0.5 accent-fel" checked={hostConfirmed} disabled={busy} onChange={(event) => { setHostConfirmed(event.target.checked); setErrors((current) => { const next = { ...current }; delete next.$hostWrites; return next; }); }} />I confirm these host-write paths.</label>{errors.$hostWrites && <p role="alert" className="mt-2 text-xs text-blood">{errors.$hostWrites}</p>}</Card>}
        {Boolean(requestError) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-blood bg-blood/5 p-3 text-sm text-blood"><span>Peon rejected the configuration.</span>{operationConflict && <Button type="button" size="sm" variant="iron" onClick={() => { setRequestError(null); void onRefresh(); }}>Refresh operation status</Button>}</div>}
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}>{submitting ? "Submitting…" : "Save configuration"}</Button>{configured && editing && <Button type="button" variant="iron" disabled={busy} onClick={() => { setEditing(false); setValues({}); setErrors({}); setHostConfirmed(false); }}>Cancel</Button>}<Button type="button" variant="iron" aria-haspopup="dialog" disabled={busy} onClick={() => setDeleteOpen(true)}>Delete configuration</Button></div>
      </form></Card>}
      {schema && schema.fields.length === 0 && installed.configurationStatus !== "not_required" && <div className="flex gap-3"><Button type="button" variant="iron" aria-haspopup="dialog" disabled={busy} onClick={() => setDeleteOpen(true)}>Delete configuration</Button></div>}
      {deleteOpen && schema && <Dialog title="Delete configuration?" onClose={() => { setDeleteOpen(false); setIncludeHost(false); setDeleteHostConfirmed(false); }} dismissible={!busy}><p className="text-sm text-bone-dim">This deletes Armory-managed configuration and disables the package. It does not uninstall the package.</p>{schema.hostWrites.length > 0 && <div className="mt-4"><p className="text-sm text-bone-dim">Managed deletion leaves these declared host paths untouched:</p><ul className="mt-2 space-y-1 font-mono text-xs text-bone">{schema.hostWrites.map((path) => <li key={path} className="break-all">{path}</li>)}</ul><label className="mt-3 flex items-start gap-2 text-sm text-bone"><input type="checkbox" className="mt-0.5 accent-fel" checked={includeHost} disabled={busy} onChange={(event) => { setIncludeHost(event.target.checked); setDeleteHostConfirmed(false); }} />Also delete the exact declared host paths.</label>{includeHost && <label className="mt-3 flex items-start gap-2 border-l-2 border-blood bg-blood/5 p-3 text-sm text-bone"><input type="checkbox" className="mt-0.5 accent-fel" checked={deleteHostConfirmed} disabled={busy} onChange={(event) => setDeleteHostConfirmed(event.target.checked)} />I explicitly confirm deletion of every path listed above.</label>}</div>}<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="iron" disabled={busy} onClick={() => { setDeleteOpen(false); setIncludeHost(false); setDeleteHostConfirmed(false); }}>Cancel</Button><Button type="button" className="!border-blood/50 !text-blood hover:!bg-blood/10" variant="iron" disabled={busy || (includeHost && !deleteHostConfirmed)} onClick={() => void remove()}>{submitting ? "Deleting…" : includeHost ? "Delete configuration and host paths" : "Delete managed configuration"}</Button></div></Dialog>}
      {operation && !(configured && operation.status === "success") && <OperationProgress operation={operation} pollingError={pollingError} onRetry={() => { pollAttempts.current = 0; setPollingError(null); setPollAttempt((value) => value + 1); }} />}
    </section>
  );
}
