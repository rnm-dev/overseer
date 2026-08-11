import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import type { OauthProvider } from "./auth";

// Which doors this instance has, as the server describes them. Kept beside the
// feature's other models rather than inside the sign-in page: the shape is a
// contract with `GET /api/auth/methods` (describeAuthMethods on the server), and
// the page is only one of its readers.

export interface AuthMethods {
  password: boolean;
  github: boolean;
  oidc: boolean;
  /** What to call the OIDC provider — only this instance knows. */
  oidcLabel: string | null;
}

// An unreachable API is not "no sign-in methods": a transient failure should
// leave the page usable rather than blank. An unconfigured OIDC provider has no
// name to put on a button, so the fallback cannot invent one — it offers the two
// doors that need no instance-specific detail to render.
const WHEN_UNREACHABLE: AuthMethods = { password: true, github: true, oidc: false, oidcLabel: null };

export function redirectProvidersOf(methods: AuthMethods): OauthProvider[] {
  const providers: OauthProvider[] = [];
  if (methods.github) providers.push("github");
  if (methods.oidc) providers.push("oidc");
  return providers;
}

export function noMethodsAvailable(methods: AuthMethods): boolean {
  return !methods.password && !methods.github && !methods.oidc;
}

/** `null` until the answer arrives, so a disabled method never flashes into view. */
export function useAuthMethods(): AuthMethods | null {
  const [methods, setMethods] = useState<AuthMethods | null>(null);

  useEffect(() => {
    let active = true;
    void api<AuthMethods>("/auth/methods")
      .catch(() => WHEN_UNREACHABLE)
      .then((available) => {
        if (active) setMethods(available);
      });
    return () => {
      active = false;
    };
  }, []);

  return methods;
}
