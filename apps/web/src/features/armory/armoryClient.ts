import { ApiError, api } from "../../shared/api";
import type { ApiRequest } from "../fleet/peonApi";
import { ARMORY_PAGE_SIZE, type ArmoryAssignmentListResponse, type ArmoryConfiguration, type ArmoryInventoryResponse, type ArmoryMcpDetails, type ArmoryOperationResponse, type ArmoryPackageDetailResponse, type ArmoryProfile, type ArmoryProfileListResponse, type ArmoryProfileOperation, type ArmoryProfileOperationResponse, type ArmoryProjectAssignment, type ArmorySettings, type ArmoryView } from "./armoryTypes";

let request: ApiRequest = api;

/** Test-only seam: replaces the transport for every Armory client call. */
export function setArmoryRequestForTests(next: ApiRequest = api): void {
  request = next;
}

export function inventoryPath(base: string, input: { q?: string; view?: ArmoryView; cursor?: string | null; limit?: number }): string {
  const params = new URLSearchParams();
  if (input.q?.trim()) params.set("q", input.q.trim());
  if (input.view === "installed") params.set("installed", "true");
  params.set("limit", String(input.limit ?? ARMORY_PAGE_SIZE));
  if (input.cursor) params.set("cursor", input.cursor);
  return `${base}/armory/packages?${params.toString()}`;
}

export function getArmoryInventory(base: string, input: { q?: string; view?: ArmoryView; cursor?: string | null; limit?: number }, signal?: AbortSignal) {
  return request<ArmoryInventoryResponse>(inventoryPath(base, input), { signal });
}

export function refreshArmory(base: string, signal?: AbortSignal) {
  return request<unknown>(`${base}/armory/refresh`, { method: "POST", signal });
}

export function installArmoryPackage(base: string, id: string, version: string | null = null) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/install`, {
    method: "POST",
    body: JSON.stringify(version ? { version } : {}),
  });
}

export function updateArmoryPackage(base: string, id: string, version: string | null = null) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/update`, {
    method: "POST",
    body: JSON.stringify(version ? { version } : {}),
  });
}

export function uninstallArmoryPackage(base: string, id: string) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export function getArmoryPackage(base: string, id: string, signal?: AbortSignal) {
  return request<ArmoryPackageDetailResponse>(`${base}/armory/packages/${encodeURIComponent(id)}`, { signal });
}

export function getArmoryConfiguration(base: string, id: string, signal?: AbortSignal) {
  return request<ArmoryConfiguration>(`${base}/armory/packages/${encodeURIComponent(id)}/configuration`, { signal });
}

export function getArmoryMcp(base: string, id: string, signal?: AbortSignal) {
  return request<ArmoryMcpDetails>(`${base}/armory/packages/${encodeURIComponent(id)}/mcp`, { signal });
}

export async function submitArmoryConfiguration(base: string, id: string, values: Record<string, string>, confirmHostWrites: boolean) {
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

export function deleteArmoryConfiguration(base: string, id: string, includeHost: boolean) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/configuration`, {
    method: "DELETE",
    body: JSON.stringify(includeHost ? { includeHost: true, confirmHostWrites: true } : {}),
  });
}

export function setArmoryPackageEnabled(base: string, id: string, enabled: boolean) {
  return request<ArmoryOperationResponse>(`${base}/armory/packages/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
    method: "POST",
  });
}

export function getArmoryOperation(base: string, operationId: string, signal?: AbortSignal) {
  return request<ArmoryOperationResponse>(`${base}/armory/operations/${encodeURIComponent(operationId)}`, { signal });
}

export function getArmorySettings(base: string) {
  return request<ArmorySettings>(`${base}/armory/settings`);
}

export function getArmoryProfiles(base: string, signal?: AbortSignal) {
  return request<ArmoryProfileListResponse>(`${base}/armory/profiles`, { signal });
}

export function createArmoryProfile(base: string, type: string, name: string) {
  return request<ArmoryProfile>(`${base}/armory/profiles`, {
    method: "POST",
    body: JSON.stringify({ type, name }),
  });
}

export function renameArmoryProfile(base: string, profileId: string, name: string) {
  return request<ArmoryProfile>(`${base}/armory/profiles/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteArmoryProfile(base: string, profileId: string) {
  return request<ArmoryProfile>(`${base}/armory/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
}

export async function configureArmoryProfile(base: string, profileId: string, values: Record<string, string>) {
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

export function verifyArmoryProfile(base: string, profileId: string) {
  return request<ArmoryProfileOperation>(`${base}/armory/profiles/${encodeURIComponent(profileId)}/verify`, { method: "POST" });
}

export function getArmoryProfileOperation(base: string, operationId: string) {
  return request<ArmoryProfileOperationResponse>(`${base}/armory/operations/${encodeURIComponent(operationId)}`);
}

export function getArmoryProjectAssignments(base: string, projectId: string) {
  return request<ArmoryAssignmentListResponse>(`${base}/armory/projects/${encodeURIComponent(projectId)}/assignments`);
}

export function setArmoryProjectAssignment(base: string, projectId: string, packageId: string, profileId: string | null) {
  return request<ArmoryProjectAssignment>(`${base}/armory/projects/${encodeURIComponent(projectId)}/assignments/${encodeURIComponent(packageId)}`, {
    method: "PUT",
    body: JSON.stringify({ profileId }),
  });
}

export function removeArmoryProjectAssignment(base: string, projectId: string, packageId: string) {
  return request<ArmoryProjectAssignment>(`${base}/armory/projects/${encodeURIComponent(projectId)}/assignments/${encodeURIComponent(packageId)}`, { method: "DELETE" });
}
