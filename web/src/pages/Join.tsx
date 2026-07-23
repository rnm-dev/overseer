import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { useT } from "../i18n";
import { Button, Card, GithubMark, LocaleSwitcher, Logo } from "../ui";

// Opening an invite link lands here. Signed-out visitors get a "sign in to join"
// button (the token is stashed and resumed after the GitHub round-trip); signed-in
// visitors are accepted automatically and dropped into the workspace.
const PENDING_INVITE_KEY = "overseer_pending_invite";
const CURRENT_WS_KEY = "overseer_ws"; // matches workspace.tsx

type Preview = { workspaceName: string } | "invalid" | null;

export function Join() {
  const { token } = useParams();
  const { user, loginWithGithub } = useAuth();
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

  async function signInToJoin() {
    if (token) sessionStorage.setItem(PENDING_INVITE_KEY, token);
    try {
      await loginWithGithub();
    } catch {
      setError(t("error.generic"));
    }
  }

  const workspaceName = preview && preview !== "invalid" ? preview.workspaceName : "";

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <LocaleSwitcher className="fixed right-4 top-4" />
      <div className="reveal flex w-full max-w-sm flex-col items-center text-center">
        <Logo size={150} />
        <Card className="surface--lit mt-6 w-full p-8">
          {preview === "invalid" ? (
            <>
              <p className="font-mono text-sm text-blood">{t("join.invalid")}</p>
              <a href="/" className="btn-ghost mt-4 inline-block">
                {t("join.backHome")}
              </a>
            </>
          ) : preview === null ? (
            <div className="flex flex-col items-center">
              <div className="forge-spin" />
            </div>
          ) : user ? (
            <div className="flex flex-col items-center gap-3">
              <div className="forge-spin" />
              <p className="rune text-xs text-bone-dim">{t("join.joining", { workspace: workspaceName })}</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-bone-dim">{t("join.invited")}</p>
              <p className="mt-1 font-display text-lg font-semibold text-fel-bright">{workspaceName}</p>
              <Button type="button" className="mt-5 flex w-full items-center justify-center gap-2" onClick={signInToJoin}>
                <GithubMark size={18} />
                {t("join.signIn")}
              </Button>
            </>
          )}
          {error && <p className="mt-4 border-l-2 border-blood pl-3 text-left font-mono text-xs text-blood">{error}</p>}
        </Card>
      </div>
    </div>
  );
}
