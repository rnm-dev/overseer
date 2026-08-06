import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "../../api";
import { Badge, Button, Card, Dialog } from "../../ui";
import { usePeon } from "./context";
import { ProjectPageHeader } from "./ProjectPageHeader";
import { ProjectTabs } from "./ProjectTabs";
import type { ProjectDetail } from "./peonApi";
import {
  ArmoryRequestGate,
  armoryProfileReadiness,
  getArmoryInventory,
  getArmoryProfiles,
  getArmoryProjectAssignments,
  matchingArmoryProfiles,
  missingArmoryProfileFields,
  removeArmoryProjectAssignment,
  setArmoryProjectAssignment,
  supportsArmoryProjectPackages,
  type ArmoryPackageSummary,
  type ArmoryProfile,
  type ArmoryProjectAssignment,
} from "./armoryApi";

export const UNASSIGNMENT_CONTEXT_COPY = "Removing an assignment excludes this package’s tools and instructions from future turns and can reduce context and token use. An active turn does not change.";

function profileOptionLabel(profile: ArmoryProfile, item: ArmoryPackageSummary): string {
  const requirement = item.installed?.profileRequirement;
  if (!requirement) return profile.name;
  const readiness = armoryProfileReadiness(profile, requirement);
  if (readiness === "missing_fields") return `${profile.name} — missing fields`;
  if (readiness === "unverified") return `${profile.name} — unverified`;
  if (readiness === "invalid") return `${profile.name} — invalid`;
  return `${profile.name} — verified`;
}

