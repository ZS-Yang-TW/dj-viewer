/* ---------- 粒子網絡：漂浮粒子 + 連線 ---------- */
import { paletteColorAt } from './shared.js';

let plexusParticles = [];

// 用 p5 的 random()，只能在 setup() 之後（p5 的全域函式掛到 window 上）才能呼叫，
// 所以這裡開一個 init 函式讓進入點的 setup() 呼叫，不能在 import 當下就跑。
export function initPlexus() {
  plexusParticles = [];
  for (let i = 0; i < 64; i++) {
    plexusParticles.push({ seedX: random(1000), seedY: random(1000), sizeSeed: random(1000) });
  }
}

export function drawPlexus(pulse, accentColors, colorPhase) {
  // 拉開分佈範圍的同時把時間係數等比例調慢，不然移動速度會被拉伸放大
  const t = millis() * 0.00006;
  const spread = (n) => constrain((n - 0.5) * 1.6 + 0.5, 0, 1);
  const pts = plexusParticles.map((p) => ({
    x: spread(noise(p.seedX, t)) * width,
    y: spread(noise(p.seedY, t)) * height,
    r: 2 + noise(p.sizeSeed, t * 2) * 3 + pulse * 15,
  }));

  const linkColor = paletteColorAt(accentColors, colorPhase, 0);
  const maxDist = Math.min(width, height) * (0.24 + pulse * 0.12);
  strokeWeight(1.6);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = dist(pts[i].x, pts[i].y, pts[j].x, pts[j].y);
      if (d < maxDist) {
        const alpha = map(d, 0, maxDist, 220, 0) * (0.6 + pulse * 0.7);
        stroke(linkColor[0], linkColor[1], linkColor[2], alpha);
        line(pts[i].x, pts[i].y, pts[j].x, pts[j].y);
      }
    }
  }

  noStroke();
  pts.forEach((p, idx) => {
    // 每顆粒子的相位錯開一點，顏色循環時像一陣波而不是全部同時瞬間跳色
    const col = paletteColorAt(accentColors, colorPhase + idx * 0.15, idx % accentColors.length);
    fill(col[0], col[1], col[2], 210);
    ellipse(p.x, p.y, p.r * 2, p.r * 2);
  });
}
