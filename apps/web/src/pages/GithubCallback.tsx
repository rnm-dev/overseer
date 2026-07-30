import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth";
import { ApiError } from "../api";
import { useT } from "../i18n";

// GitHub's shared frontend callback. It submits code + state to the API, which
// either finishes web sign-in or tells the browser to open the native app.
const PENDING_INVITE_KEY = "overseer_pending_invite";
const PENDING_CLAIM_KEY = "overseer_pending_claim";

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
    const githubError = params.get("error");
    if (!state || (!code && !githubError)) {
      setError(t("login.callbackFailed"));
      return;
    }
    completeGithubCallback(code, state, githubError)
      .then((flow) => {
        if (flow === "native") return;
        const pendingClaim = sessionStorage.getItem(PENDING_CLAIM_KEY);
        const pending = sessionStorage.getItem(PENDING_INVITE_KEY);
        if (pendingClaim) {
          sessionStorage.removeItem(PENDING_CLAIM_KEY);
          navigate(`/claim/${pendingClaim}`, { replace: true });
        } else if (pending) {
          sessionStorage.removeItem(PENDING_INVITE_KEY);
          navigate(`/join/${pending}`, { replace: true });
        } else {
          navigate("/", { replace: true });
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t("login.callbackFailed")));
  }, [params, completeGithubCallback, navigate, t]);

  return (
    <div className="auth-scene">
      <div className="auth-stack">
        <h1 className="auth-wordmark auth-wordmark--muted">{t("app.name")}</h1>
        {error ? (
          <>
            <p className="auth-error" role="alert">{error}</p>
            <a href="/login" className="auth-link">{t("login.backToLogin")}</a>
          </>
        ) : (
          <p className="auth-status" role="status">
            <span className="auth-orbit" aria-hidden />
            {t("login.callback")}
          </p>
        )}
      </div>
    </div>
  );
}
