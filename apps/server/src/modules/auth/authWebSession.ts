import type { Request, Response } from "express";
import { config } from "../../infrastructure/config/index.js";

export const WEB_SESSION_COOKIE = "__Host-overseer_session";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

function cookies(req: Request): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    try {
      parsed.set(name, decodeURIComponent(raw));
    } catch {
      // A malformed unrelated cookie must not break authentication.
    }
  }
  return parsed;
}

export function webSessionToken(req: Request): string {
  return cookies(req).get(WEB_SESSION_COOKIE) ?? "";
}

export function setWebSessionCookie(res: Response, token: string, expiresAt?: number): void {
  res.cookie(WEB_SESSION_COOKIE, token, {
    ...COOKIE_OPTIONS,
    expires: new Date(expiresAt ?? Date.now() + config.auth.deviceTokenTtlMs),
  });
}

export function clearWebSessionCookie(res: Response): void {
  res.clearCookie(WEB_SESSION_COOKIE, COOKIE_OPTIONS);
}

export function requestHasTrustedOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  try {
    return new URL(origin).origin === new URL(config.publicUrl).origin;
  } catch {
    return false;
  }
}

export function requiresCsrfOrigin(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}
