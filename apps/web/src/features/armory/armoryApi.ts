import { ApiError, api } from "../../shared/api";
import type { ApiRequest } from "../fleet/peonApi";

export interface ArmoryRegistry {
  url: string;
  official: boolean;
  source: "live" | "cached" | "unavailable";
  fetchedAt: number | null;
  catalogUpdatedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface InstalledPackage {
  id?: string;
  packageId?: string;
  version: string;
  enabled?: boolean;
  state: "installing" | "needs_configuration" | "verifying" | "ready" | "error" | "removing";
  installedAt?: number;
  updatedAt?: number;
  sourceDigest?: string;
  configurationStatus?: "not_required" | "missing" | "unverified" | "verified" | "invalid";
  lastError?: string | null;
  activeOperationId?: string | null;
  profileRequirement?: ArmoryProfileRequirement | null;
}

export const ARMORY_PROJECT_PACKAGES_CAPABILITY = "armory-project-packages-v1";

export interface ArmoryProfileRequirement {
  type: string;
  requiredFields: string[];
}

export interface ArmoryProfileIdentity {
  label: string;
  value: string;
}

export interface ArmoryProfile {
  profileId: string;
  type: string;
  name: string;
  status: "missing" | "unverified" | "verified" | "invalid";
  configuredFields: Record<string, true>;
  // The public address the credential acts as — a Google service account
  // email, for example — which an operator has to grant access to elsewhere.
  // Older Peons omit it, so treat a missing value as "none".
  identity?: ArmoryProfileIdentity | null;
}

export interface ArmoryProfileListResponse { profiles: ArmoryProfile[] }

export interface ArmoryProjectAssignment {
  projectId: string;
  packageId: string;
  profileId: string | null;
}

export interface ArmoryAssignmentListResponse { assignments: ArmoryProjectAssignment[] }

export interface ArmoryProfileOperation {
  operationId: string;
  kind: "profile_configure" | "profile_verify";
  status: "queued" | "running" | "succeeded" | "failed";
  code: string | null;
}

export interface ArmoryProfileOperationResponse { operation: ArmoryProfileOperation }

export function supportsArmoryProjectPackages(capabilities: string[] | null | undefined): boolean {
  return capabilities?.includes(ARMORY_PROJECT_PACKAGES_CAPABILITY) === true;
}

export function matchingArmoryProfiles(profiles: ArmoryProfile[], requirement: ArmoryProfileRequirement): ArmoryProfile[] {
  return profiles.filter((profile) => profile.type === requirement.type);
}

export function missingArmoryProfileFields(profile: ArmoryProfile, requirement: ArmoryProfileRequirement): string[] {
  return requirement.requiredFields.filter((field) => profile.configuredFields[field] !== true);
}

export type ArmoryProfileReadiness = "ready" | "missing_fields" | "unverified" | "invalid" | "type_mismatch";

export function armoryProfileReadiness(profile: ArmoryProfile, requirement: ArmoryProfileRequirement): ArmoryProfileReadiness {
  if (profile.type !== requirement.type) return "type_mismatch";
  if (missingArmoryProfileFields(profile, requirement).length > 0 || profile.status === "missing") return "missing_fields";
  if (profile.status === "invalid") return "invalid";
  if (profile.status !== "verified") return "unverified";
  return "ready";
}

export interface ArmoryPackageSummary {
  id: string;
  available: boolean;
  displayName: string | null;
  summary: string | null;
  publisher: string | null;
  documentationUrl: string | null;
  latestVersion: string | null;
  requirements: { credentials: boolean; hostWrites: boolean } | null;
  capabilities?: Record<string, boolean> | null;
  installed: InstalledPackage | null;
  updateAvailable: boolean | null;
  iconUrl?: string | null;
  icon?: string | null;
}

export function isMcpCapable(value: { capabilities?: Record<string, boolean> | null } | null | undefined): boolean {
  return value?.capabilities?.mcp === true;
}

export function activeArmoryCapabilities(value: { capabilities?: Record<string, boolean> | null } | null | undefined): string[] {
  return Object.entries(value?.capabilities ?? {}).filter(([, enabled]) => enabled === true).map(([name]) => name);
}

export interface ArmoryInventoryResponse {
  registry: ArmoryRegistry;
  packages: ArmoryPackageSummary[];
  total: number;
  nextCursor: string | null;
}

export interface ArmoryCatalogVersion {
  version: string;
  minPeonVersion: string;
  platforms: Array<{ os: "darwin" | "linux"; arch: "x64" | "arm64" }>;
  archive: { url: string; size: number; sha256: string };
}

export interface ArmoryPackageDetailResponse {
  registry: ArmoryRegistry;
  package: ArmoryPackageSummary;
  catalog: null | {
    id: string;
    displayName: string;
    summary: string;
    publisher: "rnm-dev";
    documentationUrl: string;
    latest: string;
    requirements: { credentials: boolean; hostWrites: boolean };
    capabilities?: Record<string, boolean> | null;
    versions: ArmoryCatalogVersion[];
    iconUrl?: string | null;
    icon?: string | null;
  };
}

export interface ArmoryConfigurationField {
  id: string;
  label: string;
  help?: string;
  type: "text" | "secret" | "select" | "file";
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  validation?: { pattern?: string; maxLength?: number };
}

export interface ArmoryConfiguration {
  packageId: string;
  fields: ArmoryConfigurationField[];
  configured: Record<string, boolean>;
  hostWrites: string[];
  identity?: ArmoryProfileIdentity | null;
}

export interface ArmoryOperation {
  id: string;
  packageId: string;
  kind: "install" | "update" | "uninstall" | "configure" | "delete_configuration" | "enable" | "disable";
  status: "queued" | "running" | "success" | "failure" | "needs_human";
  phase: string;
  progress: number | null;
  message: string;
  errorCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ArmoryOperationResponse { operation: ArmoryOperation }

export function armoryOperationProgress(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null;
}

export interface ArmorySettings {
  registryUrl: string;
  effectiveRegistryUrl: string;
  registryOverridden: boolean;
  agentInstallAllowlist: string[];
}

export interface ArmoryMcpInputProperty {
  type?: string | string[];
  description?: string;
  [key: string]: unknown;
}

export interface ArmoryMcpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, ArmoryMcpInputProperty>;
    required?: string[];
    [key: string]: unknown;
  };
}

