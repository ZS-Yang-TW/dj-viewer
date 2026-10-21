const NUM_DECKS = 4;
const RHYTHM_STALE_MS = 3000;
const HIDE_34_KEY = 'djviewer.hideDecks34';
const HIDE_OVERLAY_PREVIEW_KEY = 'djviewer.hideOverlayPreview';

const decksEl = document.getElementById('decks');
const hideToggle = document.getElementById('hide-3-4');
const toggleOverlayBtn = document.getElementById('toggle-overlay-btn');
const historyListEl = document.getElementById('history-list');
const statusSeratoEl = document.getElementById('status-serato');
const statusRhythmEl = document.getElementById('status-rhythm');
const statusOverlayEl = document.getElementById('status-overlay');
const overlayStateTextEl = document.getElementById('overlay-state-text');
const vjStyleGridEl = document.getElementById('vj-style-grid');
const toggleWebcamBtn = document.getElementById('toggle-webcam-btn');
const dropBtn = document.getElementById('drop-btn');
const overlayPreviewEl = document.getElementById('overlay-preview');
const overlayPreviewFrameEl = document.getElementById('overlay-preview-frame');
const overlayPreviewToggleBtn = document.getElementById('overlay-preview-toggle');

const state = {};
let overlayVisible = true;
let webcamEnabled = false;
let lastPlayheadAt = 0;

function applyHide34(hidden) {
  document.getElementById('deck-3')?.classList.toggle('hidden', hidden);
  document.getElementById('deck-4')?.classList.toggle('hidden', hidden);
}

hideToggle.checked = localStorage.getItem(HIDE_34_KEY) === '1';
hideToggle.addEventListener('change', () => {
  localStorage.setItem(HIDE_34_KEY, hideToggle.checked ? '1' : '0');
  applyHide34(hideToggle.checked);
});

// iframe 內部固定用 1920x1080（overlay.css 很多尺寸是 clamp() 夾了 px 下限，
// 縮小 viewport 會讓版面被下限撐爆），外層只用 transform: scale() 整張縮小，
// 縮放比例照容器實際渲染寬度換算，容器變寬（例如視窗縮放）要重算一次。
function fitOverlayPreview() {
  if (overlayPreviewEl.classList.contains('hidden')) return;
  const scale = overlayPreviewEl.clientWidth / 1920;
  overlayPreviewFrameEl.style.transform = `scale(${scale})`;
  overlayPreviewEl.style.height = `${1080 * scale}px`;
}
window.addEventListener('resize', fitOverlayPreview);
overlayPreviewFrameEl.addEventListener('load', fitOverlayPreview);

overlayPreviewEl.classList.toggle('hidden', localStorage.getItem(HIDE_OVERLAY_PREVIEW_KEY) === '1');
overlayPreviewToggleBtn.textContent = overlayPreviewEl.classList.contains('hidden') ? '顯示預覽' : '隱藏預覽';
fitOverlayPreview();
overlayPreviewToggleBtn.addEventListener('click', () => {
  const hidden = overlayPreviewEl.classList.toggle('hidden');
  localStorage.setItem(HIDE_OVERLAY_PREVIEW_KEY, hidden ? '1' : '0');
  overlayPreviewToggleBtn.textContent = hidden ? '顯示預覽' : '隱藏預覽';
  if (!hidden) fitOverlayPreview();
});

const DECK_EDIT_KEYS = ['Q', 'W', 'E', 'R'];
const DECK_INCOMING_KEYS = ['A', 'S', 'D', 'F'];

