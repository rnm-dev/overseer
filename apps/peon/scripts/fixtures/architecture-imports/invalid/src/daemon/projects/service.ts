import type { ProjectRecord } from "./contracts.js";
import { legacyProjectLabel } from "./utils/legacyUtils.js";

export const createProjectService = () => ({
  list(): ProjectRecord[] {
    return [];
  },
});

export const label = legacyProjectLabel();