// Peon returns the live tools/list discovery document. The optional nested
// forms keep the client compatible with protocol envelopes while preserving
// every description and schema verbatim from that response.
export interface ArmoryMcpDetails {
  packageId?: string;
  status?: "running" | "disabled" | "unavailable";
  endpoint?: string;
  runtime?: { status?: "running" | "disabled" | "unavailable"; endpoint?: string };
  tools?: ArmoryMcpTool[];
  discovery?: { tools?: ArmoryMcpTool[]; result?: { tools?: ArmoryMcpTool[] } } | null;
}

export const ARMORY_PAGE_SIZE = 24;
export const ARMORY_SEARCH_DEBOUNCE_MS = 300;
export type ArmoryView = "available" | "installed";

export function inventoryPath(base: string, input: { q?: string; view?: ArmoryView; cursor?: string | null; limit?: number }): string {
  const params = new URLSearchParams();
  if (input.q?.trim()) params.set("q", input.q.trim());
  if (input.view === "installed") params.set("installed", "true");
  params.set("limit", String(input.limit ?? ARMORY_PAGE_SIZE));
  if (input.cursor) params.set("cursor", input.cursor);
  return `${base}/armory/packages?${params.toString()}`;
}

export function getArmoryInventory(base: string, input: { q?: string; view?: ArmoryView; cursor?: string | null; limit?: number }, request: ApiRequest = api) {
  return request<ArmoryInventoryResponse>(inventoryPath(base, input));
}

export function refreshArmory(base: string, request: ApiRequest = api) {
  return request<unknown>(`${base}/armory/refresh`, { method: "POST" });
}

export function installArmoryPackage(base: string, id: string, version: string | null = null, request: ApiRequest = api) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/install`, {
    method: "POST",
    body: JSON.stringify(version ? { version } : {}),
  });
}

export function updateArmoryPackage(base: string, id: string, version: string | null = null, request: ApiRequest = api) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/update`, {
    method: "POST",
    body: JSON.stringify(version ? { version } : {}),
  });
}

export function uninstallArmoryPackage(base: string, id: string, request: ApiRequest = api) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export function getArmoryPackage(base: string, id: string, request: ApiRequest = api) {
  return request<ArmoryPackageDetailResponse>(`${base}/armory/packages/${encodeURIComponent(id)}`);
}

