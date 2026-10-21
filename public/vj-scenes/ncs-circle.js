/* ---------- NCS Circle：仿 NCS 頻道那個發光圓圈(不含文字) ----------
 * 核心是一套「假的音訊視覺化」pipeline：
 *   (假)頻譜 → log 頻段對應 → 空間平滑 → 時間平滑 → 鏡射 → 逐點算半徑位移
 *   → 描一條平滑閉合曲線 + 光暈 + 殘影
 * 這幾步裡，鏡射跟兩種平滑才是「看起來像 NCS」的關鍵——如果只是每個點各自
 * 獨立地雜訊跳動，畫出來會像一顆海膽，不會是那種流動、左右對稱的圓。
 *
 * 這個 app 目前沒有接上真的音訊訊號可以做 FFT（Route B 純視覺、不解碼/播放
 * 音訊，節奏都是從 Serato 回報的 bpm/playRate/position 算出來的合成 pulse），
 * 所以下面的「頻段」是用 noise() 模擬出來的假頻譜，不是真正的頻率分析：
 * 低頻段(bass)取樣變化慢、震幅大，且跟真正的節奏 pulse 掛鉤；高頻段取樣
 * 變化快、震幅小、更雜訊化——只是外觀上模仿真實頻譜「低頻穩重、高頻瑣碎」
 * 的統計特性。
 */
import { paletteColorAt } from './shared.js';

const POINT_COUNT = 128; // 圓周上的總點數
const NUM_BANDS = POINT_COUNT / 2; // 只算半邊，另一半用鏡射補滿（見 mirrorBands）
const SMOOTH_SPEED = 0.15; // 每幀往目標值靠近的比例，數字愈小晃動愈慢愈柔
const SPATIAL_SMOOTH_PASSES = 2;
const TRAIL_FADE_ALPHA = 26; // 每幀疊在殘影 buffer 上的黑色不透明度，愈小拖尾愈長
const TRAIL_RESET_GAP_MS = 250; // 切離這個風格一段時間後切回來，隔太久就當作重新開始，清掉舊殘影

let rotation = 0;
let previousValues = new Array(NUM_BANDS).fill(0);
let lastActiveMillis = -Infinity;

// 殘影效果需要一塊不會被 vj-sketch.js 每幀 background(0) 全清掉的畫布，所以
// 自己養一個 p5.Graphics buffer：每幀只疊一層半透明黑（不是整個擦乾淨），
// 舊的曲線會慢慢淡出而不是瞬間消失，畫出「震動時拖出一段殘影」的效果，
// 再把這塊 buffer 整個貼回主畫布。
let trailBuffer = null;
let trailW = 0;
let trailH = 0;

function ensureTrailBuffer() {
  if (!trailBuffer || trailW !== width || trailH !== height) {
    trailBuffer = createGraphics(width, height);
    trailBuffer.colorMode(RGB, 255);
    trailBuffer.background(0);
    trailW = width;
    trailH = height;
  }
}

// 模擬一個頻段「現在的能量」。freqPos(0=bass, 1=treble) 決定取樣 noise 的
// 時間軸速度跟震幅比例：低頻慢而大力、高頻快而瑣碎。beatWeight 讓低頻段更
// 貼著真正的節奏 pulse 走（模擬 bass 通常跟鼓點同步），高頻段主要靠自己
// 的 noise 雜訊、比較不受拍子牽動。
function fakeBandRaw(i, t, pulse) {
  const freqPos = i / (NUM_BANDS - 1);
  const noiseSpeed = lerp(0.5, 3.2, freqPos);
  const n = noise(i * 3.7 + 100, t * noiseSpeed);
  const beatWeight = 1 - freqPos * 0.75;
  return n * (0.35 + freqPos * 0.3) + pulse * beatWeight * 0.6;
}

// 空間平滑：跟左右鄰居做加權平均（box blur），抹掉逐點跳動的尖刺——這是避免
// 畫面變成海膽的第二道關卡（第一道是頻段取樣時已經帶有的低頻大跨度特性）。
function spatialSmooth(bands) {
  let arr = bands;
  for (let pass = 0; pass < SPATIAL_SMOOTH_PASSES; pass++) {
    arr = arr.map((v, i) => {
      const prev = arr[Math.max(0, i - 1)];
      const next = arr[Math.min(arr.length - 1, i + 1)];
      return (prev + v * 2 + next) / 4;
    });
  }
  return arr;
}

