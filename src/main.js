import * as THREE from "three";
import * as CANNON from "cannon-es";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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

// Player rig. The headset tracks freely WITHIN this group (bounded by your
// physical guardian); moving the group is how we add virtual locomotion so you
// can travel beyond your room. The camera's own offset is only used on desktop —
// in XR three.js drives the eyes from the headset pose times the rig transform.
const player = new THREE.Group();
player.add(camera);
scene.add(player);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(
  VRButton.createButton(renderer, {
    optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
  })
);

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
// F fires a hitscan kick from the camera; R restacks the cubes for everyone.
const keys = new Set();
window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "KeyF" && !renderer.xr.isPresenting) {
    camera.getWorldPosition(_rayOrigin);
    camera.getWorldQuaternion(_q);
    _rayDir.set(0, 0, -1).applyQuaternion(_q);
    fireKick(_rayOrigin, _rayDir);
  }
  if (e.code === "KeyR") {
    resetCubes();
    if (connected) socket.send(JSON.stringify({ type: "cube-reset" }));
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
const MOVE_SPEED = 2.6; // metres/sec
const FLOOR_RADIUS = 24;

function moveDesktop(dt) {
  const fwd = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const strafe = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  if (!fwd && !strafe) return;
  const s = Math.sin(lookYaw);
  const c = Math.cos(lookYaw);
  // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
  camera.position.x += (fwd * -s + strafe * c) * MOVE_SPEED * dt;
  camera.position.z += (fwd * -c + strafe * -s) * MOVE_SPEED * dt;
  clampToFloor(camera.position);
}

// --- VR locomotion: left stick glides, right stick snap-turns ---------------
const VR_MOVE_SPEED = 2.6;
const SNAP_ANGLE = Math.PI / 6; // 30°
const DEADZONE = 0.18;
const _yAxis = new THREE.Vector3(0, 1, 0);
const _pivot = new THREE.Vector3();
const _headQuat = new THREE.Quaternion();
let snapReady = true;

function clampToFloor(pos) {
  const r = Math.hypot(pos.x, pos.z);
  if (r > FLOOR_RADIUS) {
    pos.x *= FLOOR_RADIUS / r;
    pos.z *= FLOOR_RADIUS / r;
  }
}

function moveVR(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;
  let mx = 0;
  let mz = 0;
  let turn = 0;
  let hasStick = false;
  for (const src of session.inputSources) {
    const ax = src.gamepad?.axes;
    if (!ax || ax.length < 4) continue; // hand inputs have no thumbstick
    hasStick = true;
    const x = ax[2]; // thumbstick X
    const y = ax[3]; // thumbstick Y
    if (src.handedness === "right") turn += x;
    else {
      mx += x;
      mz += y;
    }
  }

  // Forward direction the head is facing (flattened to the floor plane).
  renderer.xr.getCamera().getWorldQuaternion(_headQuat);
  _camEuler.setFromQuaternion(_headQuat, "YXZ");
  const s = Math.sin(_camEuler.y);
  const c = Math.cos(_camEuler.y);

  if (hasStick && Math.hypot(mx, mz) > DEADZONE) {
    // Thumbstick: glide + strafe relative to gaze.
    const fwd = -mz;
    const strafe = mx;
    player.position.x += (fwd * -s + strafe * c) * VR_MOVE_SPEED * dt;
    player.position.z += (fwd * -c + strafe * -s) * VR_MOVE_SPEED * dt;
    clampToFloor(player.position);
  } else if (!hasStick && [...pinching].some((i) => !fistClosed[i])) {
    // No controllers — pinch and hold to glide forward where you look.
    // (A closing fist can momentarily read as a pinch; punches don't glide.)
    player.position.x += -s * VR_MOVE_SPEED * dt;
    player.position.z += -c * VR_MOVE_SPEED * dt;
    clampToFloor(player.position);
  }

  // Snap-turn around the head so the world pivots in place.
  if (Math.abs(turn) > 0.7 && snapReady) {
    snapReady = false;
    const angle = turn > 0 ? -SNAP_ANGLE : SNAP_ANGLE;
    renderer.xr.getCamera().getWorldPosition(_pivot);
    player.position.sub(_pivot);
    player.position.applyAxisAngle(_yAxis, angle);
    player.position.add(_pivot);
    player.rotateY(angle);
  } else if (Math.abs(turn) < 0.3) {
    snapReady = true;
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
  new THREE.CircleGeometry(25, 64),
  new THREE.MeshStandardMaterial({ color: 0x161d33, roughness: 0.95 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

scene.add(new THREE.GridHelper(50, 50, 0x3a4a7a, 0x223052));

const originRing = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.4, 40),
  new THREE.MeshBasicMaterial({ color: 0x89b4fa, side: THREE.DoubleSide })
);
originRing.rotation.x = -Math.PI / 2;
originRing.position.y = 0.011;
scene.add(originRing);

// ---------------------------------------------------------------------------
// Physics playground: three stacks of cubes you can hitscan-kick around.
// After https://gafferongames.com/post/networked_physics_in_virtual_reality/ —
// every client runs the same cannon-es sim from the same initial state, kick
// impulses are broadcast so all sims receive the identical hit, and the
// lowest-id peer acts as authority, streaming cube state while anything is
// awake so the sims converge instead of slowly drifting apart.
// ---------------------------------------------------------------------------
const CUBE_SIZE = 0.35;
const STACK_HEIGHT = 5;
const STACK_SPOTS = [
  { x: -1.6, z: -1.4 },
  { x: 1.6, z: -1.4 },
  { x: 0, z: -2.6 },
];
const STACK_COLORS = [0xf38ba8, 0xa6e3a1, 0xfab387];

const physWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
physWorld.allowSleep = true;

const groundPhysMat = new CANNON.Material("ground");
const cubePhysMat = new CANNON.Material("cube");
physWorld.addContactMaterial(
  new CANNON.ContactMaterial(groundPhysMat, cubePhysMat, { friction: 0.5, restitution: 0.15 })
);
physWorld.addContactMaterial(
  new CANNON.ContactMaterial(cubePhysMat, cubePhysMat, { friction: 0.4, restitution: 0.1 })
);

const groundBody = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane(), material: groundPhysMat });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
physWorld.addBody(groundBody);

const cubes = []; // { mesh, body }, index is the shared network id of the cube
{
  const cubeGeo = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
  const halfExtents = new CANNON.Vec3(CUBE_SIZE / 2, CUBE_SIZE / 2, CUBE_SIZE / 2);
  for (let s = 0; s < STACK_SPOTS.length; s++) {
    const mat = new THREE.MeshStandardMaterial({ color: STACK_COLORS[s], roughness: 0.65 });
    for (let i = 0; i < STACK_HEIGHT; i++) {
      const mesh = new THREE.Mesh(cubeGeo, mat);
      scene.add(mesh);
      const body = new CANNON.Body({
        mass: 1,
        shape: new CANNON.Box(halfExtents),
        material: cubePhysMat,
        allowSleep: true,
        sleepSpeedLimit: 0.25,
        sleepTimeLimit: 0.6,
      });
      physWorld.addBody(body);
      cubes.push({ mesh, body });
    }
  }
}

function resetCubes() {
  let n = 0;
  for (let s = 0; s < STACK_SPOTS.length; s++) {
    for (let i = 0; i < STACK_HEIGHT; i++) {
      const { body } = cubes[n++];
      // Deterministic sub-mm stagger: keeps the solver from treating the stack
      // as perfectly degenerate while staying identical on every client.
      const jx = (((s * 5 + i) % 3) - 1) * 0.004;
      const jz = (((s * 3 + i) % 3) - 1) * 0.004;
      body.position.set(STACK_SPOTS[s].x + jx, CUBE_SIZE / 2 + i * (CUBE_SIZE + 0.001), STACK_SPOTS[s].z + jz);
      body.quaternion.set(0, 0, 0, 1);
      body.velocity.setZero();
      body.angularVelocity.setZero();
      body.sleep(); // stacks hold still until something hits them
    }
  }
}
resetCubes();

// --- hitscan kick ------------------------------------------------------------
const KICK_IMPULSE = 5; // kg·m/s along the ray; cubes weigh 1 kg
const raycaster = new THREE.Raycaster();
const cubeMeshes = cubes.map((c) => c.mesh);
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _impulse = new CANNON.Vec3();
const _relPoint = new CANNON.Vec3();

// Short-lived laser beams so kicks are visible (yours and your peers').
const beams = []; // { line, mat, ttl }
function flashBeam(origin, end) {
  const geo = new THREE.BufferGeometry().setFromPoints([origin, end]);
  const mat = new THREE.LineBasicMaterial({ color: 0x89b4fa, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  beams.push({ line, mat, ttl: 0.18 });
}

function updateBeams(dt) {
  for (let i = beams.length - 1; i >= 0; i--) {
    const b = beams[i];
    b.ttl -= dt;
    if (b.ttl <= 0) {
      scene.remove(b.line);
      b.line.geometry.dispose();
      b.mat.dispose();
      beams.splice(i, 1);
    } else {
      b.mat.opacity = b.ttl / 0.18;
    }
  }
}

// Apply a kick impulse to cube `i` at world point `p`. Waking everything (not
// just the hit cube) matters: sleeping cubes higher in a stack never get a
// collision event when their support is blasted away, so they'd float.
function applyKick(i, point, impulse) {
  const cube = cubes[i];
  if (!cube) return;
  for (const c of cubes) c.body.wakeUp();
  _impulse.set(impulse.x, impulse.y, impulse.z);
  _relPoint.set(point.x - cube.body.position.x, point.y - cube.body.position.y, point.z - cube.body.position.z);
  cube.body.applyImpulse(_impulse, _relPoint);
}

const _hitPoint = new THREE.Vector3();
const _missEnd = new THREE.Vector3();
function fireKick(origin, dir) {
  raycaster.set(origin, dir);
  raycaster.far = 30;
  const hit = raycaster.intersectObjects(cubeMeshes, false)[0];
  if (!hit) {
    _missEnd.copy(dir).multiplyScalar(30).add(origin);
    flashBeam(origin, _missEnd);
    return;
  }
  _hitPoint.copy(hit.point);
  flashBeam(origin, _hitPoint);
  const i = cubeMeshes.indexOf(hit.object);
  const impulse = { x: dir.x * KICK_IMPULSE, y: dir.y * KICK_IMPULSE, z: dir.z * KICK_IMPULSE };
  applyKick(i, _hitPoint, impulse);
  if (connected) {
    socket.send(
      JSON.stringify({
        type: "cube-kick",
        i,
        o: [origin.x, origin.y, origin.z],
        p: [_hitPoint.x, _hitPoint.y, _hitPoint.z],
        j: [impulse.x, impulse.y, impulse.z],
      })
    );
  }
}

// --- authority sync (gaffer-style convergence) -------------------------------
// The connected peer with the lowest id owns the "true" cube state and streams
// it at 10 Hz whenever any cube is awake. Everyone else snaps their bodies to
// it; between snapshots their local sim keeps motion smooth.
const SYNC_INTERVAL = 0.1;
let syncAccum = 0;

function isAuthority() {
  if (!connected || !myId) return false;
  for (const id of peers.keys()) if (id < myId) return false;
  return true;
}

const _r3 = (x) => Math.round(x * 1000) / 1000;
function sendCubeSync(dt, force = false) {
  syncAccum += dt;
  if (!connected || !isAuthority()) return;
  // Periodic sends need someone listening and something moving; a forced send
  // (peer-join catch-up) always goes out — the peers map may not yet include
  // the newcomer whose join triggered it.
  if (!force && (peers.size === 0 || syncAccum < SYNC_INTERVAL)) return;
  if (!force && !cubes.some((c) => c.body.sleepState !== CANNON.Body.SLEEPING)) return;
  syncAccum = 0;
  const c = cubes.map(({ body: b }) => [
    _r3(b.position.x), _r3(b.position.y), _r3(b.position.z),
    _r3(b.quaternion.x), _r3(b.quaternion.y), _r3(b.quaternion.z), _r3(b.quaternion.w),
    _r3(b.velocity.x), _r3(b.velocity.y), _r3(b.velocity.z),
    _r3(b.angularVelocity.x), _r3(b.angularVelocity.y), _r3(b.angularVelocity.z),
  ]);
  socket.send(JSON.stringify({ type: "cube-sync", c }));
}

function applyCubeSync(c) {
  if (!Array.isArray(c)) return;
  for (let i = 0; i < c.length && i < cubes.length; i++) {
    const d = c[i];
    if (!Array.isArray(d) || d.length < 13) continue;
    const b = cubes[i].body;
    b.position.set(d[0], d[1], d[2]);
    b.quaternion.set(d[3], d[4], d[5], d[6]);
    b.velocity.set(d[7], d[8], d[9]);
    b.angularVelocity.set(d[10], d[11], d[12]);
    const moving = b.velocity.lengthSquared() > 1e-4 || b.angularVelocity.lengthSquared() > 1e-4;
    if (moving) b.wakeUp();
  }
}

function stepPhysics(dt) {
  physWorld.step(1 / 60, dt, 4);
  for (const c of cubes) {
    c.mesh.position.copy(c.body.position);
    c.mesh.quaternion.copy(c.body.quaternion);
  }
  updateBeams(dt);
}

// ---------------------------------------------------------------------------
// Generated models (fal.ai / Tripo text-to-3D)
// The PartyKit server runs the job and broadcasts the GLB url; we load it,
// normalise its size, and stand it on the origin ring. Only one at a time.
// ---------------------------------------------------------------------------
const gltfLoader = new GLTFLoader();
let currentModel = null;

function loadModel(url) {
  genStatus.textContent = "Loading model…";
  gltfLoader.load(
    url,
    (gltf) => {
      const model = gltf.scene;
      // Scale so the largest dimension is ~1.5m, then sit it on the floor (y=0)
      // centred over the origin regardless of the model's native pivot.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 1.5 / maxDim;
      model.scale.setScalar(scale);
      model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

      if (currentModel) {
        scene.remove(currentModel);
        currentModel.traverse((o) => {
          o.geometry?.dispose?.();
          if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((mtl) => mtl.dispose?.());
        });
      }
      scene.add(model);
      currentModel = model;
      genStatus.textContent = "";
    },
    undefined,
    (err) => {
      console.warn("[gen] model load failed", err);
      genStatus.textContent = "Couldn't load the model";
    }
  );
}

// In-world prompt box (HTML overlay — typeable on desktop / Quest browser).
const genStatus = document.createElement("div");
genStatus.style.cssText =
  "position:fixed;bottom:64px;left:50%;transform:translateX(-50%);z-index:20;" +
  "color:#89b4fa;font:13px system-ui,sans-serif;text-shadow:0 1px 4px #000;text-align:center;";
document.body.appendChild(genStatus);

const genWrap = document.createElement("div");
genWrap.style.cssText =
  "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:20;" +
  "display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:14px;" +
  "background:rgba(11,15,26,0.85);border:1px solid #2a3550;backdrop-filter:blur(4px);";
const genInput = document.createElement("input");
genInput.type = "text";
genInput.maxLength = 1024;
genInput.placeholder = "Describe a 3D object to spawn…";
genInput.style.cssText =
  "width:min(60vw,300px);padding:9px 12px;border-radius:9px;border:1px solid #2a3550;" +
  "background:#0b0f1a;color:#cdd6f4;font:14px system-ui,sans-serif;outline:none;";
const genBtn = document.createElement("button");
genBtn.textContent = "Generate";
genBtn.style.cssText =
  "padding:9px 16px;border:0;border-radius:9px;background:#89b4fa;color:#0b0f1a;" +
  "font:600 14px system-ui,sans-serif;cursor:pointer;white-space:nowrap;";
genWrap.append(genInput, genBtn);
document.body.appendChild(genWrap);

function submitGen() {
  const prompt = genInput.value.trim();
  if (!prompt) return;
  if (!connected) {
    genStatus.textContent = "Not connected yet…";
    return;
  }
  socket.send(JSON.stringify({ type: "generate", prompt }));
  genStatus.textContent = "Submitting…";
  genInput.blur();
}
genBtn.addEventListener("click", submitGen);
// Keep typing out of the WASD/locomotion handlers on window.
genInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") submitGen();
});
genInput.addEventListener("keyup", (e) => e.stopPropagation());

// ---------------------------------------------------------------------------
// Local player: controller grips + own hand spheres
// ---------------------------------------------------------------------------
const ownHandGeo = new THREE.SphereGeometry(0.05, 16, 12);
const ownHandMat = new THREE.MeshStandardMaterial({ color: 0xe6edf7, roughness: 0.4 });

const gripL = renderer.xr.getControllerGrip(0);
const gripR = renderer.xr.getControllerGrip(1);
gripL.add(new THREE.Mesh(ownHandGeo, ownHandMat));
gripR.add(new THREE.Mesh(ownHandGeo, ownHandMat));
player.add(gripL, gripR);

let leftLive = false;
let rightLive = false;
const ctrl0 = renderer.xr.getController(0);
const ctrl1 = renderer.xr.getController(1);
player.add(ctrl0, ctrl1);

// Faint aim ray shown on the left controller so you can line up kicks.
const aimRay = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -6)]),
  new THREE.LineBasicMaterial({ color: 0x89b4fa, transparent: true, opacity: 0.35 })
);

