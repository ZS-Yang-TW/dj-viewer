/**
 * DJ Overlay 後端 —— Route A（控制台）+ Route B（觀眾畫面）共用同一個伺服器。
 *
 * 用 serato-connect 的 SeratoRemoteClient 即時拿 4 個 deck 的曲目/播放進度/
 * mixer 狀態，music-metadata 讀封面/曲長。前端透過 WebSocket 收即時更新，
 * 波形跟封面主色都在瀏覽器端算（不引入 ffmpeg 之類的原生相依）。
 *
 * on-air 判斷只看 upfader + playRate，不解讀 crossfader —— Serato Remote
 * 協定的 crossfader/upfader 數值範圍官方文件標「unverified」，猜錯方向會比
 * 不判斷還糟，之後有機會實際觀察 mixerChange 原始值再校準。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const mm = require('music-metadata');
const yts = require('yt-search');
const { SeratoRemoteClient } = require('serato-connect');

// serato-connect 底層的 mDNS 廣播函式庫（bonjour-service）在網路狀態變動時
// （Wi-Fi 短暫斷線、電腦睡眠喚醒）送封包失敗會直接 throw，預設會讓整個
// process 掛掉。這類錯誤跟我們自己的狀態無關、也不會弄壞任何東西，記錄
// 一下就好，不要讓暫時性的網路問題把整晚的 DJ 場次直接搞當機。
process.on('uncaughtException', (err) => {
  // 只吞 bonjour-service 送 mDNS 封包時真的會丟出的那個錯誤代碼。其他錯誤
  // （例如 port 已經被佔用的 EADDRINUSE）要讓 process 直接崩潰、清楚報錯——
  // 之前這裡寫成吞掉「所有」未預期錯誤，導致重複啟動、bind port 失敗的殭屍
  // 程序不會死掉，卻繼續在背景廣播一個衝突的 Serato Bonjour 服務，是先前
  // 連線一直不穩定、真正的病灶。
  if (err.code === 'EADDRNOTAVAIL') {
    console.error('⚠️ mDNS 廣播暫時失敗（已忽略，伺服器繼續運行）：', err.message);
    return;
  }
  console.error('❌ 未預期的嚴重錯誤，伺服器即將結束：', err);
  process.exit(1);
});

const PORT = process.env.PORT || 4545;
const NUM_DECKS = 4;
const PLAYHEAD_THROTTLE_MS = 80;
// 遲滯區間（hysteresis）：轉 fader 經過單一門檻值附近時數值會抖動，若開/關
// 用同一個門檻，on-air 狀態會在門檻上下瞬間真假來回跳，導致 Route B 收到一串
// onair 廣播、瘋狂重抓 state / 重載影片，畫面看起來像當掉。開跟關分開兩個值，
// 中間留一段緩衝區，同一次轉動只會觸發一次真正的狀態改變。
const UPFADER_ON_THRESHOLD = 0.05;
const UPFADER_OFF_THRESHOLD = 0.02;
const NOW_PLAYING_SOLO_MS = 3000;
const INCOMING_HOLD_MS = 8000;
const HISTORY_MAX = 200;
const HISTORY_LOG_PATH = path.join(__dirname, 'history.log');
const VIDEOS_DIR = path.join(__dirname, 'public', 'videos');
const VJ_STYLES = ['circles', 'waveform', 'plexus', 'laser', 'breath', 'chaos', 'beatbars', 'constellation', 'coderain', 'ytmv', 'localmp4'];

fs.mkdirSync(VIDEOS_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const decks = new Map();
const metadataCache = new Map();
const ytVideoCache = new Map();
const history = [];
let overlayVisible = true;
let vjStyle = 'circles';
let localVideoFile = null;
let lastDropAt = 0;
let webcamEnabled = false;
let seratoConnected = false;
let currentOnAirDeckIds = [];
let autoHideTimer = null;
let autoIncomingTimer = null;

function getDeck(deckId) {
  if (!decks.has(deckId)) {
    decks.set(deckId, {
      deckId,
      track: null,
      duration: null,
      hasArt: false,
      positionSeconds: 0,
      playRate: 0,
      bpm: null,
      upfader: undefined,
      override: null,
      onAir: false,
      onAirSince: null,
      lastLoggedFilePath: null,
    });
  }
  return decks.get(deckId);
}

function effectiveTrack(deck) {
  if (!deck.track) return null;
  const o = deck.override;
  return {
    title: o?.title || deck.track.title,
    artist: o?.artist || deck.track.artist,
    filePath: deck.track.filePath,
  };
}

function serializeDeck(deck) {
  const { deckId, duration, hasArt, positionSeconds, playRate, bpm, onAir, override } = deck;
  return {
    deckId,
    track: effectiveTrack(deck),
    duration,
    hasArt: hasArt || !!override?.artUrl,
    positionSeconds,
    playRate,
    bpm,
    onAir,
    override,
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

// iTunes Search API 除了封面，同一筆結果也附 trackTimeMillis（曲長）——
// Serato Remote 協定本身完全不傳曲長欄位，串流曲目（Spotify/TIDAL/...）的
// filePath 又不是本機路徑讀不到 ID3，這是唯一能補回曲長的來源，抓不到就是
// 抓不到（前端進度條會維持在 0%，這是已知限制，不是 bug）。
async function fetchOnlineTrackInfo(track) {
  if (!track?.title) return { artUrl: null, durationSeconds: null };
  const term = `${track.artist ?? ''} ${track.title}`.trim();
  if (!term) return { artUrl: null, durationSeconds: null };
  try {
    const res = await fetch(`https://itunes.apple.com/search?entity=song&limit=1&term=${encodeURIComponent(term)}`);
    const data = await res.json();
    const first = data.results?.[0];
    const artworkUrl = first?.artworkUrl100;
    return {
      artUrl: artworkUrl ? artworkUrl.replace('100x100bb', '600x600bb') : null,
      durationSeconds: typeof first?.trackTimeMillis === 'number' ? first.trackTimeMillis / 1000 : null,
    };
  } catch (err) {
    console.error(`❌ iTunes 查詢失敗（${term}）：${err.message}`);
    return { artUrl: null, durationSeconds: null };
  }
}

// Serato 4 的串流曲目（Spotify/TIDAL/...）filePath 長這樣：
// streaming://spotify/3h4T9Bg8OVSUYa6danHeH5 —— 不是本機檔案，直接跳過
// mm.parseFile（一定會 ENOENT），改走 iTunes 線上查詢。
function isLocalFilePath(filePath) {
  return !filePath.includes('://');
}

async function getMetadata(filePath, track) {
  if (metadataCache.has(filePath)) return metadataCache.get(filePath);
  const result = { duration: null, picture: null, onlineArtUrl: null };
  if (isLocalFilePath(filePath)) {
    try {
      const meta = await mm.parseFile(filePath, { duration: true });
      result.duration = meta.format.duration ?? null;
      result.picture = mm.selectCover(meta.common.picture) ?? null;
    } catch (err) {
      console.error(`❌ 讀取音檔 metadata 失敗（${filePath}）：${err.message}`);
    }
  }
  if (!result.picture || result.duration == null) {
    const info = await fetchOnlineTrackInfo(track);
    if (!result.picture) result.onlineArtUrl = info.artUrl;
    if (result.duration == null) result.duration = info.durationSeconds;
  }
  metadataCache.set(filePath, result);
  return result;
}

// 非官方套件、不用申請 API 金鑰，直接拿第一個搜尋結果就好——本來就只是拿來當
// 靜音背景素材用，不用求精準比對到正確版本的 MV。
async function findYoutubeVideoId(filePath, track) {
  if (ytVideoCache.has(filePath)) return ytVideoCache.get(filePath);
  const q = `${track?.artist ?? ''} ${track?.title ?? ''}`.trim();
  let videoId = null;
  if (q) {
    try {
      const r = await yts(q);
      videoId = r.videos?.[0]?.videoId ?? null;
    } catch (err) {
      console.error(`❌ YouTube 搜尋失敗（${q}）：${err.message}`);
    }
  }
  ytVideoCache.set(filePath, videoId);
  return videoId;
}

function guessAudioMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.aiff': 'audio/aiff',
      '.aif': 'audio/aiff',
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg',
    }[ext] || 'application/octet-stream'
  );
}

function loadHistory() {
  try {
    const lines = fs.readFileSync(HISTORY_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        history.push(JSON.parse(line));
      } catch {
        // 忽略壞掉的單行，不要讓整個檔案讀取失敗
      }
    }
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    history.reverse(); // 檔案是舊到新 append，記憶體陣列要新的在前面
  } catch {
    // 檔案不存在很正常（第一次跑），不用報錯
  }
}

function addHistoryEntry(effTrack, filePath) {
  const entry = { time: Date.now(), title: effTrack.title, artist: effTrack.artist, filePath };
  history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  fs.appendFile(HISTORY_LOG_PATH, JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error('❌ 寫入 history.log 失敗：', err.message);
  });
  broadcast({ type: 'history', entry });
}

// 兩個 deck 同時符合條件時（正在混音/mashup），兩個都算 on-air ——
// 不像先前只挑一個「最新的」，因為 Route B 現在會同時顯示兩張 Now Playing 卡。
function recomputeOnAir() {
  const now = Date.now();
  const onAirDeckIds = [];

  for (const deck of decks.values()) {
    const wasOnAir = deck.onAir;
    const threshold = wasOnAir ? UPFADER_OFF_THRESHOLD : UPFADER_ON_THRESHOLD;
    const isCandidate = deck.playRate > 0 && (deck.upfader === undefined || deck.upfader > threshold);
    deck.onAir = isCandidate && !!deck.track;

    if (deck.onAir) {
      if (deck.onAirSince == null) deck.onAirSince = now;
      onAirDeckIds.push(deck.deckId);

      // 這個 deck 剛從「非 on-air」變成「on-air」，且曲目跟上次幫它記錄的不一樣 → 記一筆
      if (!wasOnAir) {
        const effTrack = effectiveTrack(deck);
        if (effTrack && deck.track.filePath !== deck.lastLoggedFilePath) {
          addHistoryEntry(effTrack, deck.track.filePath);
          deck.lastLoggedFilePath = deck.track.filePath;
        }
      }
    } else {
      deck.onAirSince = null;
    }
  }

  onAirDeckIds.sort((a, b) => a - b);
  const changed = onAirDeckIds.join(',') !== currentOnAirDeckIds.join(',');
  if (changed) {
    currentOnAirDeckIds = onAirDeckIds;
    broadcast({ type: 'onair', deckIds: currentOnAirDeckIds });
  }
  return changed;
}

app.get('/api/state', (req, res) => {
  const all = [];
  for (let i = 1; i <= NUM_DECKS; i++) all.push(serializeDeck(getDeck(i)));
  res.json({
    decks: all,
    overlayVisible,
    seratoConnected,
    onAirDeckIds: currentOnAirDeckIds,
    vjStyle,
    dropAt: lastDropAt,
    webcamEnabled,
    localVideoFile,
  });
});

// 場景「在地 MP4」用的影片清單/選片 —— 檔案本身直接放 public/videos/ 底下，
// express.static 已經會把整個 public/ 目錄公開，所以不用另外寫一支下載用的
// route，這裡只需要「列出有哪些檔案」跟「切換選中哪一個」。
app.get('/api/videos', (req, res) => {
  fs.readdir(VIDEOS_DIR, (err, files) => {
    if (err) return res.json({ files: [] });
    res.json({ files: files.filter((f) => f.toLowerCase().endsWith('.mp4')).sort() });
  });
});

app.post('/api/local-video', (req, res) => {
  // path.basename 擋掉路徑穿越（例如 "../../etc/passwd"），只留檔名本身，
  // 再檢查那個檔名是否真的存在於 videos 目錄裡。
  const requested = req.body.file ? path.basename(req.body.file) : null;
  if (requested && !fs.existsSync(path.join(VIDEOS_DIR, requested))) {
    return res.status(400).json({ error: 'file not found' });
  }
  localVideoFile = requested;
  broadcast({ type: 'localVideo', file: localVideoFile });
  res.json({ localVideoFile });
});

app.get('/api/history', (req, res) => {
  res.json({ history });
});

app.get('/api/art/:deckId', async (req, res) => {
  const deck = getDeck(Number(req.params.deckId));
  if (!deck.track?.filePath) return res.status(404).end();

  const overrideUrl = deck.override?.artUrl;
  if (overrideUrl) {
    try {
      const artRes = await fetch(overrideUrl);
      if (artRes.ok) {
        res.set('Content-Type', artRes.headers.get('content-type') || 'image/jpeg');
        return res.send(Buffer.from(await artRes.arrayBuffer()));
      }
    } catch (err) {
      console.error(`❌ 下載自訂封面失敗：${err.message}`);
    }
  }

  const meta = await getMetadata(deck.track.filePath, deck.track);
  if (meta.picture) {
    res.set('Content-Type', meta.picture.format);
    return res.send(Buffer.from(meta.picture.data));
  }

  if (meta.onlineArtUrl) {
    try {
      const artRes = await fetch(meta.onlineArtUrl);
      if (artRes.ok) {
        res.set('Content-Type', artRes.headers.get('content-type') || 'image/jpeg');
        return res.send(Buffer.from(await artRes.arrayBuffer()));
      }
    } catch (err) {
      console.error(`❌ 下載封面失敗：${err.message}`);
    }
  }

  res.status(404).end();
});

app.get('/api/audio/:deckId', (req, res) => {
  const deck = getDeck(Number(req.params.deckId));
  if (!deck.track?.filePath) return res.status(404).end();
  const filePath = deck.track.filePath;
  fs.stat(filePath, (err, stat) => {
    if (err) return res.status(404).end();
    res.set('Content-Length', stat.size);
    res.set('Content-Type', guessAudioMime(filePath));
    fs.createReadStream(filePath).pipe(res);
  });
});

app.get('/api/yt/:deckId', async (req, res) => {
  const deck = getDeck(Number(req.params.deckId));
  if (!deck.track?.filePath) return res.status(404).end();
  const videoId = await findYoutubeVideoId(deck.track.filePath, deck.track);
  if (!videoId) return res.status(404).end();
  res.json({ videoId });
});

function setOverlayVisible(visible) {
  clearTimeout(autoHideTimer);
  clearTimeout(autoIncomingTimer);
  autoHideTimer = null;
  autoIncomingTimer = null;
  overlayVisible = visible;
  broadcast({ type: 'overlay', visible: overlayVisible });
}

app.post('/api/overlay', (req, res) => {
  setOverlayVisible(!!req.body.visible);
  res.json({ overlayVisible });
});

app.post('/api/vj-style', (req, res) => {
  const { style } = req.body;
  if (!VJ_STYLES.includes(style)) return res.status(400).json({ error: 'unknown style' });
  vjStyle = style;
  broadcast({ type: 'vjStyle', style: vjStyle });
  res.json({ vjStyle });
});

app.post('/api/drop', (req, res) => {
  lastDropAt = Date.now();
  broadcast({ type: 'drop', at: lastDropAt });
  res.json({ dropAt: lastDropAt });
});

app.post('/api/webcam', (req, res) => {
  webcamEnabled = !!req.body.enabled;
  broadcast({ type: 'webcam', enabled: webcamEnabled });
  res.json({ webcamEnabled });
});

// 手動微調 YouTube MV 的播放位置（一次性事件，不存狀態）——自動對位只在
// 換歌/切風格那一刻對一次，之後會慢慢跟實際音樂飄掉，這個給 DJ 手動校正。
app.post('/api/yt-nudge', (req, res) => {
  const seconds = Number(req.body.seconds) || 0;
  broadcast({ type: 'ytNudge', seconds });
  res.json({ ok: true });
});

app.post('/api/deck/:deckId/override', (req, res) => {
  const deck = getDeck(Number(req.params.deckId));
  const { title, artist, artUrl } = req.body;
  const hasAny = title || artist || artUrl;
  deck.override = hasAny ? { title: title || null, artist: artist || null, artUrl: artUrl || null } : null;
  broadcast({ type: 'deck', deck: serializeDeck(deck) });
  res.json({ ok: true });
});

app.post('/api/deck/:deckId/incoming', (req, res) => {
  const deck = getDeck(Number(req.params.deckId));
  if (!deck.track) return res.status(404).json({ error: 'deck 沒有載入曲目' });
  const snapshot = serializeDeck(deck);

  if (overlayVisible) {
    // Overlay 本來就開著：Now Playing 已經在畫面上了，Incoming 直接跳出來就好
    broadcast({ type: 'incoming', deck: snapshot });
  } else {
    // Overlay 是關的：先讓 Now Playing 單獨露臉 5 秒，Incoming 接著出現再撐 5 秒，
    // 最後兩個一起收掉。中途只要有人手動按過顯示/隱藏（setOverlayVisible）就會
    // 把這兩個 timer 清掉，改用手動操作的結果為準。
    overlayVisible = true;
    broadcast({ type: 'overlay', visible: true });

    clearTimeout(autoIncomingTimer);
    autoIncomingTimer = setTimeout(() => {
      autoIncomingTimer = null;
      broadcast({ type: 'incoming', deck: snapshot });

      clearTimeout(autoHideTimer);
      autoHideTimer = setTimeout(() => {
        autoHideTimer = null;
        overlayVisible = false;
        broadcast({ type: 'overlay', visible: false });
      }, INCOMING_HOLD_MS);
    }, NOW_PLAYING_SOLO_MS);
  }

  res.json({ ok: true });
});

async function main() {
  loadHistory();

  const remote = new SeratoRemoteClient({ peerName: 'dj-viewer' });
  const lastPlayheadSent = new Map();

  const connectedAt = new Map();
  const fmt = (port) => {
    const t0 = connectedAt.get(port);
    return t0 ? `+${Date.now() - t0}ms` : '';
  };

  remote.on('peerConnected', (peer) => {
    connectedAt.set(peer.remotePort, Date.now());
    console.log(`[serato][t=0] TCP 已連上（尚未完成配對）：`, peer);
    seratoConnected = true;
    broadcast({ type: 'status', seratoConnected });
  });
  remote.on('paired', (peer) => {
    console.log(`[serato][${fmt(peer.remotePort)}] 配對完成，開始接收狀態：`, peer);
  });
  remote.on('ping', () => {
    console.log(`[serato] ping`);
  });
  remote.on('peerDisconnected', (peer) => {
    console.log(`[serato][${fmt(peer.remotePort)}] 已斷線：`, peer);
    seratoConnected = false;
    broadcast({ type: 'status', seratoConnected });
  });

  remote.on('deckChange', async ({ deckId, track }) => {
    console.log(`[serato] deckChange deck=${deckId}`, track);
    const deck = getDeck(deckId);
    const newFilePath = track?.valid ? track.filePath : null;
    const trackChanged = newFilePath !== deck.track?.filePath;

    deck.track = track?.valid ? { title: track.title, artist: track.artist, filePath: track.filePath } : null;
    deck.duration = null;
    deck.hasArt = false;
    if (trackChanged) deck.override = null;

    if (deck.track?.filePath) {
      const meta = await getMetadata(deck.track.filePath, deck.track);
      deck.duration = meta.duration;
      deck.hasArt = !!(meta.picture || meta.onlineArtUrl);
    }

    broadcast({ type: 'deck', deck: serializeDeck(deck) });
    recomputeOnAir();
  });

  let lastPlayheadLog = 0;
  remote.on('playhead', ({ deckId, playhead }) => {
    if (Date.now() - lastPlayheadLog > 2000) {
      lastPlayheadLog = Date.now();
      console.log(`[serato] playhead deck=${deckId}`, playhead);
    }
    const deck = getDeck(deckId);
    deck.positionSeconds = playhead.positionSeconds ?? deck.positionSeconds;
    deck.playRate = playhead.playRate ?? deck.playRate;
    deck.bpm = playhead.bpm ?? deck.bpm;

    recomputeOnAir();

    const now = Date.now();
    if (now - (lastPlayheadSent.get(deckId) || 0) < PLAYHEAD_THROTTLE_MS) return;
    lastPlayheadSent.set(deckId, now);

    broadcast({
      type: 'playhead',
      deckId,
      positionSeconds: deck.positionSeconds,
      playRate: deck.playRate,
      bpm: deck.bpm,
      onAir: deck.onAir,
    });
  });

  remote.on('mixerChange', ({ mixer }) => {
    console.log(`[serato] mixerChange`, mixer);
    for (let i = 0; i < NUM_DECKS; i++) {
      // 實測 upfaders[0] 沒對應到任何 deck，deck 1..4 實際對應 index 1..4
      // （跟 serato-connect 文件寫的「index 0 = deck 1」不一樣，這裡以實測為準）。
      getDeck(i + 1).upfader = mixer.upfaders[i + 1];
    }
    recomputeOnAir();
  });

  remote.on('loopChange', ({ deckId, loop }) => console.log(`[serato] loopChange deck=${deckId}`, loop));

  remote.on('error', (err) => console.error('❌ Serato Remote 錯誤：', err));

  const { port, instanceName } = await remote.start();
  console.log(`[serato] 已廣播服務 "${instanceName}"（port ${port}），等待 Serato DJ 連線...`);
}

server.listen(PORT, () => {
  console.log(`[web] Route A（控制台）  http://localhost:${PORT}/`);
  console.log(`[web] Route B（觀眾畫面） http://localhost:${PORT}/overlay`);
});

main().catch((err) => {
  console.error('未預期的錯誤：', err);
  process.exit(1);
});
