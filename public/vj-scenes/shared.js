/**
 * VJ 場景共用的節拍/調色盤運算。每個場景模組（circles.js / waveform.js /
 * plexus.js / laser.js）都拿同一份 pulse/colorPhase 當「音樂強度」輸入，
 * 這裡是它們共同的計算來源，不屬於任何單一場景。
 */

// 每 BEATS_PER_COLOR 拍換一次調色盤裡的顏色（大約一個小節），回傳一個連續數字：
// 整數部分是目前第幾輪、小數部分是這輪內的進度（拿來做顏色間的平滑過渡，
// 不是瞬間切換）。沒有任何 voice 在播放時退回很慢的固定速度循環，不會完全靜止。
export const BEATS_PER_COLOR = 4;

export function voicePulse(voice) {
  if (voice?.bpm && voice.playRate > 0 && voice.positionSeconds != null) {
    const elapsed = (performance.now() - voice.positionAt) / 1000;
    const pos = voice.positionSeconds + elapsed * voice.playRate;
    const beatSec = 60 / voice.bpm;
    const phase = (((pos % beatSec) + beatSec) % beatSec) / beatSec;
    // 平滑的餘弦包絡，每拍一次、漸強漸弱，不是瞬間尖峰
    return 0.15 + 0.75 * Math.pow((1 + Math.cos(phase * Math.PI * 2)) / 2, 2);
  }
  return null;
}

export function lerpRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function colorCyclePhase(voices) {
  const voice = voices.find((v) => v?.bpm && v.playRate > 0 && v.positionSeconds != null);
  if (!voice) return millis() * 0.00008;
  const elapsed = (performance.now() - voice.positionAt) / 1000;
  const pos = voice.positionSeconds + elapsed * voice.playRate;
  const beatSec = 60 / voice.bpm;
  return pos / beatSec / BEATS_PER_COLOR;
}

export function paletteColorAt(palette, phase, offset = 0) {
  const n = palette.length;
  if (n === 1) return palette[0];
  const shifted = phase + offset;
  const idx = Math.floor(shifted);
  const frac = shifted - idx;
  const c1 = palette[((idx % n) + n) % n];
  const c2 = palette[(((idx + 1) % n) + n) % n];
  return lerpRgb(c1, c2, frac);
}
