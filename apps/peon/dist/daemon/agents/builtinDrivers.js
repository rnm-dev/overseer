import { claudeCodeDriver } from "./claudeCodeDriver.js";
import { codexAppServerDriver } from "./codexAppServerDriver.js";
import { registerAgentDriver } from "./registry.js";
// The one place that names the harnesses Peon ships with. Adding a harness is
// a new driver module plus a line here; nothing else in Peon should change.
registerAgentDriver(claudeCodeDriver);
registerAgentDriver(codexAppServerDriver);
