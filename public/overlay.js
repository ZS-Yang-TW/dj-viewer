const rootEl = document.getElementById('root');
const mashupLinkEl = document.getElementById('mashup-link');
const vjCanvasHolderEl = document.getElementById('vj-canvas-holder');
const ytPlayerWrapEl = document.getElementById('yt-player-wrap');
const localMp4WrapEl = document.getElementById('local-mp4-wrap');
const localMp4VideoEl = document.getElementById('local-mp4-video');

const SLOTS = ['a', 'b'];
const els = {};
for (const slot of SLOTS) {
  els[slot] = {
    card: document.getElementById(`now-playing-${slot}`),
    art: document.getElementById(`np-art-${slot}`),
    title: document.getElementById(`np-title-${slot}`),
    artist: document.getElementById(`np-artist-${slot}`),
    progress: document.getElementById(`np-progress-${slot}`),
  };
}

const inCard = document.getElementById('incoming');
const inArt = document.getElementById('in-art');
const inTitle = document.getElementById('in-title');
const inArtist = document.getElementById('in-artist');

const webcamFrameEl = document.getElementById('webcam-frame');
const webcamVideoEl = document.getElementById('webcam-video');
let webcamStream = null;

const INCOMING_HOLD_MS = 8000; // 要跟 server.js 的 INCOMING_HOLD_MS 對齊，才會一起消失

let overlayVisible = true;
// 哪個 deckId 占用哪個視覺欄位（a/b）——「黏住」不隨排序重新洗牌，
// 已經在畫面上的那軌不會因為另一軌加入/離開而突然跳位置。
let slotAssignment = { a: null, b: null };
const nowPlaying = { a: null, b: null }; // slot -> { deckId, track, duration, bpm, playRate, positionSeconds, positionAt, accentColor }
let incomingTimer = null;

let vjStyle = 'circles';
let dropAt = 0; // 上次按 Drop 按鈕的時間戳（伺服器的 Date.now()），0 代表還沒按過
window.VJ_STATE = { voices: [], accentColors: [], style: vjStyle, dropAt };

function syncVjState() {
  const voices = [];
  const accentColors = [];
  for (const slot of SLOTS) {
    const np = nowPlaying[slot];
    if (!np) continue;
    voices.push({ bpm: np.bpm, playRate: np.playRate, positionSeconds: np.positionSeconds, positionAt: np.positionAt });
    // 每個 slot 貢獻一整組（多色）調色盤，不是只有一個顏色，VJ 視覺才有變化
    accentColors.push(...(np.accentPalette?.length ? np.accentPalette : [np.accentColor || [74, 158, 255]]));
  }
  window.VJ_STATE = { voices, accentColors, style: vjStyle, dropAt };
}

/* ---------- 封面主色萃取 ---------- */

// 專輯封面常常偏暗/偏灰，直接平均出來的顏色套在黑底上會很難看見。
// 轉成 HSL 之後把飽和度/亮度夾到一個好看的範圍，色相還是取自封面本身。
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function vividize(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  const s2 = Math.max(s, 0.55);
  const l2 = Math.min(Math.max(l, 0.42), 0.62);
  return hslToRgb(h, s2, l2);
}

const PALETTE_SIZE = 4;
const PALETTE_MIN_DISTANCE = 60; // 兩個顏色的歐幾里得距離小於這個就當作太像，跳過

const colorCanvas = document.createElement('canvas');
colorCanvas.width = 32;
colorCanvas.height = 32;
const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });

function colorDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// 很多封面本身顏色變化就不大，篩選完常常只剩 1-2 個顏色——用色相旋轉補到
// 至少 target 個，色相基準還是從封面抓到的顏色來，只是刻意分散開讓 VJ
// 視覺的顏色循環有東西可以換。
function padPalette(palette, target) {
  const result = [...palette];
  let i = 0;
  while (result.length < target) {
    const base = palette[i % palette.length];
    const [h, s, l] = rgbToHsl(base);
    const hueShift = (i + 1) / (target + 1);
    result.push(hslToRgb((h + hueShift) % 1, Math.max(s, 0.6), Math.min(Math.max(l, 0.45), 0.6)));
    i++;
  }
  return result;
}

