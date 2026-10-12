import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  PoseMapper, Equipment, HurtBoxes, Game, mulberry32, syntheticPose, OneEuro, Calibrator,
  distPointSegment, LM, STAND_HIP_Y, K_X,
} from '../game-core.js';
import { encodePose, validPose, N_LM } from '../protocol.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function rig(t = 0) {
  const m = new PoseMapper(), eq = new Equipment(), hb = new HurtBoxes();
  for (let i = 0; i < 20; i++) { const j = m.update(syntheticPose(t, i), i / 30); eq.update(j, 1 / 30); hb.update(j); }
  return { m, eq, hb };
}
function farEquip(eq) {
  eq.shield.c.set(50, 50, 50); eq.sword.base.set(50, 50, 50); eq.sword.tip.set(51, 50, 50); eq.sword.speed = 0;
}

test('protocol round trip + validation', () => {
  const lm = Array.from({ length: N_LM }, (_, i) => ({ x: i / 100, y: -i / 100, z: 0.01 * i, visibility: 0.9 }));
  const msg = encodePose(7, lm, lm.map(p => ({ x: 0.5, y: 0.6 })));
  assert.ok(validPose(JSON.parse(JSON.stringify(msg))));
  assert.ok(JSON.stringify(msg).length < 2500, 'payload small enough for 30+ Hz');
  const bad = JSON.parse(JSON.stringify(msg)); bad.w[3] = null;
  assert.equal(validPose(bad), false);
  assert.equal(validPose({ t: 'p' }), false);
});

test('pose mapping: avatar is not mirrored and faces -z', () => {
  const { m } = rig(0);
  const j = m.joints;
  assert.ok(j[LM.R_SH].x > 0 && j[LM.L_SH].x < 0, 'right side is +x');
  assert.ok(j[LM.L_WR].z < 0, 'reaching toward the camera = forward = -z');
  assert.ok(j[LM.R_WR].y > STAND_HIP_Y, 'raised wrist is above hips');
  assert.ok(Math.abs(j[LM.L_HIP].y - STAND_HIP_Y) < 0.02);
});

test('calibration + dodge offsets have the right sign', () => {
  const c = new Calibrator();
  for (let i = 0; i < 12; i++) c.add(0.5, 0.5);
  assert.ok(c.done);
  const o = c.offsets(0.6, 0.5);
  assert.ok(Math.abs(o.x + 0.1 * K_X) < 1e-9, 'moving image-right moves avatar to its left (-x)');
  assert.ok(c.offsets(0.5, 0.6).y < 0, 'hips lower in image = crouch');
});

test('low visibility joint holds last position', () => {
  const m = new PoseMapper();
  const msg = syntheticPose(0, 0);
  for (let i = 0; i < 5; i++) m.update(msg, i / 30);
  const before = m.joints[LM.R_WR].clone();
  const bad = JSON.parse(JSON.stringify(msg));
  bad.w[LM.R_WR * 4] += 5; bad.w[LM.R_WR * 4 + 3] = 0.05;
  m.update(bad, 6 / 30);
  assert.ok(m.joints[LM.R_WR].distanceTo(before) < 1e-6);
});

test('one-euro filter: stable on constant, converges on step, reduces jitter', () => {
  const f = new OneEuro();
  for (let i = 0; i < 30; i++) assert.ok(Math.abs(f.filter(1, 1 / 30) - 1) < 1e-9);
  let v = 0; for (let i = 0; i < 20; i++) v = f.filter(2, 1 / 30);
  assert.ok(Math.abs(v - 2) < 0.05);
  const g = new OneEuro(), rng = mulberry32(3); let raw = 0, filt = 0, prev = 0;
  for (let i = 0; i < 300; i++) { const n = (rng() - 0.5) * 0.04, o = g.filter(n, 1 / 30); if (i > 30) { raw += n * n; filt += o * o; prev = o; } }
  assert.ok(filt < raw * 0.5, `filtered ${filt} vs raw ${raw}`);
  assert.ok(Number.isFinite(prev));
});

test('distPointSegment', () => {
  assert.ok(Math.abs(distPointSegment(V(0, 1, 0), V(-1, 0, 0), V(1, 0, 0)) - 1) < 1e-9);
  assert.ok(Math.abs(distPointSegment(V(3, 0, 0), V(-1, 0, 0), V(1, 0, 0)) - 2) < 1e-9);
});

test('equipment follows the hands (sword on right, shield on left, shield faces enemies)', () => {
  const { m, eq } = rig(0);
  assert.ok(eq.sword.base.distanceTo(m.joints[LM.R_WR]) < 0.12);
  assert.ok(Math.abs(eq.sword.tip.distanceTo(eq.sword.base) - 1.05) < 1e-6);
  assert.ok(eq.sword.dir.y > 0.8, 'forearm up -> sword up');
  assert.ok(eq.shield.n.z < -0.7, 'shield normal points to -z');
  assert.ok(eq.shield.c.distanceTo(m.joints[LM.L_WR]) < 0.4);
});

