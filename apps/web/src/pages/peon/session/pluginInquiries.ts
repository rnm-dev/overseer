import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../../api";

export const PLUGIN_INQUIRY_CAPABILITY = "managed-plugin-inquiry-v1";
export const PLUGIN_INQUIRY_REFRESH_MS = 15_000;

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

export function usePluginInquiries(base: string, sid: string, supported: boolean) {
  const [inquiries, setInquiries] = useState<PluginInstallInquiry[]>([]);
  const [loading, setLoading] = useState(supported);
  const [loadFailed, setLoadFailed] = useState(false);
  const inFlight = useRef(new Set<string>());
  const requestIds = useRef(new Map<string, string>());
  const scopeRef = useRef(`${base}:${sid}`);
  scopeRef.current = `${base}:${sid}`;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!supported || !sid) return;
    const scope = `${base}:${sid}`;
    try {
      const body = await api<InquiryListResponse>(inquiryCollectionPath(base, sid), { cache: "no-store", signal });
      if (scopeRef.current !== scope) return;
      setInquiries(parsePluginInquiries(body));
      setLoadFailed(false);
    } catch (error) {
      if (scopeRef.current === scope && !(error instanceof DOMException && error.name === "AbortError")) setLoadFailed(true);
    } finally {
      if (scopeRef.current === scope && !signal?.aborted) setLoading(false);
    }
  }, [base, sid, supported]);

  useEffect(() => {
    setInquiries([]);
    setLoading(supported);
    setLoadFailed(false);
    inFlight.current.clear();
    requestIds.current.clear();
    if (!supported || !sid) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, PLUGIN_INQUIRY_REFRESH_MS);
    const recover = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", recover);
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", recover);
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [refresh, sid, supported]);

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
      await refresh();
    } catch (error) {
      if (scopeRef.current !== scope) return;
      setInquiries((current) => current.map((row) => row.inquiryId === inquiry.inquiryId
        ? { ...row, status: stableInquiryError(error) }
        : row));
      if (error instanceof ApiError && error.status < 500) requestIds.current.delete(key);
    } finally {
      inFlight.current.delete(inquiry.inquiryId);
    }
  }, [base, refresh, sid]);

  return { inquiries, loading, loadFailed, refresh, respond };
}
