// Game core: pose mapping, sword/shield equipment, hurtboxes, enemies, swept collision detection.
// Pure logic (only depends on three's math classes) so it can be unit-tested in Node.
import * as THREE from 'three';
import { LM, N_LM } from './protocol.js';
export { LM, N_LM };

const V3 = THREE.Vector3;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const STAND_HIP_Y = 0.95; // hips height above ground (m)
export const K_X = 2.8;          // metres of scene per unit of normalised image width (lateral dodge)
export const K_Y = 3.5;          // metres per unit of normalised image height (crouch / jump)
export const SPAWN_Z = -16;      // enemies spawn this far in front of the avatar
export const SWORD_LEN = 1.05;
export const SWORD_R = 0.06;
export const SHIELD_R = 0.38;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- One Euro filter: low jitter when still, low lag when moving fast ---------- */
class LowPass {
  constructor() { this.y = null; }
  filter(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; }
}
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 5, dCutoff = 1) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = new LowPass(); this.dx = new LowPass(); this.last = null;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, dt) {
    dt = Math.max(dt, 1e-3);
    if (this.last === null) { this.last = v; this.x.y = v; this.dx.y = 0; return v; }
    const dv = (v - this.last) / dt; this.last = v;
    const edv = this.dx.filter(dv, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edv);
    return this.x.filter(v, OneEuro.alpha(cutoff, dt));
  }
}

/* ---------- Calibration of the player's standing position (hip centre in the camera image) ---------- */
export class Calibrator {
  constructor(frames = 12) { this.frames = frames; this.reset(); }
  reset() { this.n = 0; this.sx = 0; this.sy = 0; this.done = false; this.x = 0.5; this.y = 0.5; }
  add(hx, hy) {
    if (this.done) return;
    this.sx += hx; this.sy += hy; this.n++;
    if (this.n >= this.frames) { this.x = this.sx / this.n; this.y = this.sy / this.n; this.done = true; }
  }
  // Image x grows to the right; the avatar's world x is mirrored (see PoseMapper), so signs are negated.
  offsets(hx, hy) {
    if (!this.done) return { x: 0, y: 0 };
    return { x: clamp(-(hx - this.x) * K_X, -2.2, 2.2), y: clamp(-(hy - this.y) * K_Y, -0.7, 0.6) };
  }
}

/* ---------- Pose -> avatar joints (Three.js world, avatar faces -z, camera behind at +z) ----------
   MediaPipe world landmarks: x -> image right, y -> down, z -> away from camera (negative = toward camera).
   Three:  x' = -x, y' = -y, z' = z   (a pure rotation, so the avatar is not mirrored: your right hand is its right hand) */
export class PoseMapper {
  constructor() {
    this.filters = Array.from({ length: N_LM * 3 }, () => new OneEuro(1.2, 5, 1));
    this.fox = new OneEuro(0.8, 2, 1); this.foy = new OneEuro(0.8, 2, 1);
    this.local = Array.from({ length: N_LM }, () => new V3());
    this.joints = Array.from({ length: N_LM }, () => new V3(0, STAND_HIP_Y, 0));
    this.cal = new Calibrator();
    this.mirrorX = true; // set false if left/right look swapped on your device
    this.lastT = null; this.has = false;
  }
  recalibrate() { this.cal.reset(); }
  update(msg, tSec) {
    const dt = this.lastT === null ? 1 / 30 : clamp(tSec - this.lastT, 1e-3, 0.2);
    this.lastT = tSec;
    this.cal.add(msg.h[0], msg.h[1]);
    const o = this.cal.offsets(msg.h[0], msg.h[1]);
    const ox = this.fox.filter(o.x, dt), oy = this.foy.filter(o.y, dt);
    const sx = this.mirrorX ? -1 : 1;
    for (let i = 0; i < N_LM; i++) {
      if (msg.w[i * 4 + 3] < 0.25 && this.has) continue; // low confidence: hold last position
      this.local[i].set(
        this.filters[i * 3].filter(sx * msg.w[i * 4], dt),
        this.filters[i * 3 + 1].filter(-msg.w[i * 4 + 1], dt),
        this.filters[i * 3 + 2].filter(msg.w[i * 4 + 2], dt));
    }
    for (let i = 0; i < N_LM; i++) {
      this.joints[i].set(this.local[i].x + ox, this.local[i].y + STAND_HIP_Y + oy, this.local[i].z);
    }
    this.has = true;
    return this.joints;
  }
}

