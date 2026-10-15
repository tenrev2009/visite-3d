// Visite 3D web : scene exportee d'Unreal (glTF) + fichier d'export SketchUp
// (project_manifest.json) pour les vues, les vitres et, plus tard, les bulles.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { setupInteractions, isShown } from './interactions.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// -- Reglages ----------------------------------------------------------------
const EYE = 1.6;          // hauteur des yeux (m)
const RADIUS = 0.3;       // distance minimale aux murs (m)
const SPEED = 1.5;        // vitesse de marche (m/s), x2.5 avec Maj
const STEP = 0.35;        // marche franchissable (m)
const LOOK = 0.0035;      // sensibilite du regard (rad par pixel)
const BLEND = 1.5;        // duree d'une transition de vue (s)

// -- Rendu -------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.7;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd8e3);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 5000);
camera.rotation.order = 'YXZ';
window.visite = { camera, look: (y, p) => { yaw = y; pitch = p; } };   // aide au diagnostic

// Panorama exterieur : nom donne par visite.json (cree par Unreal), sinon panorama.jpg.
fetch('visite.json').then((r) => r.json()).catch(() => ({})).then((cfg) => {
  if (cfg.panorama === '') { return; }
  new THREE.TextureLoader().load(cfg.panorama || 'panorama.jpg', (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
  scene.backgroundIntensity = 0.9;
  });
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (composer) { composer.setSize(innerWidth, innerHeight); }
  if (floorMirror) {
    floorMirror.getRenderTarget().setSize(Math.round(innerWidth * MIRROR_RES), Math.round(innerHeight * MIRROR_RES));
  }
});

// Unreal (cm, Z vers le haut) -> scene glTF (m, Y vers le haut).
function ueToScene(p) {
  return new THREE.Vector3(p.x / 100, p.z / 100, p.y / 100);
}

// -- Chargement --------------------------------------------------------------
const colliders = [];
let manifest = { cameras: [], material_settings: [] };
let links = [];
let interactions = null;

async function start() {
  try {
    manifest = await (await fetch('project_manifest.json')).json();
  } catch (e) {
    console.warn('Manifeste illisible', e);
  }
  try {
    links = await (await fetch('liens.json')).json();
  } catch (e) {
    console.warn('Liens SketchUp illisibles : pas d\'interactions', e);
  }
  const glass = {};
  (manifest.material_settings || []).forEach((s) => {
    if (s.glass && s.glass !== 'none') { glass[s.name.toLowerCase()] = s; }
  });

  // Scene compressee (Draco ou Meshopt) a la creation de la visite web.
  const draco = new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/');
  const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  loader.load('scene.glb', (gltf) => {
    gltf.scene.traverse((o) => {
      if (o.isLight) {
        if (o.isDirectionalLight) { sunSource = o; o.intensity = 0; } else { o.intensity = Math.min(o.intensity, 3); }
      }
      if (!o.isMesh) { return; }
      if (/Panorama/i.test(o.name)) { o.visible = false; return; }
      const fix = (m) => {
        const s = glassFor(m, glass);
        return s ? makeGlass(m, s) : m;
      };
      o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
      const isGlass = [].concat(o.material).some((m) => m.isMeshPhysicalMaterial && m.transparent);
      o.castShadow = !isGlass;
      o.receiveShadow = !isGlass;
      o.geometry.computeBoundsTree();
      colliders.push(o);
    });
    scene.add(gltf.scene);
    buildViews();
    setupEffects(gltf.scene);
    interactions = setupInteractions({
      scene, camera, root: gltf.scene, manifest, links, ueToScene,
      collidersChanged() { renderer.shadowMap.needsUpdate = true; }
    });
    console.log('Interactions :', interactions.count);
    document.getElementById('loading').remove();
  }, (p) => {
    const pct = Math.min(100, Math.round(100 * p.loaded / (p.total || 20e6)));
    document.getElementById('loading-bar').style.width = pct + '%';
    document.getElementById('loading-text').textContent = 'Chargement de la visite… ' + pct + ' %';
  }, (e) => {
    document.getElementById('loading-text').textContent = 'Chargement impossible : ' + e.message;
  });
}

