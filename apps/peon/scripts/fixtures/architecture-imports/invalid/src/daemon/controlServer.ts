import { createProjectService } from "./projects/service.js";
import { projectCatalog } from "./projectCatalog.js";

const projects = createProjectService();
const catalog = projectCatalog;

void projects;
void catalog;