/* ---------- geometry ---------- */
const _ab = new V3(), _ap = new V3();
export function distPointSegment(p, a, b) {
  _ab.subVectors(b, a); _ap.subVectors(p, a);
  const l2 = _ab.lengthSq();
  const t = l2 < 1e-9 ? 0 : clamp(_ap.dot(_ab) / l2, 0, 1);
  _ap.addScaledVector(_ab, -t);
  return _ap.length();
}

/* ---------- Sword (right hand) + shield (left forearm) ---------- */
export class Equipment {
  constructor() {
    this.sword = { base: new V3(), tip: new V3(), dir: new V3(0, 1, 0), speed: 0 };
    this.shield = { c: new V3(), n: new V3(0, 0, -1), R: SHIELD_R };
    this.prevTip = null;
    this._f = new V3(); this._h = new V3(); this._hc = new V3(); this._d = new V3();
  }
  update(j, dt) {
    const { sword, shield, _f, _h, _hc, _d } = this;
    // sword: forearm direction blended with hand direction
    _f.subVectors(j[LM.R_WR], j[LM.R_EL]).normalize();
    _hc.addVectors(j[LM.R_PINKY], j[LM.R_INDEX]).multiplyScalar(0.5);
    _h.subVectors(_hc, j[LM.R_WR]).normalize();
    _d.copy(_f).multiplyScalar(0.75).addScaledVector(_h, 0.25);
    if (_d.lengthSq() < 1e-6) _d.set(0, 1, 0);
    _d.normalize();
    sword.dir.copy(_d);
    sword.base.copy(j[LM.R_WR]).lerp(_hc, 0.5);
    sword.tip.copy(sword.base).addScaledVector(_d, SWORD_LEN);
    if (this.prevTip) {
      const raw = sword.tip.distanceTo(this.prevTip) / Math.max(dt, 1e-3);
      sword.speed += (raw - sword.speed) * 0.5;
    }
    this.prevTip = (this.prevTip || new V3()).copy(sword.tip);
    // shield: disc on the left forearm facing the enemies (-z)
    _f.subVectors(j[LM.L_WR], j[LM.L_EL]).normalize();
    // normal = "forward" made perpendicular to the forearm; when the forearm itself points
    // toward the enemies that projection degenerates, so blend back toward plain forward.
    const fz = _f.z; // dot(forearm, (0,0,-1)) = -fz
    _h.set(0, 0, -1).addScaledVector(_f, fz); // fwd - f*(f.fwd) = fwd + f*fz
    if (_h.lengthSq() < 1e-6) _h.set(0, 0, -1); else _h.normalize();
    const a = clamp((Math.abs(fz) - 0.5) / 0.4, 0, 1);
    _h.multiplyScalar(1 - a).z += -a;
    _h.normalize();
    shield.n.copy(_h);
    shield.c.copy(j[LM.L_EL]).lerp(j[LM.L_WR], 0.7).addScaledVector(shield.n, 0.1);
  }
}

/* ---------- Avatar hurtboxes (capsules) ---------- */
export class HurtBoxes {
  constructor() {
    this.caps = Array.from({ length: 11 }, () => ({ a: new V3(), b: new V3(), r: 0.1 }));
    this.torso = new V3(); this.head = new V3(); this._sh = new V3(); this._hip = new V3();
  }
  update(j) {
    let k = 0;
    const set = (a, b, r) => { const c = this.caps[k++]; c.a.copy(a); c.b.copy(b); c.r = r; };
    this.head.addVectors(j[LM.L_EAR], j[LM.R_EAR]).multiplyScalar(0.5);
    this._sh.addVectors(j[LM.L_SH], j[LM.R_SH]).multiplyScalar(0.5);
    this._hip.addVectors(j[LM.L_HIP], j[LM.R_HIP]).multiplyScalar(0.5);
    set(this.head, this.head, 0.13);
    set(this._sh, this._hip, 0.24);
    set(j[LM.L_SH], j[LM.R_SH], 0.09);
    set(j[LM.L_SH], j[LM.L_EL], 0.07); set(j[LM.L_EL], j[LM.L_WR], 0.06);
    set(j[LM.R_SH], j[LM.R_EL], 0.07); set(j[LM.R_EL], j[LM.R_WR], 0.06);
    set(j[LM.L_HIP], j[LM.L_KNEE], 0.1); set(j[LM.L_KNEE], j[LM.L_ANK], 0.08);
    set(j[LM.R_HIP], j[LM.R_KNEE], 0.1); set(j[LM.R_KNEE], j[LM.R_ANK], 0.08);
    this.torso.addVectors(this._sh, this._hip).multiplyScalar(0.5);
    return this;
  }
}

