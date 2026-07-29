import { settings } from "../settings/index.js";
import { listSessions } from "../sessions/index.js";

export function overview() {
  return {
    paused: settings.get().paused,
    sessions: listSessions(),
  };
}