test('body hit reduces hp and removes the enemy', () => {
  const { eq, hb } = rig(0); farEquip(eq);
  const g = new Game(mulberry32(1)); g.spawnTimer = 999;
  g.spawnRaw('orb', V(0.1, 0.55, -10), V(0, 0, 10));
  let ev = [];
  for (let i = 0; i < 90 && !ev.some(e => e.type === 'hit'); i++) ev = g.update(1 / 30, eq, hb);
  assert.equal(g.hp, 90); assert.equal(g.enemies.length, 0); assert.equal(g.combo, 0);
});

test('shield blocks without damage', () => {
  const { eq, hb } = rig(0); farEquip(eq);
  eq.shield.c.set(0, 1.3, -0.5); eq.shield.n.set(0, 0, -1);
  const g = new Game(mulberry32(1)); g.spawnTimer = 999;
  g.spawnRaw('orb', V(0.1, 1.3, -10), V(0, 0, 10));
  const evs = []; for (let i = 0; i < 90; i++) evs.push(...g.update(1 / 30, eq, hb));
  assert.ok(evs.some(e => e.type === 'block'));
  assert.equal(g.hp, 100); assert.equal(g.stats.blocks, 1); assert.equal(g.combo, 1);
});

test('shield edge-on does not block (needs to face the enemy)', () => {
  const { eq, hb } = rig(0); farEquip(eq);
  eq.shield.c.set(0, 1.3, -0.5); eq.shield.n.set(1, 0, 0); // turned sideways
  const g = new Game(mulberry32(1)); g.spawnTimer = 999;
  g.spawnRaw('orb', V(0.05, 1.2, -10), V(0, 0, 10));
  for (let i = 0; i < 90; i++) g.update(1 / 30, eq, hb);
  assert.equal(g.stats.blocks, 0);
});

test('sword slashes and deflects orbs back', () => {
  const { eq, hb } = rig(0); farEquip(eq);
  eq.sword.base.set(-0.5, 1.3, -0.4); eq.sword.tip.set(0.5, 1.3, -0.4); eq.sword.speed = 4;
  const g = new Game(mulberry32(1)); g.spawnTimer = 999;
  const e = g.spawnRaw('orb', V(0, 1.3, -10), V(0, 0, 10));
  const evs = []; for (let i = 0; i < 90; i++) evs.push(...g.update(1 / 30, eq, hb));
  assert.ok(evs.some(x => x.type === 'slash'));
  assert.ok(e.deflected && e.vel.z < 0);
  assert.equal(g.hp, 100); assert.ok(g.score >= 15);
});

test('no tunnelling: 300 m/s projectile is still caught by shield and by body', () => {
  const { eq, hb } = rig(0); farEquip(eq);
  eq.shield.c.set(0, 1.3, -0.5); eq.shield.n.set(0, 0, -1);
  let g = new Game(mulberry32(1)); g.spawnTimer = 999;
  g.spawnRaw('orb', V(0, 1.3, -5), V(0, 0, 300));
  g.update(1 / 30, eq, hb);
  assert.equal(g.stats.blocks, 1);
  farEquip(eq);
  g = new Game(mulberry32(1)); g.spawnTimer = 999;
  g.spawnRaw('orb', V(0.1, 0.55, -5), V(0, 0, 300));
  g.update(1 / 30, eq, hb);
  assert.equal(g.stats.hits, 1);
});

test('orb that passes the avatar is a miss, no damage', () => {
  const { eq, hb } = rig(0); farEquip(eq);
  const g = new Game(mulberry32(1)); g.spawnTimer = 999;
  g.spawnRaw('orb', V(4, 1.3, -10), V(0, 0, 10));
  const evs = []; for (let i = 0; i < 120; i++) evs.push(...g.update(1 / 30, eq, hb));
  assert.ok(evs.some(e => e.type === 'miss')); assert.equal(g.hp, 100); assert.equal(g.enemies.length, 0);
});

test('brute: needs multiple sword hits, has hit cooldown, awards score', () => {
  const { eq, hb } = rig(0); farEquip(eq);
  eq.sword.base.set(-0.8, 1.0, -1.2); eq.sword.tip.set(0.8, 1.0, -1.2); eq.sword.speed = 3;
  const g = new Game(mulberry32(1)); g.spawnTimer = 999;
  const b = g.spawnRaw('brute', V(0, 1.0, -8), V(0, 0, 3));
  const evs = []; for (let i = 0; i < 400 && g.enemies.length; i++) evs.push(...g.update(1 / 30, eq, hb));
  assert.equal(g.stats.kills, 1, 'brute died to sword hits');
  assert.ok(evs.filter(e => e.type === 'slash').length >= 1 && evs.some(e => e.type === 'kill'));
  assert.ok(g.score >= 50); assert.equal(g.hp, 100); assert.ok(b.hp <= 0);
});

