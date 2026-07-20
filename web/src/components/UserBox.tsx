import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { useAuth } from "../auth";
import { Button, LocaleSwitcher } from "../ui";
import { useT } from "../i18n";
import { selectedSoundPack, setSelectedSoundPack, SOUND_PACKS, type SoundPack } from "../peonSounds";

// author: Viktor
// Account panel, shown as the final in-flow block on the fleet dashboard.
export function UserBox() {
  const { user, logout } = useAuth();
  const t = useT();
  const [soundPack, setSoundPack] = useState(selectedSoundPack);

  const chooseSoundPack = (pack: SoundPack) => {
    setSoundPack(pack);
    setSelectedSoundPack(pack);
  };

  return (
    <div className="user-box mx-auto mb-3 mt-6 w-64 space-y-2.5 rounded-lg border border-iron-800 bg-iron-950/85 px-3 py-3 shadow-lg backdrop-blur">
      <div className="truncate px-0.5 font-mono text-[0.7rem] text-bone-dim" title={user?.email}>
        {user?.email}
      </div>
      <div className="flex items-center justify-between gap-3 border-y border-iron-800/80 py-2">
        <div className="flex-none text-bone-dim" title={t("user.peonSounds")}>
          {soundPack === "none" ? <VolumeX size={15} aria-hidden /> : <Volume2 size={15} aria-hidden />}
        </div>
        <select
          aria-label={t("user.peonSounds")}
          value={soundPack}
          onChange={(event) => chooseSoundPack(event.target.value as SoundPack)}
          className="min-w-0 max-w-44 cursor-pointer border-0 bg-transparent p-0 text-right font-mono text-[0.7rem] text-bone-dim outline-none focus-visible:text-bone focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-fel"
        >
          {SOUND_PACKS.map((pack) => (
            <option key={pack.id} value={pack.id}>{pack.id === "none" ? t("user.noSound") : pack.label}</option>
          ))}
        </select>
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
