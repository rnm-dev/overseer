import type { ProjectRecord } from "./contracts.js";

export const createProjectService = () => ({
  list(): ProjectRecord[] {
    return [];
  },
});