function deckCardTemplate(deckId) {
  const editKey = DECK_EDIT_KEYS[deckId - 1];
  const incomingKey = DECK_INCOMING_KEYS[deckId - 1];
  return `
    <div class="deck-card empty" id="deck-${deckId}">
      <div class="deck-label">DECK ${deckId}<span class="live-badge">▶ LIVE</span></div>
      <div class="body-row">
        <div class="art-wrap">
          <img class="art" id="art-${deckId}" alt="" />
          <div class="art-placeholder" id="art-placeholder-${deckId}">無曲目</div>
        </div>
        <div class="meta">
          <div class="title" id="title-${deckId}">—</div>
          <div class="artist" id="artist-${deckId}">—</div>
          <div class="bpm" id="bpm-${deckId}"></div>
        </div>
      </div>
      <canvas class="waveform" id="wave-${deckId}" width="600" height="60"></canvas>
      <div class="mini-progress" id="mini-progress-${deckId}">
        <div class="mini-progress-line"></div>
        <div class="mini-progress-dot" id="mini-dot-${deckId}"></div>
      </div>
      <div class="progress-track"><div class="progress-fill" id="progress-${deckId}"></div></div>
      <div class="time-row">
        <span id="pos-${deckId}">0:00</span>
        <span id="dur-${deckId}">0:00</span>
      </div>
      <div class="deck-actions">
        <button class="btn btn-small edit-btn" id="edit-btn-${deckId}">編輯 <kbd>⌥${editKey}</kbd></button>
        <button class="btn btn-small" id="incoming-btn-${deckId}">發送 Incoming <kbd>⌥${incomingKey}</kbd></button>
      </div>
      <div class="edit-form" id="edit-form-${deckId}">
        <input type="text" id="edit-title-${deckId}" placeholder="曲名（留空使用自動抓取）" />
        <input type="text" id="edit-artist-${deckId}" placeholder="演出者（留空使用自動抓取）" />
        <input type="text" id="edit-art-${deckId}" placeholder="封面圖網址（留空使用自動抓取）" />
        <div class="edit-form-actions">
          <button class="btn btn-small btn-primary" id="edit-save-${deckId}">Save</button>
          <button class="btn btn-small" id="edit-cancel-${deckId}">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

for (let i = 1; i <= NUM_DECKS; i++) {
  decksEl.insertAdjacentHTML('beforeend', deckCardTemplate(i));
  state[i] = { deckId: i, track: null, duration: null, hasArt: false, positionSeconds: 0, playRate: 0, bpm: null, onAir: false, override: null, peaks: null };

  document.getElementById(`edit-btn-${i}`).addEventListener('click', () => openEditForm(i));
  document.getElementById(`edit-cancel-${i}`).addEventListener('click', () => closeEditForm(i));
  document.getElementById(`edit-save-${i}`).addEventListener('click', () => saveEdit(i));
  document.getElementById(`incoming-btn-${i}`).addEventListener('click', () => sendIncoming(i));
}
applyHide34(hideToggle.checked);

function formatTime(sec) {
  if (sec == null || Number.isNaN(sec)) return '0:00';
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const ART_PLACEHOLDER_SRC = 'art-placeholder.svg';

// 有曲目但抓不到封面(串流曲目、iTunes 也查無結果……)時,放一張灰色唱盤的
// 預設圖示,不要讓 <img> 顯示瀏覽器內建那個破圖示——跟「deck 完全沒載入
// 曲目」是不同狀態,那個仍然用 art-placeholder 文字（見 updateDeckUI）。
async function loadArt(deckId) {
  const img = document.getElementById(`art-${deckId}`);
  const placeholder = document.getElementById(`art-placeholder-${deckId}`);
  try {
    const res = await fetch(`/api/art/${deckId}?t=${Date.now()}`);
    if (!res.ok) throw new Error('no art');
    const blob = await res.blob();
    img.src = URL.createObjectURL(blob);
  } catch {
    img.src = ART_PLACEHOLDER_SRC;
  }
  img.style.display = 'block';
  placeholder.style.display = 'none';
}

let audioCtx;
async function loadWaveform(deckId) {
  try {
    const res = await fetch(`/api/audio/${deckId}`);
    if (!res.ok) throw new Error('no audio');
    const arrayBuffer = await res.arrayBuffer();
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const canvas = document.getElementById(`wave-${deckId}`);
    const buckets = canvas.width;
    const step = Math.max(1, Math.floor(channelData.length / buckets));
    const peaks = new Float32Array(buckets);
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const start = i * step;
      const end = Math.min(channelData.length, start + step);
      for (let j = start; j < end; j++) {
        const v = Math.abs(channelData[j]);
        if (v > peak) peak = v;
      }
      peaks[i] = peak;
    }
    state[deckId].peaks = peaks;
  } catch (err) {
    console.warn(`deck ${deckId} 波形解碼失敗：`, err.message);
    state[deckId].peaks = null;
  }
  drawWaveform(deckId);
}

function drawWaveform(deckId) {
  const canvas = document.getElementById(`wave-${deckId}`);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const d = state[deckId];
  const peaks = d.peaks;
  if (!peaks) return;

  const mid = canvas.height / 2;
  ctx.fillStyle = '#4a9eff';
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, peaks[i] * mid);
    ctx.fillRect(i, mid - h, 1, h * 2);
  }

  if (d.duration) {
    const x = Math.min(canvas.width - 1, (d.positionSeconds / d.duration) * canvas.width);
    ctx.fillStyle = '#ff4a4a';
    ctx.fillRect(x, 0, 2, canvas.height);
  }
}

function updateDeckUI(deckId) {
  const d = state[deckId];
  const card = document.getElementById(`deck-${deckId}`);
  const titleEl = document.getElementById(`title-${deckId}`);
  const artistEl = document.getElementById(`artist-${deckId}`);
  const bpmEl = document.getElementById(`bpm-${deckId}`);
  const posEl = document.getElementById(`pos-${deckId}`);
  const durEl = document.getElementById(`dur-${deckId}`);
  const progressEl = document.getElementById(`progress-${deckId}`);
  const miniDotEl = document.getElementById(`mini-dot-${deckId}`);

  card.classList.toggle('on-air', !!d.onAir);

  if (!d.track) {
    card.classList.add('empty');
    card.classList.remove('playing');
    titleEl.textContent = '（沒有載入曲目）';
    artistEl.textContent = '';
    bpmEl.textContent = '';
    posEl.textContent = '0:00';
    durEl.textContent = '0:00';
    progressEl.style.width = '0%';
    miniDotEl.style.left = '0%';
    return;
  }

  card.classList.remove('empty');
  card.classList.toggle('playing', d.playRate > 0);
  titleEl.textContent = d.track.title || '(未知曲名)';
  artistEl.textContent = d.track.artist || '(未知藝人)';
  bpmEl.textContent = d.bpm ? `${d.bpm.toFixed(1)} BPM` : '';
  posEl.textContent = formatTime(d.positionSeconds);
  durEl.textContent = formatTime(d.duration);
  const pct = d.duration ? Math.min(100, (d.positionSeconds / d.duration) * 100) : 0;
  progressEl.style.width = `${pct}%`;
  miniDotEl.style.left = `${pct}%`;
  drawWaveform(deckId);
}

function openEditForm(deckId) {
  const d = state[deckId];
  document.getElementById(`edit-title-${deckId}`).value = d.override?.title || '';
  document.getElementById(`edit-artist-${deckId}`).value = d.override?.artist || '';
  document.getElementById(`edit-art-${deckId}`).value = d.override?.artUrl || '';
  document.getElementById(`deck-${deckId}`).classList.add('editing');
}

function closeEditForm(deckId) {
  document.getElementById(`deck-${deckId}`).classList.remove('editing');
}

async function saveEdit(deckId) {
  const title = document.getElementById(`edit-title-${deckId}`).value.trim();
  const artist = document.getElementById(`edit-artist-${deckId}`).value.trim();
  const artUrl = document.getElementById(`edit-art-${deckId}`).value.trim();
  await fetch(`/api/deck/${deckId}/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, artist, artUrl }),
  });
  closeEditForm(deckId);
}

