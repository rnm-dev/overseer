import { filesApi } from "../files/index.js";
import { settings } from "../settings/index.js";

void filesApi;

export function listSessions() {
  return {
    active: settings.get().paused,
  };
}