// 從封面圖抓一組（不是只有一個）主色：把圖縮小取樣、依相近程度分桶統計出現
// 頻率，取頻率最高的幾桶，同時跳過跟已選顏色太像的，避免選出 4 個幾乎同色。
function extractPalette(img) {
  try {
    const size = 32;
    colorCtx.clearRect(0, 0, size, size);
    colorCtx.drawImage(img, 0, 0, size, size);
    const { data } = colorCtx.getImageData(0, 0, size, size);

    const buckets = new Map();
    const BUCKET = 24;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) continue; // 幾乎透明的像素不算
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = `${(r / BUCKET) | 0}_${(g / BUCKET) | 0}_${(b / BUCKET) | 0}`;
      const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }

    const ranked = Array.from(buckets.values())
      .sort((a, b) => b.count - a.count)
      .map((bucket) => [bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count]);

    const palette = [];
    for (const candidate of ranked) {
      if (palette.length >= PALETTE_SIZE) break;
      if (palette.some((chosen) => colorDistance(candidate, chosen) < PALETTE_MIN_DISTANCE)) continue;
      palette.push(candidate);
    }
    if (!palette.length && ranked.length) palette.push(ranked[0]);

    const vivid = palette.length ? palette.map(vividize) : [[74, 158, 255]];
    return padPalette(vivid, PALETTE_SIZE);
  } catch {
    return [[74, 158, 255]];
  }
}

function applyAccentPalette(slot, palette) {
  const varName = slot === 'a' ? '--accent-color' : '--accent-color-b';
  document.documentElement.style.setProperty(varName, palette[0].join(', '));
  if (nowPlaying[slot]) {
    nowPlaying[slot].accentColor = palette[0];
    nowPlaying[slot].accentPalette = palette;
  }
  syncVjState();
}

/* ---------- Now Playing 卡片（a/b 兩個欄位） ---------- */

function setNowPlayingArt(slot, deckId) {
  const img = els[slot].art;
  img.onload = () => applyAccentPalette(slot, extractPalette(img));
  img.onerror = () => applyAccentPalette(slot, [[74, 158, 255]]);
  img.src = `/api/art/${deckId}?t=${Date.now()}`;
}

function updateNowPlayingSlot(slot, deck) {
  const e = els[slot];
  const prevFilePath = nowPlaying[slot]?.track?.filePath;
  const newFilePath = deck?.track?.filePath;

  if (!deck || !deck.track) {
    nowPlaying[slot] = null;
    e.card.classList.remove('visible');
    syncVjState();
    updateMashupLink();
    syncYtContainers();
    return;
  }

  const trackChanged = newFilePath !== prevFilePath;
  nowPlaying[slot] = {
    deckId: deck.deckId,
    track: deck.track,
    duration: deck.duration,
    bpm: deck.bpm,
    playRate: deck.playRate,
    positionSeconds: deck.positionSeconds,
    positionAt: performance.now(),
    accentColor: nowPlaying[slot]?.accentColor ?? null,
    accentPalette: nowPlaying[slot]?.accentPalette ?? null,
  };
  syncVjState();

  if (trackChanged) {
    e.card.classList.remove('visible');
    setTimeout(() => {
      e.title.textContent = deck.track.title || '(未知曲名)';
      e.artist.textContent = deck.track.artist || '(未知藝人)';
      setNowPlayingArt(slot, deck.deckId);
      e.card.classList.add('visible');
      updateMashupLink();
    }, 250);
  } else {
    e.card.classList.add('visible');
  }
  updateMashupLink();
  syncYtContainers();
}