// Vitres : l'export glTF d'Unreal les laisse opaques ; on reprend les
// reglages « verre » saisis dans SketchUp.
function glassFor(mat, glass) {
  const key = (mat.name || '').replace(/^MI_Skp_/, '').replace(/_\d+$/, '').toLowerCase();
  return glass[key] || (mat.transparent ? { glass: 'clear', opacity: 0.1 } : null);
}

function makeGlass(mat, s) {
  const g = new THREE.MeshPhysicalMaterial({
    color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
    metalness: 0,
    roughness: s.glass === 'frosted' ? 0.35 : 0.03,
    transparent: true,
    opacity: Math.max(0.12, Math.min(0.5, s.opacity || 0.1)),
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.2
  });
  g.name = mat.name;
  return g;
}

// -- Ombres et reflets ------------------------------------------------------
let sunSource = null;
let composer = null;
let floorMirror = null;
let sunRig = null;

// Course du soleil simplifiee autour de l'heure exportee d'Unreal (13 h).
function setHour(h) {
  if (!sunRig) { return; }
  const { sun, center, span, az0, elev0 } = sunRig;
  const elev = Math.max(elev0, 0.2) * Math.sin(Math.PI * (h - 6) / 14);
  const az = az0 + THREE.MathUtils.degToRad((h - 13) * 15);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elev), -Math.sin(elev), Math.cos(az) * Math.cos(elev)).normalize();
  sun.position.copy(center).addScaledVector(dir, -span * 2);
  const day = THREE.MathUtils.smoothstep(elev, -0.05, 0.12);
  sun.intensity = 2.6 * day;
  scene.environmentIntensity = 0.12 + 0.48 * day;
  scene.backgroundIntensity = 0.12 + 0.78 * day;
  renderer.shadowMap.needsUpdate = true;
  const label = document.getElementById('hour-label');
  if (label) { label.textContent = 'Heure   ' + Math.floor(h) + 'h' + String(Math.round((h % 1) * 60)).padStart(2, '0'); }
}

document.getElementById('hour').addEventListener('input', (e) => setHour(Number(e.target.value)));
const MIRROR_RES = 0.6;   // resolution du reflet (part de l'ecran) : plus doux et plus leger

