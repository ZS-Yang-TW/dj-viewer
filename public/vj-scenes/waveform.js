/* ---------- 波形：模擬聲波，鏡射長條圖跨滿畫面 ---------- */
import { paletteColorAt, lerpRgb } from './shared.js';

export function drawWaveform(pulse, accentColors, colorPhase) {
  const barCount = 90;
  const barWidth = width / barCount;
  const midY = height / 2;
  const t = millis() * 0.001;

  // 左右兩端各自跟著拍子在調色盤裡循環，兩端顏色不同又會隨拍數換，
  // 不會固定卡在同一個顏色。
  const colorLeft = paletteColorAt(accentColors, colorPhase, 0);
  const colorRight = paletteColorAt(accentColors, colorPhase, accentColors.length / 2);

  rectMode(CENTER);
  for (let i = 0; i < barCount; i++) {
    const n = i / barCount;
    const x = i * barWidth + barWidth / 2;
    const wave =
      Math.sin(n * Math.PI * 6 + t * 2.1) * 0.5 +
      Math.sin(n * Math.PI * 13 + t * 3.4) * 0.3 +
      Math.sin(n * Math.PI * 2.3 - t * 1.2) * 0.25;
    const h = Math.max(6, Math.abs(wave) * height * 0.55 * (0.2 + pulse * 1.3));

    const col = lerpRgb(colorLeft, colorRight, n);
    fill(col[0], col[1], col[2], 190);
    rect(x, midY, barWidth * 0.68, h);
  }
}
