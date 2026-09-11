/* ---------- 氣息：柔和的橫向 noise 波浪，一條條自己呼吸、消散、重生 ---------- */
import { paletteColorAt } from './shared.js';

const STRAND_COUNT = 4;
const SAMPLE_STEP = 2; // 沿 x 方向每隔幾像素取一次 noise，省效能用，值太大會把細節層的碎浪抹平

let strands = [];

function makeStrand(staggerAge) {
  const life = random(4000, 9000);
  return {
    yoff: random(1000),
    xoffRate: random(0.006, 0.016),
    yoffRate: random(0.0015, 0.0035),
    detailSeed: random(1000),
    waveHeight: random(0.14, 0.32), // 佔畫面高度的比例
    tilt: random(-0.12, 0.12), // 弧度，p5 預設 RADIANS
    xShift: random(-0.08, 0.08), // 佔畫面寬度的比例
    anchorY: random(0.28, 0.72),
    life,
    age: staggerAge ? random(life) : 0, // 一開始就錯開壽命，不會同時淡出又同時重生
  };
}

// random() 要在 p5 setup() 之後才能呼叫（跟 plexus.js 的 initPlexus 同理），
// 所以進入點的 setup() 要另外呼叫這個 init。
export function initBreath() {
  strands = [];
  for (let i = 0; i < STRAND_COUNT; i++) strands.push(makeStrand(true));
}

export function drawBreath(pulse, accentColors, colorPhase) {
  const dt = deltaTime || 16;

  strands.forEach((strand, i) => {
    strand.age += dt;
    if (strand.age > strand.life) Object.assign(strand, makeStrand(false));

    // 壽命中段最濃、頭尾淡出，像一次呼吸的吐納，不是硬生生消失
    const progress = constrain(strand.age / strand.life, 0, 1);
    const envelope = Math.sin(Math.PI * progress);

    const waveHeight = strand.waveHeight * height * (0.6 + pulse * 1.2);
    const col = paletteColorAt(accentColors, colorPhase, i * 1.3);

    push();
    translate(width / 2 + strand.xShift * width, strand.anchorY * height);
    rotate(strand.tilt);
    scale(1.8, 1);

    noFill();
    stroke(col[0], col[1], col[2], envelope * (90 + pulse * 90));
    strokeWeight(2 + pulse * 2);
    beginShape();
    vertex(-width / 2 - 30, 0);
    let xo = 0;
    for (let x = -width / 2; x <= width / 2; x += SAMPLE_STEP) {
      // 兩層疊加：主波身負責大幅度起伏，細節層用高好幾倍的頻率疊一點碎浪，
      // 單一層 noise 太圓滑，看起來只是緩緩起伏，缺乏曲折的質感。
      const base = noise(xo, strand.yoff);
      const detail = noise(xo * 4.5 + strand.detailSeed, strand.yoff * 2);
      const combined = base * 0.7 + detail * 0.3;
      const y = map(combined, 0, 1, -waveHeight, waveHeight);
      vertex(x, y);
      xo += strand.xoffRate * SAMPLE_STEP;
    }
    vertex(width / 2 + 30, 0);
    endShape();
    pop();

    strand.yoff += strand.yoffRate * (0.5 + pulse);
  });
}
