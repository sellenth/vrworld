// PartyKit room server for the VR lounge.
// Relays pose updates between peers and coordinates live-reload on deploy.
// Avatar poses are transient and reset when the room empties, but the most
// recently generated model is remembered so late joiners see it at the origin.
const FAL_ENDPOINT = "https://queue.fal.run/tripo3d/tripo/v2.5/text-to-3d";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default class Lounge {
  constructor(room) {
    this.room = room;
    this.maxBuild = 0; // highest client build seen this session
    this.generating = false; // one fal job at a time per room
    this.lastModel = null; // { url, prompt, by } of the current world model
  }

  onConnect(conn) {
    conn.send(JSON.stringify({ type: "welcome", id: conn.id }));
    // Show the current world model to whoever just walked in.
    if (this.lastModel) conn.send(JSON.stringify({ type: "model", ...this.lastModel }));
    this.room.broadcast(JSON.stringify({ type: "peer-join", id: conn.id }), [conn.id]);
  }

  onMessage(raw, sender) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (m.type === "hello") {
      const build = Number(m.build) || 0;
      if (build > this.maxBuild) {
        // A newer deploy just connected — tell everyone else to refresh.
        this.maxBuild = build;
        for (const c of this.room.getConnections()) {
          if (c.id !== sender.id) c.send(JSON.stringify({ type: "reload" }));
        }
      } else if (build < this.maxBuild) {
        // This client is stale relative to others — refresh it.
        sender.send(JSON.stringify({ type: "reload" }));
      }
      return;
    }

    if (m.type === "pose") {
      m.id = sender.id;
      this.room.broadcast(JSON.stringify(m), [sender.id]);
      return;
    }

    // --- Text-to-3D generation (fal.ai / Tripo) -----------------------------
    // A player submits a prompt; we run the fal job server-side (so the API key
    // never reaches the browser) and broadcast the resulting GLB to everyone.
    if (m.type === "generate") {
      this.handleGenerate(m, sender);
      return;
    }

    // --- Voice (WebRTC) signaling -------------------------------------------
    // voice-on: broadcast "I have a mic". voice-ack: direct reply so the
    // lower-id peer knows to initiate. rtc: relay offer/answer/ICE to one peer.
    if (m.type === "voice-on") {
      this.room.broadcast(JSON.stringify({ type: "voice-on", id: sender.id }), [sender.id]);
      return;
    }
    if (m.type === "voice-ack") {
      const c = this.room.getConnection(m.to);
      if (c) c.send(JSON.stringify({ type: "voice-ack", id: sender.id }));
      return;
    }
    if (m.type === "rtc") {
      const c = this.room.getConnection(m.to);
      if (c) c.send(JSON.stringify({ type: "rtc", from: sender.id, kind: m.kind, data: m.data }));
      return;
    }
  }

  onClose(conn) {
    this.room.broadcast(JSON.stringify({ type: "peer-leave", id: conn.id }));
  }

  // Submit a Tripo text-to-3D job to fal's queue, poll until done, then push
  // the model URL to every connected peer. Status updates stream out as we go.
  async handleGenerate(m, sender) {
    const prompt = String(m.prompt || "").trim().slice(0, 1024);
    if (!prompt) return;
    if (this.generating) {
      sender.send(JSON.stringify({ type: "gen-status", state: "busy" }));
      return;
    }
    const key = this.room.env.FAL_KEY;
    if (!key) {
      sender.send(JSON.stringify({ type: "gen-status", state: "error", error: "Server is missing FAL_KEY" }));
      return;
    }

    this.generating = true;
    const auth = { Authorization: `Key ${key}` };
    this.room.broadcast(JSON.stringify({ type: "gen-status", state: "submitting", prompt, by: sender.id }));

    try {
      const submit = await fetch(FAL_ENDPOINT, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, texture: "standard" }),
      });
      if (!submit.ok) throw new Error(`submit failed (${submit.status})`);
      const { status_url, response_url } = await submit.json();

      let result = null;
      // Poll up to ~5 minutes (Tripo usually finishes in 30–90s).
      for (let i = 0; i < 150; i++) {
        await sleep(2000);
        const s = await fetch(status_url, { headers: auth });
        const sj = await s.json();
        if (sj.status === "COMPLETED") {
          const r = await fetch(response_url, { headers: auth });
          result = await r.json();
          break;
        }
        if (sj.status === "FAILED" || sj.status === "ERROR") throw new Error("generation failed");
        if (i % 3 === 0) {
          this.room.broadcast(JSON.stringify({ type: "gen-status", state: "working", prompt, by: sender.id }));
        }
      }

      const url = result?.model_mesh?.url;
      if (!url) throw new Error("no model returned");
      this.lastModel = { url, prompt, by: sender.id };
      this.room.broadcast(JSON.stringify({ type: "model", url, prompt, by: sender.id }));
    } catch (err) {
      this.room.broadcast(JSON.stringify({ type: "gen-status", state: "error", error: String(err.message || err).slice(0, 200) }));
    } finally {
      this.generating = false;
    }
  }
}
