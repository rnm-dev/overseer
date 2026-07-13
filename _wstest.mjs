import { WebSocket } from "ws";
const TOKEN = process.env.WT;
const WS_ID = "def74479-eaa2-483a-a608-1b7774e135e3";
const ws = new WebSocket(`ws://127.0.0.1:5000/api/ws?token=${TOKEN}`);
const seen = [];
let cursor = 0, gotSnapshot = false, gotSync = false, resumeOk = false;
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", workspaceId: WS_ID, cursor: 0 })));
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  seen.push(m.type);
  if (m.type === "snapshot") { gotSnapshot = true; cursor = m.cursor || 0;
    // exercise resume immediately (replay from 0; may be empty — just must not crash/close)
    ws.send(JSON.stringify({ type: "resume", cursor: 0 })); resumeOk = true; }
  if (m.type === "sync") { gotSync = true; }
});
ws.on("close", (c) => { if (c === 4401) { console.log("REJECTED_4401 (unexpected — token bad)"); process.exit(3);} });
ws.on("error", (e) => { console.log("WS_ERROR", e.message); process.exit(2); });
setTimeout(() => {
  console.log("types:", JSON.stringify(seen.slice(0,8)), seen.length>8?`(+${seen.length-8})`:"");
  console.log("snapshot:", gotSnapshot, "resume_sent:", resumeOk, "sync_recv:", gotSync, "cursor:", cursor);
  console.log(gotSnapshot && gotSync ? "PASS" : "FAIL");
  ws.close(); process.exit(0);
}, 17000);
