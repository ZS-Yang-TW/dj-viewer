/**
 * Route A 用的 VJ 風格圖卡即時預覽。
 *
 * 用固定的示範節奏（DEMO_BPM）跟示範調色盤跑一個縮小版動畫，讓 DJ 選之前
 * 先感受一下這個風格大概長怎樣——跟 Route B 實際播放的內容無關，純粹示範用。
 * 每張卡是獨立的 p5 instance-mode sketch（不是 global mode），彼此不互相
 * 影響，也不會跟 Route B 的 vj-sketch.js 衝突（那個是另一個頁面）。
 *
 * 演算法刻意寫得比 vj-sketch.js 簡化一點（粒子數/圈數更少），畢竟只是個
 * 小卡片預覽，不需要跟正式輸出的視覺完全一比一。
 */
const VJ_STYLE_DEFS = [
  { key: 'circles', label: '圓環' },
  { key: 'waveform', label: '波形' },
  { key: 'plexus', label: '粒子網絡' },
  { key: 'laser', label: '雷射' },
  { key: 'breath', label: '氣息' },
  { key: 'chaos', label: '混沌橢圓' },
  { key: 'beatbars', label: '節拍長條' },
  { key: 'constellation', label: '星座' },
  { key: 'coderain', label: '程式碼' },
  { key: 'ytmv', label: 'YouTube MV（靜音）' },
  { key: 'localmp4', label: '本機 MP4' },
];

const DEMO_BPM = 128;
const DEMO_PALETTE = [
  [74, 158, 255],
  [255, 106, 74],
  [255, 209, 102],
  [100, 220, 150],
];
const PREVIEW_START = performance.now();

function demoPulse() {
  const beatSec = 60 / DEMO_BPM;
  const pos = (performance.now() - PREVIEW_START) / 1000;
  const phase = (((pos % beatSec) + beatSec) % beatSec) / beatSec;
  return 0.15 + 0.75 * Math.pow((1 + Math.cos(phase * Math.PI * 2)) / 2, 2);
}

function demoColorPhase() {
  const beatSec = 60 / DEMO_BPM;
  const pos = (performance.now() - PREVIEW_START) / 1000;
  return pos / beatSec / 4;
}

function lerpNum(a, b, t) {
  return a + (b - a) * t;
}

function paletteAt(phase, offset) {
  const n = DEMO_PALETTE.length;
  const shifted = phase + offset;
  const idx = Math.floor(shifted);
  const frac = shifted - idx;
  const c1 = DEMO_PALETTE[((idx % n) + n) % n];
  const c2 = DEMO_PALETTE[(((idx + 1) % n) + n) % n];
  return [lerpNum(c1[0], c2[0], frac), lerpNum(c1[1], c2[1], frac), lerpNum(c1[2], c2[2], frac)];
}

