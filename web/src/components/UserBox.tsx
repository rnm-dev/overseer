import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { useAuth } from "../auth";
import { Button, LocaleSwitcher } from "../ui";
import { useT } from "../i18n";
import { peonSoundsEnabled, setPeonSoundsEnabled } from "../peonSounds";

// author: Viktor
// Floating account panel, shown only on the fleet dashboard by AppLayout.
export function UserBox() {
  const { user, logout } = useAuth();
  const t = useT();
  const [soundsEnabled, setSoundsEnabled] = useState(peonSoundsEnabled);

  const toggleSounds = () => {
    const next = !soundsEnabled;
    setSoundsEnabled(next);
    setPeonSoundsEnabled(next);
  };

  return (
    <div className="user-box fixed bottom-3 left-3 z-40 w-64 space-y-2.5 rounded-lg border border-iron-800 bg-iron-950/85 px-3 py-3 shadow-lg backdrop-blur">
      <div className="truncate px-0.5 font-mono text-[0.7rem] text-bone-dim" title={user?.email}>
        {user?.email}
      </div>
      <div className="flex items-center justify-between gap-3 border-y border-iron-800/80 py-2">
        <div className="flex min-w-0 items-center gap-2 text-bone-dim">
          {soundsEnabled ? <Volume2 size={15} aria-hidden /> : <VolumeX size={15} aria-hidden />}
          <span className="font-display text-xs font-semibold">{t("user.peonSounds")}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={soundsEnabled}
          aria-label={t("user.peonSounds")}
          onClick={toggleSounds}
          className={`flex h-6 w-11 flex-none items-center rounded border p-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fel ${soundsEnabled ? "justify-end border-fel/50 bg-fel/10" : "justify-start border-iron-600 bg-iron-900"}`}
        >
          <span className={`block size-4 rounded-[2px] transition-colors ${soundsEnabled ? "bg-fel-bright shadow-[0_0_7px_rgba(132,204,22,0.28)]" : "bg-iron-500"}`} />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <LocaleSwitcher />
        <Button variant="iron" size="sm" onClick={() => logout()}>
          {t("action.signOut")}
        </Button>
      </div>
    </div>
  );
}
