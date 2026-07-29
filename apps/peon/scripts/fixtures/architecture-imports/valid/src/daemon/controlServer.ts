import { createProjectService } from "./projects/index.js";
import { listSessions } from "./sessions/index.js";

const projects = createProjectService();
const sessions = listSessions();

void projects;
void sessions;
