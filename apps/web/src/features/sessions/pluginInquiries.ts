import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../shared/api";

export const PLUGIN_INQUIRY_CAPABILITY = "managed-plugin-inquiry-v1";

export type PluginInquiryStatus =
  | "pending"
  | "installing"
  | "installed"
  | "auth_required"
  | "expired"
  | "cancelled"
  | "refused"
  | "failed"
  | "stale";

export interface PluginIdentity {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  developerName: string | null;
  category: string | null;
  capabilities: string[];
  authPolicy: "ON_INSTALL" | "ON_USE";
  installPolicy: "NOT_AVAILABLE" | "AVAILABLE" | "INSTALLED_BY_DEFAULT";
  installed: boolean;
}

export interface PluginInstallInquiry {
  version: "inquiry-v1";
  inquiryId: string;
  kind: "managed_plugin_install";
  status: PluginInquiryStatus;
  plugin: PluginIdentity;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  respondedBy: string | null;
  terminalCode: string | null;
  authPolicy: "ON_INSTALL" | "ON_USE" | null;
  appsNeedingAuth: Array<{ id: string; name: string; category: string | null; description: string | null }>;
}

interface InquiryListResponse { inquiries: PluginInstallInquiry[] }
type ApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
const inquiryReads = new Map<string, Promise<InquiryListResponse>>();
const CONTROL_READ_TIMEOUT_MS = 15_000;
export const ACTIVE_INQUIRY_RECOVERY_MS = 30_000;

export function inquiryRecoveryEnabled(supported: boolean, sid: string, running: boolean, visible: boolean): boolean {
  return supported && sid.length > 0 && running && visible;
}

export function readPluginInquiries(
  path: string,
  ownerScope: string,
  request: ApiRequest = api,
): Promise<InquiryListResponse> {
  const key = ownerScope ? `${ownerScope}\0${path}` : null;
  const existing = key ? inquiryReads.get(key) : null;
  if (existing) return existing;
  const controller = request === api ? new AbortController() : null;
  const timeout = controller ? window.setTimeout(() => controller.abort(), CONTROL_READ_TIMEOUT_MS) : null;
  const read = request<InquiryListResponse>(path, {
    cache: "no-store",
    ...(controller ? { signal: controller.signal } : {}),
  })
    .finally(() => {
      if (timeout !== null) window.clearTimeout(timeout);
      if (key && inquiryReads.get(key) === read) inquiryReads.delete(key);
    });
  if (key) inquiryReads.set(key, read);
  return read;
}

export function inquiryCollectionPath(base: string, sid: string): string {
  return `${base}/sessions/${encodeURIComponent(sid)}/inquiries`;
}

export function inquiryResponsePath(base: string, sid: string, inquiryId: string): string {
  return `${inquiryCollectionPath(base, sid)}/${encodeURIComponent(inquiryId)}/respond`;
}

export function respondToPluginInquiry(base: string, sid: string, inquiryId: string, action: "install" | "cancel", requestId: string, request: ApiRequest = api) {
  return request<PluginInstallInquiry>(inquiryResponsePath(base, sid, inquiryId), {
    method: "POST",
    headers: { "Peon-Request-Id": requestId },
    body: JSON.stringify({ action }),
  });
}

export function visiblePluginInquiry(value: unknown, now = Date.now()): PluginInstallInquiry | null {
  if (!value || typeof value !== "object") return null;
  const inquiry = value as Partial<PluginInstallInquiry>;
  const plugin = inquiry.plugin as Partial<PluginIdentity> | undefined;
  if (inquiry.version !== "inquiry-v1" || inquiry.kind !== "managed_plugin_install" || typeof inquiry.inquiryId !== "string") return null;
  if (!plugin || typeof plugin.id !== "string" || typeof plugin.name !== "string" || typeof plugin.displayName !== "string") return null;
  if (typeof inquiry.expiresAt !== "string" || !Number.isFinite(Date.parse(inquiry.expiresAt))) return null;
  const allowed: PluginInquiryStatus[] = ["pending", "installing", "installed", "auth_required", "expired", "cancelled", "failed"];
  if (!allowed.includes(inquiry.status as PluginInquiryStatus)) return null;
  const normalized = inquiry as PluginInstallInquiry;
  if (Date.parse(normalized.expiresAt) <= now && normalized.status === "pending") return { ...normalized, status: "expired" };
  if (normalized.status === "failed" && ["INQUIRY_STALE_GENERATION", "INQUIRY_RUNTIME_LOST", "INQUIRY_TURN_ENDED"].includes(normalized.terminalCode ?? "")) {
    return { ...normalized, status: "stale" };
  }
  return normalized;
}

export function parsePluginInquiries(value: unknown, now = Date.now()): PluginInstallInquiry[] {
  const rows = Array.isArray(value) ? value : (value as InquiryListResponse | null)?.inquiries;
  if (!Array.isArray(rows)) throw new Error("Invalid inquiry list");
  return rows.map((row) => {
    const inquiry = visiblePluginInquiry(row, now);
    if (!inquiry) throw new Error("Invalid inquiry envelope");
    return inquiry;
  });
}

