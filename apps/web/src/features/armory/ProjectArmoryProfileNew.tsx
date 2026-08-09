import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, api } from "../../shared/api";
import { Badge, Button, Card } from "../../shared/ui";
import { usePeon } from "../fleet/context";
import { ProfileField } from "./ArmoryProfilesPanel";
import { ProjectPageHeader } from "../projects/ProjectPageHeader";
import { ProjectTabs } from "../projects/ProjectTabs";
import type { ProjectDetail } from "../fleet/peonApi";
import {
  ArmoryActionGate,
  ArmoryRequestGate,
  clearSettledArmoryProfileValues,
  configureArmoryProfile,
  createArmoryProfile,
  getArmoryConfiguration,
  getArmoryPackage,
  getArmoryProfileOperation,
  profileOperationActive,
  setArmoryProjectAssignment,
  supportsArmoryProjectPackages,
  validateArmoryConfiguration,
  verifyArmoryProfile,
  type ArmoryConfiguration,
  type ArmoryPackageSummary,
  type ArmoryProfileOperation,
  type ArmoryProfileRequirement,
  type ConfigurationErrors,
} from "./armoryApi";

const POLL_INTERVAL_MS = 1_200;
const MAX_POLLS = 150;

function wait(ms: number) {
  return new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });
}

// Configuration and verification are durable Peon operations. The form follows
// one attempt to its settled state instead of reporting a queued request as
// success; it never resubmits on its own.
async function settleProfileOperation(base: string, operation: ArmoryProfileOperation): Promise<ArmoryProfileOperation> {
  let current = operation;
  for (let attempt = 0; profileOperationActive(current) && attempt < MAX_POLLS; attempt += 1) {
    await wait(POLL_INTERVAL_MS);
    current = (await getArmoryProfileOperation(base, current.operationId)).operation;
  }
  return current;
}

