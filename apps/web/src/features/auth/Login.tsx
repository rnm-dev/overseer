import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import { api, ApiError } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Palette, Skull } from "lucide-react";
import { GithubMark, LocaleSwitcher } from "../../shared/ui";
import { useTheme } from "../themes/ThemeProvider";

// Two doors into the same session: an email + password form, and GitHub. Both
// end in the server's HttpOnly cookie, and an account registered here links to
// a GitHub identity on the same address the first time it signs in that way.
//
// Which doors exist is the instance's decision (OVERSEER_PASSWORD_AUTH and the
// GitHub app credentials), read from /auth/methods rather than assumed — the
// page shows nothing it cannot actually complete. Until that answer arrives it
// shows neither, so a disabled method never flashes into view.
//
// The page carries no card and no logo: identity is the wordmark, the surface
// is the void itself (.auth-* in index.css).

type Mode = "signIn" | "register";

interface AuthMethods {
  password: boolean;
  github: boolean;
}

export function Login() {
  const { loginWithGithub, signInWithPassword, registerWithPassword } = useAuth();
  const { theme, themes, selectTheme } = useTheme();
  const t = useT();
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"github" | "password" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methods, setMethods] = useState<AuthMethods | null>(null);

  useEffect(() => {
    let active = true;
    // An unreachable API is not "no sign-in methods" — fall back to both, so a
    // transient failure leaves the page usable rather than blank.
    void api<AuthMethods>("/auth/methods")
      .catch(() => ({ password: true, github: true }))
      .then((available) => {
        if (active) setMethods(available);
      });
    return () => {
      active = false;
    };
  }, []);

  const registering = mode === "register";

  async function attempt(what: "github" | "password", run: () => Promise<unknown>) {
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
    void attempt("password", () =>
      registering ? registerWithPassword(email, password) : signInWithPassword(email, password),
    );
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

        {methods?.password && (
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

        {/* The divider only earns its place when both doors are open. */}
        {methods?.password && methods.github && (
          <p className="auth-divider" aria-hidden>
            <span className="auth-rule" />
            {t("login.or")}
            <span className="auth-rule" />
          </p>
        )}

        {methods?.github && (
          <button
            type="button"
            className={methods.password ? "auth-cta auth-cta--quiet" : "auth-cta"}
            disabled={busy !== null}
            onClick={() => void attempt("github", loginWithGithub)}
          >
            <GithubMark size={17} />
            {busy === "github" ? t("login.signingIn") : t("login.github")}
          </button>
        )}

        {methods && !methods.password && !methods.github && (
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
