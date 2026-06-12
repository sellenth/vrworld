// Headless test for the voice SIGNALING relay (not the media itself — node has
// no WebRTC). Verifies the PartyKit server: broadcasts voice-on, routes
// voice-ack to a specific peer, and relays rtc offers point-to-point.
import PartySocket from "partysocket";

const host = process.env.VITE_PARTYKIT_HOST || "vrworld-lounge.sellenth.partykit.dev";
const a = new PartySocket({ host, room: "lounge" });
const b = new PartySocket({ host, room: "lounge" });

let aId = null;
let bId = null;
const got = { voiceOn: false, ack: false, rtc: false };

a.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "welcome") aId = m.id;
  if (m.type === "voice-ack") got.ack = true;
  if (m.type === "rtc" && m.kind === "offer") got.rtc = true;
});
b.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "welcome") bId = m.id;
  if (m.type === "voice-on") {
    got.voiceOn = true;
    // B acks A and sends a fake offer directly to A
    b.send(JSON.stringify({ type: "voice-ack", to: m.id }));
    b.send(JSON.stringify({ type: "rtc", to: m.id, kind: "offer", data: { sdp: "fake" } }));
  }
});

a.addEventListener("open", () => a.send(JSON.stringify({ type: "hello", build: "1" })));
b.addEventListener("open", () => {
  b.send(JSON.stringify({ type: "hello", build: "1" }));
  setTimeout(() => a.send(JSON.stringify({ type: "voice-on" })), 600);
});

setTimeout(() => {
  const pass = got.voiceOn && got.ack && got.rtc;
  console.log(`voice-on broadcast: ${got.voiceOn}, ack routed: ${got.ack}, rtc relayed: ${got.rtc}`);
  console.log(pass ? "PASS: voice signaling relay works" : "FAIL");
  process.exit(pass ? 0 : 1);
}, 5000);