export function getArmoryConfiguration(base: string, id: string, request: ApiRequest = api) {
  return request<ArmoryConfiguration>(`${base}/armory/packages/${encodeURIComponent(id)}/configuration`);
}

export function getArmoryMcp(base: string, id: string, request: ApiRequest = api) {
  return request<ArmoryMcpDetails>(`${base}/armory/packages/${encodeURIComponent(id)}/mcp`);
}

export async function submitArmoryConfiguration(base: string, id: string, values: Record<string, string>, confirmHostWrites: boolean, request: ApiRequest = api) {
  try {
    return await request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/configuration`, {
      method: "PUT",
      body: JSON.stringify({ values, ...(confirmHostWrites ? { confirmHostWrites: true } : {}) }),
    });
  } catch (error) {
    // Peon validation is authoritative, but upstream error text is not a safe
    // place to reflect configuration payloads.
    if (error instanceof ApiError) {
      throw new ApiError(error.status, error.code === "OPERATION_IN_PROGRESS" ? error.code : "CONFIGURATION_REJECTED", "Peon rejected the configuration.", error.requestId);
    }
    // Intentionally omit the cause: an arbitrary transport error can contain a
    // submitted secret or file value.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Peon rejected the configuration.");
  }
}

export function deleteArmoryConfiguration(base: string, id: string, includeHost: boolean, request: ApiRequest = api) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/configuration`, {
    method: "DELETE",
    body: JSON.stringify(includeHost ? { includeHost: true, confirmHostWrites: true } : {}),
  });
}

export function setArmoryPackageEnabled(base: string, id: string, enabled: boolean, request: ApiRequest = api) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
    method: "POST",
  });
}

export function getArmoryOperation(base: string, operationId: string, request: ApiRequest = api) {
  return request<ArmoryOperationResponse>(`${base}/armory/operations/${encodeURIComponent(operationId)}`);
}

export function getArmorySettings(base: string, request: ApiRequest = api) {
  return request<ArmorySettings>(`${base}/armory/settings`);
}

export function getArmoryProfiles(base: string, request: ApiRequest = api) {
  return request<ArmoryProfileListResponse>(`${base}/armory/profiles`);
}

export function createArmoryProfile(base: string, type: string, name: string, request: ApiRequest = api) {
  return request<ArmoryProfile>(`${base}/armory/profiles`, {
    method: "POST",
    body: JSON.stringify({ type, name }),
  });
}

