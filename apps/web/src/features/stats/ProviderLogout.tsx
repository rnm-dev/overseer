import { LoaderCircle, LogOut } from "lucide-react";
import { useState } from "react";
import { api, json } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Button } from "../../shared/ui";
import type { Provider } from "./statsModel";

export function ProviderLogout({ base, provider, onSuccess }: { base: string; provider: Provider; onSuccess: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function logout() {
    setBusy(true); setError(false);
    try {
      await api(`${base}/driver/${provider}/logout`, json({}));
      onSuccess();
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <div className="mt-2">
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void logout()} className="gap-1.5 !rounded-lg text-ink-faint hover:text-danger">
      {busy ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <LogOut size={13} aria-hidden="true" />}
      {t(busy ? "providerLogin.loggingOut" : "providerLogin.logout")}
    </Button>
    {error && <p role="alert" className="mt-2 text-xs text-danger">{t("providerLogin.logoutError")}</p>}
  </div>;
}
