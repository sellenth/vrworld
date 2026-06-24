// Headless functional test: two clients join the lounge, one submits a text
// prompt, and BOTH must receive a "model" broadcast with a GLB url (proves the
// server-side fal/Tripo generation + broadcast works end-to-end). Run against a
// local `partykit dev` (default) so it uses the .env FAL_KEY:
//   VITE_PARTYKIT_HOST=127.0.0.1:1999 node scripts/gen-test.mjs
import PartySocket from "partysocket";

const host = process.env.VITE_PARTYKIT_HOST || "127.0.0.1:1999";
const a = new PartySocket({ host, room: "lounge" });
const b = new PartySocket({ host, room: "lounge" });

let modelUrl = null;

for (const [name, sock] of [["A", a], ["B", b]]) {
  sock.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "gen-status") console.log(`${name} status: ${m.state}${m.error ? " — " + m.error : ""}`);
    if (m.type === "model") {
      console.log(`${name} received model: ${m.url}`);
      if (name === "B") modelUrl = m.url; // B is the peer — proves broadcast, not echo
    }
  });
}

a.addEventListener("open", () => a.send(JSON.stringify({ type: "hello", build: "1" })));
b.addEventListener("open", () => {
  b.send(JSON.stringify({ type: "hello", build: "1" }));
  setTimeout(() => {
    console.log("A submitting prompt…");
    a.send(JSON.stringify({ type: "generate", prompt: "a small blue ceramic teapot" }));
  }, 600);
});

// Tripo takes ~30–90s; give it 4 minutes.
setTimeout(() => {
  const ok = modelUrl && modelUrl.endsWith(".glb");
  console.log(ok ? "PASS: peer received generated model" : "FAIL: no model broadcast received");
  process.exit(ok ? 0 : 1);
}, 240000);