function updateMashupLink() {
  mashupLinkEl.classList.toggle('active', !!nowPlaying.a && !!nowPlaying.b);
}

/* ---------- VJ 風格 4：YouTube MV（靜音背景） ----------
 * 兩軌同時 on-air（mashup）時分割畫面，左（slot a）右（slot b）各一支影片；
 * 只有一軌時 slot a 的影片獨佔全螢幕。
 */

const ytPlayers = { a: null, b: null };
let ytApiReady = false;
const ytCurrentVideoId = { a: null, b: null };
const ytCurrentFilePath = { a: null, b: null };
// 只有真的成功拿到影片 ID 且 player 就緒時才算「有畫面」——搜尋失敗、API 還沒
// load 好、或影片播放中途出錯，都要退回 p5 生成式背景，不能讓畫面變成純黑。
const ytHasVideo = { a: false, b: false };

// 生成式 p5 畫布跟兩種「外部影片」圖層（YouTube MV / 在地 MP4）共用同一塊
// vj-canvas-holder 空間——同一時間最多只有一種在顯示，所以用一個函式統一算，
// 不要讓兩邊各自 toggle 同一個 class，不然後呼叫的那個會覆蓋掉前一個的判斷。
function refreshYtLayerVisibility() {
  const showYt = vjStyle === 'ytmv' && (ytHasVideo.a || ytHasVideo.b);
  const showLocalMp4 = vjStyle === 'localmp4' && localMp4HasVideo;
  vjCanvasHolderEl.classList.toggle('style-hidden', showYt || showLocalMp4);
  ytPlayerWrapEl.classList.toggle('active', showYt);
  localMp4WrapEl.classList.toggle('active', showLocalMp4);
}

/* ---------- YT 容器（誰的影片放在哪個 iframe）跟 NP 卡片欄位分開追蹤 ----------
 * NP 卡片欄位（slotAssignment）在只剩一軌時會把它收斂回 slot a，純粹是排版
 * 決定。如果 YouTube 影片也直接照抄這個收斂，等於把已經在播的那支影片從
 * container b 硬搬到 container a——實際上是整個 loadVideoById 重新載入，
 * 畫面就會斷線好幾秒。這裡讓「container 裡放哪個 deck 的影片」自己黏住，
 * 只要那個 deck 還在線上就不動；畫面上誰全螢幕/誰分割純粹靠 CSS class
 * 決定，不會動到底層的 YT.Player。
 */
const ytContainerDeckId = { a: null, b: null };

function containerForDeckId(deckId) {
  return SLOTS.find((c) => ytContainerDeckId[c] === deckId) ?? null;
}

function activeYtDeckIds() {
  return [...new Set(SLOTS.map((s) => nowPlaying[s]?.deckId).filter((id) => id != null))];
}

function npByDeckId(deckId) {
  return SLOTS.map((s) => nowPlaying[s]).find((np) => np?.deckId === deckId) ?? null;
}

function sizePlayer(slot) {
  const player = ytPlayers[slot];
  if (!player?.setSize) return;
  const container = document.getElementById(`yt-player-slot-${slot}`);
  const vw = container.clientWidth;
  const vh = container.clientHeight;
  if (!vw || !vh) return;
  const aspect = 16 / 9;
  let w, h;
  if (vw / vh > aspect) {
    w = vw;
    h = w / aspect;
  } else {
    h = vh;
    w = h * aspect;
  }
  player.setSize(Math.ceil(w), Math.ceil(h));
}

function sizeAllYtPlayers() {
  sizePlayer('a');
  sizePlayer('b');
}
window.addEventListener('resize', sizeAllYtPlayers);

