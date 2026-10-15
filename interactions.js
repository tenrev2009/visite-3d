// Interactions de la visite web, pilotees par le fichier d'export SketchUp
// (project_manifest.json) : variantes de mobilier, matieres, interrupteurs,
// portes automatiques. liens.json relie chaque objet de la scene web (nom
// d'acteur Unreal) a son chemin SketchUp.
import * as THREE from 'three';

const NEAR_DEFAULT = 2.0;   // rayon d'approche par defaut (m)

export function setupInteractions(ctx) {
  const { scene, camera, root, manifest, links, ueToScene } = ctx;

  // -- Chemin SketchUp -> objet de la scene ----------------------------------
  const byName = new Map();
  root.traverse((o) => { if (o.name && !byName.has(o.name)) { byName.set(o.name, o); } });
  const byPath = new Map();
  links.forEach((l) => {
    const node = byName.get(l.name);
    if (!node) { return; }
    // Le plus haut des objets portant ce chemin (acteur plutot que sa maille).
    const prev = byPath.get(l.path);
    if (!prev || isAncestor(node, prev)) { byPath.set(l.path, node); }
  });
  const find = (path) => byPath.get(path) || null;

  const items = [];          // { kind, anchorNode, radius, title, build(), ... }
  const doors = [];

  // -- Variantes de mobilier -----------------------------------------------------
  (manifest.variant_groups || []).forEach((g) => {
    const container = find(g.skp_path);
    const variants = (g.variants || []).map((v) => ({ v, node: find(v.skp_path) })).filter((x) => x.node);
    if (!container || variants.length < 2) { return; }
    let active = Math.max(0, variants.findIndex((x) => x.v.is_default));
    const show = (i) => {
      active = i;
      variants.forEach((x, k) => { x.node.visible = k === i; });
      ctx.collidersChanged();
    };
    show(active);
    items.push({
      kind: 'variant', node: container, radius: (g.interaction_radius || 200) / 100,
      title: g.group_name || 'Variantes',
      render(body) {
        variants.forEach((x, i) => {
          const card = el('button', 'card' + (i === active ? ' on' : ''));
          if (x.v.thumbnail) {
            const img = el('img');
            img.src = x.v.thumbnail;
            img.alt = '';
            card.appendChild(img);
          }
          card.appendChild(el('span', '', x.v.label));
          card.addEventListener('click', () => { show(i); refresh(); });
          body.appendChild(card);
        });
      },
      subtitle: () => (active + 1) + ' / ' + variants.length + ' — ' + variants[active].v.label
    });
  });

  // -- Matieres et couleurs ------------------------------------------------------
  (manifest.material_groups || []).forEach((slot) => {
    const target = find(slot.skp_path);
    if (!target || !(slot.options || []).length) { return; }
    const swap = materialSlot(slot, target, root);
    if (!swap) { return; }
    items.push({
      kind: 'material', node: target, radius: (slot.interaction_radius || manifest.settings?.default_interaction_cm || 200) / 100,
      title: slot.slot_name,
      render(body) {
        slot.options.forEach((o, i) => {
          const sw = el('button', 'swatch' + (i === swap.active ? ' on' : ''));
          sw.title = o.name;
          sw.style.backgroundColor = o.hex || '#888';
          if (o.texture_file) { sw.style.backgroundImage = 'url("' + o.texture_file + '")'; }
          sw.addEventListener('click', () => { swap.select(i); refresh(); });
          body.appendChild(sw);
        });
      },
      subtitle: () => (swap.active + 1) + ' / ' + slot.options.length + ' — ' + slot.options[swap.active].name
    });
  });

  // -- Eclairages : un interrupteur par luminaire ----------------------------
  const channels = new Map();   // canal -> { on, lights: [] }
  (manifest.lights || []).forEach((l) => {
    const host = find(l.parent_match && l.parent_match.skp_path);
    if (!host) { return; }
    const lights = [];
    host.traverse((o) => { if (o.isLight) { lights.push(o); } });
    if (!lights.length) { return; }
    const ch = channels.get(l.channel) || { on: l.default_on !== false, lights: [], hosts: new Set() };
    ch.lights.push(...lights);
    ch.hosts.add(host);
    channels.set(l.channel, ch);
  });
  channels.forEach((ch, name) => {
    const apply = () => ch.lights.forEach((li) => { li.visible = ch.on; });
    apply();
    ch.hosts.forEach((host) => {
      items.push({
        kind: 'light', node: host, radius: 2.0, title: name.replace(/_/g, ' '),
        render(body) {
          const b = el('button', 'switch' + (ch.on ? ' on' : ''), ch.on ? 'Éteindre' : 'Allumer');
          b.addEventListener('click', () => { ch.on = !ch.on; apply(); refresh(); });
          body.appendChild(b);
        },
        subtitle: () => (ch.on ? 'Allumé' : 'Éteint')
      });
    });
  });

  // -- Portes automatiques -------------------------------------------------------
  (manifest.doors || []).forEach((d) => {
    const leaf = find(d.skp_path);
    if (!leaf) { return; }
    leaf.updateWorldMatrix(true, false);
    const closed = {
      pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3()
    };
    leaf.matrixWorld.decompose(closed.pos, closed.quat, closed.scale);
    doors.push({
      d, leaf, closed,
      hinge: ueToScene(d.hinge),
      axis: axisToScene(d.axis),
      center: ueToScene(d.center),
      front: axisToScene(d.front),
      slide: axisToScene(d.slide_dir),
      progress: 0, sign: 1, open: false
    });
  });
  // Porte double : detection au centre de la paire.
  doors.forEach((door) => {
    const mates = door.d.group ? doors.filter((o) => o.d.group === door.d.group) : [door];
    door.trigger = mates.reduce((s, o) => s.add(o.center), new THREE.Vector3()).divideScalar(mates.length);
  });

  // -- Bulle d'interaction -------------------------------------------------------
  const bubble = el('div', 'bubble hidden');
  const head = el('div', 'bubble-title');
  const sub = el('div', 'bubble-sub');
  const body = el('div', 'bubble-body');
  bubble.append(head, sub, body);
  document.body.appendChild(bubble);
  let focused = null;

  function refresh() {
    if (!focused) { return; }
    head.textContent = focused.title;
    sub.textContent = focused.subtitle ? focused.subtitle() : '';
    body.innerHTML = '';
    body.className = 'bubble-body ' + focused.kind;
    focused.render(body);
  }

  items.forEach((it) => {
    const box = new THREE.Box3().setFromObject(it.node);
    it.anchor = box.isEmpty() ? it.node.getWorldPosition(new THREE.Vector3())
      : new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + 0.25, (box.min.z + box.max.z) / 2);
  });

  const tmp = new THREE.Vector3();
  const forward = new THREE.Vector3();

  function update(dt) {
    const eye = camera.position;
    camera.getWorldDirection(forward);

    // Element le plus proche, devant le visiteur, dans son rayon.
    let best = null;
    let bestScore = Infinity;
    items.forEach((it) => {
      if (!isShown(it.node)) { return; }
      tmp.copy(it.anchor).sub(eye);
      const dist = tmp.length();
      const radius = it === focused ? it.radius * 1.15 : it.radius;
      if (dist > Math.max(radius, NEAR_DEFAULT * 0.5) || dist < 0.01) { return; }
      if (tmp.normalize().dot(forward) < 0.35) { return; }
      const score = dist / it.radius;
      if (score < bestScore) { bestScore = score; best = it; }
    });
    if (best !== focused) {
      focused = best;
      bubble.classList.toggle('hidden', !focused);
      refresh();
    }
    if (focused) {
      tmp.copy(focused.anchor).project(camera);
      const x = (tmp.x * 0.5 + 0.5) * innerWidth;
      const y = (-tmp.y * 0.5 + 0.5) * innerHeight;
      // Bulle au-dessus de l'objet, gardee dans l'ecran.
      const w = bubble.offsetWidth, h = bubble.offsetHeight;
      const left = THREE.MathUtils.clamp(x - w / 2, 8, Math.max(8, innerWidth - w - 8));
      const top = THREE.MathUtils.clamp(y - h, 8, Math.max(8, innerHeight - h - 8));
      bubble.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    }

    doors.forEach((door) => updateDoor(door, eye, dt));
  }

  function updateDoor(door, eye, dt) {
    const off = eye.clone().sub(door.trigger);
    const flat = Math.hypot(off.x, off.z);
    const radius = (door.d.radius || 200) / 100;
    door.open = Math.abs(off.y) < 3 && flat < (door.open ? radius * 1.15 : radius);
    const target = door.open ? 1 : 0;
    if (door.progress === target) { return; }
    if (door.open && door.progress === 0 && door.d.kind !== 'slide') {
      door.sign = rotationSign(door, eye);
    }
    const step = dt / Math.max(0.05, door.d.duration || 1.2);
    door.progress = THREE.MathUtils.clamp(door.progress + (door.open ? step : -step), 0, 1);
    applyDoor(door);
  }

  function rotationSign(door, eye) {
    let wanted = door.front.clone();
    if (door.d.swing === 'back') { wanted.negate(); } else if (door.d.swing !== 'front') {
      // Le vantail part a l'oppose du visiteur.
      if (door.center.clone().sub(eye).dot(wanted) < 0) { wanted.negate(); }
    }
    const arm = door.center.clone().sub(door.hinge);
    const moved = arm.clone().applyAxisAngle(door.axis, THREE.MathUtils.degToRad(10));
    return moved.sub(arm).dot(wanted) >= 0 ? 1 : -1;
  }

  function applyDoor(door) {
    const p = door.progress;
    const eased = p * p * (3 - 2 * p);
    const pos = door.closed.pos.clone();
    const quat = door.closed.quat.clone();
    if (door.d.kind === 'slide') {
      pos.addScaledVector(door.slide, (door.d.slide_distance || 90) / 100 * eased);
    } else {
      const turn = new THREE.Quaternion().setFromAxisAngle(door.axis, door.sign * THREE.MathUtils.degToRad(door.d.angle || 90) * eased);
      pos.sub(door.hinge).applyQuaternion(turn).add(door.hinge);
      quat.premultiply(turn);
    }
    // Monde -> repere du parent.
    const parent = door.leaf.parent;
    parent.updateWorldMatrix(true, false);
    const world = new THREE.Matrix4().compose(pos, quat, door.closed.scale);
    door.leaf.matrix.copy(parent.matrixWorld.clone().invert().multiply(world));
    door.leaf.matrix.decompose(door.leaf.position, door.leaf.quaternion, door.leaf.scale);
    door.leaf.updateMatrixWorld(true);
  }

  return { update, count: { items: items.length, doors: doors.length } };
}