export function ProjectArmoryProfileNew() {
  const { key = "" } = useParams();
  const [params] = useSearchParams();
  const packageId = params.get("package") ?? "";
  const navigate = useNavigate();
  const { peon, base } = usePeon();
  const capable = supportsArmoryProjectPackages(peon.capabilities);
  const toolsLink = `/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}/tools`;

  const [projectId, setProjectId] = useState<string | null>(null);
  const [item, setItem] = useState<ArmoryPackageSummary | null>(null);
  const [schema, setSchema] = useState<ArmoryConfiguration | null>(null);
  const [loading, setLoading] = useState(capable && peon.online && packageId !== "");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<ConfigurationErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const gate = useRef(new ArmoryRequestGate());
  const action = useRef(new ArmoryActionGate());

  const requirement: ArmoryProfileRequirement | null = item?.installed?.profileRequirement ?? null;

  const load = useCallback(async () => {
    const token = gate.current.begin();
    setLoading(true); setLoadError(null);
    try {
      const detail = await api<ProjectDetail>(`${base}/projects/${encodeURIComponent(key)}`);
      if (!detail.projectId) throw new ApiError(409, "PROJECT_ID_UNAVAILABLE", "This project has no immutable ID.");
      const [packageDetail, configuration] = await Promise.all([
        getArmoryPackage(base, packageId),
        getArmoryConfiguration(base, packageId).catch(() => null),
      ]);
      if (!gate.current.current(token)) return;
      setProjectId(detail.projectId);
      setItem(packageDetail.package);
      setSchema(configuration);
    } catch (reason) { if (gate.current.current(token)) setLoadError(reason); }
    finally { if (gate.current.current(token)) setLoading(false); }
  }, [base, key, packageId]);

  useEffect(() => {
    const requestGate = gate.current;
    const actionGate = action.current;
    setProjectId(null); setItem(null); setSchema(null); setName(""); setValues({}); setErrors({});
    setLoadError(null); setSubmitError(null); setProgress(null); setSubmitting(false);
    if (capable && peon.online && packageId) void load(); else setLoading(false);
    return () => { requestGate.clear(); actionGate.clear(); };
  }, [capable, load, packageId, peon.online]);

  const submit = async () => {
    if (!requirement || !schema || !projectId || !name.trim()) return;
    const validation = validateArmoryConfiguration(schema, values);
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;
    const token = action.current.begin();
    if (token === null) return;
    setSubmitting(true); setSubmitError(null); setProgress("Creating profile…");
    try {
      const profile = await createArmoryProfile(base, requirement.type, name.trim());
      setProgress("Saving write-only configuration…");
      const configured = await settleProfileOperation(base, await configureArmoryProfile(base, profile.profileId, values));
      if (!action.current.current(token)) return;
      if (configured.status !== "succeeded") {
        throw new ApiError(409, configured.code ?? "PROFILE_CONFIGURATION_FAILED", "Peon could not store this profile’s configuration.");
      }
      setProgress("Verifying profile…");
      const verified = await settleProfileOperation(base, await verifyArmoryProfile(base, profile.profileId));
      if (!action.current.current(token)) return;
      if (verified.status !== "succeeded") {
        throw new ApiError(409, verified.code ?? "PROFILE_NOT_VERIFIED", "The profile was created but could not be verified.");
      }
      setProgress("Assigning to this project…");
      await setArmoryProjectAssignment(base, projectId, packageId, profile.profileId);
      if (!action.current.current(token)) return;
      navigate(toolsLink, { replace: true });
    } catch (reason) { if (action.current.current(token)) { setSubmitError(reason); setProgress(null); } }
    finally {
      // Every submitted profile value is write-only, including plain text and
      // select fields. Scrub them after a settled attempt.
      setValues(clearSettledArmoryProfileValues());
      if (action.current.finish(token)) setSubmitting(false);
    }
  };

  const body = () => {
    if (!capable) return <Card className="p-5 text-sm text-ink-muted">This Peon does not support typed profiles and project assignments.</Card>;
    if (!peon.online) return <p className="border-l-2 border-danger bg-danger/5 px-4 py-3 font-mono text-sm text-danger">This Peon is offline — profiles cannot be created.</p>;
    if (!packageId) return <Card className="p-5 text-sm text-ink-muted">No package was selected. <Link className="text-accent-strong hover:underline" to={toolsLink}>Back to Tools</Link></Card>;
    if (loading) return <Card className="grid min-h-40 place-items-center"><span className="loading-spinner" role="status" aria-label="Loading package" /></Card>;
    if (loadError || !item) return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-danger bg-danger/5 px-4 py-3 text-sm text-danger"><span>{loadError instanceof Error ? loadError.message : "The package could not be loaded."}{loadError instanceof ApiError ? ` (${loadError.code})` : ""}</span><Button type="button" size="sm" variant="secondary" onClick={() => void load()}>Retry</Button></div>;
    if (!requirement) return <Card className="p-5 text-sm text-ink-muted">{item.displayName || item.id} is credential-free and needs no profile. <Link className="text-accent-strong hover:underline" to={toolsLink}>Assign it from Tools.</Link></Card>;
    if (!schema) return <Card className="p-5 text-sm text-ink-muted">Configuration fields are unavailable for this installed package.</Card>;

    return <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-base font-bold text-ink">New profile for {item.displayName || item.id}</h2><Badge>{requirement.type}</Badge></div>
      <p className="mt-1 text-sm text-ink-muted">The profile belongs to this Peon and can be reused by compatible packages and projects. Values are write-only: they are stored on the Peon and never shown again. Once verified, it is assigned to this project automatically.</p>
      <form className="mt-5 space-y-4" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="block"><span className="mb-1 block font-display text-xs font-bold text-ink">Profile name<span className="ml-1 text-warning-strong" aria-label="required">*</span></span><input className="field w-full" maxLength={80} autoFocus disabled={submitting} value={name} placeholder="Production Google" onChange={(event) => setName(event.target.value)} /></label>
        {schema.fields.map((field) => <ProfileField key={field.id} field={field} value={values[field.id] ?? ""} configured={false} error={errors[field.id]} disabled={submitting} onValue={(value) => { setValues((current) => ({ ...current, [field.id]: value })); setErrors((current) => { const next = { ...current }; delete next[field.id]; return next; }); }} />)}
        {schema.hostWrites.length > 0 && <p className="border-l-2 border-warning bg-warning/5 px-3 py-2 text-xs text-warning-strong">This package’s handler declares host writes. Review the package documentation before submitting.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={submitting || !name.trim()}>{submitting ? "Working…" : "Create and assign profile"}</Button>
          <Button type="button" variant="secondary" disabled={submitting} onClick={() => navigate(toolsLink)}>Cancel</Button>
        </div>
      </form>
      {progress && <p role="status" aria-live="polite" className="mt-4 border-l-2 border-warning bg-warning/5 px-3 py-2 text-sm text-warning-strong">{progress}</p>}
      {Boolean(submitError) && <div role="alert" className="mt-4 border-l-2 border-danger bg-danger/5 px-3 py-2 text-sm text-danger">{submitError instanceof ApiError ? `${submitError.message} (${submitError.code})` : submitError instanceof Error ? submitError.message : "The profile could not be created."} <Link className="underline" to={`/peons/${encodeURIComponent(peon.peonId)}/settings/armory/${encodeURIComponent(packageId)}`}>Open Armory to finish it.</Link></div>}
    </Card>;
  };

  return <div className="space-y-4">
    <ProjectPageHeader showDesktopNewSession={false} />
    <ProjectTabs />
    <header><h1 className="font-display text-xl font-extrabold text-ink">Add profile</h1><p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-muted"><Link className="text-accent-strong hover:underline" to={toolsLink}>← Back to Tools</Link></p></header>
    {body()}
  </div>;
}