function makeYtPlayer(slot) {
  try {
    ytPlayers[slot] = new YT.Player(`yt-player-${slot}`, {
      width: '1280',
      height: '720',
      playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: () => {
          ytPlayers[slot].mute();
          sizePlayer(slot);
          if (ytCurrentVideoId[slot]) ytPlayers[slot].loadVideoById(ytCurrentVideoId[slot]);
        },
        onError: () => {
          ytHasVideo[slot] = false;
          refreshYtLayerVisibility();
        },
        onStateChange: (e) => {
          // 1 = playing；只有真的開始播放才算數，buffering/ended/error 都不算
          ytHasVideo[slot] = e.data === 1;
          refreshYtLayerVisibility();
        },
      },
    });
  } catch (err) {
    console.warn(`YouTube player (slot ${slot}) 初始化失敗：`, err.message);
  }
}

window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
  makeYtPlayer('a');
  makeYtPlayer('b');
};

async function loadYtVideoForContainer(container, deckId) {
  const np = npByDeckId(deckId);
  if (!np) return;
  if (np.track.filePath === ytCurrentFilePath[container]) return; // 同一支影片，不用重新載入
  ytCurrentFilePath[container] = np.track.filePath;

  let videoId = null;
  try {
    const res = await fetch(`/api/yt/${deckId}`);
    videoId = res.ok ? (await res.json()).videoId : null;
  } catch {
    videoId = null;
  }
  // await 這段期間容器可能已經被指派給別的 deck（快速切歌），這次結果就過期了
  if (ytContainerDeckId[container] !== deckId) return;
  ytCurrentVideoId[container] = videoId;

  if (!videoId) {
    ytHasVideo[container] = false;
    if (ytPlayers[container]?.stopVideo) ytPlayers[container].stopVideo();
    refreshYtLayerVisibility();
    return;
  }
  if (ytApiReady && ytPlayers[container]?.loadVideoById) {
    try {
      // 對一次目前實際播放到的秒數，讓 MV 大概接在對應的位置——只在載入這支
      // 影片的當下對一次，不會持續強制拉回同步（YouTube 上的版本跟你播的
      // 檔案剪輯不一定完全一樣長，硬要持續同步只會一直跳格很怪）。
      const elapsed = (performance.now() - np.positionAt) / 1000;
      const estimatedPos = Math.max(0, np.positionSeconds + elapsed * (np.playRate || 0));
      ytPlayers[container].loadVideoById(videoId, estimatedPos);
      ytPlayers[container].mute();
      ytPlayers[container].playVideo();
      // ytHasVideo 交給 onStateChange 確認真的開始播放才設 true，這裡不搶著設
    } catch (err) {
      console.warn(`YouTube 影片載入失敗（container ${container}）：`, err.message);
      ytHasVideo[container] = false;
      refreshYtLayerVisibility();
    }
  } else {
    // API 還沒 ready，先保持退回生成式背景，等 onReady 裡的 loadVideoById 補上
    ytHasVideo[container] = false;
    refreshYtLayerVisibility();
  }
}

function syncYtContainers() {
  if (vjStyle !== 'ytmv') return;
  const activeDeckIds = activeYtDeckIds();

  // 釋放已經離場的 deck 占用的容器
  for (const c of SLOTS) {
    const deckId = ytContainerDeckId[c];
    if (deckId != null && !activeDeckIds.includes(deckId)) {
      ytContainerDeckId[c] = null;
      ytCurrentFilePath[c] = null;
      ytCurrentVideoId[c] = null;
      ytHasVideo[c] = false;
      if (ytPlayers[c]?.stopVideo) ytPlayers[c].stopVideo();
    }
  }

  // 幫新上線、還沒有容器的 deck 分配一個空容器
  for (const deckId of activeDeckIds) {
    if (containerForDeckId(deckId) != null) continue;
    const free = SLOTS.find((c) => ytContainerDeckId[c] == null);
    if (free) ytContainerDeckId[free] = deckId;
  }

  // 排版：只剩一軌時，那一軌原本在哪個容器就讓哪個容器全螢幕——不強迫搬家
  const split = activeDeckIds.length >= 2;
  const solo = !split && activeDeckIds.length === 1 ? containerForDeckId(activeDeckIds[0]) : null;
  ytPlayerWrapEl.classList.toggle('split', split);
  for (const c of SLOTS) {
    document.getElementById(`yt-player-slot-${c}`).classList.toggle('yt-solo', c === solo);
  }
  // 等 CSS 的 width transition 排版更新完再重新量尺寸，不然會抓到過渡中的尺寸
  requestAnimationFrame(() => requestAnimationFrame(sizeAllYtPlayers));

  for (const c of SLOTS) {
    const deckId = ytContainerDeckId[c];
    if (deckId != null) loadYtVideoForContainer(c, deckId);
  }
  refreshYtLayerVisibility();
}

