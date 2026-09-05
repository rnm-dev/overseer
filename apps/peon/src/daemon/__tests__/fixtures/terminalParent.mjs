import { startTerminal } from "../../agents/terminalHarness.ts";
startTerminal({
  command: process.execPath,
  args: ["-e", `
    const {spawn} = require('node:child_process');
    process.on('SIGTERM', () => {});
    const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);'], {stdio:'ignore'});
    process.stdout.write(JSON.stringify({child:process.pid,grandchild:grandchild.pid})+'\\n');
    setInterval(()=>{},1000);
  `],
  onData: (text) => process.stdout.write(text),
  onExit: () => {},
});