function hookController(ctrl, index) {
  ctrl.addEventListener("connected", (e) => {
    if (index === 0) leftLive = true;
    else rightLive = true;
    if (e.data && !e.data.hand && e.data.handedness === "left") ctrl.add(aimRay);
  });
  ctrl.addEventListener("disconnected", () => {
    if (index === 0) leftLive = false;
    else rightLive = false;
    if (aimRay.parent === ctrl) ctrl.remove(aimRay);
  });
}
hookController(ctrl0, 0);
hookController(ctrl1, 1);

// "select" fires on trigger pull AND on a hand-tracking pinch. Pinch-and-hold
// still drives controller-free locomotion; a *left controller* trigger pull
// additionally fires a hitscan kick along the controller's pointing ray.
const pinching = new Set();
function hookSelect(ctrl, index) {
  ctrl.addEventListener("selectstart", (e) => {
    pinching.add(index);
    const src = e.data;
    if (src && !src.hand && src.handedness === "left") {
      ctrl.getWorldPosition(_rayOrigin);
      ctrl.getWorldQuaternion(_q);
      _rayDir.set(0, 0, -1).applyQuaternion(_q);
      fireKick(_rayOrigin, _rayDir);
    }
  });
  ctrl.addEventListener("selectend", () => pinching.delete(index));
}
hookSelect(ctrl0, 0);
hookSelect(ctrl1, 1);