/* ---------- VJ 風格：在地 MP4 ----------
 * 控制台選好 public/videos/ 底下的某個檔案後，這裡直接把它當 <video> 的 src
 * 播放（靜音、循環），畫面全螢幕鋪滿——跟 YouTube MV 那組邏輯平行，只是
 * 不用處理雙軌分割畫面（純粹單一背景素材，不跟著哪個 deck 走）。
 */
let localVideoFile = null; // 目前選中的檔名（來自伺服器狀態，可能還沒真的載入播放）
let localMp4LoadedFile = null; // 目前真的載入到 <video> 裡的檔名
let localMp4HasVideo = false; // 真的開始播放才算數，載入中/出錯都要退回 p5 生成式背景

// 用 loadeddata（第一格畫面可解出來就算數）而不是 playing——playing 在部分
// 瀏覽器要等緩衝到足以撐過一段播放才觸發，大檔案會讓切換卡好幾秒才生效，
// 換成 loadeddata 幾乎是選好檔案立刻就能看到畫面。
localMp4VideoEl.addEventListener('loadeddata', () => {
  localMp4HasVideo = true;
  refreshYtLayerVisibility();
});
localMp4VideoEl.addEventListener('error', () => {
  localMp4HasVideo = false;
  refreshYtLayerVisibility();
});

function loadLocalMp4(file) {
  if (!file) {
    localMp4LoadedFile = null;
    localMp4HasVideo = false;
    localMp4VideoEl.pause();
    localMp4VideoEl.removeAttribute('src');
    localMp4VideoEl.load();
    refreshYtLayerVisibility();
    return;
  }
  if (file === localMp4LoadedFile) {
    // 同一支影片只是被切走又切回來——元素沒被卸載（src 還在），readyState
    // 還留著上次的緩衝，不會再觸發一次 loadeddata，所以要在這裡自己補上
    // hasVideo + 重新算可見度，不然畫面會停在切走那一刻的 p5 背景。
    localMp4HasVideo = true;
    localMp4VideoEl.play().catch(() => {});
    refreshYtLayerVisibility();
    return;
  }
  localMp4LoadedFile = file;
  localMp4HasVideo = false;
  refreshYtLayerVisibility();
  localMp4VideoEl.src = `/videos/${encodeURIComponent(file)}`;
  localMp4VideoEl.load();
  localMp4VideoEl.play().catch(() => {});
}

function applyVjStyleVisibility() {
  if (vjStyle === 'ytmv') {
    syncYtContainers();
    for (const c of SLOTS) if (ytPlayers[c]?.playVideo) ytPlayers[c].playVideo();
  } else {
    for (const c of SLOTS) {
      if (ytPlayers[c]?.pauseVideo) ytPlayers[c].pauseVideo();
      ytHasVideo[c] = false;
    }
  }

  if (vjStyle === 'localmp4') {
    loadLocalMp4(localVideoFile);
  } else {
    localMp4VideoEl.pause();
    localMp4HasVideo = false;
  }

  refreshYtLayerVisibility();
}

