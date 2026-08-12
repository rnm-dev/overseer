import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth, type OauthProvider } from "./auth";
import { ApiError } from "../../shared/api";
import { useT } from "../../shared/i18n";

// The shared frontend callback for every redirect provider. It submits code +
// state to the API, which either finishes web sign-in or tells the browser to
// open the native app. One component serves both because the difference between
// them is a path segment the router already knows.
const PENDING_INVITE_KEY = "overseer_pending_invite";

export function OauthCallback({ provider }: { provider: OauthProvider }) {
  const { completeOauthCallback } = useAuth();
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
    const providerError = params.get("error");
    if (!state || (!code && !providerError)) {
      setError(t("login.callbackFailed"));
      return;
    }
    completeOauthCallback(provider, code, state, providerError)
      .then((flow) => {
        if (flow === "native") return;
        const pending = sessionStorage.getItem(PENDING_INVITE_KEY);
        if (pending) {
          sessionStorage.removeItem(PENDING_INVITE_KEY);
          navigate(`/join/${pending}`, { replace: true });
        } else {
          navigate("/", { replace: true });
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t("login.callbackFailed")));
  }, [params, provider, completeOauthCallback, navigate, t]);

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
