import { useState } from "react";
import { Languages, Volume2, VolumeX } from "lucide-react";
import { useAuth } from "../auth";
import { LOCALES, useI18n } from "../i18n";
import { selectedSoundPack, setSelectedSoundPack, SOUND_PACKS, type SoundPack } from "../peonSounds";
import { GithubMark } from "../ui";

// author: Viktor
// Account panel, shown as the final in-flow block on the fleet dashboard.
export const HOME_USER_CARD_CLASS = "surface user-box w-full overflow-hidden";
export const HOME_USER_TITLE_CLASS = "truncate px-5 py-5 font-display text-lg font-bold tracking-[0.06em] text-fel-bright drop-shadow-[0_0_8px_rgba(134,171,99,0.18)]";
export const HOME_USER_ITEMS_CLASS = "space-y-3 px-4 pb-4";
export const HOME_USER_ITEM_CLASS = "on-surface flex min-h-12 items-center justify-between gap-4 rounded-lg px-4 py-3";
export const HOME_USER_LABEL_CLASS = "min-w-0 truncate font-display text-sm font-semibold text-bone";
export const HOME_USER_VALUE_CLASS = "font-mono text-xs text-bone-dim";
export const HOME_USER_SELECT_CLASS = `min-w-0 max-w-48 cursor-pointer border-0 bg-transparent p-0 text-right outline-none focus-visible:text-bone focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-fel ${HOME_USER_VALUE_CLASS}`;
export const HOME_USER_SIGN_OUT_CLASS = `${HOME_USER_ITEM_CLASS} group w-full text-left transition-colors hover:bg-blood/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blood/60`;

export function UserBox() {
  const { user, logout } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const [soundPack, setSoundPack] = useState(selectedSoundPack);

  const chooseSoundPack = (pack: SoundPack) => {
    setSoundPack(pack);
    setSelectedSoundPack(pack);
  };

  return (
    <section className={HOME_USER_CARD_CLASS}>
      <h2 className={HOME_USER_TITLE_CLASS}>{t("user.settings")}</h2>
      <div className={HOME_USER_ITEMS_CLASS}>
        <div className={HOME_USER_ITEM_CLASS}>
          <div className="flex items-center gap-2 text-bone-dim" title={t("user.peonSounds")}>
            {soundPack === "none" ? <VolumeX size={16} aria-hidden /> : <Volume2 size={16} aria-hidden />}
            <span className={HOME_USER_LABEL_CLASS}>{t("user.peonSounds")}</span>
          </div>
          <select
            aria-label={t("user.peonSounds")}
            value={soundPack}
            onChange={(event) => chooseSoundPack(event.target.value as SoundPack)}
            className={HOME_USER_SELECT_CLASS}
          >
            {SOUND_PACKS.map((pack) => (
              <option key={pack.id} value={pack.id}>{pack.id === "none" ? t("user.noSound") : pack.label}</option>
            ))}
          </select>
        </div>

        <div className={HOME_USER_ITEM_CLASS}>
          <div className="flex items-center gap-2 text-bone-dim">
            <Languages size={16} aria-hidden />
            <span className={HOME_USER_LABEL_CLASS}>{t("user.language")}</span>
          </div>
          <select
            aria-label={t("user.language")}
            value={locale}
            onChange={(event) => setLocale(event.target.value as typeof locale)}
            className={HOME_USER_SELECT_CLASS}
          >
            {LOCALES.map((option) => (
              <option key={option.code} value={option.code}>{option.label}</option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className={HOME_USER_SIGN_OUT_CLASS}
          onClick={() => logout()}
        >
          <span className="flex min-w-0 items-center gap-2 text-bone-dim transition-colors group-hover:text-blood/85">
            <GithubMark size={16} />
            <span className={`${HOME_USER_LABEL_CLASS} transition-colors group-hover:text-blood/85`} title={user?.email}>{user?.email}</span>
          </span>
          <span className={`${HOME_USER_VALUE_CLASS} shrink-0 transition-colors group-hover:text-blood`}>{t("action.signOut")}</span>
        </button>
      </div>
    </section>
  );
}