function tickNowPlayingProgress() {
  for (const slot of SLOTS) {
    const np = nowPlaying[slot];
    if (!np) continue;
    const elapsed = (performance.now() - np.positionAt) / 1000;
    const pos = np.positionSeconds + elapsed * (np.playRate || 0);
    els[slot].progress.style.width = np.duration ? `${Math.min(100, (pos / np.duration) * 100)}%` : '0%';
  }
}
setInterval(tickNowPlayingProgress, 200);

/* ---------- 欄位分配（哪個 deck 顯示在哪個欄位） ---------- */

function slotForDeckId(deckId) {
  return SLOTS.find((s) => slotAssignment[s] === deckId) ?? null;
}

function reassignSlots(activeDeckIds) {
  for (const slot of SLOTS) {
    if (slotAssignment[slot] != null && !activeDeckIds.includes(slotAssignment[slot])) {
      slotAssignment[slot] = null;
    }
  }

  if (activeDeckIds.length <= 1) {
    // 只剩一軌（或都沒有）時一律收斂回左邊，不要卡在右邊欄位
    slotAssignment = { a: activeDeckIds[0] ?? null, b: null };
    return;
  }

  for (const deckId of activeDeckIds) {
    if (slotForDeckId(deckId) != null) continue;
    const freeSlot = SLOTS.find((s) => slotAssignment[s] == null);
    if (freeSlot) slotAssignment[freeSlot] = deckId;
    // 理論上很少見：同時 on-air 超過 2 軌時，多出來的先不顯示
  }
}

// 短時間內連續收到多個 onair 事件時（例如轉 fader 經過門檻附近時數值抖動），
// 每個都會各自發一個 /api/state 請求，回應可能不按送出順序抵達——用一個世代
// 編號擋掉過期的回應，避免舊的結果蓋掉新的畫面狀態。
let onairGeneration = 0;

async function refreshSlotsFromState() {
  const gen = ++onairGeneration;
  let data;
  try {
    const res = await fetch('/api/state');
    data = await res.json();
  } catch (err) {
    // fetch 失敗就靜靜放棄這次更新——不要讓卡片卡在「已經 remove visible
    // 但沒人補回來」的半途狀態。下面的定期校正會在幾秒內自動補上。
    console.warn('/api/state 更新失敗：', err.message);
    return;
  }
  if (gen !== onairGeneration) return; // 已經有更新的 onair 事件進來了，這次結果過期
  for (const slot of SLOTS) {
    const deckId = slotAssignment[slot];
    const deck = deckId != null ? data.decks.find((d) => d.deckId === deckId) : null;
    updateNowPlayingSlot(slot, deck || null);
  }
}

// 保底的定期自動校正：萬一漏接或處理失敗某個即時事件導致畫面卡住，
// 最多幾秒內會自動抓一次完整狀態校正回來，不需要手動觸發（例如重新
// load 一次 deck）才能恢復。
setInterval(refreshSlotsFromState, 4000);

/* ---------- Incoming 預告卡 ---------- */

function showIncoming(deck) {
  if (!overlayVisible || !deck?.track) return;
  clearTimeout(incomingTimer);

  inTitle.textContent = deck.track.title || '(未知曲名)';
  inArtist.textContent = deck.track.artist || '(未知藝人)';
  inArt.src = `/api/art/${deck.deckId}?t=${Date.now()}`;
  inCard.classList.add('show');

  incomingTimer = setTimeout(() => {
    inCard.classList.remove('show');
  }, INCOMING_HOLD_MS);
}

/* ---------- 視訊畫面（DJ 鏡頭） ---------- */

const WEBCAM_FADE_MS = 1000; // 跟 overlay.css 的 .webcam-frame transition 時間對齊
let webcamStopTimer = null;