export function ProjectPackageAssignmentCard({ item, assignment, profiles, busy, settingsLink, onAssign, onRemove }: {
  item: ArmoryPackageSummary;
  assignment: ArmoryProjectAssignment | null;
  profiles: ArmoryProfile[];
  busy: boolean;
  settingsLink: string;
  onAssign: (profileId: string | null) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const requirement = item.installed?.profileRequirement ?? null;
  const compatible = requirement ? matchingArmoryProfiles(profiles, requirement) : [];
  const readyProfiles = requirement ? compatible.filter((profile) => armoryProfileReadiness(profile, requirement) === "ready") : [];
  const assignedProfile = assignment?.profileId ? profiles.find((profile) => profile.profileId === assignment.profileId) ?? null : null;
  const assignedReadiness = assignedProfile && requirement ? armoryProfileReadiness(assignedProfile, requirement) : null;
  const [selected, setSelected] = useState(assignment?.profileId ?? readyProfiles[0]?.profileId ?? "");
  const [removeOpen, setRemoveOpen] = useState(false);
  const packageReady = item.installed?.state === "ready";
  const firstReadyProfileId = readyProfiles[0]?.profileId;

  useEffect(() => { setSelected(assignment?.profileId ?? firstReadyProfileId ?? ""); }, [assignment?.profileId, firstReadyProfileId]);

  let problem: string | null = null;
  if (!packageReady) problem = `Package is unavailable while its state is ${item.installed?.state?.replace(/_/g, " ") ?? "unknown"}.`;
  else if (assignment && requirement && assignment.profileId === null) problem = "This package requires a compatible verified profile, but the assignment has none.";
  else if (assignment && !requirement && assignment.profileId !== null) problem = "Credential-free packages cannot use a profile.";
  else if (assignment?.profileId && !assignedProfile) problem = "The assigned profile is unavailable.";
  else if (assignedReadiness === "type_mismatch") problem = `Assigned profile type does not match ${requirement?.type}.`;
  else if (assignedReadiness === "missing_fields" && assignedProfile && requirement) problem = `Assigned profile is missing required fields: ${missingArmoryProfileFields(assignedProfile, requirement).join(", ")}.`;
  else if (assignedReadiness === "unverified") problem = "Assigned profile is unverified.";
  else if (assignedReadiness === "invalid") problem = "Assigned profile is invalid.";

  return <Card className="p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-base font-bold text-ink">{item.displayName || item.id}</h2>{assignment ? <Badge tone={problem ? "red" : "green"}>{problem ? "Assigned · unavailable" : "Assigned"}</Badge> : <Badge>Not assigned</Badge>}</div>{item.displayName && <p className="mt-1 font-mono text-[0.68rem] text-ink-faint">{item.id}</p>}</div>
      <span className="font-mono text-xs text-ink-faint">Installed {item.installed?.version}</span>
    </div>
    <p className="mt-3 text-sm leading-relaxed text-ink-muted">{item.summary || "Installed Armory package."}</p>
    <div className="mt-4 border-t border-edge pt-4">
      {requirement ? <>
        <p className="font-mono text-xs text-ink-faint">Profile type · {requirement.type}</p>
        <label className="mt-2 block"><span className="sr-only">Profile for {item.displayName || item.id}</span><select className="field w-full" value={selected} disabled={busy || !packageReady} onChange={(event) => setSelected(event.target.value)}><option value="">Select a verified profile…</option>{compatible.map((profile) => <option key={profile.profileId} value={profile.profileId} disabled={armoryProfileReadiness(profile, requirement) !== "ready"}>{profileOptionLabel(profile, item)}</option>)}</select></label>
        {compatible.length === 0 ? <p role="status" className="mt-2 text-sm text-warning-strong">No profile has the exact required type. <Link className="text-accent-strong hover:underline" to={settingsLink}>Create and configure one in Armory.</Link></p>
          : readyProfiles.length === 0 ? <p role="status" className="mt-2 text-sm text-warning-strong">Compatible profiles are missing fields, unverified, or invalid. <Link className="text-accent-strong hover:underline" to={settingsLink}>Open Armory to make one ready.</Link></p> : null}
      </> : <p className="text-sm text-ink-muted">Credential-free package. Its assignment deliberately uses no profile.</p>}
      {problem && <p role="alert" className="mt-3 border-l-2 border-danger bg-danger/5 px-3 py-2 text-sm text-danger">{problem}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {assignment ? <>{requirement && <Button type="button" disabled={busy || !selected || selected === assignment.profileId} onClick={() => void onAssign(selected)}>{busy ? "Saving…" : "Update profile"}</Button>}<Button type="button" variant="secondary" disabled={busy} aria-haspopup="dialog" onClick={() => setRemoveOpen(true)}>{busy ? "Removing…" : "Remove assignment"}</Button></>
          : <Button type="button" disabled={busy || !packageReady || (requirement ? !selected : false)} onClick={() => void onAssign(requirement ? selected : null)}>{busy ? "Assigning…" : "Assign to project"}</Button>}
      </div>
    </div>
    {removeOpen && <Dialog title="Remove assignment?" onClose={() => setRemoveOpen(false)} dismissible={!busy}><p className="text-sm leading-relaxed text-ink-muted">{UNASSIGNMENT_CONTEXT_COPY}</p><div className="mt-5 flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => setRemoveOpen(false)}>Cancel</Button><Button type="button" variant="secondary" className="!border-danger/50 !text-danger hover:!bg-danger/10" disabled={busy} onClick={() => void onRemove()}>{busy ? "Removing…" : "Confirm removal"}</Button></div></Dialog>}
  </Card>;
}

export function ProjectArmoryPackages() {
  const { key = "" } = useParams();
  const { peon, base } = usePeon();
  const capable = supportsArmoryProjectPackages(peon.capabilities);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [packages, setPackages] = useState<ArmoryPackageSummary[]>([]);
  const [profiles, setProfiles] = useState<ArmoryProfile[]>([]);
  const [assignments, setAssignments] = useState<ArmoryProjectAssignment[]>([]);
  const [loading, setLoading] = useState(capable && peon.online);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const gate = useRef(new ArmoryRequestGate());
  const scope = useRef(`${base}:${key}`);
  scope.current = `${base}:${key}`;

  const load = useCallback(async () => {
    const token = gate.current.begin();
    setLoading(true); setError(null);
    try {
      const detail = await api<ProjectDetail>(`${base}/projects/${encodeURIComponent(key)}`);
      if (!detail.projectId) throw new ApiError(409, "PROJECT_ID_UNAVAILABLE", "This project has no immutable ID.");
      const [inventory, profileList, assignmentList] = await Promise.all([
        getArmoryInventory(base, { view: "installed", limit: 100 }),
        getArmoryProfiles(base),
        getArmoryProjectAssignments(base, detail.projectId),
      ]);
      if (!gate.current.current(token)) return;
      setProjectId(detail.projectId);
      setPackages(inventory.packages.filter((item) => item.installed !== null));
      setProfiles(profileList.profiles);
      setAssignments(assignmentList.assignments);
    } catch (reason) { if (gate.current.current(token)) setError(reason); }
    finally { if (gate.current.current(token)) setLoading(false); }
  }, [base, key]);

  useEffect(() => {
    const requestGate = gate.current;
    setProjectId(null); setPackages([]); setProfiles([]); setAssignments([]); setError(null); setBusy(new Set());
    if (capable && peon.online) void load(); else setLoading(false);
    return () => requestGate.clear();
  }, [capable, load, peon.online]);

  const byPackage = useMemo(() => new Map(assignments.map((assignment) => [assignment.packageId, assignment])), [assignments]);
  const mutate = async (packageId: string, profileId: string | null, remove: boolean) => {
    if (!projectId || busy.has(packageId)) return;
    const mutationScope = scope.current;
    setBusy((current) => new Set(current).add(packageId));
    setError(null);
    try {
      if (remove) await removeArmoryProjectAssignment(base, projectId, packageId);
      else await setArmoryProjectAssignment(base, projectId, packageId, profileId);
      if (scope.current === mutationScope) await load();
    } catch (reason) { if (scope.current === mutationScope) setError(reason); }
    finally { if (scope.current === mutationScope) setBusy((current) => { const next = new Set(current); next.delete(packageId); return next; }); }
  };

  return <div className="space-y-4">
    <ProjectPageHeader showDesktopNewSession={false} />
    <ProjectTabs />
    <header><h1 className="font-display text-xl font-extrabold text-ink">Project packages</h1><p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-muted">Assignment presence is the only package availability setting for this project. Changes apply to subsequent turns; an active turn keeps the package/profile snapshot it started with.</p></header>
    {!capable ? <Card className="p-5"><h2 className="font-display text-base font-bold text-ink">Legacy Armory</h2><p className="mt-2 text-sm text-ink-muted">This Peon does not support project package assignments. Its existing package state remains available from the read-only/legacy Armory experience; the new profile and assignment routes are not used.</p></Card>
      : !peon.online ? <p className="border-l-2 border-danger bg-danger/5 px-4 py-3 font-mono text-sm text-danger">This Peon is offline — project assignments are unavailable.</p>
        : loading ? <Card className="grid min-h-40 place-items-center"><span className="loading-spinner" role="status" aria-label="Loading project packages" /></Card>
          : error && packages.length === 0 ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-danger bg-danger/5 px-4 py-3 text-sm text-danger"><span>{error instanceof Error ? error.message : "Project packages could not be loaded."}{error instanceof ApiError ? ` (${error.code})` : ""}</span><Button type="button" size="sm" variant="secondary" onClick={() => void load()}>Retry</Button></div>
            : packages.length === 0 ? <Card className="p-6 text-center text-sm text-ink-muted">No Armory packages are installed on this Peon.</Card>
              : <>
                {error && <div role="alert" className="border-l-2 border-danger bg-danger/5 px-4 py-3 text-sm text-danger">{error instanceof Error ? error.message : "Assignment action failed."}{error instanceof ApiError ? ` (${error.code})` : ""}</div>}
                <div className="grid gap-4 lg:grid-cols-2">{packages.map((item) => <ProjectPackageAssignmentCard key={item.id} item={item} profiles={profiles} assignment={byPackage.get(item.id) ?? null} busy={busy.has(item.id)} settingsLink={`/peons/${encodeURIComponent(peon.peonId)}/settings/armory/${encodeURIComponent(item.id)}`} onAssign={(profileId) => mutate(item.id, profileId, false)} onRemove={() => mutate(item.id, null, true)} />)}</div>
                <Card className="border-accent/25 bg-accent/[0.03] p-4 text-sm leading-relaxed text-ink-muted">{UNASSIGNMENT_CONTEXT_COPY}</Card>
              </>}
  </div>;
}
