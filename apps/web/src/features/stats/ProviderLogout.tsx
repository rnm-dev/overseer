import { useState } from "react";
import { api, json } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { ConfirmationDialog } from "../../shared/ui";
import type { Provider } from "./statsModel";

/** Confirms and performs a provider logout; stays open with the error if it fails. */
export function ProviderLogoutDialog({ base, provider, onSuccess, onClose }: { base: string; provider: Provider; onSuccess: () => void; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const providerName = t(`peon.quota.provider.${provider}`);
  async function logout() {
    setBusy(true); setError(false);
    try {
      await api(`${base}/driver/${provider}/logout`, json({}));
      onClose();
      onSuccess();
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return (
    <ConfirmationDialog
      title={t("providerLogin.logoutConfirmTitle", { provider: providerName })}
      description={<>
        {t("providerLogin.logoutConfirmBody", { provider: providerName })}
        {error && <span role="alert" className="mt-2 block text-danger">{t("providerLogin.logoutError")}</span>}
      </>}
      confirmLabel={t("providerLogin.logout")}
      pendingLabel={t("providerLogin.loggingOut")}
      pending={busy}
      onConfirm={() => void logout()}
      onClose={() => { if (!busy) onClose(); }}
    />
  );
}