/* ---------- Game: enemy spawning, movement, swept collisions, scoring ---------- */
const _prev = new V3(), _p = new V3(), _t = new V3(), _hitPos = new V3();

export class Game {
  constructor(rng = Math.random) { this.rng = rng; this.reset(); }
  reset() {
    this.hp = 100; this.score = 0; this.combo = 0; this.time = 0;
    this.enemies = []; this.nextId = 1; this.spawnTimer = 1.5; this.over = false;
    this.stats = { blocks: 0, slashes: 0, hits: 0, kills: 0, misses: 0 };
  }
  get level() { return 1 + Math.floor(this.time / 20); }
  addScore(base) { this.score += Math.round(base * (1 + Math.min(this.combo, 20) * 0.1)); }

  spawnRaw(kind, pos, vel) {
    const brute = kind === 'brute';
    const e = {
      id: this.nextId++, kind, pos: pos.clone(), vel: vel.clone(),
      radius: brute ? 0.45 : 0.16, hp: brute ? 3 : 1, dmg: brute ? 25 : 10,
      cool: 0, deflected: false, age: 0,
    };
    this.enemies.push(e);
    return e;
  }
  spawnOrb(torso, zOff = 0, xBias = 0) {
    const r = this.rng, lvl = this.level;
    const near = r() < 0.7, sx = near ? 0.25 : 0.9, sy = near ? 0.35 : 0.7;
    const aim = new V3(torso.x + xBias * 0.5 + (r() * 2 - 1) * sx, clamp(torso.y + (r() * 2 - 1) * sy, 0.15, 1.9), torso.z);
    const from = new V3(torso.x + (r() * 2 - 1) * 3, 0.6 + r() * 1.8, SPAWN_Z - zOff);
    const speed = Math.min(14, 6 + 0.6 * (lvl - 1)) * (0.85 + 0.3 * r());
    return this.spawnRaw('orb', from, aim.sub(from).normalize().multiplyScalar(speed));
  }
  spawnBrute(torso) {
    const from = new V3(torso.x + (this.rng() * 2 - 1) * 2, 1.0, SPAWN_Z);
    const speed = 2.6 + 0.2 * this.level;
    return this.spawnRaw('brute', from, new V3(torso.x, 1.0, torso.z).sub(from).normalize().multiplyScalar(speed));
  }
  spawnPattern(torso) {
    const r = this.rng();
    if (this.level >= 2 && r < 0.15) this.spawnBrute(torso);
    else if (r < 0.6) this.spawnOrb(torso, 0);
    else for (let k = 0; k < 3; k++) this.spawnOrb(torso, k * 2.2, (k - 1) * 0.7);
  }

  // Priority at each sample along the swept path: shield > sword > body
  contact(e, p, equip, hurt) {
    const rr = e.radius;
    if (e.cool <= 0) {
      const s = equip.shield;
      _t.subVectors(p, s.c);
      const d = _t.dot(s.n);
      if (Math.abs(d) <= rr + 0.05 && e.vel.dot(s.n) < 0) {
        _t.addScaledVector(s.n, -d);
        if (_t.length() <= s.R + rr * 0.5) return 'shield';
      }
      if (distPointSegment(p, equip.sword.base, equip.sword.tip) <= rr + SWORD_R) return 'sword';
    }
    for (const c of hurt.caps) if (distPointSegment(p, c.a, c.b) <= rr + c.r) return 'body';
    return null;
  }

  resolve(e, idx, hit, equip, ev) {
    const pos = _hitPos.clone();
    if (hit === 'shield') {
      this.stats.blocks++; this.combo++; this.addScore(5);
      if (e.kind === 'orb') this.enemies.splice(idx, 1); else { e.pos.z -= 2.5; e.cool = 0.5; }
      ev.push({ type: 'block', pos, kind: e.kind });
    } else if (hit === 'sword') {
      const sp = equip.sword.speed;
      this.stats.slashes++; this.combo++;
      if (e.kind === 'orb') {
        e.deflected = true;
        e.vel.set((this.rng() - 0.5) * 4, this.rng() * 3, -Math.abs(e.vel.z) * 1.3 - 4);
        this.addScore(10 + (sp > 2.5 ? 5 : 0));
        ev.push({ type: 'slash', pos, speed: sp, kind: 'orb' });
      } else {
        e.hp -= sp > 2.5 ? 2 : 1; e.cool = 0.3; e.pos.z -= 1.0;
        if (e.hp <= 0) {
          this.enemies.splice(idx, 1); this.stats.kills++; this.addScore(50);
          ev.push({ type: 'kill', pos, kind: 'brute' });
        } else ev.push({ type: 'slash', pos, speed: sp, kind: 'brute' });
      }
    } else {
      this.hp -= e.dmg; this.combo = 0; this.stats.hits++;
      this.enemies.splice(idx, 1);
      ev.push({ type: 'hit', pos, dmg: e.dmg, kind: e.kind });
      if (this.hp <= 0) { this.hp = 0; this.over = true; ev.push({ type: 'gameover' }); }
    }
  }

