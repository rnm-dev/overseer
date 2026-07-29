import type { DaemonSettings } from "./settingsTypes.js";

export const settings = {
  get(): DaemonSettings {
    return { paused: false };
  },
};
