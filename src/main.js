import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import PartySocket from "partysocket";

/* global __BUILD_ID__ */
const BUILD_ID = __BUILD_ID__;

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f1a);
scene.fog = new THREE.Fog(0x0b0f1a, 12, 45);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.6, 1.5);

// Spatial-audio listener. Kept on the scene and driven each frame from the
// active head pose so it tracks the headset in VR and the camera on desktop.
const listener = new THREE.AudioListener();
scene.add(listener);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Desktop mouse-look (ignored in XR — the headset drives the camera there).
// Click-drag to look around; the resulting head pose is what peers see.
// ---------------------------------------------------------------------------
const _camEuler = new THREE.Euler(0, 0, 0, "YXZ");
let dragging = false;
let prevX = 0;
let prevY = 0;
let lookYaw = 0; // 0 = looking down -Z, toward the origin from our spawn
let lookPitch = 0;
const LOOK_SPEED = 0.0025;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

renderer.domElement.style.cursor = "grab";
renderer.domElement.addEventListener("mousedown", (e) => {
  if (renderer.xr.isPresenting) return;
  dragging = true;
  prevX = e.clientX;
  prevY = e.clientY;
  renderer.domElement.style.cursor = "grabbing";
});
window.addEventListener("mouseup", () => {
  dragging = false;
  renderer.domElement.style.cursor = "grab";
});
window.addEventListener("mousemove", (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  lookYaw -= (e.clientX - prevX) * LOOK_SPEED;
  lookPitch -= (e.clientY - prevY) * LOOK_SPEED;
  lookPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, lookPitch));
  prevX = e.clientX;
  prevY = e.clientY;
});

// WASD walking (desktop only). Movement is relative to where you're looking.
const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.code));
window.addEventListener("keyup", (e) => keys.delete(e.code));
const MOVE_SPEED = 2.2; // metres/sec
const FLOOR_RADIUS = 11;

function moveDesktop(dt) {
  const fwd = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const strafe = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  if (!fwd && !strafe) return;
  const s = Math.sin(lookYaw);
  const c = Math.cos(lookYaw);
  // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
  camera.position.x += (fwd * -s + strafe * c) * MOVE_SPEED * dt;
  camera.position.z += (fwd * -c + strafe * -s) * MOVE_SPEED * dt;
  const r = Math.hypot(camera.position.x, camera.position.z);
  if (r > FLOOR_RADIUS) {
    camera.position.x *= FLOOR_RADIUS / r;
    camera.position.z *= FLOOR_RADIUS / r;
  }
}

// ---------------------------------------------------------------------------
// Environment: floor, grid, spawn origin
// ---------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a2030, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(4, 10, 2);
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(12, 48),
  new THREE.MeshStandardMaterial({ color: 0x161d33, roughness: 0.95 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

scene.add(new THREE.GridHelper(24, 24, 0x3a4a7a, 0x223052));

const originRing = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.4, 40),
  new THREE.MeshBasicMaterial({ color: 0x89b4fa, side: THREE.DoubleSide })
);
originRing.rotation.x = -Math.PI / 2;
originRing.position.y = 0.011;
scene.add(originRing);

// ---------------------------------------------------------------------------
// Local player: controller grips + own hand spheres
// ---------------------------------------------------------------------------
const ownHandGeo = new THREE.SphereGeometry(0.05, 16, 12);
const ownHandMat = new THREE.MeshStandardMaterial({ color: 0xe6edf7, roughness: 0.4 });

const gripL = renderer.xr.getControllerGrip(0);
const gripR = renderer.xr.getControllerGrip(1);
gripL.add(new THREE.Mesh(ownHandGeo, ownHandMat));
gripR.add(new THREE.Mesh(ownHandGeo, ownHandMat));
scene.add(gripL, gripR);

let leftLive = false;
let rightLive = false;
const ctrl0 = renderer.xr.getController(0);
const ctrl1 = renderer.xr.getController(1);
ctrl0.addEventListener("connected", () => (leftLive = true));
ctrl0.addEventListener("disconnected", () => (leftLive = false));
ctrl1.addEventListener("connected", () => (rightLive = true));
ctrl1.addEventListener("disconnected", () => (rightLive = false));
scene.add(ctrl0, ctrl1);

// ---------------------------------------------------------------------------
// Pose helpers
// ---------------------------------------------------------------------------
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

function worldPose(obj) {
  obj.getWorldPosition(_p);
  obj.getWorldQuaternion(_q);
  return { p: [_p.x, _p.y, _p.z], q: [_q.x, _q.y, _q.z, _q.w] };
}

