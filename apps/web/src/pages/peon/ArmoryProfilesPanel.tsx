import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { ApiError } from "../../api";
import { Badge, Button, Card, Dialog } from "../../ui";
import {
  ArmoryActionGate,
  armoryProfileReadiness,
  clearSettledArmoryProfileValues,
  configureArmoryProfile,
  createArmoryProfile,
  deleteArmoryProfile,
  getArmoryProfileOperation,
  matchingArmoryProfiles,
  missingArmoryProfileFields,
  profileOperationActive,
  renameArmoryProfile,
  validateArmoryProfileConfiguration,
  verifyArmoryProfile,
  type ArmoryConfiguration,
  type ArmoryConfigurationField,
  type ArmoryProfile,
  type ArmoryProfileOperation,
  type ArmoryProfileRequirement,
  type ConfigurationErrors,
} from "./armoryApi";

const POLL_INTERVAL_MS = 1_200;

function profileTone(profile: ArmoryProfile): "green" | "amber" | "red" | undefined {
  if (profile.status === "verified") return "green";
  if (profile.status === "invalid") return "red";
  return "amber";
}

export function ProfileField({ field, value, configured, error, disabled, onValue }: {
  field: ArmoryConfigurationField;
  value: string;
  configured: boolean;
  error?: string;
  disabled: boolean;
  onValue: (value: string) => void;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const file = useRef<HTMLInputElement>(null);
  const [userActivated, setUserActivated] = useState(false);
  useEffect(() => { if (!value && file.current) file.current.value = ""; }, [value]);
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (!selected) return onValue("");
    try { onValue(await selected.text()); } catch { onValue(""); }
  };
  const common = {
    id,
    disabled,
    required: field.required && !configured,
    "aria-invalid": Boolean(error),
    "aria-describedby": [field.help ? helpId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined,
  };
  return <div className="grid gap-2 border-b border-edge pb-4 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-5">
    <div><label className="font-display text-xs font-bold text-ink" htmlFor={id}>{field.label}{field.required && <span className="ml-1 text-warning-strong" aria-label="required">*</span>}</label>{field.help && <p id={helpId} className="mt-1 text-xs leading-relaxed text-ink-muted">{field.help}</p>}</div>
    <div>
      <div className="relative">
        {field.type === "select" ? <select {...common} className="field w-full" value={value} onChange={(event) => onValue(event.target.value)}><option value="">Select…</option>{(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : field.type === "file" ? <input {...common} ref={file} className="field w-full file:mr-3 file:border-0 file:bg-surface-hover file:px-3 file:py-1 file:text-ink" type="file" onChange={(event) => void readFile(event)} />
            : <input {...common} className="field w-full" autoComplete={field.type === "secret" ? "new-password" : "off"} data-1p-ignore="true" data-lpignore="true" data-form-type="other" readOnly={!userActivated} onFocus={() => setUserActivated(true)} type={field.type === "secret" ? "password" : "text"} value={value} pattern={field.validation?.pattern} maxLength={field.validation?.maxLength} onChange={(event) => onValue(event.target.value)} />}
        {configured && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"><Badge>Configured</Badge></span>}
      </div>
      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  </div>;
}

function ProfileCard({ base, profile, requirement, schema, onRefresh }: {
  base: string;
  profile: ArmoryProfile;
  requirement: ArmoryProfileRequirement;
  schema: ArmoryConfiguration;
  onRefresh: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<ConfigurationErrors>({});
  const [editingConfiguration, setEditingConfiguration] = useState(profile.status !== "verified");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(profile.name);
  const [deleting, setDeleting] = useState(false);
  const [operation, setOperation] = useState<ArmoryProfileOperation | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [pollingError, setPollingError] = useState<unknown>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const gate = useRef(new ArmoryActionGate());
  const missingFields = missingArmoryProfileFields(profile, requirement);
  const readiness = armoryProfileReadiness(profile, requirement);
  const busy = submitting || profileOperationActive(operation) || gate.current.locked();

  useEffect(() => {
    const actionGate = gate.current;
    actionGate.clear();
    setValues({});
    setErrors({});
    setOperation(null);
    setSubmitting(false);
    setRequestError(null);
    setPollingError(null);
    setName(profile.name);
    return () => actionGate.clear();
  }, [base, profile.profileId, profile.name]);

  useEffect(() => {
    if (!profileOperationActive(operation) || pollingError) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      if (!operation) return;
      try {
        const response = await getArmoryProfileOperation(base, operation.operationId);
        if (!alive) return;
        setOperation(response.operation);
        if (profileOperationActive(response.operation)) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        else await onRefresh();
      } catch (error) { if (alive) setPollingError(error); }
    };
    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => { alive = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [base, onRefresh, operation, pollAttempt, pollingError]);

  const run = async (action: "configure" | "verify" | "rename" | "delete") => {
    if (action === "configure") {
      const nextErrors = validateArmoryProfileConfiguration(schema, profile, values);
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;
    }
    const token = gate.current.begin();
    if (token === null) return;
    setSubmitting(true);
    setRequestError(null);
    try {
      if (action === "configure") {
        const accepted = await configureArmoryProfile(base, profile.profileId, values);
        if (!gate.current.current(token)) return;
        setOperation(accepted);
        setPollingError(null);
        if (!profileOperationActive(accepted)) await onRefresh();
      } else if (action === "verify") {
        const accepted = await verifyArmoryProfile(base, profile.profileId);
        if (!gate.current.current(token)) return;
        setOperation(accepted);
        setPollingError(null);
        if (!profileOperationActive(accepted)) await onRefresh();
      } else if (action === "rename") {
        await renameArmoryProfile(base, profile.profileId, name.trim());
        if (!gate.current.current(token)) return;
        setRenaming(false);
        await onRefresh();
      } else {
        await deleteArmoryProfile(base, profile.profileId);
        if (!gate.current.current(token)) return;
        setDeleting(false);
        await onRefresh();
      }
    } catch (error) {
      if (gate.current.current(token)) setRequestError(error);
    } finally {
      // All profile values are write-only, including ordinary text/select
      // fields. Scrub them after every settled configure attempt.
      if (action === "configure") setValues(clearSettledArmoryProfileValues());
      gate.current.finish(token);
      setSubmitting(false);
    }
  };

  return <Card className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-display text-base font-bold text-ink">{profile.name}</h3><Badge tone={profileTone(profile)}>{profile.status}</Badge></div><p className="mt-1 font-mono text-[0.7rem] text-ink-faint">Type · {profile.type}</p></div>
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setName(profile.name); setRenaming(true); }}>Rename</Button><Button type="button" size="sm" variant="ghost" disabled={busy} aria-haspopup="dialog" onClick={() => setDeleting(true)}>Delete</Button></div>
    </div>
    {readiness !== "ready" && <div role="status" className={`mt-4 border-l-2 px-3 py-2 text-sm ${readiness === "invalid" ? "border-danger bg-danger/5 text-danger" : "border-warning bg-warning/5 text-warning-strong"}`}>
      {readiness === "missing_fields" ? `Missing required fields: ${missingFields.join(", ") || "configuration"}.` : readiness === "invalid" ? "The latest profile configuration or verification failed." : readiness === "unverified" ? "Configured profile has not been verified." : "Profile type does not match this package."}
    </div>}
    <dl className="mt-4 grid gap-3 sm:grid-cols-2"><div><dt className="font-mono text-xs text-ink-faint">Configured fields</dt><dd className="mt-1 text-sm text-ink">{Object.keys(profile.configuredFields).length ? Object.keys(profile.configuredFields).join(", ") : "None"}</dd></div><div><dt className="font-mono text-xs text-ink-faint">Verification</dt><dd className="mt-1 text-sm capitalize text-ink">{profile.status}</dd></div></dl>
    <div className="mt-4 flex flex-wrap gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setEditingConfiguration((value) => !value)}>{editingConfiguration ? "Hide configuration" : "Configure"}</Button><Button type="button" size="sm" disabled={busy || missingFields.length > 0 || profile.status === "missing"} title={missingFields.length ? "Configure every required field before verifying." : undefined} onClick={() => void run("verify")}>Verify</Button></div>
    {editingConfiguration && <form className="mt-4 space-y-4 border-t border-edge pt-4" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void run("configure"); }}>
      {schema.fields.map((field) => <ProfileField key={field.id} field={field} value={values[field.id] ?? ""} configured={profile.configuredFields[field.id] === true} error={errors[field.id]} disabled={busy} onValue={(value) => { setValues((current) => ({ ...current, [field.id]: value })); setErrors((current) => { const next = { ...current }; delete next[field.id]; return next; }); }} />)}
      {schema.hostWrites.length > 0 && <p className="border-l-2 border-warning bg-warning/5 px-3 py-2 text-xs text-warning-strong">This profile’s package handler declares host writes. Review the package documentation before submitting.</p>}
      <Button type="submit" disabled={busy}>Save write-only configuration</Button>
    </form>}
    {operation && <div role="status" aria-live="polite" className={`mt-4 border-l-2 px-3 py-2 text-sm ${operation.status === "failed" ? "border-danger bg-danger/5 text-danger" : operation.status === "succeeded" ? "border-accent bg-accent/5 text-accent-strong" : "border-warning bg-warning/5 text-warning-strong"}`}>{operation.kind === "profile_configure" ? "Profile configuration" : "Profile verification"}: {operation.status.replace(/_/g, " ")}{operation.code ? ` (${operation.code})` : ""}</div>}
    {Boolean(pollingError) && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 border-l-2 border-danger bg-danger/5 px-3 py-2 text-sm text-danger"><span>Operation status could not be refreshed. It was not resubmitted.</span><Button type="button" size="sm" variant="secondary" onClick={() => { setPollingError(null); setPollAttempt((value) => value + 1); }}>Retry status</Button></div>}
    {Boolean(requestError) && <div role="alert" className="mt-4 border-l-2 border-danger bg-danger/5 px-3 py-2 text-sm text-danger">{requestError instanceof ApiError ? `${requestError.message} (${requestError.code})` : requestError instanceof Error ? requestError.message : "Profile action failed."}</div>}
    {renaming && <Dialog title="Rename profile" onClose={() => setRenaming(false)} dismissible={!busy}><form onSubmit={(event) => { event.preventDefault(); void run("rename"); }}><label className="block font-display text-xs font-bold text-ink" htmlFor={`rename-${profile.profileId}`}>Profile name</label><input id={`rename-${profile.profileId}`} autoFocus className="field mt-2 w-full" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /><div className="mt-5 flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => setRenaming(false)}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>Save name</Button></div></form></Dialog>}
    {deleting && <Dialog title="Delete profile?" onClose={() => setDeleting(false)} dismissible={!busy}><p className="text-sm text-ink-muted">Profiles assigned to any project/package must be unassigned first. Stored values are never shown here.</p><div className="mt-5 flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => setDeleting(false)}>Cancel</Button><Button type="button" variant="secondary" className="!border-danger/50 !text-danger hover:!bg-danger/10" disabled={busy} onClick={() => void run("delete")}>Delete profile</Button></div></Dialog>}
  </Card>;
}

export function ArmoryProfilesPanel({ base, requirement, schema, profiles, loading, error, onRefresh }: {
  base: string;
  requirement: ArmoryProfileRequirement;
  schema: ArmoryConfiguration | null;
  profiles: ArmoryProfile[];
  loading: boolean;
  error: unknown;
  onRefresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const createGate = useRef(new ArmoryActionGate());
  const compatible = matchingArmoryProfiles(profiles, requirement);
  const mismatchedCount = profiles.length - compatible.length;
  useEffect(() => {
    const gate = createGate.current;
    gate.clear();
    setCreating(false);
    setCreateError(null);
    setName("");
    return () => gate.clear();
  }, [base, requirement.type]);
  const create = async () => {
    if (creating || !name.trim()) return;
    const token = createGate.current.begin();
    if (token === null) return;
    setCreating(true); setCreateError(null);
    try {
      await createArmoryProfile(base, requirement.type, name.trim());
      if (!createGate.current.current(token)) return;
      setName("");
      await onRefresh();
    } catch (reason) { if (createGate.current.current(token)) setCreateError(reason); }
    finally { if (createGate.current.finish(token)) setCreating(false); }
  };

  return <section className="space-y-4" aria-labelledby="armory-profiles-title">
    <div><div className="flex flex-wrap items-center gap-2"><h2 id="armory-profiles-title" className="font-display text-lg font-bold text-ink">Shared profiles</h2><Badge>{requirement.type}</Badge></div><p className="mt-1 text-sm text-ink-muted">Profiles belong to this Peon and can be reused by compatible packages and projects. Stored values stay write-only.</p></div>
    {mismatchedCount > 0 && <p className="border-l-2 border-edge-strong px-3 py-2 text-sm text-ink-muted">{mismatchedCount} other profile{mismatchedCount === 1 ? " has" : "s have"} a different exact type and cannot be selected for this package.</p>}
    <Card className="p-4"><form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); void create(); }}><label className="min-w-0 flex-1"><span className="mb-1 block font-display text-xs font-bold text-ink">New {requirement.type} profile</span><input className="field w-full" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Profile name" /></label><Button type="submit" disabled={creating || !name.trim()}>{creating ? "Creating…" : "Create profile"}</Button></form>{Boolean(createError) && <p role="alert" className="mt-3 text-sm text-danger">{createError instanceof Error ? createError.message : "Profile could not be created."}</p>}</Card>
    {Boolean(error) && <div role="alert" className="border-l-2 border-danger bg-danger/5 px-3 py-2 text-sm text-danger">Profiles or their configuration fields could not be refreshed. Previously loaded safe profile metadata is shown when available.</div>}
    {loading && profiles.length === 0 ? <Card className="grid min-h-28 place-items-center"><span className="loading-spinner" aria-label="Loading profiles" /></Card>
      : !schema ? <Card className="p-5 text-sm text-ink-muted">Configuration fields are unavailable for this installed package.</Card>
          : compatible.length === 0 ? <Card className="p-5 text-sm text-ink-muted">No compatible profiles yet. Create one to configure and assign this package.</Card>
            : <div className="space-y-3">{compatible.map((profile) => <ProfileCard key={profile.profileId} base={base} profile={profile} requirement={requirement} schema={schema} onRefresh={onRefresh} />)}</div>}
  </section>;
}
