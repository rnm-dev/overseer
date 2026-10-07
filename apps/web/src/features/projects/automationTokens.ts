import { api } from "../../shared/api";
import type { ApiRequest } from "../fleet/peonApi";

export interface AutomationToken {
  id: string;
  label: string | null;
  peonId: string;
  projectKey: string | null;
  projectId: string | null;
  ownerUserId: string;
  ownerEmail: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  mine: boolean;
}

export interface AutomationTokenList {
  tokens: AutomationToken[];
  canManageAll: boolean;
}

const path = (base: string, key: string) => `${base}/projects/${encodeURIComponent(key)}/automation-tokens`;

export function listAutomationTokens(base: string, key: string, request: ApiRequest = api) {
  return request<AutomationTokenList>(path(base, key));
}

export function createAutomationToken(
  base: string,
  key: string,
  input: { label: string | null; expiresInDays: number | null },
  request: ApiRequest = api,
) {
  return request<{ token: string; created: AutomationToken }>(path(base, key), {
    method: "POST",
    body: JSON.stringify({
      label: input.label,
      // Omitted means "no expiry", which the server treats as a deliberate
      // choice. Sending null would say the same thing; sending 0 would not.
      ...(input.expiresInDays === null ? {} : { expiresInDays: input.expiresInDays }),
    }),
  });
}

export function revokeAutomationToken(base: string, key: string, id: string, request: ApiRequest = api) {
  return request<{ ok: true }>(`${path(base, key)}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export const EXPIRY_CHOICES = [30, 90, 365, null] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

// A token is only worth showing once; after that the row is all an operator
// has. Sort so the ones that still matter are on top: recently used first,
// then recently created.
export function orderedTokens(tokens: AutomationToken[]): AutomationToken[] {
  return [...tokens].sort((left, right) =>
    (right.lastUsedAt ?? right.createdAt) - (left.lastUsedAt ?? left.createdAt));
}

export function isExpired(token: AutomationToken, now = Date.now()): boolean {
  return token.expiresAt !== null && token.expiresAt <= now;
}

// Whether this operator may revoke the row. The server decides for real; this
// only keeps the UI from offering a button that would answer 404.
export function canRevoke(token: AutomationToken, canManageAll: boolean): boolean {
  return canManageAll || token.mine;
}