// -- Slot de matiere ------------------------------------------------------------
function materialSlot(slot, target, root) {
  // Elements de maille du slot, regroupes par matiere (aires et densite UV).
  const parts = [];
  target.traverse((o) => {
    if (o.isMesh && !Array.isArray(o.material)) { parts.push({ mesh: o, key: baseName(o.material.name), ...measure(o) }); }
  });
  if (!parts.length) { return null; }
  const total = parts.reduce((s, p) => s + p.world, 0);
  const areaOf = (key) => parts.filter((p) => p.key === key).reduce((s, p) => s + p.world, 0);

  // Matiere du slot ; si elle ne couvre presque rien (objet peint « par-dessus »
  // dans SketchUp), la matiere dominante est remplacee a sa place.
  let key = baseName(slot.default_material);
  if (areaOf(key) < 0.25 * total) {
    const byKey = new Map();
    parts.forEach((p) => byKey.set(p.key, (byKey.get(p.key) || 0) + p.world));
    key = [...byKey.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  const targets = parts.filter((p) => p.key === key);
  const tw = targets.reduce((s, p) => s + p.world, 0);
  const tu = targets.reduce((s, p) => s + p.uv, 0);
  const density = tw > 0 ? Math.sqrt(tu / tw) : 1;   // repetitions UV par metre
  const originals = targets.map((p) => p.mesh.material);

  // Matieres deja presentes ailleurs dans la scene : taille de motif de reference.
  const own = new Set(parts.map((p) => p.mesh));
  const reference = new Map();
  root.traverse((o) => {
    if (!o.isMesh || own.has(o) || Array.isArray(o.material)) { return; }
    const k = baseName(o.material.name);
    const m = measure(o);
    const r = reference.get(k) || { material: o.material, world: 0, uv: 0 };
    r.world += m.world;
    r.uv += m.uv;
    reference.set(k, r);
  });

  const cache = new Map();
  const loader = new THREE.TextureLoader();
  const defaultIndex = Math.max(0, slot.options.findIndex((o) => baseName(o.name) === baseName(slot.default_material)));
  const defaultSize = slot.options[defaultIndex] ? slot.options[defaultIndex].width_cm : 0;

  function build(i) {
    if (cache.has(i)) { return cache.get(i); }
    const o = slot.options[i];
    const ref = reference.get(baseName(o.name));
    let mat;
    if (ref && ref.world > 0 && ref.uv > 0) {
      // Meme matiere que sur un autre objet : meme taille de motif.
      mat = ref.material.clone();
      const k = Math.sqrt(ref.uv / ref.world) / density;
      ['map', 'normalMap', 'roughnessMap', 'metalnessMap'].forEach((slotName) => {
        if (mat[slotName]) {
          mat[slotName] = mat[slotName].clone();
          mat[slotName].wrapS = mat[slotName].wrapT = THREE.RepeatWrapping;
          mat[slotName].repeat.set(k, k);
          mat[slotName].needsUpdate = true;
        }
      });
    } else {
      mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(o.hex || '#888888'), roughness: 0.8 });
      if (o.texture_file) {
        const tex = loader.load(o.texture_file);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        // Les UV reprennent l'echelle de la matiere d'origine ; une texture
        // de 2,54 cm signale un placement explicite (SketchUV) : UV conserves.
        const explicit = defaultSize > 0 && defaultSize <= 2.6;
        const k = (!explicit && defaultSize > 0 && o.width_cm > 0) ? defaultSize / o.width_cm : 1;
        tex.repeat.set(k, k);
        mat.map = tex;
        mat.color.set(0xffffff);
      }
    }
    cache.set(i, mat);
    return mat;
  }

  // La matiere d'origine des elements repeints reste telle quelle ; toute
  // autre option (y compris celle du slot, si elle ne couvrait pas l'objet)
  // est construite.
  const swap = {
    active: defaultIndex,
    select(i) {
      swap.active = i;
      const same = baseName(slot.options[i].name) === key;
      targets.forEach((p, n) => { p.mesh.material = same ? originals[n] : build(i); });
    }
  };
  swap.select(defaultIndex);   // comme Unreal au lancement de la visite
  return swap;
}

