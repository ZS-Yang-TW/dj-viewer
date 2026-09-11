/* ---------- 程式碼：駭客任務風格的直向字元瀑布，字元沿格線往下掉、頭亮尾暗 ---------- */
import { paletteColorAt } from './shared.js';

const CELL = 22; // 字元格大小（px），決定行寬跟直向密度
const CHARS =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789{}[]()<>/\\;:=+-*#$%&'.split('');
const FLICKER_CHANCE = 0.025; // 每格每幀隨機換字的機率，做出資料流動的閃爍感（純材質抖動，不是同步閃爍）

function pickChar() {
  return CHARS[(Math.random() * CHARS.length) | 0];
}

let columns = [];
let gridCols = 0;
let gridRows = 0;

// 每次畫面尺寸改變才重建整個格子，字元用 Math.random() 就好（跟 beat-bars.js
// 的材質抖動同理），不需要等 p5 setup() 之後才能呼叫的 random()。
function rebuildGrid(cols, rows) {
  columns = [];
  for (let i = 0; i < cols; i++) {
    columns.push({
      y: -Math.random() * rows, // 起始位置錯開，不會一起從頂端掉下來
      speed: 0.35 + Math.random() * 0.55,
      trailLen: 12 + Math.floor(Math.random() * 12),
      glyphs: Array.from({ length: rows }, pickChar),
    });
  }
  gridCols = cols;
  gridRows = rows;
}

export function drawCodeRain(pulse, accentColors, colorPhase) {
  const cols = Math.ceil(width / CELL) + 1;
  const rows = Math.ceil(height / CELL) + 2;
  if (cols !== gridCols || rows !== gridRows) rebuildGrid(cols, rows);

  textFont('monospace');
  textSize(CELL * 0.82);
  textAlign(CENTER, CENTER);
  noStroke();

  const fallSpeed = 0.6 + pulse * 1.3; // 音樂強度推快掉落速度，跟其他場景一樣吃平滑過的 pulse

  columns.forEach((col, ci) => {
    col.y += col.speed * fallSpeed;
    const headRow = Math.floor(col.y);
    if (headRow - col.trailLen > gridRows) {
      // 整條尾巴都掉出畫面了，從頂端隨機重生一條新的
      col.y = -Math.random() * 20;
      col.speed = 0.35 + Math.random() * 0.55;
      col.trailLen = 12 + Math.floor(Math.random() * 12);
      return;
    }
    if (headRow >= 0 && headRow < gridRows) col.glyphs[headRow] = pickChar();

    const x = ci * CELL + CELL / 2;
    const trailColor = paletteColorAt(accentColors, colorPhase, ci * 0.35);

    for (let t = 0; t < col.trailLen; t++) {
      const row = headRow - t;
      if (row < 0 || row >= gridRows) continue;
      if (Math.random() < FLICKER_CHANCE) col.glyphs[row] = pickChar();

      const y = row * CELL + CELL / 2;
      if (t === 0) {
        // 領頭字元亮白色，跟星座場景的星星核心同一個手法：彩色光暈 + 白色亮點
        fill(255, 255, 255, 235 + pulse * 20);
      } else {
        const tt = t / col.trailLen;
        fill(trailColor[0], trailColor[1], trailColor[2], (1 - tt) * 220 * (0.55 + pulse * 0.45));
      }
      text(col.glyphs[row], x, y);
    }
  });
}
