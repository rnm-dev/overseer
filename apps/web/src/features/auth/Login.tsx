import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "./auth";
import { noMethodsAvailable, redirectProvidersOf, useAuthMethods } from "./authMethods";
import { ApiError } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { KeyRound, Palette, Skull } from "lucide-react";
import { GithubMark, LocaleSwitcher } from "../../shared/ui";
import { useTheme } from "../themes/ThemeProvider";

// Up to three doors into the same session: an email + password form, GitHub, and
// the instance's OIDC provider. All end in the server's HttpOnly cookie, and
// accounts meet on their email address — an account registered here links to a
// GitHub or OIDC identity on the same address the first time it signs in that way.
//
// Which doors exist is the instance's decision (OVERSEER_PASSWORD_AUTH, the
// GitHub app credentials, OVERSEER_OIDC_*), read from /auth/methods rather than
// assumed — the page shows nothing it cannot actually complete. Until that
// answer arrives it shows none, so a disabled method never flashes into view.
// The OIDC button carries the provider's name, because "OIDC" is a protocol and
// not a place anyone recognises signing in to.
//
// The page carries no card and no logo: identity is the wordmark, the surface
// is the void itself (.auth-* in index.css).

// Matches Join.tsx: a visitor who arrived from an invite link resumes it once
// signed in. The redirect providers do this in their callback page; the password
// form has no callback, so it does it here.
const PENDING_INVITE_KEY = "overseer_pending_invite";

type Mode = "signIn" | "register";

export function Login() {
  const { loginWithProvider, signInWithPassword, registerWithPassword } = useAuth();
  const { theme, themes, selectTheme } = useTheme();
  const t = useT();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"github" | "oidc" | "password" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const methods = useAuthMethods();

  const redirectDoors = methods ? redirectProvidersOf(methods).length : 0;
  // Two ways an account may be created here: the instance takes anyone
  // (OVERSEER_OPEN_SIGNUP), or this visitor came from an invite link and stashed
  // it on the way. Read once per render rather than held in state — the only
  // writer is Join.tsx, on a different page.
  const pendingInvite = sessionStorage.getItem(PENDING_INVITE_KEY);
  const mayRegister = Boolean(methods?.openSignup) || pendingInvite !== null;
  const registering = mode === "register" && mayRegister;

  async function attempt(what: "github" | "oidc" | "password", run: () => Promise<unknown>) {
    setBusy(what);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("error.generic"));
      setBusy(null);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    void attempt("password", async () => {
      const ended = await (registering
        ? registerWithPassword(email, password, pendingInvite)
        : signInWithPassword(email, password));
      // The browser is on its way to the app's deep link; there is no page left
      // to navigate and the invite is the app's to resume.
      if (ended === "native") return;
      const pending = sessionStorage.getItem(PENDING_INVITE_KEY);
      if (!pending) return;
      sessionStorage.removeItem(PENDING_INVITE_KEY);
      // Registration already spent the token on the new account, so sending it
      // back to /join would only redeem it a second time and fail.
      if (!registering) navigate(`/join/${pending}`, { replace: true });
    });
  }

  return (
    <div className="auth-scene">
      <div className="auth-controls">
        <label className="auth-theme-picker">
          <Palette size={14} aria-hidden />
          <span className="sr-only">{t("user.theme")}</span>
          <select
            aria-label={t("user.theme")}
            value={theme.id}
            onChange={(event) => selectTheme(event.target.value)}
          >
            {themes.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </label>
        <LocaleSwitcher />
      </div>
      <div className="auth-stack">
        <h1 className="auth-wordmark">{t("app.name")}</h1>
        <p className="auth-tagline">
          <span className="auth-rule" aria-hidden />
          {t("app.tagline")}
          <span className="auth-rule" aria-hidden />
        </p>

        {methods?.password && (
          <form className="auth-form" onSubmit={submit}>
            <input
              className="field"
              type="email"
              name="email"
              autoComplete="email"
              required
              placeholder={t("login.email")}
              aria-label={t("login.email")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="field"
              type="password"
              name="password"
              autoComplete={registering ? "new-password" : "current-password"}
              required
              minLength={registering ? 10 : undefined}
              placeholder={registering ? t("login.passwordNew") : t("login.password")}
              aria-label={t("login.password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="submit" className="auth-cta" disabled={busy !== null}>
              {busy === "password" ? t("login.working") : registering ? t("login.register") : t("login.signIn")}
            </button>
          </form>
        )}

        {/* Hidden on an invite-only instance: the form is there, but nothing
            this visitor could type would be accepted. */}
        {methods?.password && mayRegister && (
          <p className="auth-switch">
            {registering ? t("login.haveAccount") : t("login.noAccount")}{" "}
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                setMode(registering ? "signIn" : "register");
                setError(null);
              }}
            >
              {registering ? t("login.signIn") : t("login.register")}
            </button>
          </p>
        )}

        {/* The divider only earns its place when the form has company. */}
        {methods?.password && redirectDoors > 0 && (
          <p className="auth-divider" aria-hidden>
            <span className="auth-rule" />
            {t("login.or")}
            <span className="auth-rule" />
          </p>
        )}

        {methods?.github && (
          <button
            type="button"
            className={methods.password || methods.oidc ? "auth-cta auth-cta--quiet" : "auth-cta"}
            disabled={busy !== null}
            onClick={() => void attempt("github", () => loginWithProvider("github"))}
          >
            <GithubMark size={17} />
            {busy === "github" ? t("login.signingIn") : t("login.github")}
          </button>
        )}

        {methods?.oidc && (
          <button
            type="button"
            className={methods.password || methods.github ? "auth-cta auth-cta--quiet" : "auth-cta"}
            disabled={busy !== null}
            onClick={() => void attempt("oidc", () => loginWithProvider("oidc"))}
          >
            <KeyRound size={17} />
            {t(busy === "oidc" ? "login.oidcSigningIn" : "login.oidc", {
              provider: methods.oidcLabel ?? t("login.oidcProvider"),
            })}
          </button>
        )}

        {methods && noMethodsAvailable(methods) && (
          <p className="auth-error" role="alert">
            <Skull size={14} className="shrink-0" />
            {t("login.noMethods")}
          </p>
        )}

        {error && (
          <p className="auth-error" role="alert">
            <Skull size={14} className="shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
