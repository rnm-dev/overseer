import { useState } from "react";
import { useAuth } from "../auth";
import { ApiError } from "../api";
import { useT } from "../i18n";
import { Skull } from "lucide-react";
import { GithubMark, LocaleSwitcher } from "../ui";

// Sign-in is a single GitHub button. GitHub returns to the shared frontend
// callback, which asks the API to finish the web or native flow.
//
// The page carries no card and no logo: identity is the wordmark, the surface
// is the void itself (.auth-* in index.css).

export function Login() {
  const { loginWithGithub } = useAuth();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await loginWithGithub(); // navigates away to GitHub on success
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("error.generic"));
      setBusy(false);
    }
  }

  return (
    <div className="auth-scene">
      <LocaleSwitcher className="fixed right-4 top-4" />
      <div className="auth-stack">
        <h1 className="auth-wordmark">{t("app.name")}</h1>
        <p className="auth-tagline">
          <span className="auth-rule" aria-hidden />
          {t("app.tagline")}
          <span className="auth-rule" aria-hidden />
        </p>
        <button type="button" className="auth-cta" disabled={busy} onClick={signIn}>
          <GithubMark size={17} />
          {busy ? t("login.signingIn") : t("login.github")}
        </button>
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
