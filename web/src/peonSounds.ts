export type PeonSound = "start" | "stop" | "complete";

export type SoundPack = "none" | "peon" | "peasant" | "dota2_axe" | "sc_scv";
type SoundPool = readonly [string, ...string[]];

export const SOUND_PACKS: readonly { id: SoundPack; label: string }[] = [
  { id: "peon", label: "Peon" },
  { id: "peasant", label: "Peasant (Warcraft III)" },
  { id: "none", label: "No sound" },
  { id: "dota2_axe", label: "Axe (Dota 2)" },
  { id: "sc_scv", label: "StarCraft SCV" },
];

export const SOUND_PACK_PATHS: Record<Exclude<SoundPack, "none">, Record<PeonSound, SoundPool>> = {
  peon: {
    start: ["/sounds/peon/work-start.wav", "/sounds/peon/work-start-2.wav"],
    stop: ["/sounds/peon/work-stop.wav", "/sounds/peon/work-stop-2.wav"],
    complete: ["/sounds/peon/work-complete.wav", "/sounds/peon/work-start.wav"],
  },
  peasant: {
    start: ["/sounds/peasant/work-start.wav", "/sounds/peasant/work-start-2.wav"],
    stop: ["/sounds/peasant/work-stop.wav", "/sounds/peasant/work-stop-2.wav"],
    complete: ["/sounds/peasant/work-complete.wav", "/sounds/peasant/work-complete-2.wav"],
  },
  dota2_axe: {
    start: ["/sounds/dota2_axe/work-start.mp3", "/sounds/dota2_axe/work-start-2.mp3"],
    stop: ["/sounds/dota2_axe/work-stop.mp3", "/sounds/dota2_axe/work-stop-2.mp3"],
    complete: ["/sounds/dota2_axe/work-complete.mp3", "/sounds/dota2_axe/work-complete-2.mp3"],
  },
  sc_scv: {
    start: ["/sounds/sc_scv/work-start.mp3", "/sounds/sc_scv/work-start-2.mp3"],
    stop: ["/sounds/sc_scv/work-stop.mp3", "/sounds/sc_scv/work-stop-2.mp3"],
    complete: ["/sounds/sc_scv/work-complete.mp3", "/sounds/sc_scv/work-complete-2.mp3"],
  },
};

export const SOUND_PACK_STORAGE_KEY = "overseer.sound-pack";
export const LEGACY_PEON_SOUNDS_STORAGE_KEY = "overseer.peon-sounds-enabled";

interface SoundPreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function browserStorage(): SoundPreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isSoundPack(value: string | null): value is SoundPack {
  return SOUND_PACKS.some((pack) => pack.id === value);
}

export function selectedSoundPack(storage: SoundPreferenceStorage | null = browserStorage()): SoundPack {
  try {
    const selected = storage?.getItem(SOUND_PACK_STORAGE_KEY) ?? null;
    if (isSoundPack(selected)) return selected;
    return storage?.getItem(LEGACY_PEON_SOUNDS_STORAGE_KEY) === "false" ? "none" : "peon";
  } catch {
    return "peon";
  }
}

export function setSelectedSoundPack(pack: SoundPack, storage: SoundPreferenceStorage | null = browserStorage()): void {
  try {
    storage?.setItem(SOUND_PACK_STORAGE_KEY, pack);
    storage?.setItem(LEGACY_PEON_SOUNDS_STORAGE_KEY, String(pack !== "none"));
  } catch {
    // A private/restricted browser may deny storage; keep the UI usable.
  }
}

interface AudioPlayer {
  currentTime: number;
  preload: string;
  play: () => Promise<unknown> | void;
}

type CreateAudio = (src: string) => AudioPlayer;

export function createPeonSoundPlayer(
  createAudio: CreateAudio,
  selectedPack: () => SoundPack = selectedSoundPack,
  random: () => number = Math.random,
) {
  const players = new Map<string, AudioPlayer>();

  return (sound: PeonSound) => {
    const pack = selectedPack();
    if (pack === "none") return;
    try {
      const candidates = SOUND_PACK_PATHS[pack][sound];
      const src = candidates[Math.floor(random() * candidates.length)] ?? candidates[0];
      let player = players.get(src);
      if (!player) {
        player = createAudio(src);
        player.preload = "auto";
        players.set(src, player);
      }
      player.currentTime = 0;
      const playback = player.play();
      if (playback && typeof playback.catch === "function") void playback.catch(() => {});
    } catch {
      // Audio is an enhancement. Browser autoplay/device failures must never
      // turn a successful session action into a visible application error.
    }
  };
}

export const playPeonSound = createPeonSoundPlayer((src) => new Audio(src));

export function isSuccessfulRunResult(event: { type?: string; is_error?: boolean }): boolean {
  return event.type === "result" && event.is_error !== true;
}
