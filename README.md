# VR Lounge

A no-install WebXR lounge for Meta Quest 3. You and a friend open a URL, tap
**Enter VR**, and spawn around a shared origin. Everyone else shows up as a
capsule body with sphere hands. Push to GitHub → Vercel redeploys → connected
headsets auto-reload onto the new version.

- **Rendering / VR:** [Three.js](https://threejs.org) + the browser WebXR API
- **Multiplayer:** [PartyKit](https://partykit.io) (WebSocket rooms, free tier)
- **Static hosting:** Vercel (auto-deploys on git push)

The site (Vercel) and the realtime server (PartyKit) deploy **separately**.
Vercel can't hold persistent WebSocket connections, so presence lives on PartyKit.

## Local dev

```bash
npm install

# terminal 1 — realtime server on http://127.0.0.1:1999
npm run party:dev

# terminal 2 — site on http://localhost:5173
npm run dev
```

> WebXR requires HTTPS, so you can't enter VR from a plain `http://<lan-ip>:5173`
> on the headset. Easiest path is to deploy (below) and open the Vercel URL on
> the Quest. For local headset testing, put the dev server behind an HTTPS tunnel
> (e.g. `cloudflared tunnel`/`ngrok`) and load that URL.

## Deploy

### 1. PartyKit (realtime server)

```bash
npx partykit deploy
```

This prints a host like `vrworld-lounge.<your-username>.partykit.dev`. Copy it.

### 2. Vercel (the site)

Import the GitHub repo in Vercel (it auto-detects Vite). Add one env var:

```
VITE_PARTYKIT_HOST = vrworld-lounge.<your-username>.partykit.dev
```

Redeploy. Open the Vercel URL on both Quest 3 headsets, tap **Enter VR**, done.

## How "live reload on deploy" works

Each build is stamped with a `__BUILD_ID__` (a timestamp). On connect, a client
tells the PartyKit server its build. When a newer build connects, the server
sends every older client a `reload` message and they refresh — so pushing to
GitHub propagates to anyone currently connected. (In VR this drops them out of
the session momentarily, which is unavoidable when swapping the running code.)

## Controls

**In VR:** tap *Enter VR*; your head and controllers drive your avatar.
- **Left thumbstick** — glide (relative to where you look); **right thumbstick** — snap-turn
- **No controllers?** With hand tracking, **pinch and hold** to glide forward where you're looking (turn physically). Auto-enabled whenever no thumbstick is detected.

**On desktop (no headset):**
- **Drag** the mouse to look around
- **WASD** to walk (movement is relative to where you're looking)

**Voice (both):** click **🎤 Enable voice** and grant mic access. Voice is
spatial — each peer's audio comes from their avatar's position. On the headset,
click *Enable voice* before tapping *Enter VR* so the mic prompt is handled on
the flat page first.

> Voice uses a WebRTC mesh signalled through PartyKit, with a public STUN server
> only (no TURN). That connects across most home networks; if two peers are
> behind strict/symmetric NATs it may fail to connect — add a TURN server if you
> hit that.

## What to build next

- Assign per-peer spawn offsets so you don't start overlapping the origin
- Grabbable objects with authoritative ownership
- Snap-turn / teleport locomotion for VR
- Mute button + a "who's talking" indicator
