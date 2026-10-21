const rootEl = document.getElementById('root');
const mashupLinkEl = document.getElementById('mashup-link');
const vjCanvasHolderEl = document.getElementById('vj-canvas-holder');
const ytPlayerWrapEl = document.getElementById('yt-player-wrap');
const localMp4WrapEl = document.getElementById('local-mp4-wrap');
const localMp4VideoEl = document.getElementById('local-mp4-video');
const localMvWrapEl = document.getElementById('local-mv-wrap');
const localMvVideoEls = { a: document.getElementById('local-mv-video-a'), b: document.getElementById('local-mv-video-b') };

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

const ART_PLACEHOLDER_SRC = 'art-placeholder.svg';

// 有曲目但抓不到封面(串流曲目、iTunes 也查無結果……)時,放一張灰色唱盤的
// 預設圖示,不要讓觀眾畫面上的 <img> 顯示瀏覽器內建那個破圖示。
function setNowPlayingArt(slot, deckId) {
  const img = els[slot].art;
  img.onload = () => applyAccentPalette(slot, extractPalette(img));
  img.onerror = () => {
    img.onerror = null; // 避免萬一連預設圖示都載入失敗時無限觸發
    img.onload = () => applyAccentPalette(slot, [[74, 158, 255]]); // 純灰階圖示不用抓色，直接用預設配色
    img.src = ART_PLACEHOLDER_SRC;
  };
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
    syncLocalMvContainers();
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
  // 不用 snap:剛載入頁面/定期整體狀態校正時只補記錄,不要每次都硬 seek 一次
  // 造成畫面跳動——真正「loop 剛啟動」的視覺對位由 ws 的 loop 事件負責。
  setVideoLoopState(deck.deckId, deck.loopActive, deck.loopStartSeconds, deck.loopDurationSeconds, { snap: false });

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
  syncLocalMvContainers();
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
const ytFallbackTimer = { a: null, b: null };
// loop 跟拍/跳位置偵測/手動更新對位都會呼叫 seekTo()，YouTube player 每次
// seek 幾乎都會先閃過一次 buffering 狀態（onStateChange 的 e.data !== 1），
// 如果一收到 buffering 就立刻判定「沒畫面」切回 p5 生成式背景，loop 每次
// wrap 都會讓畫面閃一下退回去再彈回來。改成延遲一小段時間才真的判定沒畫面，
// 讓 buffering 這種通常一下就恢復播放的過渡狀態有機會在退回 p5 之前先復原；
// 真的長時間播不出來（影片掛了、網路斷線）還是會照樣退回去，只是慢個幾百毫秒。
// 「本機 MV」（見後面 VJ 風格：本機 MV 那段）也共用同一個緩衝時間常數。
const VIDEO_BUFFER_GRACE_MS = 700;
function setYtHasVideo(slot, playing) {
  clearTimeout(ytFallbackTimer[slot]);
  ytFallbackTimer[slot] = null;
  if (playing) {
    ytHasVideo[slot] = true;
    refreshVideoLayerVisibility();
    return;
  }
  ytFallbackTimer[slot] = setTimeout(() => {
    ytFallbackTimer[slot] = null;
    ytHasVideo[slot] = false;
    refreshVideoLayerVisibility();
  }, VIDEO_BUFFER_GRACE_MS);
}
const lastYtRate = { a: null, b: null }; // 上次幫這個 container 設過的 playbackRate,避免每個 playhead 事件都重打 API
// deckId -> { startSeconds, durationSeconds } | null,只跟 autoLoopOn 這種手動
// loop 對齊。YouTube MV 跟本機 MV 共用同一份——這是 server.js 廣播出來的
// deck 層級狀態，跟哪一種視覺樣式在顯示無關。
const videoLoopState = {};

// 生成式 p5 畫布跟三種「外部影片」圖層（YouTube MV / 在地 MP4 / 本機 MV）
// 共用同一塊 vj-canvas-holder 空間——同一時間最多只有一種在顯示，所以用一個
// 函式統一算，不要讓各自 toggle 同一個 class，不然後呼叫的那個會覆蓋掉
// 前一個的判斷。
// 「本機 MV」某個 container 目前實際顯示的畫面來源是本機影片還是 YT fallback，
// 有沒有畫面要看對應那邊的 hasVideo 旗標。
function localMvContainerShowingVideo(c) {
  return mvSourceIsYt[c] ? ytHasVideo[c] : localMvHasVideo[c];
}

function refreshVideoLayerVisibility() {
  // showYt 同時涵蓋兩種情況：純 'ytmv' 風格，或 'localmv' 風格底下真的有
  // container 落到 YT fallback「而且」YT 那邊也真的找到、播出了影片——後者
  // 缺一不可，只是「正在嘗試 fallback」但 YouTube 還沒回應/根本找不到時，
  // 不能把 .yt-player-wrap 顯示出來，不然它自己的黑底會把整個畫面蓋黑、
  // 蓋住原本該退回去的 p5 生成式背景。
  const localMvUsingYtFallback = vjStyle === 'localmv' && (mvSourceIsYt.a || mvSourceIsYt.b);
  const showYt = (vjStyle === 'ytmv' || localMvUsingYtFallback) && (ytHasVideo.a || ytHasVideo.b);
  const showLocalMp4 = vjStyle === 'localmp4' && localMp4HasVideo;
  const showLocalMv = vjStyle === 'localmv' && (localMvContainerShowingVideo('a') || localMvContainerShowingVideo('b'));
  vjCanvasHolderEl.classList.toggle('style-hidden', showYt || showLocalMp4 || showLocalMv);
  ytPlayerWrapEl.classList.toggle('active', showYt);
  localMp4WrapEl.classList.toggle('active', showLocalMp4);
  localMvWrapEl.classList.toggle('active', vjStyle === 'localmv');
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

function activeVjDeckIds() {
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
      // 曾經多加過 rel:0/fs:0/iv_load_policy:3/cc_load_policy:0 想再降低一點
      // YouTube 自己的介面元素，結果反而讓畫面中央冒出一個暫停鈕（controls:0
      // 照理說不該有，但 fs:0 之類的參數組合會讓某些版本的 YouTube 播放器
      // 又把它加回來）——這幾個參數帶來的好處遠不如這個副作用嚴重，退回最
      // 精簡的版本。
      playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: () => {
          ytPlayers[slot].mute();
          sizePlayer(slot);
          if (ytCurrentVideoId[slot]) ytPlayers[slot].loadVideoById(ytCurrentVideoId[slot]);
        },
        onError: () => {
          // 真的播放失敗，不用等 buffering 的緩衝時間，立刻退回 p5 生成式背景
          clearTimeout(ytFallbackTimer[slot]);
          ytFallbackTimer[slot] = null;
          ytHasVideo[slot] = false;
          refreshVideoLayerVisibility();
        },
        onStateChange: (e) => {
          // 1 = playing；只有真的開始播放才算數，buffering/ended 都不算，但
          // 走 setYtHasVideo 給一段緩衝時間，讓 seek 之後短暫的 buffering
          // 有機會自己恢復播放，不要立刻切回 p5 生成式背景又跳回來。
          setYtHasVideo(slot, e.data === 1);
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
    refreshVideoLayerVisibility();
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
      refreshVideoLayerVisibility();
    }
  } else {
    // API 還沒 ready，先保持退回生成式背景，等 onReady 裡的 loadVideoById 補上
    ytHasVideo[container] = false;
    refreshVideoLayerVisibility();
  }
}

/* ---------- YouTube MV:速度跟拍 + loop 跟拍 ----------
 * Serato Remote 給的是 playRate(相對 1.0 的倍率)跟 bpm,不是 YouTube
 * setPlaybackRate 可以吃任意值——YouTube 合法倍率是離散檔位(通常
 * 0.25/0.5/0.75/1/1.25/1.5/1.75/2),這裡只能找「最接近的合法值」貼過去,
 * pitch fader 只調 ±2%~3% 這種小差距很可能完全對不到最近檔位,這是
 * YouTube API 本身的限制。
 */
function nearestPlaybackRate(player, target) {
  const rates = player?.getAvailablePlaybackRates?.() ?? [1];
  if (!rates.length) return 1;
  return rates.reduce((best, r) => (Math.abs(r - target) < Math.abs(best - target) ? r : best), rates[0]);
}

// track 秒數直接當 video 秒數用(跟 loadYtVideoForContainer/loop 對位同一套
// t=0 對齊假設),把某個 deck 對到的 YT 影片 seek 過去。
function seekYtToTrackPosition(deckId, trackSeconds) {
  const container = containerForDeckId(deckId);
  const player = ytPlayers[container];
  if (!container || !player?.seekTo) return;
  try {
    player.seekTo(Math.max(0, trackSeconds), true);
  } catch {
    // 容器目前沒有真的在播影片就算了
  }
}

// 一般播放時,每次 playhead 更新的位置跟「用上次位置 + 經過時間 * playRate」
// 推算出來的位置頂多差個零點幾秒(訊息延遲、rate 量化誤差)。差距一旦超過
// 這個門檻,代表使用者手動跳了位置(seek、hot cue、倒轉、needle drop……),
// 不是正常播放的漂移——這種情況要把 MV 也拉去對應位置,不然兩邊會直接對不上。
// 門檻抓太小容易被抖動誤觸發,抓太大則小範圍的 beatjump 抓不到——但那種
// 位移本來就小,视觉上感覺不出來對不上,可以接受。
const SEEK_JUMP_THRESHOLD_SECONDS = 0.75;

function estimatedTrackPosition(np) {
  const elapsed = (performance.now() - np.positionAt) / 1000;
  return Math.max(0, np.positionSeconds + elapsed * (np.playRate || 0));
}

// 手動「更新對位」用:把目前所有有指定 deck 的 YT container 都重新對到
// 那個 deck 現在估計的播放位置——跟自動跳位置偵測用同一個 seekYtToTrackPosition,
// 差別只在這裡是使用者主動觸發、不看有沒有超過門檻。
function resyncAllYtPlayers() {
  for (const c of SLOTS) {
    const deckId = ytContainerDeckId[c];
    if (deckId == null) continue;
    const np = npByDeckId(deckId);
    if (!np) continue;
    seekYtToTrackPosition(deckId, estimatedTrackPosition(np));
  }
}

function applyYtPlaybackRate(deckId, playRate) {
  if (!playRate) return;
  const container = containerForDeckId(deckId);
  if (!container) return;
  // 'ytmv' 風格底下每個 container 一定是 YT；'localmv' 風格則只有真的在用
  // YT fallback 的 container 才需要對速，本機影片那邊交給
  // applyLocalMvPlaybackRate 處理。
  const usingYt = vjStyle === 'ytmv' || (vjStyle === 'localmv' && mvSourceIsYt[container]);
  if (!usingYt) return;
  const player = ytPlayers[container];
  if (!player?.setPlaybackRate) return;
  const rate = nearestPlaybackRate(player, playRate);
  if (rate === lastYtRate[container]) return; // 沒變就不用重打 API
  lastYtRate[container] = rate;
  try {
    player.setPlaybackRate(rate);
  } catch {
    // 影片還沒真的載入好時呼叫會丟錯,忽略,下次 playhead tick 會再試
  }
}

// Serato 只給「loop 開/關」+「loop 長度(拍數)」,沒有 loop-in/out 的絕對秒數,
// server.js 已經換算成 track 秒數的 startSeconds/durationSeconds。這裡假設
// YouTube MV 跟音檔從同一個 t=0 開始對齊——跟載入影片時的一次性對位邏輯
// (loadYtVideoForContainer 那段)用同一套假設,所以直接把 track 秒數當
// video 秒數用,不用另外維護一個 offset。
// snap=true 是剛收到「loop 啟動」事件那一刻,把畫面立刻拉去 loop-in 點跟
// 音樂對上;snap=false(定期整體狀態校正/剛載入頁面時)只更新記錄,不要
// 每次都硬 seek 一次造成畫面跳動。
// 保底用:hot cue 跳出 loop 時,server.js 那邊的判斷跟這裡的跳位置偵測理論上
// 幾乎同時發生,但畢竟隔著一個 WS 來回——這裡先在客戶端自己檢查一次「新位置
// 是否已經離開目前記錄的 loop 範圍」,先清掉本地的 videoLoopState,不用等
// server 那則 loop off 訊息真的送到,避免 tickYtLoops 在這個空檔又把畫面拉回
// loop 裡卡一下。跟 server.js 的 isOutsideLoop 用同一套容忍誤差。
const LOOP_EXIT_TOLERANCE_SECONDS = 1.5;
function clearVideoLoopIfOutside(deckId, positionSeconds) {
  const loop = videoLoopState[deckId];
  if (!loop) return;
  if (positionSeconds < loop.startSeconds - LOOP_EXIT_TOLERANCE_SECONDS || positionSeconds > loop.startSeconds + loop.durationSeconds + LOOP_EXIT_TOLERANCE_SECONDS) {
    videoLoopState[deckId] = null;
  }
}

// deckId 這個 loop 狀態可能同時對到 YouTube MV 的 container、也可能對到
// 本機 MV 的 container（兩者互不衝突，只有目前實際啟用的那個風格才有非 null
// 的 container 指派，另一個風格的 container map 就算留著舊值也不會顯示出來）
// ——snap 的時候兩邊都試著 seek 一次，各自檢查自己有沒有真的指派到就好。
function setVideoLoopState(deckId, active, startSeconds, durationSeconds, { snap }) {
  videoLoopState[deckId] = active && durationSeconds ? { startSeconds, durationSeconds } : null;
  if (!snap || !videoLoopState[deckId]) return;

  const ytContainer = containerForDeckId(deckId);
  const ytPlayer = ytPlayers[ytContainer];
  if (ytContainer && ytPlayer?.seekTo) {
    try {
      ytPlayer.seekTo(startSeconds, true);
    } catch {
      // 容器目前沒有真的在播影片就算了
    }
  }

  const mvContainer = containerForLocalMvDeckId(deckId);
  if (mvContainer && !mvSourceIsYt[mvContainer]) localMvVideoEls[mvContainer].currentTime = startSeconds;
}

// 定期檢查:哪個 container 對到的 deck 目前正在 loop,播放時間超過 loop 終點
// 就跳回 loop 起點,做出「畫面也跟著 loop」的效果。輪詢間隔跟精準度換效能,
// 150ms 的誤差對一支當背景用的 MV 來說看不太出來。
function tickYtLoops() {
  for (const c of SLOTS) {
    const deckId = ytContainerDeckId[c];
    const loop = deckId != null ? videoLoopState[deckId] : null;
    if (!loop) continue;
    const player = ytPlayers[c];
    if (!player?.getCurrentTime || !player?.seekTo) continue;
    let current;
    try {
      current = player.getCurrentTime();
    } catch {
      continue;
    }
    if (current >= loop.startSeconds + loop.durationSeconds) {
      try {
        player.seekTo(loop.startSeconds, true);
      } catch {
        // 忽略
      }
    }
  }
}

// 本機 MV 版本的 loop 跟拍——邏輯跟 tickYtLoops 一樣，只是 <video> 元素的
// currentTime 是同步、精準的屬性存取，不用 try/catch 包 async API。
function tickLocalMvLoops() {
  for (const c of SLOTS) {
    if (!shouldTickLocalMvLoop(c)) continue; // 這個 container 目前是 YT fallback，交給 tickYtLoops
    const deckId = localMvContainerDeckId[c];
    const loop = deckId != null ? videoLoopState[deckId] : null;
    if (!loop) continue;
    const videoEl = localMvVideoEls[c];
    if (videoEl.currentTime >= loop.startSeconds + loop.durationSeconds) {
      videoEl.currentTime = loop.startSeconds;
    }
  }
}

function syncYtContainers() {
  if (vjStyle !== 'ytmv') return;
  const activeDeckIds = activeVjDeckIds();

  // 釋放已經離場的 deck 占用的容器
  for (const c of SLOTS) {
    const deckId = ytContainerDeckId[c];
    if (deckId != null && !activeDeckIds.includes(deckId)) {
      ytContainerDeckId[c] = null;
      ytCurrentFilePath[c] = null;
      ytCurrentVideoId[c] = null;
      ytHasVideo[c] = false;
      lastYtRate[c] = null;
      if (ytPlayers[c]?.stopVideo) ytPlayers[c].stopVideo();
    }
  }

  // 幫新上線、還沒有容器的 deck 分配一個空容器
  for (const deckId of activeDeckIds) {
    if (containerForDeckId(deckId) != null) continue;
    const free = SLOTS.find((c) => ytContainerDeckId[c] == null);
    if (free) ytContainerDeckId[free] = deckId;
  }

  applyYtLayoutFromContainerMap();

  for (const c of SLOTS) {
    const deckId = ytContainerDeckId[c];
    if (deckId != null) loadYtVideoForContainer(c, deckId);
  }
  refreshVideoLayerVisibility();
}

// 排版：只剩一軌時，那一軌原本在哪個容器就讓哪個容器全螢幕——不強迫搬家。
// 抽出來是因為「本機 MV」風格找不到本機檔案、退回 YouTube 搜尋時，也要用
// ytContainerDeckId（跟本機 MV 的 container map 鏡射過）算一次同樣的排版，
// 兩層畫面才會疊在同一個位置。
function applyYtLayoutFromContainerMap() {
  const activeIds = SLOTS.map((c) => ytContainerDeckId[c]).filter((id) => id != null);
  const split = activeIds.length >= 2;
  const solo = !split && activeIds.length === 1 ? SLOTS.find((c) => ytContainerDeckId[c] != null) : null;
  ytPlayerWrapEl.classList.toggle('split', split);
  for (const c of SLOTS) {
    document.getElementById(`yt-player-slot-${c}`).classList.toggle('yt-solo', c === solo);
  }
  // 等 CSS 的 width transition 排版更新完再重新量尺寸，不然會抓到過渡中的尺寸
  requestAnimationFrame(() => requestAnimationFrame(sizeAllYtPlayers));
}

/* ---------- VJ 風格：本機 MV（比對曲名的本機影片，跟著每個 deck 走） ----------
 * 跟 YouTube MV 是同一種「per-deck、雙軌分割畫面」架構，差別只在影片來源：
 * 不查 YouTube，而是直接檢查 public/videos/ 底下有沒有一支「檔名（不含副檔名）
 * 跟曲名一模一樣」的 .mp4——有就用本機 <video> 播放。
 *
 * 用本機 <video> 換掉 YouTube iframe 換來兩個實質好處：
 *   1. playbackRate 是連續數值，不像 YouTube 只有幾個離散檔位，BPM 對速可以
 *      做到真正精準，不會四捨五入回 1×。
 *   2. currentTime 是同步、精準的屬性存取，不像 YouTube 的 seekTo() 常有緩衝
 *      延遲，loop 跟拍/跳位置偵測都可以做到逐格對齊。
 *
 * 找不到對應檔案時不會直接退回生成式背景，而是改用「舊方法」——直接借用
 * YouTube MV 那整套現成的 ytPlayers/ytContainerDeckId 機制去搜尋播放，
 * 兩者共用同一份 container map（見 mvSourceIsYt 那段），畫面上 .local-mv-wrap
 * 疊在 .yt-player-wrap 上面、背景透明，本機影片播不出來的那個 container 用
 * mv-source-yt 這個 class 把 <video> 藏起來，讓底下的 YouTube 畫面透出來；
 * 真的有本機影片在播的 container 則是自己的 <video> 畫面直接蓋過去。
 */
const localMvContainerDeckId = { a: null, b: null };
const localMvCurrentFilePath = { a: null, b: null };
const localMvHasVideo = { a: false, b: false };
const localMvFallbackTimer = { a: null, b: null };
const lastLocalMvRate = { a: null, b: null }; // 上次幫這個 container 設過的 playbackRate,避免每個 playhead 事件都重設
const mvSourceIsYt = { a: false, b: false }; // 這個 container 目前是不是退回用 YouTube 搜尋播放(本機檔案沒找到)

// 跟 setYtHasVideo 同一套「緩衝一小段時間才判定沒畫面」邏輯，理由一樣：
// seek/loop 跟拍造成的短暫 buffering 不該立刻讓畫面閃回 p5 生成式背景。
function setLocalMvHasVideo(slot, playing) {
  clearTimeout(localMvFallbackTimer[slot]);
  localMvFallbackTimer[slot] = null;
  if (playing) {
    localMvHasVideo[slot] = true;
    refreshVideoLayerVisibility();
    return;
  }
  localMvFallbackTimer[slot] = setTimeout(() => {
    localMvFallbackTimer[slot] = null;
    localMvHasVideo[slot] = false;
    refreshVideoLayerVisibility();
  }, VIDEO_BUFFER_GRACE_MS);
}

// 本機檔案播不出來（找不到/格式不支援）：切去用舊方法（YouTube 搜尋），跟
// containerForLocalMvDeckId 共用同一個 deckId——ytContainerDeckId 已經在
// syncLocalMvContainers() 裡鏡射過同一份指派，直接呼叫 loadYtVideoForContainer
// 就會用同一個 container 字母去搜尋、載入。
function fallBackToYtForContainer(slot) {
  if (mvSourceIsYt[slot]) return; // 已經在用了，不用重複觸發
  const deckId = localMvContainerDeckId[slot];
  if (deckId == null) return;
  mvSourceIsYt[slot] = true;
  document.getElementById(`local-mv-slot-${slot}`).classList.add('mv-source-yt');
  loadYtVideoForContainer(slot, deckId);
}

// playing/waiting 是整支影片生命週期都要聽的狀態變化，掛一次就好；error
// 則是每次載入各自處理（見 loadLocalMvForContainer），因為需要判斷「這次
// 失敗是不是還對應目前這首歌」，掛在這裡拿不到那個上下文。
for (const slot of SLOTS) {
  const videoEl = localMvVideoEls[slot];
  videoEl.addEventListener('playing', () => setLocalMvHasVideo(slot, true));
  videoEl.addEventListener('waiting', () => setLocalMvHasVideo(slot, false));
}

function containerForLocalMvDeckId(deckId) {
  return SLOTS.find((c) => localMvContainerDeckId[c] === deckId) ?? null;
}

// 曲名直接當檔名用（不含副檔名），用 encodeURIComponent 逃脫成單一路徑片段，
// 避免曲名裡剛好帶 "/" 之類的字元被瀏覽器解讀成路徑分隔符。找不到對應檔案
// 就是 <video> 的 error 事件接手退回舊方法，跟封面抓不到的處理方式一致，
// 不用另外呼叫伺服器問「這個檔案存不存在」。
function loadLocalMvForContainer(container, deckId) {
  const np = npByDeckId(deckId);
  if (!np?.track?.title) return;
  if (np.track.filePath === localMvCurrentFilePath[container]) return; // 同一首歌，不用重新載入
  const filePath = np.track.filePath;
  localMvCurrentFilePath[container] = filePath;

  // 每次換歌都重新樂觀地假設本機有對應檔案——上一首歌是不是在用 YT fallback
  // 跟這首歌無關，真的找不到再由 <video> 的 error 事件觸發一次新的 fallback。
  mvSourceIsYt[container] = false;
  document.getElementById(`local-mv-slot-${container}`).classList.remove('mv-source-yt');
  if (ytPlayers[container]?.stopVideo) ytPlayers[container].stopVideo();
  ytCurrentFilePath[container] = null;
  ytCurrentVideoId[container] = null;
  ytHasVideo[container] = false;

  const videoEl = localMvVideoEls[container];
  localMvHasVideo[container] = false;
  lastLocalMvRate[container] = null;
  videoEl.src = `/videos/${encodeURIComponent(np.track.title)}.mp4`;

  const elapsed = (performance.now() - np.positionAt) / 1000;
  const estimatedPos = Math.max(0, np.positionSeconds + elapsed * (np.playRate || 0));
  const onLoadedMetadata = () => {
    videoEl.currentTime = estimatedPos;
    videoEl.play().catch(() => {});
  };
  const onError = () => {
    // 這段期間容器可能已經被指派給別的 deck / 換了新曲目（快速切歌），
    // 這次的失敗就過期了，不要誤觸發新曲目的 fallback。
    if (localMvCurrentFilePath[container] !== filePath) return;
    clearTimeout(localMvFallbackTimer[container]);
    localMvFallbackTimer[container] = null;
    localMvHasVideo[container] = false;
    fallBackToYtForContainer(container);
    refreshVideoLayerVisibility();
  };
  videoEl.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
  videoEl.addEventListener('error', onError, { once: true });
  videoEl.load();
}

// 本機 <video> 的 playbackRate 是連續數值，不用像 YouTube 那樣找最接近的
// 合法檔位——直接設定 Serato 回報的 playRate 就是精準的 BPM 對速。用 YT
// fallback 的 container 交給 applyYtPlaybackRate 處理，這裡跳過。
function applyLocalMvPlaybackRate(deckId, playRate) {
  if (vjStyle !== 'localmv' || !playRate) return;
  const container = containerForLocalMvDeckId(deckId);
  if (!container || mvSourceIsYt[container]) return;
  const rate = Math.max(0.1, playRate); // 保底：<video>.playbackRate 不接受 0 或負值
  if (rate === lastLocalMvRate[container]) return;
  lastLocalMvRate[container] = rate;
  localMvVideoEls[container].playbackRate = rate;
}

// track 秒數直接當 video 秒數用（跟 loadLocalMvForContainer 的對位假設一致）
function seekLocalMvToTrackPosition(deckId, trackSeconds) {
  const container = containerForLocalMvDeckId(deckId);
  if (!container || mvSourceIsYt[container]) return;
  localMvVideoEls[container].currentTime = Math.max(0, trackSeconds);
}

// 手動「更新對位」用，跟 resyncAllYtPlayers 平行
function resyncAllLocalMvPlayers() {
  for (const c of SLOTS) {
    if (mvSourceIsYt[c]) continue; // 這個 container 交給 resyncAllYtPlayers 處理
    const deckId = localMvContainerDeckId[c];
    if (deckId == null) continue;
    const np = npByDeckId(deckId);
    if (!np) continue;
    seekLocalMvToTrackPosition(deckId, estimatedTrackPosition(np));
  }
}

// 本機 MV 版本的 loop 跟拍要跳過正在用 YT fallback 的 container——那個
// container 的畫面來源是 ytPlayers，loop 跟拍交給 tickYtLoops 處理，這裡對
// 一支被隱藏的 <video> 硬 seek 沒有意義。
function shouldTickLocalMvLoop(c) {
  return !mvSourceIsYt[c];
}

function syncLocalMvContainers() {
  if (vjStyle !== 'localmv') return;
  const activeDeckIds = activeVjDeckIds();

  // 釋放已經離場的 deck 占用的容器（本機影片 + 對應的 YT fallback 一起清掉）
  for (const c of SLOTS) {
    const deckId = localMvContainerDeckId[c];
    if (deckId != null && !activeDeckIds.includes(deckId)) {
      localMvContainerDeckId[c] = null;
      localMvCurrentFilePath[c] = null;
      localMvHasVideo[c] = false;
      lastLocalMvRate[c] = null;
      localMvVideoEls[c].pause();
      localMvVideoEls[c].removeAttribute('src');
      localMvVideoEls[c].load();

      mvSourceIsYt[c] = false;
      document.getElementById(`local-mv-slot-${c}`).classList.remove('mv-source-yt');
      ytContainerDeckId[c] = null;
      ytCurrentFilePath[c] = null;
      ytCurrentVideoId[c] = null;
      ytHasVideo[c] = false;
      lastYtRate[c] = null;
      if (ytPlayers[c]?.stopVideo) ytPlayers[c].stopVideo();
    }
  }

  // 幫新上線、還沒有容器的 deck 分配一個空容器
  for (const deckId of activeDeckIds) {
    if (containerForLocalMvDeckId(deckId) != null) continue;
    const free = SLOTS.find((c) => localMvContainerDeckId[c] == null);
    if (free) localMvContainerDeckId[free] = deckId;
  }

  // YT fallback 共用同一份 container map，兩層排版才會對到同一個位置——
  // 是不是真的要播 YouTube 由 mvSourceIsYt 決定，這裡只負責讓兩個 map 對齊。
  for (const c of SLOTS) ytContainerDeckId[c] = localMvContainerDeckId[c];

  // 排版：只剩一軌時，那一軌原本在哪個容器就讓哪個容器全螢幕——不強迫搬家
  const split = activeDeckIds.length >= 2;
  const solo = !split && activeDeckIds.length === 1 ? containerForLocalMvDeckId(activeDeckIds[0]) : null;
  localMvWrapEl.classList.toggle('split', split);
  for (const c of SLOTS) {
    document.getElementById(`local-mv-slot-${c}`).classList.toggle('mv-solo', c === solo);
  }
  applyYtLayoutFromContainerMap(); // .yt-player-wrap 的排版跟著同一份 container map 走，兩層才會疊在一起

  for (const c of SLOTS) {
    const deckId = localMvContainerDeckId[c];
    if (deckId != null) loadLocalMvForContainer(c, deckId);
  }
  refreshVideoLayerVisibility();
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
  refreshVideoLayerVisibility();
});
localMp4VideoEl.addEventListener('error', () => {
  localMp4HasVideo = false;
  refreshVideoLayerVisibility();
});

