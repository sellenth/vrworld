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
    case "pose":
      upsertPeer(m);
      break;
    case "peer-leave":
      removePeer(m.id);
      break;
    case "reload":
      // a newer version was deployed — refresh to pick it up
      location.reload();
      break;
  }
});

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
  sendPose(dt);
  updateAvatars();
  renderer.render(scene, camera);
});
