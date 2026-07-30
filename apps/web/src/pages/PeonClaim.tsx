import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { ApiError, api, json } from "../api";
import { useAuth } from "../auth";
import { useT } from "../i18n";
import { Button, Card, GithubMark, LocaleSwitcher } from "../ui";
import { claimCodeForPage, claimDecisionPath, claimResolveBody } from "./peonClaimModel";

const PENDING_CLAIM_KEY = "overseer_pending_claim";

interface Workspace {
  id: string;
  name: string;
  role: "owner" | "member";
}

interface ClaimDetails {
  type: "claim_details";
  protocol: 1;
  claimId: string;
  state: "pending";
  peonId: string;
  identityKeyId: string;
  display: {
    name: string;
    platform: "darwin" | "linux" | "windows";
    architecture: "arm64" | "x64";
    daemonVersion: string;
  };
  createdAt: number;
  expiresAt: number;
  serverTime: number;
}

type DecisionResult =
  | { state: "approved"; mode: "new" | "recover"; workspaceId: string }
  | { state: "denied" };

export function PeonClaim() {
  const routeCode = useParams().operatorCode ?? "";
  const code = useRef(claimCodeForPage(routeCode, sessionStorage.getItem(PENDING_CLAIM_KEY))).current;
  const { user, loginWithGithub } = useAuth();
  const t = useT();
  const [details, setDetails] = useState<ClaimDetails | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The locator is allowed in the human URL only. Capture it once, then remove
  // it before any navigation or later browser-history synchronization.
  useEffect(() => {
    if (code) {
      sessionStorage.setItem(PENDING_CLAIM_KEY, code);
      window.history.replaceState(window.history.state, "", "/claim");
    }
  }, [code]);

  useEffect(() => {
    if (!user || !code || details || result) return;
    setBusy(true);
    Promise.all([
      api<ClaimDetails>("/peon-claims/resolve", json(claimResolveBody(code))),
      api<{ workspaces: Workspace[] }>("/workspaces"),
    ]).then(([claim, workspaceResult]) => {
      const owned = workspaceResult.workspaces.filter((workspace) => workspace.role === "owner");
      setDetails(claim);
      setWorkspaces(owned);
      setWorkspaceId(owned[0]?.id ?? "");
      sessionStorage.removeItem(PENDING_CLAIM_KEY);
    }).catch((reason: unknown) => {
      setError(reason instanceof ApiError ? reason.message : t("claim.invalid"));
    }).finally(() => setBusy(false));
  }, [code, details, result, t, user]);

  const expires = useMemo(() => details
    ? new Date(details.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "", [details]);

  async function signIn() {
    if (code) sessionStorage.setItem(PENDING_CLAIM_KEY, code);
    setBusy(true);
    setError(null);
    try {
      await loginWithGithub();
    } catch (reason) {
      setBusy(false);
      setError(reason instanceof ApiError ? reason.message : t("error.generic"));
    }
  }

  async function decide(decision: "approve" | "deny") {
    if (!details || !workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<DecisionResult>(
        claimDecisionPath(workspaceId, details.claimId),
        json({ type: "claim_decision", protocol: 1, claimId: details.claimId, decision }),
      );
      setResult(response);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-scene px-4">
      <LocaleSwitcher className="fixed right-4 top-4" />
      <div className="w-full max-w-xl">
        <h1 className="auth-wordmark auth-wordmark--muted text-center">{t("app.name")}</h1>
        <Card className="mt-8 p-6 md:p-8">
          <h2 className="font-display text-xl font-semibold text-bone">{t("claim.title")}</h2>
          {!code ? (
            <p className="mt-4 font-body text-sm text-bone-dim">{t("claim.invalid")}</p>
          ) : !user ? (
            <div className="mt-5">
              <p className="font-body text-sm text-bone-dim">{t("claim.signInHint")}</p>
              <button type="button" className="auth-cta mt-5" disabled={busy} onClick={signIn}>
                <GithubMark size={17} />
                {t("claim.signIn")}
              </button>
            </div>
          ) : busy && !details ? (
            <div className="mt-8 flex justify-center" role="status"><div className="forge-spin" /></div>
          ) : result ? (
            <div className="mt-5">
              <p className="font-body text-sm text-bone">
                {result.state === "denied"
                  ? t("claim.denied")
                  : result.mode === "recover"
                    ? t("claim.recoveryApproved")
                    : t("claim.approved")}
              </p>
              <a className="auth-link mt-5 inline-block" href="/">{t("claim.back")}</a>
            </div>
          ) : details ? (
            <div className="mt-5 space-y-5">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-mono text-xs">
                <dt className="text-bone-faint">{t("claim.name")}</dt>
                <dd className="text-bone">{details.display.name}</dd>
                <dt className="text-bone-faint">{t("claim.system")}</dt>
                <dd className="text-bone">{details.display.platform} · {details.display.architecture}</dd>
                <dt className="text-bone-faint">{t("claim.version")}</dt>
                <dd className="text-bone">{details.display.daemonVersion}</dd>
                <dt className="text-bone-faint">{t("claim.identity")}</dt>
                <dd className="break-all text-bone">{details.identityKeyId}</dd>
                <dt className="text-bone-faint">{t("claim.expires")}</dt>
                <dd className="text-bone">{expires}</dd>
              </dl>
              <label className="block">
                <span className="mb-2 block font-mono text-xs text-bone-dim">{t("claim.workspace")}</span>
                <select
                  className="field w-full"
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
              </label>
              {!workspaces.length && <p className="text-sm text-forge">{t("claim.noOwnerWorkspace")}</p>}
              <p className="rounded-md border border-forge/30 bg-forge/10 p-3 font-body text-xs text-ember">
                {t("claim.recoveryWarning")}
              </p>
              <div className="flex justify-end gap-3">
                <Button variant="ghost" disabled={busy || !workspaceId} onClick={() => void decide("deny")}>{t("claim.deny")}</Button>
                <Button disabled={busy || !workspaceId} onClick={() => void decide("approve")}>{t("claim.approve")}</Button>
              </div>
            </div>
          ) : null}
          {error && <p className="mt-5 text-sm text-blood" role="alert">{error}</p>}
        </Card>
      </div>
    </div>
  );
}