function loadLocalMp4(file) {
  if (!file) {
    localMp4LoadedFile = null;
    localMp4HasVideo = false;
    localMp4VideoEl.pause();
    localMp4VideoEl.removeAttribute('src');
    localMp4VideoEl.load();
    refreshVideoLayerVisibility();
    return;
  }
  if (file === localMp4LoadedFile) {
    // 同一支影片只是被切走又切回來——元素沒被卸載（src 還在），readyState
    // 還留著上次的緩衝，不會再觸發一次 loadeddata，所以要在這裡自己補上
    // hasVideo + 重新算可見度，不然畫面會停在切走那一刻的 p5 背景。
    localMp4HasVideo = true;
    localMp4VideoEl.play().catch(() => {});
    refreshVideoLayerVisibility();
    return;
  }
  localMp4LoadedFile = file;
  localMp4HasVideo = false;
  refreshVideoLayerVisibility();
  localMp4VideoEl.src = `/videos/${encodeURIComponent(file)}`;
  localMp4VideoEl.load();
  localMp4VideoEl.play().catch(() => {});
}

function applyVjStyleVisibility() {
  if (vjStyle === 'ytmv') {
    syncYtContainers();
    for (const c of SLOTS) if (ytPlayers[c]?.playVideo) ytPlayers[c].playVideo();
  } else if (vjStyle !== 'localmv') {
    // 'localmv' 風格底下,ytPlayers 可能正被某個 container 借去當 YT fallback
    // 用(見 mvSourceIsYt),不能無條件暫停清掉——交給 syncLocalMvContainers()
    // 自己決定每個 container 要不要用。
    for (const c of SLOTS) {
      if (ytPlayers[c]?.pauseVideo) ytPlayers[c].pauseVideo();
      ytHasVideo[c] = false;
      mvSourceIsYt[c] = false;
      document.getElementById(`local-mv-slot-${c}`).classList.remove('mv-source-yt');
    }
  }

  if (vjStyle === 'localmp4') {
    loadLocalMp4(localVideoFile);
  } else {
    localMp4VideoEl.pause();
    localMp4HasVideo = false;
  }

  if (vjStyle === 'localmv') {
    syncLocalMvContainers();
    for (const c of SLOTS) localMvVideoEls[c].play().catch(() => {});
  } else {
    for (const c of SLOTS) {
      localMvVideoEls[c].pause();
      localMvHasVideo[c] = false;
    }
  }

  refreshVideoLayerVisibility();
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
setInterval(tickYtLoops, 150);
setInterval(tickLocalMvLoops, 150);

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
  inArt.onerror = () => {
    inArt.onerror = null;
    inArt.src = ART_PLACEHOLDER_SRC;
  };
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
        const prev = nowPlaying[slot];
        const expected = estimatedTrackPosition(prev);
        if (Math.abs(msg.positionSeconds - expected) > SEEK_JUMP_THRESHOLD_SECONDS) {
          clearVideoLoopIfOutside(msg.deckId, msg.positionSeconds);
          seekYtToTrackPosition(msg.deckId, msg.positionSeconds);
          seekLocalMvToTrackPosition(msg.deckId, msg.positionSeconds);
        }
        prev.positionSeconds = msg.positionSeconds;
        prev.playRate = msg.playRate;
        prev.bpm = msg.bpm;
        prev.positionAt = performance.now();
        syncVjState();
      }
      applyYtPlaybackRate(msg.deckId, msg.playRate);
      applyLocalMvPlaybackRate(msg.deckId, msg.playRate);
    } else if (msg.type === 'loop') {
      setVideoLoopState(msg.deckId, msg.active, msg.startSeconds, msg.durationSeconds, { snap: true });
    } else if (msg.type === 'ytResync') {
      resyncAllYtPlayers();
      resyncAllLocalMvPlayers();
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
