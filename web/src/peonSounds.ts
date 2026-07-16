export type PeonSound = "start" | "stop" | "complete";

export const PEON_SOUND_PATHS: Record<PeonSound, string> = {
  start: "/sounds/peon/work-start.wav",
  stop: "/sounds/peon/work-stop.wav",
  complete: "/sounds/peon/work-complete.wav",
};

export const PEON_SOUNDS_STORAGE_KEY = "overseer.peon-sounds-enabled";

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

export function peonSoundsEnabled(storage: SoundPreferenceStorage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(PEON_SOUNDS_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setPeonSoundsEnabled(enabled: boolean, storage: SoundPreferenceStorage | null = browserStorage()): void {
  try {
    storage?.setItem(PEON_SOUNDS_STORAGE_KEY, String(enabled));
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

export function createPeonSoundPlayer(createAudio: CreateAudio, enabled: () => boolean = peonSoundsEnabled) {
  const players = new Map<PeonSound, AudioPlayer>();

  return (sound: PeonSound) => {
    if (!enabled()) return;
    try {
      let player = players.get(sound);
      if (!player) {
        player = createAudio(PEON_SOUND_PATHS[sound]);
        player.preload = "auto";
        players.set(sound, player);
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
