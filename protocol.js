// Wire protocol shared by player.html and viewer.html (no dependencies).
// Pose message: { t:'p', s:seq, w:[x,y,z,vis]*33 (world landmarks, metres, hip-origin), h:[hipX,hipY] (image, 0..1) }

export const N_LM = 33;
export const LM = {
  NOSE: 0, L_EAR: 7, R_EAR: 8,
  L_SH: 11, R_SH: 12, L_EL: 13, R_EL: 14, L_WR: 15, R_WR: 16,
  L_PINKY: 17, R_PINKY: 18, L_INDEX: 19, R_INDEX: 20, L_THUMB: 21, R_THUMB: 22,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANK: 27, R_ANK: 28,
  L_HEEL: 29, R_HEEL: 30, L_FOOT: 31, R_FOOT: 32,
};

export const ROOM_PREFIX = 'vrcombat-';
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const r3 = (v) => Math.round(v * 1000) / 1000;

export function encodePose(seq, world, image) {
  const w = new Array(N_LM * 4);
  for (let i = 0; i < N_LM; i++) {
    const p = world[i];
    w[i * 4] = r3(p.x);
    w[i * 4 + 1] = r3(p.y);
    w[i * 4 + 2] = r3(p.z);
    w[i * 4 + 3] = Math.round((p.visibility ?? 1) * 100) / 100;
  }
  const hx = (image[23].x + image[24].x) / 2;
  const hy = (image[23].y + image[24].y) / 2;
  return { t: 'p', s: seq, w, h: [r3(hx), r3(hy)] };
}

export function validPose(m) {
  if (!m || m.t !== 'p' || !Array.isArray(m.w) || m.w.length !== N_LM * 4) return false;
  if (!Array.isArray(m.h) || m.h.length !== 2 || !Number.isFinite(m.s)) return false;
  for (const v of m.w) if (!Number.isFinite(v)) return false;
  return Number.isFinite(m.h[0]) && Number.isFinite(m.h[1]);
}
