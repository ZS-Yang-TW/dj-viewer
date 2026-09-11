/* ---------- 節拍長條：畫面切成 8 條直的長條，跟著拍子一次顯示一條，由左到右 ---------- */
import { paletteColorAt } from './shared.js';

const BAR_COUNT = 8;
const GRAIN_AMOUNT = 42; // 每個像素明暗隨機抖動的幅度，數字越大顆粒感越粗

export function drawBeatBars(pulse, accentColors, colorPhase) {
  // colorPhase 每 4 拍繞一圈（見 shared.js 的 BEATS_PER_COLOR），乘回 4 還原成拍子計數；
  // 再乘 2 讓長條每半拍就換一格，速度變成兩倍。
  const beatIndex = Math.floor(colorPhase * 8);
  // 一次只顯示一條，跟著拍子從左到右移動，到底了就從頭開始，不是疊加。
  const activeIndex = beatIndex % BAR_COUNT;

  const barWidth = width / BAR_COUNT;
  const x0 = activeIndex * barWidth;
  const col = paletteColorAt(accentColors, colorPhase, activeIndex * 0.9);

  // 先鋪一層看得清楚的底色，長條本身要像一塊實體的面，不是一堆浮在黑底上的點。
  noStroke();
  fill(col[0], col[1], col[2], 200);
  rect(x0, 0, barWidth, height);

  // 材質：在底色上對每個像素做明暗隨機抖動，模擬粗糙材質的顆粒感（類似底片
  // 顆粒/雜訊材質），跟純粹灑稀疏的點不同，這樣才看得出「一塊有材質的長條」
  // 而不是「一堆看不清楚形狀的雜訊點」。
  loadPixels();
  const d = pixelDensity();
  const canvasW = width * d;
  const canvasH = height * d;
  const bx0 = Math.max(0, Math.floor(x0 * d));
  const bx1 = Math.min(canvasW, Math.floor((x0 + barWidth) * d));
  const grain = GRAIN_AMOUNT * (0.7 + pulse * 0.5);

  for (let y = 0; y < canvasH; y++) {
    const rowStart = y * canvasW;
    for (let x = bx0; x < bx1; x++) {
      const idx = 4 * (rowStart + x);
      const shade = (Math.random() - 0.5) * 2 * grain;
      pixels[idx] = constrain(pixels[idx] + shade, 0, 255);
      pixels[idx + 1] = constrain(pixels[idx + 1] + shade, 0, 255);
      pixels[idx + 2] = constrain(pixels[idx + 2] + shade, 0, 255);
    }
  }
  updatePixels();
}