// 鏡射：把半邊頻段接上自己的反轉，補成一整圈。結果是 bass 集中在圓周上的
// 一個點、treble 集中在正對面那一點，兩邊像鏡子一樣對稱地往外扇開，而不是
// 每個角度各自獨立地雜訊跳動——這一步是「看起來像 NCS」最關鍵的一步。
function mirrorBands(bands) {
  return bands.concat(bands.slice().reverse());
}

// curveVertex 需要頭尾各多一個控制點才能讓 Catmull-Rom 曲線在接縫處平滑
// 銜接，不然閉合處會有一個尖角。ctx 是 p5.Graphics（殘影 buffer）或全域
// p5（this 沒有 buffer 可用時），兩者 API 一致。
//
// 鏡射會在頻段序列中間造出一個「折返」點（數值先降後升，方向瞬間反轉）—
// 加上振幅夠大時，預設的 Catmull-Rom 張力在那個折返點附近會算出過衝的切線，
// 曲線甩出去一根尖刺，飛出圓外一大截。把 curveTightness 調高（愈接近 1
// 愈像直線、愈不會過衝）能壓掉這根尖刺，同時還留一點點弧度、不是死板的
// 直線多邊形。
const CURVE_TIGHTNESS = 0.75;
function drawClosedCurve(ctx, pts) {
  ctx.curveTightness(CURVE_TIGHTNESS);
  ctx.beginShape();
  ctx.curveVertex(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  pts.forEach((p) => ctx.curveVertex(p[0], p[1]));
  ctx.curveVertex(pts[0][0], pts[0][1]);
  ctx.curveVertex(pts[1][0], pts[1][1]);
  ctx.endShape(CLOSE);
}

export function drawNcsCircle(pulse, accentColors, colorPhase) {
  ensureTrailBuffer();

  const now = millis();
  // 隔了一段時間才切回這個風格：buffer 裡還留著切走前那一刻的畫面，不清掉
  // 的話畫面會先跳出一張沒淡化過的舊殘影，之後才慢慢開始正常拖尾。
  if (now - lastActiveMillis > TRAIL_RESET_GAP_MS) trailBuffer.background(0);
  lastActiveMillis = now;

  rotation += 0.0006 + pulse * 0.0006;
  const t = now * 0.0009;

  const raw = [];
  for (let i = 0; i < NUM_BANDS; i++) raw.push(fakeBandRaw(i, t, pulse));

  const spatial = spatialSmooth(raw);
  const smoothed = spatial.map((v, i) => {
    const s = lerp(previousValues[i], v, SMOOTH_SPEED);
    previousValues[i] = s;
    return s;
  });

  const mirrored = mirrorBands(smoothed);

  const cx = width / 2;
  const cy = height / 2;
  const baseRadius = Math.min(width, height) * 0.2;
  const maxDisplacement = baseRadius * 1.3; // 振幅：頻段位移可以把半徑推到 base 的兩倍以上
  const globalPulseBoost = baseRadius * 0.22;

  const pts = mirrored.map((amp, i) => {
    const angle = (i / POINT_COUNT) * Math.PI * 2 + rotation;
    const radius = baseRadius + pulse * globalPulseBoost + amp * maxDisplacement;
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
  });

  // 先用半透明黑把上一幀淡化一點，不是整塊擦掉——這是殘影的來源
  trailBuffer.blendMode(BLEND);
  trailBuffer.noStroke();
  trailBuffer.fill(0, TRAIL_FADE_ALPHA);
  trailBuffer.rect(0, 0, width, height);

  trailBuffer.blendMode(ADD); // 光暈疊加時自然增亮，跟 laser 場景同一招
  trailBuffer.noFill();

  // 光暈：同一條閉合曲線多描幾次，線愈放愈粗、透明度愈來愈低，疊出模糊光暈感
  const glow = paletteColorAt(accentColors, colorPhase, 0);
  for (let layer = 3; layer >= 1; layer--) {
    trailBuffer.stroke(glow[0], glow[1], glow[2], 8 + layer * 6);
    trailBuffer.strokeWeight(8 + layer * 10 + pulse * 10);
    drawClosedCurve(trailBuffer, pts);
  }

  // 核心亮線
  const core = paletteColorAt(accentColors, colorPhase, 1);
  trailBuffer.stroke(core[0], core[1], core[2], 220);
  trailBuffer.strokeWeight(2.4);
  drawClosedCurve(trailBuffer, pts);

  trailBuffer.blendMode(BLEND);

  image(trailBuffer, 0, 0);
}
