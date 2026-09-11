/* ---------- 混沌橢圓：一排橢圓叢的輸送帶，畫面只在拍點那一刻整排前進一格 ---------- */
import { paletteColorAt } from './shared.js';

// 原本手動調的橢圓長寬比例，保留下來讓每一圈粗細不完全一致，看起來才會「毛」
const THREAD_W = [220, 200, 198, 220, 227, 191];
const THREAD_H = [210, 223, 191, 210, 223, 191];
const RING_COUNT = THREAD_W.length;
const CLUSTER_COUNT = 10; // 原本手動版本最多點到 10 個，排成一整排橫跨畫面
const JITTER = 14; // 每叢重新亂位時，位移量抓 ±14px

// 跟前一版不同：這裡完全不讓大小/半徑跟拍子的強弱掛勾（那種做法太常見），
// 改成「畫面本身只在拍點那一刻才變」——兩個拍點之間整排完全靜止不動，像是
// 動畫被鎖在拍子的格數上，而不是連續補間。新的橢圓叢只在拍點誕生（從右側
// 補進來），舊的則跟著排隊往左移一格，最左邊那個到點了就直接消失，不做淡出。
//
// 每隔一段時間會切成另一種場景：輸送帶暫停，改成一叢從畫面正中央放大的橢圓
// 群，再切回輸送帶——放大也是一格一格跳的，不做連續補間，維持整支場景「只
// 在拍點上變化」的調性，兩種模式只差在「變什麼」，不是差在平滑度。
const CONVEYOR_BEATS = 32; // 輸送帶模式持續幾拍，每 32 拍才切一次場景
const EXPAND_BEATS = 8; // 中央放大模式持續幾拍
const EXPAND_STEPS = EXPAND_BEATS * 2; // 放大切成幾個離散的跳格，跟輸送帶一樣是半拍一格
const CYCLE_BEATS = CONVEYOR_BEATS + EXPAND_BEATS;

let slots = [];
let lastBeatIndex = -1;
let centerStamp = null;
let wasExpanding = false;
let lastExpandStep = -1;

function jitterArray() {
  return Array.from({ length: RING_COUNT }, () => random(-JITTER, JITTER));
}

function makeStamp() {
  return {
    xOffset: jitterArray(),
    yOffset: jitterArray(),
    yLane: random(-1, 1), // 這叢專屬的縱向偏移，隨它一起移動，不會每拍重新亂跳
    colorSeed: random(4),
  };
}

// random() 要在 p5 setup() 之後才能呼叫（跟 plexus.js 的 initPlexus 同理），
// 所以進入點的 setup() 要另外呼叫這個 init。
export function initChaos() {
  slots = [];
  for (let i = 0; i < CLUSTER_COUNT; i++) slots.push(makeStamp());
  lastBeatIndex = -1;
  centerStamp = null;
  wasExpanding = false;
  lastExpandStep = -1;
}

export function drawChaos(pulse, accentColors, colorPhase) {
  // colorPhase 每 4 拍繞一圈（見 shared.js 的 BEATS_PER_COLOR），乘回 4 還原成
  // 連續的拍子計數（含小數，不是只有整數拍點）。
  const beatPos = colorPhase * 4;
  const cyclePos = ((beatPos % CYCLE_BEATS) + CYCLE_BEATS) % CYCLE_BEATS;
  const isExpandPhase = cyclePos >= CONVEYOR_BEATS;

  // 輸送帶：每半拍前進一格，只在非放大階段作用，暫停期間位置原地凍結。
  const beatIndex = Math.floor(beatPos * 2);
  if (beatIndex !== lastBeatIndex) {
    lastBeatIndex = beatIndex;
    if (!isExpandPhase) {
      slots.shift();
      slots.push(makeStamp());
    }
  }

  noFill();
  strokeWeight(2);

  if (isExpandPhase) {
    // 跟輸送帶一樣是半拍一格：放大的尺寸只在整數格才跳一次，格與格之間完全
    // 靜止，不是逐幀變大——所以每跳一格也順便重新亂位一次，看起來才不會像
    // 同一張圖片被放大，而是「新的一格」。
    const stepIndex = Math.min(EXPAND_STEPS - 1, Math.floor(((cyclePos - CONVEYOR_BEATS) / EXPAND_BEATS) * EXPAND_STEPS));
    if (!wasExpanding) {
      centerStamp = makeStamp();
      lastExpandStep = stepIndex;
    } else if (stepIndex !== lastExpandStep) {
      lastExpandStep = stepIndex;
      centerStamp.xOffset = jitterArray();
      centerStamp.yOffset = jitterArray();
    }
    wasExpanding = true;

    const stepT = stepIndex / (EXPAND_STEPS - 1); // 0～1，只在整數格才變，中間完全不補間

    const slotWidth = width / CLUSTER_COUNT;
    const baseSize = Math.min(width, height) * lerp(0.06, 0.95, stepT);
    const jitterScale = baseSize / slotWidth; // 位移量跟著放大比例一起變大，維持同樣的「毛邊」比例

    const col = paletteColorAt(accentColors, colorPhase, centerStamp.colorSeed);
    stroke(col[0], col[1], col[2], 220);
    strokeWeight(2 + stepT * 3);
    for (let i = 0; i < RING_COUNT; i++) {
      const w = (THREAD_W[i] / 220) * baseSize;
      const h = (THREAD_H[i] / 220) * baseSize;
      ellipse(
        width / 2 + centerStamp.xOffset[i] * jitterScale,
        height / 2 + centerStamp.yOffset[i] * jitterScale,
        w,
        h
      );
    }
    return;
  }

  wasExpanding = false;

  const slotWidth = width / CLUSTER_COUNT;
  const baseSize = slotWidth * 0.95; // 固定尺寸，不跟著 pulse 呼吸

  slots.forEach((stamp, ci) => {
    const cx = (ci + 0.5) * slotWidth;
    const cy = height / 2 + stamp.yLane * height * 0.12;

    const col = paletteColorAt(accentColors, colorPhase, ci * 0.8 + stamp.colorSeed);
    stroke(col[0], col[1], col[2], 200);

    for (let i = 0; i < RING_COUNT; i++) {
      const w = (THREAD_W[i] / 220) * baseSize;
      const h = (THREAD_H[i] / 220) * baseSize;
      ellipse(cx + stamp.xOffset[i], cy + stamp.yOffset[i], w, h);
    }
  });
}