export function stableInquiryError(error: unknown): PluginInquiryStatus {
  if (!(error instanceof ApiError)) return "failed";
  if (error.code === "INQUIRY_EXPIRED") return "expired";
  if (["INQUIRY_TURN_ENDED", "INQUIRY_RUNTIME_LOST", "INQUIRY_STALE_GENERATION"].includes(error.code)) return "stale";
  if (["INQUIRY_CANCELLED", "INQUIRY_ALREADY_CANCELLED"].includes(error.code)) return "cancelled";
  if (["INQUIRY_ACTOR_MISMATCH", "FORBIDDEN"].includes(error.code)) return "refused";
  return "failed";
}

export function inquiryInsertionIndex(items: object[], createdAt: string): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return items.length;
  const later = items.findIndex((item) => {
    const itemTimestamp = (item as { createdAt?: unknown }).createdAt;
    return typeof itemTimestamp === "number" && itemTimestamp > timestamp;
  });
  return later === -1 ? items.length : later;
}

export function usePluginInquiries(base: string, sid: string, supported: boolean, running: boolean, ownerScope: string) {
  const [inquiries, setInquiries] = useState<PluginInstallInquiry[]>([]);
  const [loading, setLoading] = useState(supported);
  const inFlight = useRef(new Set<string>());
  const requestIds = useRef(new Map<string, string>());
  const scopeRef = useRef(`${base}:${sid}`);
  scopeRef.current = `${base}:${sid}`;

  const refresh = useCallback(async () => {
    if (!supported || !sid) return;
    const scope = `${base}:${sid}`;
    try {
      const body = await readPluginInquiries(inquiryCollectionPath(base, sid), ownerScope);
      if (scopeRef.current !== scope) return;
      setInquiries(parsePluginInquiries(body));
    } catch {
      // A failed reconciliation says nothing about the inquiries themselves:
      // keep the last known list. Active-turn compatibility or proven-gap
      // recovery can try again without putting a transient outage in the UI.
    } finally {
      if (scopeRef.current === scope) setLoading(false);
    }
  }, [base, ownerScope, sid, supported]);

  useEffect(() => {
    setInquiries([]);
    setLoading(supported);
    inFlight.current.clear();
    requestIds.current.clear();
    if (!supported || !sid) return;
    void refresh();
  }, [refresh, sid, supported]);

  // The transcript tail carries committed message rows but no inquiry-change
  // frame. While a turn is actively capable of opening an inquiry, retain
  // one bounded legacy recovery read. Idle and background pages issue none;
  // direct response bodies and transport-gap recovery remain immediate.
  useEffect(() => {
    if (!inquiryRecoveryEnabled(supported, sid, running, true)) return;
    const recover = () => {
      if (inquiryRecoveryEnabled(supported, sid, running, document.visibilityState === "visible")) void refresh();
    };
    const timer = window.setInterval(recover, ACTIVE_INQUIRY_RECOVERY_MS);
    return () => window.clearInterval(timer);
  }, [refresh, running, sid, supported]);

  useEffect(() => {
    const expiry = inquiries
      .filter((inquiry) => inquiry.status === "pending")
      .reduce<number | null>((soonest, inquiry) => {
        const at = Date.parse(inquiry.expiresAt);
        return soonest === null || at < soonest ? at : soonest;
      }, null);
    if (expiry === null) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setInquiries((current) => current.map((inquiry) => visiblePluginInquiry(inquiry, now) ?? inquiry));
    }, Math.max(0, expiry - Date.now()) + 25);
    return () => window.clearTimeout(timer);
  }, [inquiries]);

  const respond = useCallback(async (inquiry: PluginInstallInquiry, decision: "install" | "cancel") => {
    const scope = `${base}:${sid}`;
    const key = `${inquiry.inquiryId}:${decision}`;
    if (inFlight.current.has(inquiry.inquiryId)) return;
    inFlight.current.add(inquiry.inquiryId);
    const requestId = requestIds.current.get(key) ?? crypto.randomUUID();
    requestIds.current.set(key, requestId);
    setInquiries((current) => current.map((row) => row.inquiryId === inquiry.inquiryId
      ? { ...row, status: decision === "install" ? "installing" : "cancelled" }
      : row));
    try {
      const result = await respondToPluginInquiry(base, sid, inquiry.inquiryId, decision, requestId);
      if (scopeRef.current !== scope) return;
      const next = visiblePluginInquiry(result);
      if (next) setInquiries((current) => current.map((row) => row.inquiryId === next.inquiryId ? next : row));
      requestIds.current.delete(key);
    } catch (error) {
      if (scopeRef.current !== scope) return;
      setInquiries((current) => current.map((row) => row.inquiryId === inquiry.inquiryId
        ? { ...row, status: stableInquiryError(error) }
        : row));
      if (error instanceof ApiError && error.status < 500) requestIds.current.delete(key);
    } finally {
      inFlight.current.delete(inquiry.inquiryId);
    }
  }, [base, sid]);

  return { inquiries, loading, refresh, respond };
}
