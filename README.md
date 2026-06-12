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

## What to build next

- Assign per-peer spawn offsets so you don't start overlapping the origin
- Voice chat (WebRTC, or PartyKit-brokered)
- Grabbable objects with authoritative ownership
- Snap-turn / teleport locomotion to move around the lounge
