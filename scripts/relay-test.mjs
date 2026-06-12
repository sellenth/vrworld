// Headless functional test: two clients join the lounge room, one sends a pose,
// the other must receive it (proves the PartyKit relay works end-to-end).
import PartySocket from "partysocket";

const host = process.env.VITE_PARTYKIT_HOST || "vrworld-lounge.sellenth.partykit.dev";
const a = new PartySocket({ host, room: "lounge" });
const b = new PartySocket({ host, room: "lounge" });

let aId = null;
let gotPose = false;

a.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "welcome") aId = m.id;
});

b.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "pose") {
    gotPose = true;
    console.log(`B received pose from ${m.id} head=${JSON.stringify(m.head.p)}`);
  }
});

a.addEventListener("open", () => a.send(JSON.stringify({ type: "hello", build: "1" })));
b.addEventListener("open", () => {
  b.send(JSON.stringify({ type: "hello", build: "1" }));
  setTimeout(() => {
    a.send(JSON.stringify({ type: "pose", head: { p: [1, 1.6, 2], q: [0, 0, 0, 1] }, left: null, right: null }));
  }, 600);
});

setTimeout(() => {
  console.log(gotPose ? "PASS: relay works" : "FAIL: no pose received");
  process.exit(gotPose ? 0 : 1);
}, 5000);