function makePreviewSketch(styleKey, holderEl) {
  return function (p) {
    let rotation = 0;
    const particles = [];
    if (styleKey === 'plexus') {
      for (let i = 0; i < 16; i++) particles.push({ sx: Math.random() * 1000, sy: Math.random() * 1000 });
    }

    // 混沌橢圓：圖卡預覽只做一叢、圈數也砍少一點，夠意思到就好
    const CHAOS_RING_COUNT = 4;
    let chaosOffsets = [];
    let chaosLastBeat = -1;
    const randJitter = () => Array.from({ length: CHAOS_RING_COUNT }, () => (Math.random() - 0.5) * 10);
    if (styleKey === 'chaos') {
      chaosOffsets = { x: randJitter(), y: randJitter() };
    }

    // 星座：星星位置固定、依拍點逐一連線，跟正式輸出（vj-scenes/constellation.js）
    // 同一套邏輯的簡化版——星星數更少、只挑最近的幾顆當候選
    const CONSTELLATION_STAR_COUNT = 72;
    const CONSTELLATION_NEAREST_POOL = 6;
    const CONSTELLATION_HOLD_BEATS = 6;
    const CONSTELLATION_FADE_BEATS = 10;
    const CONSTELLATION_STEPS_PER_BEAT = 4; // 連線頻率是拍點的 4 倍
    const CONSTELLATION_CHAIN_LIMIT = 8; // 連滿幾個點後強制換遠端起點
    const CONSTELLATION_FAR_POOL_RATIO = 0.2; // 用比例而不是固定數量，星星變多時才不會只跳去最角落
    let constellationStars = [];
    let constellationEdges = [];
    let constellationTip = 0;
    let constellationChainLength = 0;
    let constellationLastStep = -1;
    if (styleKey === 'constellation') {
      constellationStars = Array.from({ length: CONSTELLATION_STAR_COUNT }, () => ({
        fx: 0.06 + Math.random() * 0.88,
        fy: 0.06 + Math.random() * 0.88,
        twinkleSeed: Math.random() * 1000,
      }));
      constellationTip = Math.floor(Math.random() * constellationStars.length);
    }

    // 程式碼：跟正式輸出（vj-scenes/code-rain.js）同一套邏輯的縮小版——
    // 格子更小一點，塞進小卡片裡看起來才不會太稀疏
    const CODE_CELL = 9;
    const CODE_CHARS =
      'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789{}[]()<>/\\;:=+-*#$%&'.split('');
    const CODE_FLICKER_CHANCE = 0.025;
    const pickCodeChar = () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    let codeColumns = [];
    let codeGridCols = 0;
    let codeGridRows = 0;
    const rebuildCodeGrid = (cols, rows) => {
      codeColumns = [];
      for (let i = 0; i < cols; i++) {
        codeColumns.push({
          y: -Math.random() * rows,
          speed: 0.35 + Math.random() * 0.55,
          trailLen: 6 + Math.floor(Math.random() * 8),
          glyphs: Array.from({ length: rows }, pickCodeChar),
        });
      }
      codeGridCols = cols;
      codeGridRows = rows;
    };

    p.setup = function () {
      const rect = holderEl.getBoundingClientRect();
      p.createCanvas(rect.width || 160, rect.height || 90);
      p.noStroke();
      p.colorMode(p.RGB, 255);
    };

    p.windowResized = function () {
      const rect = holderEl.getBoundingClientRect();
      if (rect.width && rect.height) p.resizeCanvas(rect.width, rect.height);
    };

    p.draw = function () {
      p.background(8, 9, 12);
      const pulse = demoPulse();
      const colorPhase = demoColorPhase();
      const w = p.width;
      const h = p.height;

      if (styleKey === 'circles') {
        rotation += 0.02 + pulse * 0.02;
        const baseR = Math.min(w, h) * 0.34;
        for (let i = 0; i < 5; i++) {
          const tt = i / 5;
          const orbitR = baseR * (0.3 + tt * 0.7) * (0.6 + pulse * 0.6);
          const angle = rotation * (i % 2 === 0 ? 1 : -0.7) + tt * Math.PI * 2;
          const x = w / 2 + Math.cos(angle) * orbitR * 0.5;
          const y = h / 2 + Math.sin(angle) * orbitR * 0.5;
          const size = baseR * (0.55 - tt * 0.06) * (0.6 + pulse * 0.7);
          const col = paletteAt(colorPhase, i);
          p.fill(col[0], col[1], col[2], 210);
          p.ellipse(x, y, size, size);
        }
      } else if (styleKey === 'waveform') {
        const bars = 22;
        const bw = w / bars;
        const t = p.millis() * 0.003;
        p.rectMode(p.CENTER);
        for (let i = 0; i < bars; i++) {
          const n = i / bars;
          const wave = Math.sin(n * Math.PI * 5 + t * 2) * 0.6 + Math.sin(n * Math.PI * 11 - t * 3) * 0.3;
          const bh = Math.max(4, Math.abs(wave) * h * 0.8 * (0.3 + pulse));
          const col = paletteAt(colorPhase, n * DEMO_PALETTE.length);
          p.fill(col[0], col[1], col[2], 230);
          p.rect(i * bw + bw / 2, h / 2, bw * 0.7, bh);
        }
      } else if (styleKey === 'plexus') {
        const t = p.millis() * 0.0003;
        const pts = particles.map((pt) => ({ x: p.noise(pt.sx, t) * w, y: p.noise(pt.sy, t) * h }));
        const maxDist = Math.min(w, h) * 0.4;
        p.strokeWeight(1);
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const d = p.dist(pts[i].x, pts[i].y, pts[j].x, pts[j].y);
            if (d < maxDist) {
              const col = paletteAt(colorPhase, 0);
              p.stroke(col[0], col[1], col[2], p.map(d, 0, maxDist, 180, 0));
              p.line(pts[i].x, pts[i].y, pts[j].x, pts[j].y);
            }
          }
        }
        p.noStroke();
        pts.forEach((pt, idx) => {
          const col = paletteAt(colorPhase, idx);
          p.fill(col[0], col[1], col[2], 220);
          p.ellipse(pt.x, pt.y, 5 + pulse * 4, 5 + pulse * 4);
        });
      } else if (styleKey === 'laser') {
        // 圖卡預覽故意不閃（跟正式輸出不同）——小卡片在控制台上一直閃會很
        // 分心，這裡只用平滑的 pulse 做強度變化，不用銳利的拍點閃爍。
        const sweep = Math.sin(p.millis() * 0.0009) * 0.4;
        const origins = [
          { x: w * 0.05, y: h * 1.15, base: -Math.PI / 2 + 0.6, dir: 1 },
          { x: w * 0.95, y: h * 1.15, base: -Math.PI / 2 - 0.6, dir: -1 },
        ];
        p.blendMode(p.ADD);
        origins.forEach((origin) => {
          for (let i = 0; i < 3; i++) {
            const spread = (i / 2 - 0.5) * 0.7;
            const angle = origin.base + spread + sweep * origin.dir;
            const len = Math.max(w, h) * 1.3;
            const ex = origin.x + Math.cos(angle) * len;
            const ey = origin.y + Math.sin(angle) * len;
            const col = paletteAt(colorPhase, i);
            p.stroke(col[0], col[1], col[2], 90 + pulse * 90);
            p.strokeWeight(1.5 + pulse * 1);
            p.line(origin.x, origin.y, ex, ey);
          }
        });
        p.blendMode(p.BLEND);
        p.noStroke();
      } else if (styleKey === 'chaos') {
        const beatIndex = Math.floor(colorPhase * 4);
        if (beatIndex !== chaosLastBeat) {
          chaosLastBeat = beatIndex;
          chaosOffsets = { x: randJitter(), y: randJitter() };
        }
        const baseSize = Math.min(w, h) * (0.4 + pulse * 0.25);
        const threadW = [1, 0.91, 0.9, 1, 1.03, 0.88];
        const threadH = [0.95, 1.01, 0.87, 0.95, 1.01, 0.87];
        const col = paletteAt(colorPhase, 0);
        p.noFill();
        p.stroke(col[0], col[1], col[2], 220);
        p.strokeWeight(1.5 + pulse);
        for (let i = 0; i < CHAOS_RING_COUNT; i++) {
          p.ellipse(
            w / 2 + chaosOffsets.x[i],
            h / 2 + chaosOffsets.y[i],
            threadW[i] * baseSize,
            threadH[i] * baseSize
          );
        }
        p.noStroke();
      } else if (styleKey === 'beatbars') {
        // 一次只顯示一條、跟著拍子從左到右移動（每半拍一格，兩倍速），底色 +
        // 每像素明暗抖動做材質感
        const barCount = 8;
        const beatIndex = Math.floor(colorPhase * 8);
        const activeIndex = beatIndex % barCount;
        const barW = w / barCount;
        const x0 = activeIndex * barW;
        const col = paletteAt(colorPhase, activeIndex * 0.9);

        p.noStroke();
        p.fill(col[0], col[1], col[2], 200);
        p.rect(x0, 0, barW, h);

        p.loadPixels();
        const d = p.pixelDensity();
        const canvasW = w * d;
        const canvasH = h * d;
        const bx0 = Math.max(0, Math.floor(x0 * d));
        const bx1 = Math.min(canvasW, Math.floor((x0 + barW) * d));
        for (let y = 0; y < canvasH; y++) {
          const rowStart = y * canvasW;
          for (let x = bx0; x < bx1; x++) {
            const idx = 4 * (rowStart + x);
            const shade = (Math.random() - 0.5) * 2 * 42;
            p.pixels[idx] = p.constrain(p.pixels[idx] + shade, 0, 255);
            p.pixels[idx + 1] = p.constrain(p.pixels[idx + 1] + shade, 0, 255);
            p.pixels[idx + 2] = p.constrain(p.pixels[idx + 2] + shade, 0, 255);
          }
        }
        p.updatePixels();
      } else if (styleKey === 'breath') {
        // 圖卡預覽故意不做壽命循環——固定兩條線持續呼吸即可，重生邏輯留給正式輸出
        const t = p.millis() * 0.001;
        p.noFill();
        const strands = [
          { yFrac: 0.42, amp: 0.2, seed: 0 },
          { yFrac: 0.62, amp: 0.14, seed: 50 },
        ];
        strands.forEach((s, i) => {
          const col = paletteAt(colorPhase, i * 1.3);
          p.stroke(col[0], col[1], col[2], 220);
          p.strokeWeight(1.5 + pulse);
          p.beginShape();
          for (let x = 0; x <= w; x += 4) {
            const n = p.noise(x * 0.02 + s.seed, t * 0.6);
            const y = h * s.yFrac + (n - 0.5) * h * s.amp * (0.6 + pulse);
            p.vertex(x, y);
          }
          p.endShape();
        });
        p.noStroke();
      } else if (styleKey === 'constellation') {
        const beatFloat = colorPhase * 4; // demoColorPhase 是 pos/beatSec/4，乘回去還原成拍子計數
        const stepIndex = Math.floor(beatFloat * CONSTELLATION_STEPS_PER_BEAT);
        const positions = constellationStars.map((s) => ({ x: s.fx * w, y: s.fy * h }));

        const edgeAlpha = (e) => {
          const age = beatFloat - e.born;
          if (age < CONSTELLATION_HOLD_BEATS) return 1;
          return p.constrain(1 - (age - CONSTELLATION_HOLD_BEATS) / CONSTELLATION_FADE_BEATS, 0, 1);
        };
        const crossTest = (p1, p2, p3, p4) => {
          const cross = (a, b, c) => (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
          const d1 = cross(p3, p4, p1);
          const d2 = cross(p3, p4, p2);
          const d3 = cross(p1, p2, p3);
          const d4 = cross(p1, p2, p4);
          return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
        };
        const jumpToFarStart = () => {
          const tipPos = positions[constellationTip];
          const farPoolSize = Math.max(1, Math.round((constellationStars.length - 1) * CONSTELLATION_FAR_POOL_RATIO));
          const farthest = constellationStars
            .map((_, idx) => idx)
            .filter((idx) => idx !== constellationTip)
            .sort(
              (a, b) =>
                p.dist(tipPos.x, tipPos.y, positions[b].x, positions[b].y) -
                p.dist(tipPos.x, tipPos.y, positions[a].x, positions[a].y)
            )
            .slice(0, farPoolSize);
          constellationTip = farthest[Math.floor(Math.random() * farthest.length)];
          constellationChainLength = 0;
        };

        constellationEdges = constellationEdges.filter((e) => edgeAlpha(e) > 0.02);

        if (stepIndex !== constellationLastStep) {
          constellationLastStep = stepIndex;

          if (constellationChainLength >= CONSTELLATION_CHAIN_LIMIT) {
            jumpToFarStart();
          } else {
            const blocking = constellationEdges.filter((e) => edgeAlpha(e) > 0.03);
            const neighbors = new Set();
            blocking.forEach((e) => {
              if (e.a === constellationTip) neighbors.add(e.b);
              if (e.b === constellationTip) neighbors.add(e.a);
            });
            const tipPos = positions[constellationTip];
            const candidates = constellationStars
              .map((_, idx) => idx)
              .filter((idx) => idx !== constellationTip && !neighbors.has(idx))
              .sort(
                (a, b) =>
                  p.dist(tipPos.x, tipPos.y, positions[a].x, positions[a].y) -
                  p.dist(tipPos.x, tipPos.y, positions[b].x, positions[b].y)
              )
              .slice(0, CONSTELLATION_NEAREST_POOL);

            let connected = false;
            for (const cand of candidates) {
              const candPos = positions[cand];
              const crosses = blocking.some((e) => {
                if (e.a === constellationTip || e.b === constellationTip || e.a === cand || e.b === cand) return false;
                return crossTest(tipPos, candPos, positions[e.a], positions[e.b]);
              });
              if (!crosses) {
                constellationEdges.push({ a: constellationTip, b: cand, born: beatFloat });
                constellationTip = cand;
                connected = true;
                constellationChainLength++;
                break;
              }
            }
            if (!connected) jumpToFarStart();
          }
        }

        p.strokeWeight(2.4);
        constellationEdges.forEach((e, idx) => {
          const alpha = edgeAlpha(e);
          const col = paletteAt(colorPhase, idx * 0.12);
          p.stroke(col[0], col[1], col[2], 200 * alpha);
          p.line(positions[e.a].x, positions[e.a].y, positions[e.b].x, positions[e.b].y);
        });

        p.noStroke();
        constellationStars.forEach((s, idx) => {
          const pos = positions[idx];
          const twinkle = 0.5 + 0.5 * p.noise(s.twinkleSeed, p.millis() * 0.0006);
          const col = paletteAt(colorPhase, idx * 0.2);
          const core = 2 + twinkle * 1.5 + pulse;
          p.fill(col[0], col[1], col[2], 60 * twinkle);
          p.ellipse(pos.x, pos.y, core * 3, core * 3);
          p.fill(255, 255, 255, 170 + twinkle * 60);
          p.ellipse(pos.x, pos.y, core, core);
        });
      } else if (styleKey === 'coderain') {
        const cols = Math.ceil(w / CODE_CELL) + 1;
        const rows = Math.ceil(h / CODE_CELL) + 2;
        if (cols !== codeGridCols || rows !== codeGridRows) rebuildCodeGrid(cols, rows);

        p.textFont('monospace');
        p.textSize(CODE_CELL * 0.82);
        p.textAlign(p.CENTER, p.CENTER);
        p.noStroke();

        const fallSpeed = 0.6 + pulse * 1.3;
        codeColumns.forEach((col, ci) => {
          col.y += col.speed * fallSpeed;
          const headRow = Math.floor(col.y);
          if (headRow - col.trailLen > codeGridRows) {
            col.y = -Math.random() * 20;
            col.speed = 0.35 + Math.random() * 0.55;
            col.trailLen = 6 + Math.floor(Math.random() * 8);
            return;
          }
          if (headRow >= 0 && headRow < codeGridRows) col.glyphs[headRow] = pickCodeChar();

          const x = ci * CODE_CELL + CODE_CELL / 2;
          const trailColor = paletteAt(colorPhase, ci * 0.35);
          for (let t = 0; t < col.trailLen; t++) {
            const row = headRow - t;
            if (row < 0 || row >= codeGridRows) continue;
            if (Math.random() < CODE_FLICKER_CHANCE) col.glyphs[row] = pickCodeChar();

            const y = row * CODE_CELL + CODE_CELL / 2;
            if (t === 0) {
              p.fill(255, 255, 255, 235);
            } else {
              const tt = t / col.trailLen;
              p.fill(trailColor[0], trailColor[1], trailColor[2], (1 - tt) * 220 * (0.55 + pulse * 0.45));
            }
            p.text(col.glyphs[row], x, y);
          }
        });
      }
    };
  };
}

function mountVjPreviews() {
  for (const def of VJ_STYLE_DEFS) {
    if (def.key === 'ytmv' || def.key === 'localmp4') continue; // 沒有生成式畫面可以預覽，卡片用靜態圖示代替
    const holder = document.getElementById(`vj-preview-${def.key}`);
    if (!holder) continue;
    new p5(makePreviewSketch(def.key, holder), holder);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountVjPreviews);
} else {
  mountVjPreviews();
}
