// ECHO//VOID gameplay camera: pure logic, no WebGPU/DOM. Testable in Node.
// Smooth follow + velocity lookahead, trauma shake, music-reactive focal,
// sprint/dodge/boss/silence behavior, per-world modifiers. All outputs finite.
export const BASE_FOCAL = 520;
export const FOCAL_MIN = 380;
export const FOCAL_MAX = 720;
export const MAX_SHAKE = 26;
export const MAX_CAM = 20000;

export const WORLD_CAM = {
  "CALM MEADOW":   { follow: 5.0, lookahead: 0.35, shake: 1.0, zoomAmp: 1.0,  jitter: 0 },
  "NEON CITY":     { follow: 7.0, lookahead: 0.45, shake: 0.9, zoomAmp: 1.1,  jitter: 0 },
  "PAPER FOREST":  { follow: 5.0, lookahead: 0.30, shake: 1.0, zoomAmp: 1.0,  jitter: 0 },
  "CANDY PLAINS":  { follow: 5.5, lookahead: 0.40, shake: 1.1, zoomAmp: 1.15, jitter: 0 },
  "VOID GARDEN":   { follow: 3.2, lookahead: 0.20, shake: 0.7, zoomAmp: 0.7,  jitter: 0 },
  "GLITCH DESERT": { follow: 5.0, lookahead: 0.35, shake: 1.2, zoomAmp: 1.0,  jitter: 5 },
  default:         { follow: 5.0, lookahead: 0.35, shake: 1.0, zoomAmp: 1.0,  jitter: 0 },
};

const fin = (x, d = 0) => (Number.isFinite(x) ? x : d);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;

export function worldCamProps(worldName) {
  return WORLD_CAM[worldName] || WORLD_CAM.default;
}

export function createCamera() {
  return { x: 0, y: 0, vx: 0, vy: 0, trauma: 0, focal: BASE_FOCAL, horizonFrac: 0.58 };
}

export function addShake(cam, amount) {
  cam.trauma = clamp01(fin(cam.trauma) + clamp01(fin(amount) / 1));
  return cam.trauma;
}

