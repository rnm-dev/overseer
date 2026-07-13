import { WebSocket } from "ws";
const ws = new WebSocket(`ws://127.0.0.1:5000/api/ws?token=${process.env.WT}`);
const WS_ID = "def74479-eaa2-483a-a608-1b7774e135e3";
const LOW = Number(process.env.LOW);
let replay = 0, done = false;
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", workspaceId: WS_ID, cursor: 0 })));
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "snapshot") { ws.send(JSON.stringify({ type: "resume", cursor: LOW })); done = true; setTimeout(finish, 1500); }
  else if (done && (m.type === "session" || m.type === "peon")) replay++;
});
function finish(){ console.log("replayed frames after resume:", replay); console.log(replay>0?"PASS_REPLAY":"NO_EVENTS_TO_REPLAY"); ws.close(); process.exit(0);}
ws.on("error", e => { console.log("ERR", e.message); process.exit(2); });
setTimeout(finish, 8000);