  update(dt, equip, hurt) {
    const ev = [];
    if (this.over) return ev;
    this.time += dt; this.spawnTimer -= dt;
    while (this.spawnTimer <= 0) {
      this.spawnPattern(hurt.torso);
      this.spawnTimer += Math.max(0.6, 2.3 - 0.12 * (this.level - 1)) * (0.7 + 0.6 * this.rng());
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.age += dt; e.cool = Math.max(0, e.cool - dt);
      _prev.copy(e.pos); e.pos.addScaledVector(e.vel, dt);
      if (e.deflected) { if (e.pos.z < -26) this.enemies.splice(i, 1); continue; }
      const steps = Math.max(1, Math.ceil(_prev.distanceTo(e.pos) / 0.08)); // swept test: no tunnelling
      let hit = null;
      for (let s = 1; s <= steps && !hit; s++) {
        _p.lerpVectors(_prev, e.pos, s / steps);
        hit = this.contact(e, _p, equip, hurt);
        if (hit) _hitPos.copy(_p);
      }
      if (hit) { this.resolve(e, i, hit, equip, ev); if (this.over) break; }
      else if (e.pos.z > 2.2) { this.enemies.splice(i, 1); this.stats.misses++; ev.push({ type: 'miss' }); }
    }
    return ev;
  }
}

/* ---------- Synthetic pose generator (demo mode + tests) ---------- */
export function syntheticPose(t, seq = 0) {
  const P = Array.from({ length: N_LM }, () => [0, 0, 0]);
  const set = (i, x, y, z) => { P[i] = [x, y, z]; };
  const add = (a, d, k, o = [0, 0, 0]) => [a[0] + d[0] * k + o[0], a[1] + d[1] * k + o[1], a[2] + d[2] * k + o[2]];
  for (const i of [0, 1, 2, 3, 4, 5, 6, 9, 10]) set(i, 0, -0.62, -0.05);
  set(7, 0.09, -0.6, 0); set(8, -0.09, -0.6, 0);
  set(11, 0.2, -0.45, 0); set(12, -0.2, -0.45, 0);
  // right arm (image-left) swings the sword across the body
  const phi = 1.5 * Math.sin(2 * Math.PI * 0.8 * t);
  const dl = Math.hypot(Math.sin(phi), Math.cos(phi), 0.35);
  const d = [Math.sin(phi) / dl, -Math.cos(phi) / dl, -0.35 / dl];
  const el = [-0.3, -0.28, -0.15]; set(14, ...el);
  const wr = add(el, d, 0.27); set(16, ...wr);
  set(18, ...add(wr, d, 0.07, [0.02, 0, 0])); set(20, ...add(wr, d, 0.09)); set(22, ...add(wr, d, 0.05, [-0.02, 0, 0]));
  // left arm holds the shield up in front of the chest
  set(13, 0.3, -0.22, -0.1); set(15, 0.15, -0.42, -0.38);
  set(17, 0.16, -0.46, -0.4); set(19, 0.14, -0.47, -0.4); set(21, 0.13, -0.45, -0.39);
  set(23, 0.1, 0, 0); set(24, -0.1, 0, 0);
  set(25, 0.11, 0.43, 0); set(26, -0.11, 0.43, 0);
  set(27, 0.12, 0.85, 0); set(28, -0.12, 0.85, 0);
  set(29, 0.12, 0.9, 0.03); set(30, -0.12, 0.9, 0.03);
  set(31, 0.12, 0.92, -0.1); set(32, -0.12, 0.92, -0.1);
  const w = [];
  for (const p of P) w.push(p[0], p[1], p[2], 1);
  return { t: 'p', s: seq, w, h: [0.5 + 0.25 * Math.sin(2 * Math.PI * 0.1 * t), 0.5] };
}
