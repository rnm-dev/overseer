import { useState } from "react";
import { useAuth } from "../auth";
import { ApiError } from "../api";
import { useT } from "../i18n";
import { Skull } from "lucide-react";
import { Button, Card, GithubMark, LocaleSwitcher, Logo } from "../ui";

// Sign-in is a single GitHub button. It redirects to GitHub; the browser comes
// back to /auth/github/callback (GithubCallback), which finishes the exchange.

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
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <LocaleSwitcher className="fixed right-4 top-4" />
      <div className="reveal w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo size={190} />
          <p className="mt-3 font-mono text-[0.7rem] uppercase tracking-[0.3em] text-fel-deep">{t("app.tagline")}</p>
        </div>

        <Card className="warplate--lit p-8">
          <Button type="button" className="flex w-full items-center justify-center gap-2" disabled={busy} onClick={signIn}>
            <GithubMark size={18} />
            {busy ? t("login.signingIn") : t("login.github")}
          </Button>
          {error && (
            <p className="mt-4 flex items-center justify-center gap-1.5 text-center font-mono text-xs text-blood">
              <Skull size={14} />
              {error}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
