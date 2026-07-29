export {
  PROJECT_DOCS_DIR,
  PROJECT_DOCS_INDEX,
  type ProjectDocumentation,
  type ProjectDocDirectory,
  type ProjectDocFile,
  type ProjectDocNode,
  type ProjectDocPage,
  ProjectDocsError,
  projectDocumentation,
  readProjectDoc,
} from "./docs.js";

export { listProjectSkills, type ProjectSkillView } from "./skills.js";

export {
  catalogProject,
  projectStore,
  type ProjectCatalogEvent,
  type ProjectCatalogProject,
  type ProjectCatalogState,
  type ProjectRecord,
  type ProjectQuickLink,
  ProjectStore,
} from "./state.js";

export {
  PROJECT_CATALOG_CAPABILITY,
  MAX_PROJECT_CATALOG_PAGE_LIMIT,
  DEFAULT_PROJECT_CATALOG_PAGE_LIMIT,
  MAX_PROJECT_CATALOG_PAGE_BYTES,
  MAX_PROJECT_CATALOG_SNAPSHOT_BYTES,
  MAX_PROJECT_CATALOG_SNAPSHOT_ROWS,
  PROJECT_CATALOG_SNAPSHOT_TTL_MS,
  ProjectCatalog,
  ProjectCatalogError,
  type ProjectCatalogPage,
  projectCatalog,
} from "./catalog.js";

export {
  PROJECT_ONBOARDING_PROMPT,
  MAX_PROJECT_QUICK_LINKS,
  MAX_PROJECT_QUICK_LINKS_BYTES,
  MAX_PROJECT_QUICK_LINK_TITLE_LENGTH,
  MAX_PROJECT_QUICK_LINK_URL_LENGTH,
  ProjectServiceError,
  ProjectService,
  type ProjectCreationView,
  type ProjectSettingsView,
  type ProjectListView,
  type ProjectServiceErrorKind,
} from "./service.js";
export { createProjectService } from "./service.js";