export function renameArmoryProfile(base: string, profileId: string, name: string, request: ApiRequest = api) {
  return request<ArmoryProfile>(`${base}/armory/profiles/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteArmoryProfile(base: string, profileId: string, request: ApiRequest = api) {
  return request<ArmoryProfile>(`${base}/armory/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
}

export async function configureArmoryProfile(base: string, profileId: string, values: Record<string, string>, request: ApiRequest = api) {
  try {
    return await request<ArmoryProfileOperation>(`${base}/armory/profiles/${encodeURIComponent(profileId)}/configuration`, {
      method: "PUT",
      body: JSON.stringify({ values }),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const safeCodes = new Set(["BAD_REQUEST", "PROFILE_NOT_FOUND", "OPERATION_IN_PROGRESS", "PROFILE_FIELDS_MISSING", "PROFILE_NOT_VERIFIED", "UNSUPPORTED_CAPABILITY"]);
      throw new ApiError(error.status, safeCodes.has(error.code) ? error.code : "PROFILE_CONFIGURATION_REJECTED", "Peon rejected the profile configuration request.", error.requestId);
    }
    // Deliberately discard the cause because a transport error may contain the
    // submitted write-only body.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Peon rejected the profile configuration request.");
  }
}

export function verifyArmoryProfile(base: string, profileId: string, request: ApiRequest = api) {
  return request<ArmoryProfileOperation>(`${base}/armory/profiles/${encodeURIComponent(profileId)}/verify`, { method: "POST" });
}

export function getArmoryProfileOperation(base: string, operationId: string, request: ApiRequest = api) {
  return request<ArmoryProfileOperationResponse>(`${base}/armory/operations/${encodeURIComponent(operationId)}`);
}

export function getArmoryProjectAssignments(base: string, projectId: string, request: ApiRequest = api) {
  return request<ArmoryAssignmentListResponse>(`${base}/armory/projects/${encodeURIComponent(projectId)}/assignments`);
}

export function setArmoryProjectAssignment(base: string, projectId: string, packageId: string, profileId: string | null, request: ApiRequest = api) {
  return request<ArmoryProjectAssignment>(`${base}/armory/projects/${encodeURIComponent(projectId)}/assignments/${encodeURIComponent(packageId)}`, {
    method: "PUT",
    body: JSON.stringify({ profileId }),
  });
}

export function removeArmoryProjectAssignment(base: string, projectId: string, packageId: string, request: ApiRequest = api) {
  return request<ArmoryProjectAssignment>(`${base}/armory/projects/${encodeURIComponent(projectId)}/assignments/${encodeURIComponent(packageId)}`, { method: "DELETE" });
}

export function profileOperationActive(operation: ArmoryProfileOperation | null): boolean {
  return operation?.status === "queued" || operation?.status === "running";
}

export function clearSettledArmoryProfileValues(): Record<string, string> {
  return {};
}

// A monotonically increasing scope token lets UI requests ignore a response
// started for a previous Peon, query, filter, cursor chain, or package detail.
export class ArmoryRequestGate {
  private generation = 0;
  begin(): number { return ++this.generation; }
  current(token: number): boolean { return token === this.generation; }
  clear(): void { this.generation += 1; }
}

// Lifecycle mutations need a synchronous lock because two click handlers can
// run before React commits the first `submitting` state update. The token also
// prevents a response from a previous Peon/package scope updating the new UI.
export class ArmoryActionGate {
  private generation = 0;
  private active = false;
  begin(): number | null {
    if (this.active) return null;
    this.active = true;
    return ++this.generation;
  }
  locked(): boolean { return this.active; }
  current(token: number): boolean { return this.active && token === this.generation; }
  finish(token: number): boolean {
    if (!this.current(token)) return false;
    this.active = false;
    return true;
  }
  clear(): void { this.generation += 1; this.active = false; }
}

export type ConfigurationErrors = Record<string, string>;

// Client checks improve feedback only; Peon remains authoritative. Messages
// deliberately identify fields/rules without interpolating entered values.
export function validateArmoryConfiguration(schema: ArmoryConfiguration, values: Record<string, string>): ConfigurationErrors {
  const errors: ConfigurationErrors = {};
  for (const field of schema.fields) {
    const value = values[field.id] ?? "";
    if (field.required && value.length === 0) {
      errors[field.id] = `${field.label} is required.`;
      continue;
    }
    if (!value) continue;
    if (field.type === "select" && !field.options?.some((option) => option.value === value)) {
      errors[field.id] = `Choose a declared option for ${field.label}.`;
      continue;
    }
    if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) {
      errors[field.id] = `${field.label} must be at most ${field.validation.maxLength} characters.`;
      continue;
    }
    if (field.validation?.pattern) {
      try {
        if (!new RegExp(field.validation.pattern).test(value)) errors[field.id] = `${field.label} does not match the required format.`;
      } catch {
        // A malformed manifest pattern must not break configuration. Peon will
        // return MANIFEST_INVALID or authoritative field validation.
      }
    }
  }
  return errors;
}

export function validateArmoryProfileConfiguration(schema: ArmoryConfiguration, profile: ArmoryProfile, values: Record<string, string>): ConfigurationErrors {
  const errors = validateArmoryConfiguration(schema, values);
  for (const field of schema.fields) {
    if (field.required && profile.configuredFields[field.id] === true && (values[field.id] ?? "") === "") delete errors[field.id];
  }
  return errors;
}

// Secret and file values are single-use UI state. Once Peon accepts a
// replacement request, only ordinary values may remain while its operation is
// polled. Configured flags are deliberately not turned into replacement values.
export function clearAcceptedTransientValues(schema: ArmoryConfiguration, values: Record<string, string>): Record<string, string> {
  const transientIds = new Set(schema.fields.filter((field) => field.type === "secret" || field.type === "file").map((field) => field.id));
  return Object.fromEntries(Object.entries(values).filter(([id]) => !transientIds.has(id)));
}

export function operationActive(operation: ArmoryOperation | null): boolean {
  return operation?.status === "queued" || operation?.status === "running";
}