async function setWebcamEnabled(enabled) {
  clearTimeout(webcamStopTimer);

  if (enabled) {
    if (webcamStream) {
      webcamFrameEl.classList.add('visible');
      return; // 已經開著，不用重新要一次鏡頭
    }
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      webcamVideoEl.srcObject = webcamStream;
      // 等第一格畫面真的解碼出來才開始淡入，不然框先淡入時裡面還是黑的
      // （video 的預設底色），等畫面接上會像瞬間閃一下。
      await new Promise((resolve) => {
        webcamVideoEl.onloadeddata = resolve;
        setTimeout(resolve, 3000); // 保底：萬一事件沒觸發，最多等 3 秒還是讓框出現
      });
      webcamFrameEl.classList.add('visible');
    } catch (err) {
      console.warn('無法開啟攝影機：', err.message);
      webcamFrameEl.classList.remove('visible');
    }
  } else {
    webcamFrameEl.classList.remove('visible');
    // 畫面內容留著繼續播，等淡出動畫真的跑完才關鏡頭，不然框還在淡出、
    // 畫面卻已經瞬間變黑，看起來就不是「漸漸消失」了。
    webcamStopTimer = setTimeout(() => {
      if (webcamStream) {
        webcamStream.getTracks().forEach((track) => track.stop());
        webcamStream = null;
        webcamVideoEl.srcObject = null;
      }
    }, WEBCAM_FADE_MS);
  }
}

/* ---------- 資料連線 ---------- */

async function applyState(data) {
  overlayVisible = data.overlayVisible;
  rootEl.classList.toggle('hidden', !overlayVisible);
  vjStyle = data.vjStyle || vjStyle;
  dropAt = data.dropAt || dropAt;
  localVideoFile = data.localVideoFile || null;
  syncVjState();
  applyVjStyleVisibility();
  setWebcamEnabled(!!data.webcamEnabled);
  reassignSlots(data.onAirDeckIds);
  for (const slot of SLOTS) {
    const deckId = slotAssignment[slot];
    const deck = deckId != null ? data.decks.find((d) => d.deckId === deckId) : null;
    updateNowPlayingSlot(slot, deck || null);
  }
}

async function fetchInitialState() {
  const res = await fetch('/api/state');
  await applyState(await res.json());
}

function connectWebSocket() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'onair') {
      reassignSlots(msg.deckIds);
      refreshSlotsFromState();
    } else if (msg.type === 'playhead') {
      const slot = slotForDeckId(msg.deckId);
      if (slot && nowPlaying[slot]) {
        nowPlaying[slot].positionSeconds = msg.positionSeconds;
        nowPlaying[slot].playRate = msg.playRate;
        nowPlaying[slot].bpm = msg.bpm;
        nowPlaying[slot].positionAt = performance.now();
        syncVjState();
      }
    } else if (msg.type === 'deck') {
      const slot = slotForDeckId(msg.deck.deckId);
      if (slot) updateNowPlayingSlot(slot, msg.deck);
    } else if (msg.type === 'overlay') {
      overlayVisible = msg.visible;
      rootEl.classList.toggle('hidden', !overlayVisible);
    } else if (msg.type === 'incoming') {
      showIncoming(msg.deck);
    } else if (msg.type === 'vjStyle') {
      vjStyle = msg.style;
      syncVjState();
      applyVjStyleVisibility();
    } else if (msg.type === 'drop') {
      dropAt = msg.at;
      syncVjState();
    } else if (msg.type === 'webcam') {
      setWebcamEnabled(!!msg.enabled);
    } else if (msg.type === 'localVideo') {
      localVideoFile = msg.file || null;
      if (vjStyle === 'localmp4') loadLocalMp4(localVideoFile);
    } else if (msg.type === 'ytNudge') {
      for (const slot of SLOTS) {
        const player = ytPlayers[slot];
        if (!player?.getCurrentTime || !player?.seekTo) continue;
        try {
          player.seekTo(Math.max(0, player.getCurrentTime() + msg.seconds), true);
        } catch {
          // 這個 slot 目前沒有真的在播影片就算了，不用報錯
        }
      }
    }
  };
  ws.onclose = () => setTimeout(connectWebSocket, 3000);
  ws.onerror = () => ws.close();
}

fetchInitialState();
connectWebSocket();