// --- hand tracking: punch (make a fist) to fire a kick -----------------------
// Fist = all four fingertips curled in close to the wrist. The kick ray runs
// wrist → middle knuckle, i.e. wherever the punch is aimed. Hysteresis on the
// open/close thresholds stops one squeeze from firing repeatedly.
const FIST_CLOSE = 0.1; // avg fingertip→wrist distance (m) to count as closed
const FIST_OPEN = 0.13; // must re-open past this before the next punch
const FINGERTIPS = ["index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"];
const hands = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
player.add(hands[0], hands[1]);
const fistClosed = [false, false];
const _wristP = new THREE.Vector3();
const _knuckleP = new THREE.Vector3();

function updateFists() {
  for (let i = 0; i < 2; i++) {
    const joints = hands[i].joints;
    const wrist = joints["wrist"];
    const knuckle = joints["middle-finger-phalanx-proximal"];
    if (!wrist || !knuckle) {
      fistClosed[i] = false;
      continue;
    }
    let sum = 0;
    let n = 0;
    for (const name of FINGERTIPS) {
      const tip = joints[name];
      if (!tip) continue;
      sum += tip.position.distanceTo(wrist.position);
      n++;
    }
    if (n < FINGERTIPS.length) {
      fistClosed[i] = false;
      continue;
    }
    const avg = sum / n;
    if (!fistClosed[i] && avg < FIST_CLOSE) {
      fistClosed[i] = true;
      wrist.getWorldPosition(_wristP);
      knuckle.getWorldPosition(_knuckleP);
      _rayDir.copy(_knuckleP).sub(_wristP).normalize();
      fireKick(_knuckleP, _rayDir);
    } else if (fistClosed[i] && avg > FIST_OPEN) {
      fistClosed[i] = false;
    }
  }
}

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
    case "peer-join":
      // If we're the cube authority, catch the newcomer up on cube state so
      // they don't see pristine stacks while everyone else sees rubble.
      if (isAuthority()) sendCubeSync(0, true);
      break;
    case "peer-leave":
      removePeer(m.id);
      break;
    case "cube-kick":
      applyKick(m.i, { x: m.p[0], y: m.p[1], z: m.p[2] }, { x: m.j[0], y: m.j[1], z: m.j[2] });
      if (Array.isArray(m.o)) {
        flashBeam(new THREE.Vector3(m.o[0], m.o[1], m.o[2]), new THREE.Vector3(m.p[0], m.p[1], m.p[2]));
      }
      break;
    case "cube-sync":
      // Always apply — the server never echoes our own syncs back, and a
      // fresh joiner's peers map is empty (it would wrongly think it's the
      // authority and drop the catch-up state it was just sent).
      applyCubeSync(m.c);
      break;
    case "cube-reset":
      resetCubes();
      break;
    case "model":
      loadModel(m.url);
      break;
    case "gen-status":
      if (m.state === "submitting") genStatus.textContent = `Generating “${m.prompt}”…`;
      else if (m.state === "working") genStatus.textContent = `Generating “${m.prompt}”… (~1 min)`;
      else if (m.state === "busy") genStatus.textContent = "Someone else is generating — try again shortly.";
      else if (m.state === "error") genStatus.textContent = `Error: ${m.error || "generation failed"}`;
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
  } else {
    updateFists(); // hand-tracking punch detection (fires kicks) before moving
    moveVR(dt);
  }
  stepPhysics(dt);
  sendCubeSync(dt);
  // Keep the spatial-audio listener on the active head (headset or desktop cam).
  const headSrc = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  headSrc.getWorldPosition(listener.position);
  headSrc.getWorldQuaternion(listener.quaternion);

  sendPose(dt);
  updateAvatars();
  renderer.render(scene, camera);
});