function toTarget(o) {
  return o
    ? { p: new THREE.Vector3(o.p[0], o.p[1], o.p[2]), q: new THREE.Quaternion(o.q[0], o.q[1], o.q[2], o.q[3]) }
    : null;
}

function yawOf(quat) {
  _euler.setFromQuaternion(quat, "YXZ");
  return _euler.y;
}

// ---------------------------------------------------------------------------
// Remote peers: capsule body + head sphere + two hand spheres
// ---------------------------------------------------------------------------
const peers = new Map(); // id -> avatar
const peersLabel = document.getElementById("peers");

function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return new THREE.Color().setHSL(h / 360, 0.6, 0.62);
}

function makeAvatar(id) {
  const color = colorFor(id);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.8, 6, 16), mat);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), mat);
  const handGeo = new THREE.SphereGeometry(0.05, 16, 12);
  const left = new THREE.Mesh(handGeo, mat);
  const right = new THREE.Mesh(handGeo, mat);
  left.visible = right.visible = false;

  group.add(body, head, left, right);
  scene.add(group);

  return { group, body, head, left, right, target: { head: null, left: null, right: null } };
}

function upsertPeer(msg) {
  let a = peers.get(msg.id);
  if (!a) {
    a = makeAvatar(msg.id);
    peers.set(msg.id, a);
    updatePeerCount();
  }
  a.target.head = toTarget(msg.head);
  a.target.left = toTarget(msg.left);
  a.target.right = toTarget(msg.right);
}

function removePeer(id) {
  closePeer(id);
  const a = peers.get(id);
  if (!a) return;
  scene.remove(a.group);
  a.group.traverse((o) => o.geometry && o.geometry.dispose());
  peers.delete(id);
  updatePeerCount();
}

function updatePeerCount() {
  const n = peers.size;
  peersLabel.textContent = n === 0 ? "alone in the lounge" : `${n} other${n > 1 ? "s" : ""} here`;
}

const _tmp = new THREE.Vector3();
function updateAvatars() {
  for (const a of peers.values()) {
    const t = a.target;
    if (t.head) {
      a.head.position.lerp(t.head.p, 0.3);
      a.head.quaternion.slerp(t.head.q, 0.3);
      _tmp.copy(t.head.p);
      _tmp.y -= 0.6; // drop the capsule torso below the head
      a.body.position.lerp(_tmp, 0.3);
      a.body.rotation.set(0, yawOf(t.head.q), 0);
    }
    for (const side of ["left", "right"]) {
      const mesh = a[side];
      const tp = t[side];
      if (tp) {
        mesh.visible = true;
        mesh.position.lerp(tp.p, 0.3);
      } else {
        mesh.visible = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Networking (PartyKit)
// ---------------------------------------------------------------------------
const PARTY_HOST = import.meta.env.VITE_PARTYKIT_HOST || "127.0.0.1:1999";
const socket = new PartySocket({ host: PARTY_HOST, room: "lounge" });
let connected = false;
let myId = null;

socket.addEventListener("open", () => {
  connected = true;
  socket.send(JSON.stringify({ type: "hello", build: BUILD_ID }));
});
socket.addEventListener("close", () => (connected = false));

socket.addEventListener("message", (e) => {
  let m;
  try {
    m = JSON.parse(e.data);
  } catch {
    return;
  }
  switch (m.type) {
    case "welcome":
      myId = m.id;
      break;
    case "pose":
      upsertPeer(m);
      break;
    case "peer-leave":
      removePeer(m.id);
      break;
    case "voice-on":
      // a peer has a mic. Lower id initiates; higher id acks so the lower
      // one knows to start the offer.
      if (voiceEnabled && myId) {
        if (myId < m.id) ensurePeer(m.id, true);
        else socket.send(JSON.stringify({ type: "voice-ack", to: m.id }));
      }
      break;
    case "voice-ack":
      if (voiceEnabled && myId && myId < m.id) ensurePeer(m.id, true);
      break;
    case "rtc":
      onRtc(m.from, m.kind, m.data);
      break;
    case "reload":
      // a newer version was deployed — refresh to pick it up
      location.reload();
      break;
  }
});

// ---------------------------------------------------------------------------
// Spatial voice chat (WebRTC mesh, signalled over PartyKit)
// ---------------------------------------------------------------------------
let voiceEnabled = false;
let localStream = null;
const pcs = new Map(); // peerId -> { pc, audioEl, posAudio }
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function signal(to, kind, data) {
  socket.send(JSON.stringify({ type: "rtc", to, kind, data }));
}

function ensurePeer(peerId, initiator) {
  let entry = pcs.get(peerId);
  if (entry) return entry;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  entry = { pc, audioEl: null, posAudio: null };
  pcs.set(peerId, entry);

  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) signal(peerId, "ice", e.candidate);
  };
  pc.ontrack = (e) => attachRemoteAudio(peerId, e.streams[0]);
  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal(peerId, "offer", offer);
      } catch (err) {
        console.warn("[voice] offer failed", err);
      }
    };
  }
  return entry;
}