// Aires monde (m2) et UV d'une maille.
function measure(mesh) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  if (!pos || !uv) { return { world: 0, uv: 0 }; }
  mesh.updateWorldMatrix(true, false);
  const idx = g.index;
  const count = idx ? idx.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let world = 0;
  let uvArea = 0;
  const step = Math.max(3, Math.floor(count / 3 / 4000) * 3);   // echantillonnage des grosses mailles
  for (let i = 0; i + 2 < count; i += step) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
    world += b.sub(a).cross(c.sub(a)).length() * 0.5;
    const u0 = uv.getX(i0), v0 = uv.getY(i0);
    uvArea += Math.abs((uv.getX(i1) - u0) * (uv.getY(i2) - v0) - (uv.getX(i2) - u0) * (uv.getY(i1) - v0)) * 0.5;
  }
  return { world, uv: uvArea };
}

// « MI_Skp_tissu_2 » -> « tissu »
function baseName(name) {
  return (name || '').replace(/^MI_Skp_/, '').replace(/_\d+$/, '').toLowerCase();
}

function axisToScene(v) {
  return new THREE.Vector3(v.x, v.z, v.y).normalize();
}

function isAncestor(a, b) {
  for (let p = b.parent; p; p = p.parent) { if (p === a) { return true; } }
  return false;
}

export function isShown(o) {
  for (let p = o; p; p = p.parent) { if (!p.visible) { return false; } }
  return true;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) { n.className = cls; }
  if (text !== undefined) { n.textContent = text; }
  return n;
}