test('brute body hit does 25 damage; game over at 0 hp and stops updating', () => {
  const { eq, hb } = rig(0); farEquip(eq);
  const g = new Game(mulberry32(1)); g.spawnTimer = 999; g.hp = 20;
  g.spawnRaw('brute', V(0, 1.0, -3), V(0, 0, 5));
  const evs = []; for (let i = 0; i < 60; i++) evs.push(...g.update(1 / 30, eq, hb));
  assert.ok(evs.some(e => e.type === 'gameover')); assert.equal(g.hp, 0); assert.ok(g.over);
  assert.deepEqual(g.update(1 / 30, eq, hb), []);
  g.reset(); assert.equal(g.hp, 100); assert.equal(g.over, false);
});

test('spawner is random but seeded-deterministic, aims at the player, scales with level', () => {
  const run = (seed) => {
    const { eq, hb } = rig(0); farEquip(eq);
    const g = new Game(mulberry32(seed)); const log = [];
    for (let i = 0; i < 900; i++) { g.update(1 / 30, eq, hb); if (g.nextId > log.length + 1) log.push(g.nextId); }
    return { g, n: g.nextId };
  };
  const a = run(5), b = run(5), c = run(6);
  assert.equal(a.n, b.n); assert.notEqual(a.n, c.n);
  assert.ok(a.n > 10, 'enemies were spawned');
  const g = new Game(mulberry32(2)); const { hb } = rig(0);
  const o = g.spawnOrb(hb.torso); assert.ok(o.vel.z > 0, 'flies toward the avatar');
  g.time = 100; assert.equal(g.level, 6);
});

test('soak: 5 simulated minutes of swinging demo pose stays finite and does fight', () => {
  const m = new PoseMapper(), eq = new Equipment(), hb = new HurtBoxes(), g = new Game(mulberry32(42));
  const dt = 1 / 60; let t = 0, evs = 0, deaths = 0;
  const tot = { blocks: 0, slashes: 0, hits: 0, kills: 0, misses: 0 };
  const bank = () => { for (const k in tot) tot[k] += g.stats[k]; };
  for (let i = 0; i < 60 * 300; i++) {
    t += dt;
    if (i % 2 === 0) m.update(syntheticPose(t, i), t);
    eq.update(m.joints, dt); hb.update(m.joints);
    evs += g.update(dt, eq, hb).length;
    if (g.over) { bank(); deaths++; g.reset(); }
    assert.ok(Number.isFinite(g.hp) && Number.isFinite(g.score));
  }
  bank();
  assert.ok(tot.slashes + tot.blocks > 5, JSON.stringify(tot));
  assert.ok(tot.hits > 0 && tot.misses > 0, 'both hits and dodges/misses occur');
  assert.ok(g.enemies.length < 40, 'enemy list does not leak');
  console.log('  soak totals', JSON.stringify(tot), 'deaths', deaths, 'events', evs);
});

test('end-to-end wire pipeline with MediaPipe-shaped landmarks (player encode -> JSON -> viewer)', () => {
  const m = new PoseMapper(), eq = new Equipment(), hb = new HurtBoxes(), g = new Game(mulberry32(9));
  let bytes = 0, n = 0, lastSeq = -1;
  for (let i = 0; i < 300; i++) {
    const t = i / 30, syn = syntheticPose(t, 0);
    const world = Array.from({ length: N_LM }, (_, k) => ({ x: syn.w[k * 4], y: syn.w[k * 4 + 1], z: syn.w[k * 4 + 2], visibility: 0.97 }));
    const image = world.map((p, k) => ({ x: k === 23 || k === 24 ? syn.h[0] : 0.5, y: 0.5, z: 0 }));
    const wire = JSON.stringify(encodePose(i, world, image));   // what PeerJS 'json' serialization sends
    bytes += wire.length; n++;
    const msg = JSON.parse(wire);
    if (!validPose(msg) || msg.s <= lastSeq) continue;
    lastSeq = msg.s;
    m.update(msg, t); eq.update(m.joints, 1 / 30); hb.update(m.joints); g.update(1 / 30, eq, hb);
  }
  assert.ok(m.cal.done && m.has);
  console.log(`  wire: ${(bytes / n) | 0} bytes/pose -> ${(((bytes / n) * 40) / 1024).toFixed(1)} KB/s at 40 Hz`);
  assert.ok((bytes / n) * 40 < 60000, 'bandwidth well within mobile limits');
});
