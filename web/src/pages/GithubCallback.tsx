import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { ApiError } from "../api";
import { useT } from "../i18n";
import { Card, Logo } from "../ui";

// Landing page for GitHub's redirect. Reads ?code&state, finishes sign-in, then
// forwards into the app — or to a pending invite if the user arrived via a /join
// link before authenticating.
const PENDING_INVITE_KEY = "overseer_pending_invite";

export function GithubCallback() {
  const { completeGithubCallback } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return; // StrictMode double-invoke guard — the code is single-use
    done.current = true;
    const code = params.get("code");
    const state = params.get("state");
    if (params.get("error") || !code || !state) {
      setError(t("login.callbackFailed"));
      return;
    }
    completeGithubCallback(code, state)
      .then(() => {
        const pending = sessionStorage.getItem(PENDING_INVITE_KEY);
        if (pending) {
          sessionStorage.removeItem(PENDING_INVITE_KEY);
          navigate(`/join/${pending}`, { replace: true });
        } else {
          navigate("/", { replace: true });
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t("login.callbackFailed")));
  }, [params, completeGithubCallback, navigate, t]);

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="reveal flex w-full max-w-sm flex-col items-center text-center">
        <Logo size={140} />
        <Card className="mt-6 w-full p-8">
          {error ? (
            <>
              <p className="border-l-2 border-blood pl-3 text-left font-mono text-xs text-blood">{error}</p>
              <a href="/login" className="btn-ghost mt-4 inline-block">
                {t("login.backToLogin")}
              </a>
            </>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="forge-spin" />
              <p className="rune text-xs text-bone-dim">{t("login.callback")}</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
