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
    }
  }

  onClose(conn) {
    this.room.broadcast(JSON.stringify({ type: "peer-leave", id: conn.id }));
  }
}