export function updateCamera(cam, input = {}) {
  const wp = worldCamProps(input.worldName);
  const dt = clamp(fin(input.dt, 1 / 60), 0, 0.1);
  const t = fin(input.time);
  const px = fin(input.playerX), py = fin(input.playerY);
  const ivx = clamp(fin(input.playerVX), -4000, 4000);
  const ivy = clamp(fin(input.playerVY), -4000, 4000);
  const sprinting = !!input.sprinting, dodging = !!input.dodging;
  const hasBoss = !!input.hasBoss && finiteNum(input.bossX) && finiteNum(input.bossY);
  const bx = fin(input.bossX), by = fin(input.bossY);
  const bassSpike = clamp01(fin(input.bassSpike));
  const beat = clamp01(fin(input.beat));
  const intensity = clamp01(fin(input.intensity));
  const silence = clamp01(fin(input.silence));
  const viewH = clamp(fin(input.viewH, 800) || 800, 1, 10000);
  const silenced = silence > 0.5;

  // Smoothed velocity estimate (drives lookahead).
  const kv = 1 - Math.exp(-dt * 8);
  cam.vx = fin(cam.vx) + (ivx - fin(cam.vx)) * kv;
  cam.vy = fin(cam.vy) + (ivy - fin(cam.vy)) * kv;

  // Follow target: player + velocity lookahead, boss midpoint bias, dodge nudge.
  const look = wp.lookahead * 0.14;
  let tx = px + cam.vx * look;
  let ty = py + cam.vy * look;
  if (hasBoss) {
    tx = lerp(tx, (px + bx) / 2, 0.25);
    ty = lerp(ty, (py + by) / 2, 0.25);
    tx += Math.sin(t * 0.6) * 10;
    ty += Math.cos(t * 0.45) * 8;
  }
  if (dodging) {
    const sp = Math.hypot(cam.vx, cam.vy);
    if (sp > 1) { tx += (cam.vx / sp) * 30; ty += (cam.vy / sp) * 30; }
  }
  let follow = wp.follow * (sprinting ? 0.55 : 1) * (dodging ? 1.6 : 1);
  follow = fin(follow, 5);
  const k = 1 - Math.exp(-dt * follow);
  cam.x = fin(cam.x) + (tx - fin(cam.x)) * k;
  cam.y = fin(cam.y) + (ty - fin(cam.y)) * k;

  // Trauma: bass spikes + beat kicks + boss rumble; fast decay in silence.
  cam.trauma = clamp01(fin(cam.trauma));
  if (silenced) {
    cam.trauma = Math.max(0, cam.trauma - dt * 6);
  } else {
    cam.trauma = clamp01(cam.trauma + bassSpike * 0.7 + beat * 0.15 + (hasBoss ? dt * 0.25 : 0));
    cam.trauma = Math.max(0, cam.trauma - dt * 1.4);
  }

  // Shake: trauma^2 * maxOffset, deterministic sin noise; dodge i-frames steady it.
  let mag = cam.trauma * cam.trauma * MAX_SHAKE * fin(wp.shake, 1);
  if (dodging) mag *= 0.35;
  let shakeX = mag * Math.sin(t * 47.3);
  let shakeY = mag * Math.sin(t * 39.7 + 1.3);
  const jit = fin(wp.jitter, 0);
  if (jit > 0 && !silenced) {
    shakeX += jit * Math.sin(t * 61.7) * intensity;
    shakeY += jit * Math.sin(t * 55.3 + 2.1) * intensity;
  }
  shakeX = clamp(fin(shakeX), -40, 40);
  shakeY = clamp(fin(shakeY), -40, 40);

  // Focal: intensity zoom-in (up to +12%), bass punch, beat nudge, sprint/dodge/boss widen; frozen in silence.
  let ft;
  if (silenced) {
    ft = BASE_FOCAL * (hasBoss ? 0.85 : 1);
  } else {
    ft = BASE_FOCAL * (1 + 0.12 * intensity * fin(wp.zoomAmp, 1)) + bassSpike * 90 + beat * 10;
    if (sprinting) ft *= 0.96;
    if (dodging) ft += 28;
    if (hasBoss) ft *= 0.85;
  }
  ft = clamp(fin(ft, BASE_FOCAL), FOCAL_MIN, FOCAL_MAX);
  cam.focal = clamp(fin(cam.focal, BASE_FOCAL) + (ft - fin(cam.focal, BASE_FOCAL)) * (1 - Math.exp(-dt * 6)), FOCAL_MIN, FOCAL_MAX);

  // Horizon: gentle intensity lift, boss dips it, stable in silence.
  let hf = 0.58 + (silenced ? 0 : 0.04 * intensity) + (hasBoss ? -0.02 : 0);
  hf = clamp(fin(hf, 0.58), 0.3, 0.75);
  cam.horizonFrac = clamp(fin(cam.horizonFrac, 0.58) + (hf - fin(cam.horizonFrac, 0.58)) * (1 - Math.exp(-dt * 6)), 0.3, 0.75);

  const x = clamp(fin(cam.x), -MAX_CAM, MAX_CAM);
  const y = clamp(fin(cam.y), -MAX_CAM, MAX_CAM);
  cam.x = x; cam.y = y;
  const focal = fin(cam.focal, BASE_FOCAL);
  return { x, y, focal, horizon: cam.horizonFrac * viewH, shakeX, shakeY, zoom: focal / BASE_FOCAL };
}

function finiteNum(x) { return typeof x === "number" && Number.isFinite(x); }

export class Camera {
  constructor() { Object.assign(this, createCamera()); }
  addShake(amount) { return addShake(this, amount); }
  update(input) { return updateCamera(this, input); }
  reset(x = 0, y = 0) {
    Object.assign(this, createCamera(), { x: fin(x), y: fin(y) });
  }
}
