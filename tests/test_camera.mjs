import { readFileSync } from "node:fs";
import { Camera, updateCamera, createCamera, worldCamProps, WORLD_CAM, BASE_FOCAL, FOCAL_MIN, FOCAL_MAX } from "./camera.js";

const webgpuSrc = readFileSync(new URL("../src/webgpu.js", import.meta.url), "utf8");
const camSrc = readFileSync(new URL("../src/camera.js", import.meta.url), "utf8");
const camCopySrc = readFileSync(new URL("./camera.js", import.meta.url), "utf8");
const gameSrc = readFileSync(new URL("../src/game.js", import.meta.url), "utf8");
const underTestSrc = readFileSync(new URL("./webgpu_under_test.mjs", import.meta.url), "utf8");

let pass = 0, fail = 0;
const out = [];
function check(name, cond, detail) {
  if (cond) { pass++; out.push("PASS " + name); }
  else { fail++; out.push("FAIL " + name + " " + (detail || "")); }
}
const finite = (x) => Number.isFinite(x);
function outFinite(o) {
  return finite(o.x) && finite(o.y) && finite(o.focal) && finite(o.horizon) &&
    finite(o.shakeX) && finite(o.shakeY) && finite(o.zoom);
}
function baseInput(over = {}) {
  return {
    playerX: 0, playerY: 0, playerVX: 0, playerVY: 0,
    sprinting: false, dodging: false,
    hasBoss: false, bossX: 0, bossY: 0,
    bass: 0.2, treble: 0.2, intensity: 0.3, beat: 0, bassSpike: 0, silence: 0,
    worldName: "CALM MEADOW", time: 10, dt: 0.016, viewH: 800, ...over,
  };
}
function settled(worldName, over = {}, steps = 180) {
  const cam = new Camera();
  let o = null;
  for (let i = 0; i < steps; i++) {
    o = cam.update(baseInput({ worldName, time: 10 + i * 0.016, ...over }));
  }
  return { cam, o };
}

// --- API shape ---
check("exports Camera class", typeof Camera === "function");
check("exports updateCamera", typeof updateCamera === "function");
check("exports createCamera", typeof createCamera === "function");
check("exports worldCamProps", typeof worldCamProps === "function");
check("exports WORLD_CAM table", typeof WORLD_CAM === "object" && !!WORLD_CAM["VOID GARDEN"]);
check("base focal 520", BASE_FOCAL === 520);
check("focal clamps consts", FOCAL_MIN === 380 && FOCAL_MAX === 720);
{
  const cam = new Camera();
  check("Camera has addShake", typeof cam.addShake === "function");
  check("Camera has update", typeof cam.update === "function");
  const o = cam.update(baseInput());
  check("update returns all keys",
    ["x", "y", "focal", "horizon", "shakeX", "shakeY", "zoom"].every((k) => k in o), JSON.stringify(o));
  check("outputs finite on base input", outFinite(o));
  check("zoom consistent focal/520", Math.abs(o.zoom - o.focal / 520) < 1e-9, String(o.zoom));
}

