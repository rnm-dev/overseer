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

export type ArmoryProfileReadiness = "ready" | "missing_fields" | "unverified" | "invalid" | "type_mismatch";

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