async function onRtc(from, kind, data) {
  if (!voiceEnabled) return;
  if (kind === "offer") {
    const entry = ensurePeer(from, false);
    await entry.pc.setRemoteDescription(data);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    signal(from, "answer", answer);
  } else if (kind === "answer") {
    const entry = pcs.get(from);
    if (entry) await entry.pc.setRemoteDescription(data);
  } else if (kind === "ice") {
    const entry = pcs.get(from);
    if (entry) await entry.pc.addIceCandidate(data).catch(() => {});
  }
}

function attachRemoteAudio(peerId, stream) {
  const entry = pcs.get(peerId);
  if (!entry) return;

  // A muted <audio> element keeps Chrome's audio pipeline alive for streams
  // that are otherwise only consumed by WebAudio (a long-standing quirk).
  const el = document.createElement("audio");
  el.srcObject = stream;
  el.autoplay = true;
  el.muted = true;
  document.body.appendChild(el);
  entry.audioEl = el;

  const avatar = peers.get(peerId);
  if (avatar) {
    const pa = new THREE.PositionalAudio(listener);
    pa.setMediaStreamSource(stream);
    pa.setRefDistance(1.5);
    pa.setDistanceModel("inverse");
    avatar.group.add(pa);
    entry.posAudio = pa;
  } else {
    // No avatar yet — fall back to flat audio so they're still audible.
    el.muted = false;
  }
}

function closePeer(peerId) {
  const entry = pcs.get(peerId);
  if (!entry) return;
  try {
    entry.pc.close();
  } catch {}
  if (entry.posAudio) {
    entry.posAudio.disconnect();
    entry.posAudio.parent?.remove(entry.posAudio);
  }
  if (entry.audioEl) entry.audioEl.remove();
  pcs.delete(peerId);
}

async function enableVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    voiceBtn.textContent = "🎤 mic blocked";
    console.warn("[voice] getUserMedia failed", err);
    return;
  }
  voiceEnabled = true;
  if (listener.context.state === "suspended") await listener.context.resume();
  voiceBtn.textContent = "🎤 voice on";
  voiceBtn.disabled = true;
  voiceBtn.style.opacity = "0.6";
  // Any peers already connected may add their tracks now that we have a mic.
  for (const [id, entry] of pcs) {
    for (const track of localStream.getTracks()) entry.pc.addTrack(track, localStream);
  }
  socket.send(JSON.stringify({ type: "voice-on" }));
}

const voiceBtn = document.createElement("button");
voiceBtn.textContent = "🎤 Enable voice";
voiceBtn.style.cssText =
  "position:fixed;bottom:16px;right:16px;z-index:20;" +
  "padding:10px 18px;border:0;border-radius:999px;background:#89b4fa;color:#0b0f1a;" +
  "font:600 14px system-ui,sans-serif;cursor:pointer;";
voiceBtn.addEventListener("click", enableVoice);
document.body.appendChild(voiceBtn);

// ---------------------------------------------------------------------------
// Send our own pose ~20x/sec
// ---------------------------------------------------------------------------
let sendAccum = 0;
const SEND_INTERVAL = 0.05;

function sendPose(dt) {
  sendAccum += dt;
  if (!connected || sendAccum < SEND_INTERVAL) return;
  sendAccum = 0;

  const headSource = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  socket.send(
    JSON.stringify({
      type: "pose",
      head: worldPose(headSource),
      left: leftLive ? worldPose(gripL) : null,
      right: rightLive ? worldPose(gripR) : null,
    })
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (!renderer.xr.isPresenting) {
    _camEuler.set(lookPitch, lookYaw, 0, "YXZ");
    camera.quaternion.setFromEuler(_camEuler);
    moveDesktop(dt);
  }
  // Keep the spatial-audio listener on the active head (headset or desktop cam).
  const headSrc = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  headSrc.getWorldPosition(listener.position);
  headSrc.getWorldQuaternion(listener.quaternion);

  sendPose(dt);
  updateAvatars();
  renderer.render(scene, camera);
});
