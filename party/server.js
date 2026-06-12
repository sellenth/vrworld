// PartyKit room server for the VR lounge.
// Relays pose updates between peers and coordinates live-reload on deploy.
// State is intentionally ephemeral — when the room empties it hibernates and
// resets, which is exactly what we want (avatar poses are transient).
export default class Lounge {
  constructor(room) {
    this.room = room;
    this.maxBuild = 0; // highest client build seen this session
  }

  onConnect(conn) {
    conn.send(JSON.stringify({ type: "welcome", id: conn.id }));
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
}