// --- smooth follow: converges, not snap ---
{
  const cam = new Camera();
  const step1 = cam.update(baseInput({ playerX: 1000, playerY: 0 }));
  check("follow not 1:1 snap", step1.x < 1000 && step1.x > 0, String(step1.x));
  let o = step1;
  for (let i = 0; i < 300; i++) o = cam.update(baseInput({ playerX: 1000, playerY: 0, time: 10 + i * 0.016 }));
  check("follow converges", Math.abs(o.x - 1000) < 5, String(o.x));
}
// --- lag: world follow speeds differ ---
{
  const a = settled("NEON CITY", { playerX: 1000 }, 40);
  const b = settled("VOID GARDEN", { playerX: 1000 }, 40);
  check("snappy world leads heavy world", a.o.x > b.o.x + 1, `${a.o.x} vs ${b.o.x}`);
}
{
  const slow = settled("VOID GARDEN", { playerX: 800 }, 30);
  check("world modifiers differ", settled("NEON CITY", { playerX: 800 }, 30).o.x !== slow.o.x);
}
// --- lookahead by velocity ---
{
  const still = settled("CALM MEADOW", { playerVX: 0 }, 60);
  const moving = settled("CALM MEADOW", { playerVX: 1200 }, 60);
  check("lookahead shifts toward velocity", moving.o.x > still.o.x + 1, `${moving.o.x} vs ${still.o.x}`);
}
// --- trauma: decays ---
{
  const cam = new Camera();
  cam.addShake(1);
  const t0 = cam.trauma;
  cam.update(baseInput({ time: 11 }));
  cam.update(baseInput({ time: 11.5 }));
  check("trauma decays", cam.trauma < t0, `${cam.trauma} vs ${t0}`);
  check("trauma clamped 0..1", cam.trauma >= 0 && cam.trauma <= 1);
}
// --- bass adds shake, beat kicks ---
{
  const calm = settled("CALM MEADOW", { bassSpike: 0, beat: 0 }, 5);
  const c2 = new Camera();
  c2.addShake(0.01);
  let loud = null;
  for (let i = 0; i < 5; i++) loud = c2.update(baseInput({ bassSpike: 0.8, beat: 1, time: 20 + i * 0.016 }));
  check("bass spike adds shake", Math.hypot(loud.shakeX, loud.shakeY) > Math.hypot(calm.o.shakeX, calm.o.shakeY) + 0.5,
    `${Math.hypot(loud.shakeX, loud.shakeY)} vs ${Math.hypot(calm.o.shakeX, calm.o.shakeY)}`);
}
// --- deterministic noise ---
{
  const r1 = settled("CALM MEADOW", { bassSpike: 0.5 }, 10);
  const r2 = settled("CALM MEADOW", { bassSpike: 0.5 }, 10);
  check("shake deterministic", r1.o.shakeX === r2.o.shakeX && r1.o.shakeY === r2.o.shakeY);
}
// --- silence kills shake + freezes zoom ---
{
  const loud = settled("CALM MEADOW", { bassSpike: 0.9, beat: 1, intensity: 0.9, silence: 0 }, 120);
  const quiet = settled("CALM MEADOW", { bassSpike: 0.9, beat: 1, intensity: 0.9, silence: 1 }, 120);
  check("silence damps shake ~0", Math.hypot(quiet.o.shakeX, quiet.o.shakeY) < 0.05,
    String(Math.hypot(quiet.o.shakeX, quiet.o.shakeY)));
  check("silence shake < loud shake", Math.hypot(quiet.o.shakeX, quiet.o.shakeY) < Math.hypot(loud.o.shakeX, loud.o.shakeY));
  const s0 = settled("CALM MEADOW", { intensity: 0, silence: 1 }, 150);
  const s1 = settled("CALM MEADOW", { intensity: 1, silence: 1 }, 150);
  check("silence freezes zoom pulse", Math.abs(s0.o.focal - s1.o.focal) < 2, `${s0.o.focal} vs ${s1.o.focal}`);
}
// --- music zoom: intensity zooms in ---
{
  const low = settled("CALM MEADOW", { intensity: 0.1 }, 150);
  const high = settled("CALM MEADOW", { intensity: 1 }, 150);
  check("intensity zooms in", high.o.focal > low.o.focal + 5, `${high.o.focal} vs ${low.o.focal}`);
  check("zoom-in bounded ~+12%", high.o.focal <= 520 * 1.13 + 0.5, String(high.o.focal));
}
// --- boss widens + biases midpoint ---
{
  const solo = settled("CALM MEADOW", { playerX: 0, hasBoss: false }, 120);
  const boss = settled("CALM MEADOW", { playerX: 0, hasBoss: true, bossX: 400, bossY: 0 }, 120);
  check("boss widens (focal down)", boss.o.focal < solo.o.focal - 5, `${boss.o.focal} vs ${solo.o.focal}`);
  check("boss biases toward midpoint", boss.o.x > solo.o.x + 5, `${boss.o.x} vs ${solo.o.x}`);
}
// --- sprint widens + lags more ---
{
  const norm = settled("CALM MEADOW", { playerX: 600, sprinting: false }, 25);
  const sprint = settled("CALM MEADOW", { playerX: 600, sprinting: true }, 25);
  check("sprint widens", sprint.o.focal < norm.o.focal - 1, `${sprint.o.focal} vs ${norm.o.focal}`);
  check("sprint lags heavier", sprint.o.x < norm.o.x - 1, `${sprint.o.x} vs ${norm.o.x}`);
}
// --- dodge kicks + stabilizes ---
{
  const normCam = new Camera(); normCam.addShake(0.8);
  const dodgeCam = new Camera(); dodgeCam.addShake(0.8);
  let n = null, d = null;
  for (let i = 0; i < 40; i++) {
    n = normCam.update(baseInput({ dodging: false, time: 30 + i * 0.016 }));
    d = dodgeCam.update(baseInput({ dodging: true, playerVX: 500, time: 30 + i * 0.016 }));
  }
  normCam.addShake(0.8); dodgeCam.addShake(0.8);
  n = normCam.update(baseInput({ dodging: false, time: 31 }));
  d = dodgeCam.update(baseInput({ dodging: true, playerVX: 500, time: 31 }));
  check("dodge FOV kick", d.focal > n.focal + 5, `${d.focal} vs ${n.focal}`);
  check("dodge reduces shake", Math.hypot(d.shakeX, d.shakeY) < Math.hypot(n.shakeX, n.shakeY),
    `${Math.hypot(d.shakeX, d.shakeY)} vs ${Math.hypot(n.shakeX, n.shakeY)}`);
}
// --- clamps + finite incl. garbage ---
{
  const hot = settled("CANDY PLAINS", { intensity: 1, bassSpike: 1, beat: 1, dodging: true, sprinting: true }, 200);
  check("focal clamped top", hot.o.focal <= 720, String(hot.o.focal));
  const cold = settled("VOID GARDEN", { intensity: 0, hasBoss: true, bossX: -5000, sprinting: true, silence: 1 }, 200);
  check("focal clamped bottom", cold.o.focal >= 380, String(cold.o.focal));
  check("offsets bounded", Math.abs(hot.o.shakeX) <= 40 && Math.abs(hot.o.shakeY) <= 40);
  const bad = new Camera().update({
    playerX: NaN, playerY: Infinity, playerVX: NaN, playerVY: -Infinity,
    sprinting: 0, dodging: 0, hasBoss: true, bossX: NaN, bossY: undefined,
    bass: NaN, treble: undefined, intensity: Infinity, beat: NaN, bassSpike: -5,
    silence: NaN, worldName: null, time: NaN, dt: NaN, viewH: 0,
  });
  check("garbage finite", outFinite(bad), JSON.stringify(bad));
  check("garbage focal clamped", bad.focal >= 380 && bad.focal <= 720);
  check("garbage horizon clamped", bad.horizon >= 0.3 * 800 && bad.horizon <= 0.75 * 800, String(bad.horizon));
}
// --- horizon clamp ---
{
  const h1 = settled("CALM MEADOW", { intensity: 1, viewH: 900 }, 150);
  check("horizon in [0.3h,0.75h]", h1.o.horizon >= 270 && h1.o.horizon <= 675, String(h1.o.horizon));
}
// --- wiring: webgpu imports camera, globals use it ---
check("webgpu imports Camera", /from '\.\/camera\.js'/.test(webgpuSrc) && /Camera/.test(webgpuSrc));
check("webgpu camera state", /this\._cam/.test(webgpuSrc) || /_cam\b/.test(webgpuSrc));
check("webgpu no fixed snap", /,520,h\*\.58/.test(webgpuSrc) === false);
check("UBO layout intact", /size: *96/.test(webgpuSrc) && /arrayStride: *36/.test(webgpuSrc));
check("test copy in sync", underTestSrc === webgpuSrc);
check("camera test copy in sync", camCopySrc === camSrc);
// --- wiring: game passes new params ---
check("game passes sprinting", /sprinting/.test(gameSrc));
check("game shift sprint", /keys\.has\('shift'\)/.test(gameSrc));
check("game passes velocity", /playerVX/.test(gameSrc) && /playerVY/.test(gameSrc));
check("game passes dodging", /dodging/.test(gameSrc));
check("game passes boss cam", /hasBoss/.test(gameSrc) && /bossX/.test(gameSrc) && /bossY/.test(gameSrc));
check("game bass spike", /bassSpike/.test(gameSrc));
check("game keeps beat+silence", /beat:beatPulse/.test(gameSrc) && /silence/.test(gameSrc));
check("game canvas fallback cam", /fallbackCam|W\/2-/.test(gameSrc));

console.log(out.join("\n"));
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