async function sendIncoming(deckId) {
  const btn = document.getElementById(`incoming-btn-${deckId}`);
  const res = await fetch(`/api/deck/${deckId}/incoming`, { method: 'POST' });
  if (!res.ok) return;
  const original = btn.innerHTML;
  btn.textContent = '已送出 ✓';
  btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = original;
    btn.disabled = false;
  }, 1500);
}

function applyDeckPayload(payload) {
  const { deckId } = payload;
  const prevFilePath = state[deckId]?.track?.filePath;
  const prevArtUrl = state[deckId]?.override?.artUrl;
  state[deckId] = { ...state[deckId], ...payload };
  updateDeckUI(deckId);

  const newFilePath = payload.track?.filePath;
  const artChanged = payload.override?.artUrl !== prevArtUrl;
  if ((newFilePath && newFilePath !== prevFilePath) || artChanged) {
    if (newFilePath !== prevFilePath) {
      state[deckId].peaks = null;
      loadWaveform(deckId);
    }
    loadArt(deckId);
  } else if (!newFilePath) {
    document.getElementById(`art-${deckId}`).style.display = 'none';
    state[deckId].peaks = null;
    drawWaveform(deckId);
  }
}

function applyPlayhead(msg) {
  const d = state[msg.deckId];
  if (!d) return;
  d.positionSeconds = msg.positionSeconds;
  d.playRate = msg.playRate;
  d.bpm = msg.bpm;
  d.onAir = msg.onAir;
  lastPlayheadAt = Date.now();
  updateDeckUI(msg.deckId);
}

