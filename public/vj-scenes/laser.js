/* ---------- 雷射：兩側往上打的扇形光束，左右搖擺 ---------- */
import { paletteColorAt } from './shared.js';

// 自己刻一個簡單的種子亂數，不要動到 p5 全域的 random()/randomSeed()
// （避免影響到其他場景如果之後也用到 random）。
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function next() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const LASER_ORIGIN_COUNT = 4;
const LASER_RELOCATE_MS = 15000; // 每隔這麼久整組投射點換一批新位置

// 投射點沿著四個邊隨機分佈，每個「世代」（15 秒一輪）用固定種子重算一次，
// 同一輪內位置不變，換下一輪就整批換新的，不做漸變位移。
function laserOrigins() {
  const gen = Math.floor(millis() / LASER_RELOCATE_MS);
  const next = seededRandom(gen * 7919 + 101);
  const origins = [];
  for (let i = 0; i < LASER_ORIGIN_COUNT; i++) {
    const edge = Math.floor(next() * 4);
    let x, y, baseAngle;
    if (edge === 0) {
      x = next() * width;
      y = height * 1.05;
      baseAngle = -HALF_PI; // 從下往上
    } else if (edge === 1) {
      x = next() * width;
      y = -height * 0.05;
      baseAngle = HALF_PI; // 從上往下
    } else if (edge === 2) {
      x = -width * 0.05;
      y = next() * height;
      baseAngle = 0; // 從左往右
    } else {
      x = width * 1.05;
      y = next() * height;
      baseAngle = PI; // 從右往左
    }
    origins.push({ x, y, baseAngle: baseAngle + (next() - 0.5) * 0.8, dir: next() < 0.5 ? 1 : -1 });
  }
  return origins;
}

export function drawLaser(pulse, rawPulse, accentColors, colorPhase) {
  const t = millis() * 0.0006;
  const sweep = Math.sin(t * 0.9) * 0.5; // 整組光束左右搖擺的角度（弧度）
  const beamCount = 5;
  const beamLen = Math.max(width, height) * (1.05 + pulse * 0.4);

  // rawPulse（沒經過平滑處理）壓進一個很陡的曲線，變成「幾乎只有拍點瞬間
  // 才亮」的閃爍——閃爍頻率就是歌曲的拍速本身（大多落在 1.5–2.5Hz 左右），
  // 不是額外疊加一個不受控的高頻閃光。
  const norm = constrain((rawPulse - 0.15) / 0.75, 0, 1);
  const flash = Math.pow(norm, 6);

  const origins = laserOrigins();

  blendMode(ADD); // 光束疊在一起時自然增亮，比一般透明疊圖更有雷射的通透感
  origins.forEach((origin, oi) => {
    for (let i = 0; i < beamCount; i++) {
      const spread = (i / (beamCount - 1) - 0.5) * 0.9;
      const angle = origin.baseAngle + spread + sweep * origin.dir;
      const ex = origin.x + Math.cos(angle) * beamLen;
      const ey = origin.y + Math.sin(angle) * beamLen;

      const col = paletteColorAt(accentColors, colorPhase, oi * 3 + i * 0.5);

      // 光暈（粗、很淡，拍點時跟著變粗變亮）
      stroke(col[0], col[1], col[2], 14 + flash * 55);
      strokeWeight(12 + flash * 10);
      line(origin.x, origin.y, ex, ey);

      // 光束核心：平常偏暗，打到拍點瞬間銳利亮起來，這是「閃」的主要來源
      stroke(col[0], col[1], col[2], 60 + flash * 195);
      strokeWeight(1.6 + flash * 2.5);
      line(origin.x, origin.y, ex, ey);
    }

    noStroke();
    fill(255, 255, 255, 90 + flash * 165);
    ellipse(origin.x, origin.y, 8 + flash * 14, 8 + flash * 14);
  });
  blendMode(BLEND);
}
