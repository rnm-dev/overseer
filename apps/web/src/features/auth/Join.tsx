import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../../shared/api";
import { useAuth } from "./auth";
import { useT } from "../../shared/i18n";
import { LocaleSwitcher } from "../../shared/ui";

// Opening an invite link lands here. Signed-out visitors get a "sign in to join"
// button that stashes the token and sends them to the sign-in page, because that
// page is the one place that knows which doors this instance actually has —
// naming a provider here would leave a dead button on an instance without it.
// The stashed token is picked up again once they are signed in. Signed-in
// visitors are accepted automatically and dropped into the workspace.
const PENDING_INVITE_KEY = "overseer_pending_invite";
const CURRENT_WS_KEY = "overseer_ws"; // matches workspace.tsx

type Preview = { workspaceName: string } | "invalid" | null;

export function Join() {
  const { token } = useParams();
  const { user } = useAuth();
  const t = useT();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview>(null);
  const [error, setError] = useState<string | null>(null);
  const accepting = useRef(false);

  useEffect(() => {
    if (!token) return;
    api<{ workspaceName: string }>(`/invites/${token}`)
      .then(setPreview)
      .catch(() => setPreview("invalid"));
  }, [token]);

  // Signed in + valid invite → accept and drop into the workspace.
  useEffect(() => {
    if (!user || !token || !preview || preview === "invalid" || accepting.current) return;
    accepting.current = true;
    api<{ workspace: { id: string } }>(`/invites/${token}/accept`, { method: "POST" })
      .then((r) => {
        localStorage.setItem(CURRENT_WS_KEY, r.workspace.id);
        navigate("/", { replace: true });
      })
      .catch(() => setError(t("error.joinFailed")));
  }, [user, token, preview, navigate, t]);

  function signInToJoin() {
    if (token) sessionStorage.setItem(PENDING_INVITE_KEY, token);
    navigate("/login");
  }

  const workspaceName = preview && preview !== "invalid" ? preview.workspaceName : "";

  return (
    <div className="auth-scene">
      <LocaleSwitcher className="fixed right-4 top-4" />
      <div className="auth-stack">
        <h1 className="auth-wordmark auth-wordmark--muted">{t("app.name")}</h1>
        {preview === "invalid" ? (
          <>
            <p className="auth-error" role="alert">{t("join.invalid")}</p>
            <a href="/" className="auth-link">{t("join.backHome")}</a>
          </>
        ) : preview === null ? (
          <p className="auth-status" role="status">
            <span className="auth-orbit" aria-hidden />
          </p>
        ) : user ? (
          <p className="auth-status" role="status">
            <span className="auth-orbit" aria-hidden />
            {t("join.joining", { workspace: workspaceName })}
          </p>
        ) : (
          <>
            <p className="auth-lede">{t("join.invited")}</p>
            <p className="auth-subject">{workspaceName}</p>
            <button type="button" className="auth-cta" onClick={signInToJoin}>
              {t("join.signIn")}
            </button>
          </>
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
