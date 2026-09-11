/* ---------- 星座：星星依拍點逐一連線，連過的線慢慢淡出，線與線不重疊 ---------- */
import { paletteColorAt, BEATS_PER_COLOR } from './shared.js';

const STAR_COUNT = 120;
// 只從離目前連線端點最近的幾顆星裡面挑下一段，看起來才像局部生長的星座，
// 而不是隨機橫跨整個畫面的長線。
const NEAREST_POOL = 10;
const HOLD_BEATS = 6; // 連好之後先完全顯示幾拍
const FADE_BEATS = 10; // 之後再花幾拍慢慢淡出，刻意拉長、不要太快消失

const STEPS_PER_BEAT = 4; // 連線頻率是拍點的 4 倍，每 1/4 拍就嘗試連一段
const CHAIN_LIMIT = 8; // 同一條鏈連滿幾個點之後強制換到新起點

let stars = [];
let edges = [];
let tip = 0;
let chainLength = 0;
let lastStepIndex = -1;

export function initConstellation() {
  stars = Array.from({ length: STAR_COUNT }, () => ({
    fx: random(0.06, 0.94),
    fy: random(0.06, 0.94),
    twinkleSeed: random(1000),
  }));
  edges = [];
  tip = Math.floor(random(stars.length));
  chainLength = 0;
  lastStepIndex = -1;
}

function starPos(s) {
  return { x: s.fx * width, y: s.fy * height };
}

function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function edgeAlpha(edge, beatFloat) {
  const age = beatFloat - edge.born;
  if (age < HOLD_BEATS) return 1;
  return constrain(1 - (age - HOLD_BEATS) / FADE_BEATS, 0, 1);
}

// 標準線段相交測試（跨積方向判斷）。共用端點的兩條線不算相交——呼叫端會先把
// 跟目前端點共用端點的線濾掉，不會走到這裡。
function segmentsIntersect(p1, p2, p3, p4) {
  const cross = (a, b, c) => (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// 從目前端點往最近的候選星星裡找一段不會跟現有線交叉的新線，成功就把 tip
// 移過去、回傳 true；附近的星星都會撞線就回傳 false，讓呼叫端決定換遠點。
function tryConnect(beatFloat, positions) {
  // 已經淡到幾乎看不見的線不擋路，可以在它淡出後重新從那附近長出新的一段
  const blocking = edges.filter((e) => edgeAlpha(e, beatFloat) > 0.03);
  const neighborsOfTip = new Set();
  blocking.forEach((e) => {
    if (e.a === tip) neighborsOfTip.add(e.b);
    if (e.b === tip) neighborsOfTip.add(e.a);
  });

  const tipPos = positions[tip];
  const candidates = stars
    .map((_, idx) => idx)
    .filter((idx) => idx !== tip && !neighborsOfTip.has(idx))
    .sort((a, b) => distSq(tipPos, positions[a]) - distSq(tipPos, positions[b]))
    .slice(0, NEAREST_POOL);

  for (const cand of candidates) {
    const candPos = positions[cand];
    const crosses = blocking.some((e) => {
      if (e.a === tip || e.b === tip || e.a === cand || e.b === cand) return false;
      return segmentsIntersect(tipPos, candPos, positions[e.a], positions[e.b]);
    });
    if (!crosses) {
      edges.push({ a: tip, b: cand, born: beatFloat });
      tip = cand;
      return true;
    }
  }
  return false;
}

// 隨機跳到一顆新起點（不畫線），重置鏈長計數
function jumpToRandomStart() {
  const others = stars.map((_, idx) => idx).filter((idx) => idx !== tip);
  tip = others[Math.floor(random(others.length))];
  chainLength = 0;
}

export function drawConstellation(pulse, accentColors, colorPhase) {
  const t = millis() * 0.0006;
  const beatFloat = colorPhase * BEATS_PER_COLOR;
  const stepIndex = Math.floor(beatFloat * STEPS_PER_BEAT);
  const positions = stars.map(starPos);

  edges = edges.filter((e) => edgeAlpha(e, beatFloat) > 0.02);

  if (stepIndex !== lastStepIndex) {
    lastStepIndex = stepIndex;
    if (chainLength >= CHAIN_LIMIT) {
      // 同一條鏈已經連滿了，強制跳去隨機起點重新長一條新的星座
      jumpToRandomStart();
    } else if (tryConnect(beatFloat, positions)) {
      chainLength++;
    } else {
      // 附近撞線撞到走不下去，也换去隨機起點重新開始
      jumpToRandomStart();
    }
  }

  strokeWeight(2.8);
  edges.forEach((e, idx) => {
    const alpha = edgeAlpha(e, beatFloat);
    const col = paletteColorAt(accentColors, colorPhase, idx * 0.12);
    stroke(col[0], col[1], col[2], 200 * alpha * (0.7 + pulse * 0.4));
    line(positions[e.a].x, positions[e.a].y, positions[e.b].x, positions[e.b].y);
  });

  noStroke();
  stars.forEach((s, idx) => {
    const pos = positions[idx];
    const twinkle = 0.5 + 0.5 * noise(s.twinkleSeed, t);
    const col = paletteColorAt(accentColors, colorPhase, idx * 0.2);
    const core = 2 + twinkle * 2 + pulse * 1.5;
    fill(col[0], col[1], col[2], 70 * twinkle);
    ellipse(pos.x, pos.y, core * 3.2, core * 3.2);
    fill(255, 255, 255, 180 + twinkle * 60);
    ellipse(pos.x, pos.y, core, core);
  });
}