function setStatusLight(el, ok) {
  el.classList.toggle('ok', ok);
  el.classList.toggle('off', !ok);
}

function renderHistoryEntry(entry, prepend) {
  const li = document.createElement('li');
  const time = new Date(entry.time);
  const hh = time.getHours().toString().padStart(2, '0');
  const mm = time.getMinutes().toString().padStart(2, '0');
  li.innerHTML = `<span class="time">${hh}:${mm}</span><span class="track">${entry.title || '(未知曲名)'} - ${entry.artist || '(未知藝人)'}</span>`;
  if (prepend) historyListEl.prepend(li);
  else historyListEl.appendChild(li);
}

function setOverlayVisible(visible) {
  overlayVisible = visible;
  overlayStateTextEl.textContent = visible ? '顯示中' : '已隱藏';
  setStatusLight(statusOverlayEl, visible);
  toggleOverlayBtn.textContent = visible ? '隱藏 Overlay' : '顯示 Overlay';
}

toggleOverlayBtn.addEventListener('click', async () => {
  await fetch('/api/overlay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visible: !overlayVisible }),
  });
});

function setWebcamEnabled(enabled) {
  webcamEnabled = enabled;
  toggleWebcamBtn.textContent = enabled ? '關閉視訊畫面' : '開啟視訊畫面';
  toggleWebcamBtn.classList.toggle('btn-primary', enabled);
}

toggleWebcamBtn.addEventListener('click', async () => {
  await fetch('/api/webcam', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !webcamEnabled }),
  });
});

dropBtn.addEventListener('click', async () => {
  await fetch('/api/drop', { method: 'POST' });
});

const ytNudgeStepInput = document.getElementById('yt-nudge-step');
const ytNudgeBackBtn = document.getElementById('yt-nudge-back');
const ytNudgeFwdBtn = document.getElementById('yt-nudge-fwd');

function currentNudgeStep() {
  const v = parseFloat(ytNudgeStepInput.value);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function updateNudgeButtonLabels() {
  const step = currentNudgeStep();
  ytNudgeBackBtn.textContent = `-${step}s`;
  ytNudgeFwdBtn.textContent = `+${step}s`;
}
ytNudgeStepInput.addEventListener('input', updateNudgeButtonLabels);
updateNudgeButtonLabels();

function nudgeYt(sign) {
  fetch('/api/yt-nudge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds: sign * currentNudgeStep() }),
  });
}
ytNudgeBackBtn.addEventListener('click', () => nudgeYt(-1));
ytNudgeFwdBtn.addEventListener('click', () => nudgeYt(1));

const ytResyncBtn = document.getElementById('yt-resync-btn');
ytResyncBtn.addEventListener('click', () => {
  fetch('/api/yt-resync', { method: 'POST' });
});