// Miroir du sol, melange au sol avec une opacite qui croit en vue rasante
// (effet de Fresnel) : l'aspect d'un sol poli, sans deformation.
const SoftMirrorShader = {
  name: 'SoftMirror',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    opacity: { value: 0.16 }
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float opacity;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec4 base = texture2DProj(tDiffuse, vUv);
      vec3 view = normalize(cameraPosition - vWorld);
      float fresnel = mix(0.45, 1.0, pow(1.0 - clamp(view.y, 0.0, 1.0), 3.0));
      gl_FragColor = vec4(base.rgb, opacity * fresnel);
      #include <colorspace_fragment>
    }`
};
let quality = ('ontouchstart' in window) ? 'low' : 'high';

function setupEffects(root) {
  // Emprise du batiment seul (sans la sphere du panorama ni le ciel).
  const box = new THREE.Box3();
  colliders.forEach((m) => box.expandByObject(m));
  if (box.isEmpty()) { box.setFromObject(root); }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // Soleil : direction de celui d'Unreal, ombres sur toute la scene.
  const dir = new THREE.Vector3(0, -1, 0.3);
  if (sunSource) { sunSource.getWorldDirection(dir).negate(); }  // la lumiere glTF eclaire vers -Z
  dir.normalize();
  const sun = new THREE.DirectionalLight(0xfff4e5, 2.6);
  const span = Math.max(size.x, size.z) * 0.6;
  sun.position.copy(center).addScaledVector(dir, -span * 2);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = -span; sun.shadow.camera.right = span;
  sun.shadow.camera.top = span; sun.shadow.camera.bottom = -span;
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = span * 5;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  sunRig = { sun, center, span, az0: Math.atan2(dir.x, dir.z), elev0: Math.asin(Math.min(1, -dir.y)) };
  setHour(13);

  // Sol reflechissant : miroir doux pose juste au-dessus du sol.
  const floorY = floorHeight(center, box);
  floorMirror = new Reflector(new THREE.PlaneGeometry(size.x * 1.05, size.z * 1.05), {
    clipBias: 0.003,
    textureWidth: Math.round(innerWidth * MIRROR_RES),
    textureHeight: Math.round(innerHeight * MIRROR_RES),
    shader: SoftMirrorShader,
    multisample: 0
  });
  floorMirror.material.transparent = true;
  floorMirror.material.depthWrite = false;
  floorMirror.rotation.x = -Math.PI / 2;
  floorMirror.position.set(center.x, floorY + 0.003, center.z);
  floorMirror.renderOrder = 1;
  scene.add(floorMirror);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // Ombres douces dans les coins et sous les meubles.
  const ao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.2, samples: 16 });
  ao.blendIntensity = 0.9;
  composer.addPass(ao);
  composer.addPass(new OutputPass());

  applyQuality();
}

// Hauteur du sol sous la premiere vue (a defaut, bas de la scene).
function floorHeight(center, box) {
  const from = views.length ? views[0].pos.clone() : center.clone();
  from.y += 0.2;
  const hit = firstHit(from, DOWN, 20);
  return hit ? hit.point.y : box.min.y;
}

function applyQuality() {
  const high = quality === 'high';
  scene.traverse((o) => { if (o.isDirectionalLight) { o.castShadow = high; } });
  if (floorMirror) { floorMirror.visible = high; }
  renderer.shadowMap.needsUpdate = true;
  const b = document.getElementById('quality');
  b.textContent = 'Qualité : ' + (high ? 'haute' : 'légère');
  b.classList.toggle('on', high);
}

document.getElementById('quality').addEventListener('click', () => {
  quality = quality === 'high' ? 'low' : 'high';
  applyQuality();
});

// -- Vues --------------------------------------------------------------------
const views = [];
let activeView = -1;
let transition = null;     // { from, to, fromYaw, toYaw, fromPitch, toPitch, t }
let walking = false;       // exploration libre : pieds au sol, collisions

function buildViews() {
  const list = document.getElementById('views');
  (manifest.cameras || []).forEach((c, i) => {
    const pos = ueToScene(c.location);
    const target = ueToScene(c.target);
    const d = target.clone().sub(pos);
    views.push({
      name: c.name,
      pos,
      yaw: Math.atan2(-d.x, -d.z),
      pitch: Math.atan2(d.y, Math.hypot(d.x, d.z))
    });
    const b = document.createElement('button');
    b.textContent = (i + 1) + '   ' + c.name;
    b.addEventListener('click', () => goToView(i));
    list.appendChild(b);
  });

  if (views.length) {
    const v = views[0];
    camera.position.copy(v.pos);
    yaw = v.yaw;
    pitch = v.pitch;
    setActive(0);
  } else {
    camera.position.set(0, EYE, 0);
    startWalking();
  }
}

function setActive(index) {
  activeView = index;
  document.querySelectorAll('#views button').forEach((b, i) => b.classList.toggle('on', i === index));
  document.getElementById('free').classList.toggle('on', index < 0);
}

function goToView(index) {
  const v = views[index];
  walking = false;
  transition = {
    from: camera.position.clone(), to: v.pos.clone(),
    fromYaw: yaw, toYaw: yaw + shortestAngle(v.yaw - yaw),
    fromPitch: pitch, toPitch: v.pitch, t: 0
  };
  setActive(index);
}

function shortestAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// L'exploration libre demarre la ou l'on se trouve.
function startWalking() {
  transition = null;
  walking = true;
  setActive(-1);
  snapToFloor(true);
}

document.getElementById('free').addEventListener('click', startWalking);

// -- Regard (souris / doigt) --------------------------------------------------
let yaw = 0;
let pitch = 0;
let drag = null;
const canvas = renderer.domElement;

canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) { return; }
  if (transition) { transition = null; }
  yaw += (e.clientX - drag.x) * LOOK;
  pitch = THREE.MathUtils.clamp(pitch + (e.clientY - drag.y) * LOOK, -1.4, 1.4);
  drag.x = e.clientX;
  drag.y = e.clientY;
});
const endDrag = () => { drag = null; canvas.classList.remove('dragging'); };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// -- Deplacement (clavier / pave tactile) --------------------------------------
const keys = new Set();
const KEYMAP = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right'
};
addEventListener('keydown', (e) => {
  if (e.code === 'KeyH') { document.getElementById('panel').classList.toggle('hidden'); return; }
  if (/^Digit[1-9]$/.test(e.code)) {
    const i = Number(e.code.slice(5)) - 1;
    if (views[i]) { goToView(i); }
    return;
  }
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
  if (e.key === 'Shift') { keys.add('fast'); }
});
addEventListener('keyup', (e) => {
  if (KEYMAP[e.code]) { keys.delete(KEYMAP[e.code]); }
  if (e.key === 'Shift') { keys.delete('fast'); }
});
addEventListener('blur', () => keys.clear());

if ('ontouchstart' in window) { document.body.classList.add('touch'); }
document.querySelectorAll('#pad button').forEach((b) => {
  const dir = b.dataset.move;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); keys.add(dir); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => keys.delete(dir)));
});

// -- Collisions -----------------------------------------------------------------
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);

function firstHit(origin, dir, far) {
  ray.set(origin, dir);
  ray.near = 0;
  ray.far = far;
  const hits = ray.intersectObjects(colliders, false);
  return hits.find((h) => isShown(h.object)) || null;
}

// Pose les yeux a EYE au-dessus du sol (s'il y en a un sous le visiteur).
function snapToFloor(immediate) {
  const origin = camera.position.clone();
  origin.y += 0.2;
  const hit = firstHit(origin, DOWN, 6);
  if (!hit) { return; }
  const wanted = hit.point.y + EYE;
  camera.position.y = immediate ? wanted : THREE.MathUtils.lerp(camera.position.y, wanted, 0.25);
}

// Deplacement horizontal en glissant le long des murs.
function moveWithCollisions(move) {
  const feet = camera.position.clone();
  feet.y -= EYE;
  for (let attempt = 0; attempt < 2 && move.lengthSq() > 1e-10; attempt++) {
    const dir = move.clone().normalize();
    let blocked = null;
    for (const h of [STEP + 0.05, 0.9, 1.5]) {
      const hit = firstHit(feet.clone().setY(feet.y + h), dir, move.length() + RADIUS);
      if (hit && hit.face) {
        blocked = hit;
        break;
      }
    }
    if (!blocked) {
      camera.position.add(move);
      return;
    }
    // Glissement : on retire la composante qui entre dans l'obstacle.
    const n = blocked.face.normal.clone().transformDirection(blocked.object.matrixWorld);
    n.y = 0;
    if (n.lengthSq() < 1e-6) { return; }
    n.normalize();
    if (n.dot(dir) > 0) { n.negate(); }
    move.sub(n.multiplyScalar(move.dot(n)));
  }
}

// -- Boucle ------------------------------------------------------------------
const clock = new THREE.Clock();

function update(dt) {
  if (transition) {
    transition.t = Math.min(1, transition.t + dt / BLEND);
    const k = transition.t * transition.t * (3 - 2 * transition.t);
    camera.position.lerpVectors(transition.from, transition.to, k);
    yaw = THREE.MathUtils.lerp(transition.fromYaw, transition.toYaw, k);
    pitch = THREE.MathUtils.lerp(transition.fromPitch, transition.toPitch, k);
    if (transition.t >= 1) { transition = null; }
  }

  const f = (keys.has('forward') ? 1 : 0) - (keys.has('back') ? 1 : 0);
  const s = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  if (f || s) {
    if (!walking) { startWalking(); }
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const move = forward.multiplyScalar(f).add(right.multiplyScalar(s)).normalize()
      .multiplyScalar(SPEED * (keys.has('fast') ? 2.5 : 1) * dt);
    moveWithCollisions(move);
  }
  if (walking) { snapToFloor(false); }

  camera.rotation.set(pitch, yaw, 0);
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.1);
  update(dt);
  if (interactions) { interactions.update(dt); }
  if (composer && quality === 'high') {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

start();
loop();
