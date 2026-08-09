import { useState } from "react";
import { api, ApiError, json } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Button, Dialog, Input, Label } from "../../shared/ui";

// User-friendly peon enrollment: paste the peon's URL + secret phrase, optionally
// "Check" to see it connect (shows the peon's name), then "Add". Both hit the
// workspace-scoped endpoints; the connect check is a dry run that stores nothing.

type Check = { state: "ok"; name: string | null } | { state: "paired-waiting" } | { state: "err"; message: string; requestId?: string } | { state: "idle" | "checking" };

export function AddPeonDialog({ workspaceId, onClose, onAdded }: { workspaceId: string; onClose: () => void; onAdded: () => void }) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [adding, setAdding] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const base = `/workspaces/${workspaceId}/peons`;

  async function doCheck() {
    setCheck({ state: "checking" });
    try {
      const r = await api<{ ok: boolean; name?: string | null; message?: string }>(`${base}/connect`, json({ address: url, secret }));
      setCheck(r.ok ? { state: "ok", name: r.name ?? null } : { state: "err", message: r.message ?? t("error.connectionFailed") });
    } catch (err) {
      setCheck({ state: "err", message: err instanceof ApiError ? err.message : t("error.connectionFailed") });
    }
  }

  async function doAdd() {
    setAdding(true);
    try {
      const result = await api<{ registered?: boolean }>(`${base}/recruit`, json({ address: url, secret }));
      onAdded();
      if (result.registered === false) setCheck({ state: "paired-waiting" });
      else onClose();
    } catch (err) {
      setCheck({ state: "err", message: err instanceof ApiError ? err.message : t("error.couldntAdd"), requestId: err instanceof ApiError ? err.requestId : undefined });
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog title={t("addPeon.title")} onClose={onClose}>
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label>{t("addPeon.url")}</Label>
          <Input
            autoFocus
            placeholder="https://peon-box.rnm.dev"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setCheck({ state: "idle" });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>{t("addPeon.secret")}</Label>
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              className="font-mono text-xs text-ink-faint hover:text-ink"
            >
              {showSecret ? "hide" : "show"}
            </button>
          </div>
          <Input
            type={showSecret ? "text" : "password"}
            placeholder="the peon's overseer secret"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setCheck({ state: "idle" });
            }}
          />
          <p className="font-mono text-xs text-ink-faint">{t("addPeon.secretHelp")}</p>
        </div>

        {check.state === "ok" && (
          <div className="border border-accent/30 bg-accent/10 p-3 font-mono text-sm text-accent-strong">
            ⚡ {check.name ? t("addPeon.connectedNamed", { name: check.name }) : t("addPeon.connected")}
          </div>
        )}
        {check.state === "err" && (
          <div className="border border-danger/30 bg-danger/10 p-3 font-mono text-sm text-danger">
            {check.message}
            {check.requestId && <div className="mt-1 text-xs">{t("addPeon.requestId", { id: check.requestId })}</div>}
          </div>
        )}
        {check.state === "paired-waiting" && (
          <div className="border border-accent/30 bg-accent/10 p-3 font-mono text-sm text-accent-strong">
            ⚡ {t("addPeon.pairedWaiting")}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={doCheck} disabled={!url || !secret || check.state === "checking"}>
            {check.state === "checking" ? t("addPeon.checking") : t("addPeon.check")}
          </Button>
          <Button onClick={doAdd} disabled={!url || !secret || adding}>
            {adding ? t("addPeon.adding") : t("addPeon.add")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