// VJ_STYLE_DEFS 是 vj-preview.js 定義的（名稱 + 是否有即時預覽），這裡負責
// 建卡片、處理點選、還有跟伺服器同步目前選到哪個風格。
VJ_STYLE_DEFS.forEach((def, i) => {
  const card = document.createElement('div');
  card.className = 'vj-card';
  card.dataset.style = def.key;
  const keyBadge = `<kbd class="vj-card-key">⌥${i + 1}</kbd>`;
  card.innerHTML =
    def.key === 'ytmv' || def.key === 'localmp4' || def.key === 'localmv'
      ? `${keyBadge}<div class="vj-card-preview vj-card-preview-static">▶</div><div class="vj-card-label">${def.label}</div>`
      : `${keyBadge}<div class="vj-card-preview" id="vj-preview-${def.key}"></div><div class="vj-card-label">${def.label}</div>`;
  card.addEventListener('click', async () => {
    await fetch('/api/vj-style', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: def.key }),
    });
  });
  vjStyleGridEl.appendChild(card);
});

function setVjStyle(style) {
  for (const card of vjStyleGridEl.children) {
    card.classList.toggle('selected', card.dataset.style === style);
  }
  localVideoRowEl.classList.toggle('hidden', style !== 'localmp4');
}

// 場景「在地 MP4」：切到這個場景時控制面板才顯示選片 dropdown，選項是
// public/videos/ 目錄底下實際有的 .mp4 檔案（伺服器端即時掃描，不用重啟）。
const localVideoRowEl = document.getElementById('local-video-row');
const localVideoSelectEl = document.getElementById('local-video-select');

async function loadVideoList(selected) {
  const res = await fetch('/api/videos');
  const data = await res.json();
  const files = data.files || [];
  localVideoSelectEl.innerHTML = files.length
    ? files.map((f) => `<option value="${f}">${f}</option>`).join('')
    : '<option value="">（public/videos 內沒有 .mp4 檔案）</option>';
  if (selected && files.includes(selected)) localVideoSelectEl.value = selected;
}

localVideoSelectEl.addEventListener('change', () => {
  fetch('/api/local-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: localVideoSelectEl.value || null }),
  });
});

setInterval(() => {
  setStatusLight(statusRhythmEl, Date.now() - lastPlayheadAt < RHYTHM_STALE_MS);
}, 1000);

async function fetchInitialState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  for (const deck of data.decks) applyDeckPayload(deck);
  setOverlayVisible(data.overlayVisible);
  setStatusLight(statusSeratoEl, data.seratoConnected);
  setVjStyle(data.vjStyle);
  setWebcamEnabled(data.webcamEnabled);
  await loadVideoList(data.localVideoFile);

  const histRes = await fetch('/api/history');
  const histData = await histRes.json();
  for (const entry of histData.history) renderHistoryEntry(entry, false);
}

function connectWebSocket() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'deck') applyDeckPayload(msg.deck);
    else if (msg.type === 'playhead') applyPlayhead(msg);
    else if (msg.type === 'onair') {
      for (const id of Object.keys(state)) updateDeckUI(Number(id));
    } else if (msg.type === 'overlay') setOverlayVisible(msg.visible);
    else if (msg.type === 'status') setStatusLight(statusSeratoEl, msg.seratoConnected);
    else if (msg.type === 'history') renderHistoryEntry(msg.entry, true);
    else if (msg.type === 'vjStyle') setVjStyle(msg.style);
    else if (msg.type === 'webcam') setWebcamEnabled(msg.enabled);
    else if (msg.type === 'localVideo') localVideoSelectEl.value = msg.file || '';
  };
  ws.onclose = () => {
    console.warn('WebSocket 斷線，3 秒後重連...');
    setTimeout(connectWebSocket, 3000);
  };
  ws.onerror = () => ws.close();
}

fetchInitialState();
connectWebSocket();

