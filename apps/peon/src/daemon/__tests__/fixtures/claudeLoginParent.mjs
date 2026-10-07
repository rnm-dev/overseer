import { ClaudeLoginService } from "../../agents/claudeLogin.ts";
const service = new ClaudeLoginService({ command: () => process.argv[2] });
service.start("test-owner");
