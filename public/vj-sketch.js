/**
 * VJ 背景視覺（p5.js，global mode）進入點。實際場景畫在 vj-scenes/ 目錄下，
 * 一個檔案一個場景，從 Route A 切換、寫進 window.VJ_STATE.style：
 *   circles  —— 緩慢漂移的發光圓環（不死板置中）
 *   waveform —— 模擬聲波的鏡射長條圖，跨滿整個畫面寬度
 *   plexus   —— 漂浮粒子 + 連線的星網效果
 *   laser    —— 兩側往上打的扇形雷射光束，左右搖擺，視覺強度最強的一個
 *   breath   —— 柔和的橫向 noise 波浪，一條條自己呼吸、消散、重生
 *   chaos    —— 一叢叢略為錯位的同心橢圓，隨拍點跳動重新亂位
 *   beatbars —— 畫面切成 8 條直的長條，跟著拍子從左到右一條一條亮起，材質是點雜訊
 *   constellation —— 星星依拍點逐一連線成星座，舊線慢慢淡出，線與線不重疊
 *   coderain —— 駭客任務風格的直向字元瀑布，頭亮尾暗，跟著拍子加快掉落
 *
 * 這支檔案本身是 ES module（overlay.html 用 <script type="module"> 載入），
 * 所以 p5 lifecycle 函式（setup/draw/windowResized）要明著掛到 window 上——
 * p5 global mode 是靠檢查 window.setup 之類的屬性來自動啟動，module 頂層的
 * function 宣告不會自動變成 window 的屬性，跟 classic script 不一樣。
 *
 * 節拍相位（beat phase）算法共用（見 vj-scenes/shared.js）：用
 * window.VJ_STATE.voices 的 bpm/playRate/position 算出一個平滑的呼吸脈動
 * smoothedPulse，各場景都拿這個當「音樂強度」的輸入，兩軌同時 on-air
 * （mashup）時取兩軌節拍較強的那個。
 *
 * Drop 按鈕（Route A 按一下、broadcast window.VJ_STATE.dropAt 時間戳）：不是
 * 個別場景各自處理，而是在這裡把「pulse」本身短暫推高、平滑衰減幾秒，所有
 * 場景都吃同一個 pulse 當強度輸入，效果自然套用到目前正在播的任何場景，不用
 * 每個場景另外寫一份 drop 邏輯。
 *
 * 刻意避免的做法：不用「每拍瞬間全螢幕沖亮」或任何 3–20Hz 範圍的高頻閃爍
 * （照相性癲癇風險），改成單一、經過平滑處理的呼吸脈動——雷射光束的強度/長度
 * 也是跟著這個平滑脈動走，不是硬切的閃爍。
 */
import { voicePulse, colorCyclePhase } from './vj-scenes/shared.js';
import { drawCircles } from './vj-scenes/circles.js';
import { drawWaveform } from './vj-scenes/waveform.js';
import { drawPlexus, initPlexus } from './vj-scenes/plexus.js';
import { drawLaser } from './vj-scenes/laser.js';
import { drawBreath, initBreath } from './vj-scenes/breath.js';
import { drawChaos, initChaos } from './vj-scenes/chaos.js';
import { drawBeatBars } from './vj-scenes/beat-bars.js';
import { drawConstellation, initConstellation } from './vj-scenes/constellation.js';
import { drawCodeRain } from './vj-scenes/code-rain.js';

let smoothedPulse = 0.3;

const DROP_DURATION_MS = 3500; // Drop 之後額外能量能撐多久，平滑衰減、不是瞬間切斷
const DROP_PULSE_GAIN = 0.65; // 額外疊加到 pulse 上的最大量

// ease-out：剛按下時衝到最高，之後平滑收斂到 0，跟現有 smoothedPulse 一樣
// 走連續曲線，不會有瞬間切斷或高頻閃爍
function dropEnvelope(dropAt) {
  if (!dropAt) return 0;
  const elapsed = Date.now() - dropAt;
  if (elapsed < 0 || elapsed >= DROP_DURATION_MS) return 0;
  const remain = 1 - elapsed / DROP_DURATION_MS;
  return remain * remain;
}

window.setup = function setup() {
  const canvas = createCanvas(window.innerWidth, window.innerHeight);
  canvas.parent('vj-canvas-holder');
  noStroke();
  colorMode(RGB, 255);
  initPlexus();
  initBreath();
  initChaos();
  initConstellation();
};

window.windowResized = function windowResized() {
  resizeCanvas(window.innerWidth, window.innerHeight);
};

window.draw = function draw() {
  background(0);

  const st = window.VJ_STATE || {};
  const voices = st.voices || [];
  const accentColors = st.accentColors?.length ? st.accentColors : [[74, 158, 255]];

  const pulses = voices.map(voicePulse).filter((p) => p != null);
  const targetPulse = pulses.length
    ? Math.max(...pulses)
    : 0.22 + 0.12 * Math.sin(millis() * 0.00035); // 沒在播放：很慢的環境呼吸

  smoothedPulse = lerp(smoothedPulse, targetPulse, 0.08);
  const colorPhase = colorCyclePhase(voices);

  const dropBoost = dropEnvelope(st.dropAt) * DROP_PULSE_GAIN;
  const pulse = Math.min(1, smoothedPulse + dropBoost);
  const peakPulse = Math.min(1, targetPulse + dropBoost);

  const style = st.style || 'circles';
  if (style === 'waveform') drawWaveform(pulse, accentColors, colorPhase);
  else if (style === 'plexus') drawPlexus(pulse, accentColors, colorPhase);
  else if (style === 'laser') drawLaser(pulse, peakPulse, accentColors, colorPhase);
  else if (style === 'breath') drawBreath(pulse, accentColors, colorPhase);
  else if (style === 'chaos') drawChaos(pulse, accentColors, colorPhase);
  else if (style === 'beatbars') drawBeatBars(pulse, accentColors, colorPhase);
  else if (style === 'constellation') drawConstellation(pulse, accentColors, colorPhase);
  else if (style === 'coderain') drawCodeRain(pulse, accentColors, colorPhase);
  else drawCircles(pulse, accentColors, colorPhase);
};