/* ---------- 鍵盤快捷鍵 ----------
 * 全部都要「按住 Option（⌥）」＋下面的鍵才會觸發，單獨按字母/數字鍵完全
 * 不處理——這台電腦通常同時開著 Serato，單鍵很容易被 Serato 自己的快捷鍵
 * 吃掉，Cmd 又跟系統/瀏覽器保留的快捷鍵衝突，所以固定用 Option 當唯一的
 * 觸發修飾鍵。
 *
 * ⌥1-⌥5      VJ 視覺選擇（依卡片順序：圓環/波形/粒子網絡/雷射/YouTube MV）
 * ⌥O         顯示/隱藏 Overlay
 * ⌥C         開關視訊畫面
 * ⌥[ / ⌥]    YouTube MV 時間校正 -/+
 * ⌥H         隱藏 Deck 3/4
 * ⌥Q / ⌥A    Deck 1 編輯 / 發送 Incoming
 * ⌥W / ⌥S    Deck 2 編輯 / 發送 Incoming
 * ⌥E / ⌥D    Deck 3 編輯 / 發送 Incoming
 * ⌥R / ⌥F    Deck 4 編輯 / 發送 Incoming
 * 在輸入框裡打字時（編輯表單、校正秒數欄位）不會觸發，避免打字誤觸。
 */

// 用 event.code（實體按鍵位置）不用 event.key——因為要求按著 Option 時，
// Mac 上 Option+字母鍵的 event.key 會變成特殊字元（例如 Option+Q 是 "œ"），
// code 不受影響，永遠回報實際按下的是哪個鍵。
const DECK_KEY_MAP = {
  KeyQ: { deckId: 1, action: 'edit' },
  KeyA: { deckId: 1, action: 'incoming' },
  KeyW: { deckId: 2, action: 'edit' },
  KeyS: { deckId: 2, action: 'incoming' },
  KeyE: { deckId: 3, action: 'edit' },
  KeyD: { deckId: 3, action: 'incoming' },
  KeyR: { deckId: 4, action: 'edit' },
  KeyF: { deckId: 4, action: 'incoming' },
};

function toggleEditForm(deckId) {
  const card = document.getElementById(`deck-${deckId}`);
  if (!card) return;
  if (card.classList.contains('editing')) closeEditForm(deckId);
  else openEditForm(deckId);
}

document.addEventListener('keydown', (ev) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  // 一定要按著 Option（⌥）才觸發，單純按字母/數字鍵完全不處理——這台電腦
  // 通常同時開著 Serato，沒有這層防護的話一般按鍵會被 Serato 自己的快捷鍵
  // 吃掉（它很多功能也是綁單一按鍵）。Cmd 保留給系統/瀏覽器自己的快捷鍵，
  // 不拿來用，避免撞在一起。
  if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;

  const code = ev.code;

  if (/^Digit[1-9]$/.test(code)) {
    const def = VJ_STYLE_DEFS[Number(code.slice(5)) - 1];
    if (!def) return;
    ev.preventDefault();
    fetch('/api/vj-style', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: def.key }),
    });
    return;
  }

  if (code === 'KeyO') {
    ev.preventDefault();
    toggleOverlayBtn.click();
    return;
  }

  if (code === 'KeyC') {
    ev.preventDefault();
    toggleWebcamBtn.click();
    return;
  }

  if (code === 'BracketLeft') {
    ev.preventDefault();
    nudgeYt(-1);
    return;
  }

  if (code === 'BracketRight') {
    ev.preventDefault();
    nudgeYt(1);
    return;
  }

  if (code === 'Backslash') {
    ev.preventDefault();
    ytResyncBtn.click();
    return;
  }

  if (code === 'KeyH') {
    ev.preventDefault();
    hideToggle.checked = !hideToggle.checked;
    hideToggle.dispatchEvent(new Event('change'));
    return;
  }

  if (code === 'KeyD') {
    ev.preventDefault();
    dropBtn.click();
    return;
  }

  const deckAction = DECK_KEY_MAP[code];
  if (deckAction) {
    ev.preventDefault();
    if (deckAction.action === 'edit') toggleEditForm(deckAction.deckId);
    else sendIncoming(deckAction.deckId);
  }
});
