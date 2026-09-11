/* ---------- 圓環：漂移佈滿畫面，不死板置中 ---------- */
import { paletteColorAt } from './shared.js';

let rotation = 0;

export function drawCircles(pulse, accentColors, colorPhase) {
  rotation += 0.0012 + pulse * 0.0015;
  const t = millis() * 0.00006;

  // 圓環群，中心點各自沿著緩慢的 Lissajous 軌跡在畫面上遊走
  const CLUSTER_COUNT = 10;
  const clusters = [];
  for (let ci = 0; ci < CLUSTER_COUNT; ci++) {
    const freqA = 0.7 + (ci % 4) * 0.35;
    const freqB = 0.9 + ((ci + 2) % 4) * 0.3;
    const phase = (ci / CLUSTER_COUNT) * Math.PI * 2;
    const radScaleX = 0.22 + (ci % 3) * 0.05;
    const radScaleY = 0.26 + ((ci + 1) % 3) * 0.05;
    clusters.push({
      cx: width * 0.5 + Math.cos(t * freqA + phase) * width * radScaleX,
      cy: height * 0.5 + Math.sin(t * freqB + phase) * height * radScaleY,
      dir: ci % 2 === 0 ? 1 : -1,
    });
  }

  const baseRadius = Math.min(width, height) * 0.2;
  const ringCount = 7;

  clusters.forEach((cluster, ci) => {
    push();
    translate(cluster.cx, cluster.cy);
    for (let i = 0; i < ringCount; i++) {
      const tt = i / ringCount;
      const orbitRadius = baseRadius * (0.3 + tt * 0.7) * (0.6 + pulse * 0.7);
      const angle = rotation * cluster.dir * (i % 2 === 0 ? 1 : -0.7) + tt * Math.PI * 2;
      const x = Math.cos(angle) * orbitRadius * 0.35;
      const y = Math.sin(angle) * orbitRadius * 0.35;
      const size = baseRadius * (0.55 - tt * 0.08) * (0.55 + pulse * 0.9);
      const alpha = 65 * (1 - tt * 0.6) * (0.35 + pulse * 0.75);

      const color = paletteColorAt(accentColors, colorPhase, ci + i);
      fill(color[0], color[1], color[2], alpha);
      ellipse(x, y, size, size);
    }
    pop();
  });
}
