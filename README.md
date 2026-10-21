# DJ Overlay

給 DJ 直播／現場投影用的即時 Overlay。透過 Serato DJ 的 Remote 協定拿到每個 deck 正在播的曲目、播放進度和 mixer 狀態，在瀏覽器裡畫出「Now Playing」字卡和跟著音樂跑的 VJ 背景。

- **Route A（控制台）** `http://localhost:4545/`：DJ 自己看的操作面板。
- **Route B（觀眾畫面）** `http://localhost:4545/overlay`：給 OBS 擷取或直接投影的畫面。

## 功能

- **Now Playing / Incoming 字卡**：顯示曲名、歌手、封面、進度條，可以手動推出「下一首」預告。
- **曲目資訊**：本機音檔讀 ID3 tag 拿封面和曲長；串流曲目（Spotify、TIDAL 等）或沒有封面的檔案改查 iTunes Search API。曲名、歌手、封面都可以在控制台手動覆寫。
- **VJ 背景**（p5.js）：circles、waveform、plexus、laser、breath、chaos、beat bars、constellation、code rain、NCS circle 等生成式場景，加上三種影片模式：
  - **YouTube MV**：自動搜尋目前曲目的 MV 當靜音背景，會依播放進度對位，可用 ±1s 和「更新對位」手動校正。
  - **本機 MV**：播放 `public/videos/<曲名>.mp4`，找不到時改用 YouTube MV。
  - **本機 MP4**：從 `public/videos/` 手動選一支影片循環播放。
- **DROP 按鈕**：手動觸發 drop 特效。
- **視訊畫面**：在 Overlay 上疊加 webcam。
- **播放紀錄**：每首歌寫入 `history.log`，控制台可以看。

## 需求

- macOS
- Node.js 18 以上
- Serato DJ（要跟這台電腦在同一個網路，會透過 Bonjour 找到本程式）
- Google Chrome（`start.sh` 會用它開啟兩個畫面）

## 安裝與啟動

```bash
npm install
./start.sh
```

`start.sh` 會先關掉舊的伺服器程序，在背景啟動 `server.js`（log 寫到 `server.log`），再用 Chrome 開啟控制台和觀眾畫面。要改 port 可以設環境變數 `PORT`，但 `start.sh` 裡的 `PORT` 也要一起改。

只想在前景跑、直接看 log：

```bash
npm run web
```

伺服器會用 Bonjour 廣播一個 Serato Remote 服務（原本是給 Serato 官方 iOS 遙控 App 用的），Serato DJ 偵測到後會自動連過來，不需要額外設定。控制台上方的狀態列會顯示是否已連上。

## 鍵盤快捷鍵（控制台）

| 按鍵 | 動作 |
|---|---|
| `⌥H` | 隱藏 Deck 3 / 4 |
| `⌥D` | DROP |
| `⌥[` / `⌥]` | YouTube MV 往前／往後校正 |
| `⌥\` | YouTube MV 重新對位 |
| `⌥C` | 開關視訊畫面 |

## 影片素材

影片檔放在 `public/videos/`，**不會進版控**（`.gitignore` 排除了 `*.mp4` 等影音檔），clone 下來後要自己放：

- 「本機 MV」模式：檔名要跟 Serato 裡的曲名一模一樣，例如 `Enjoy This Time.mp4`。
- 「本機 MP4」模式：任何 `.mp4` 都可以，會出現在控制台的下拉選單。

## 專案結構

```
server.js          Express + WebSocket 伺服器，接 Serato Remote、處理所有 /api
start.sh           一鍵重啟並開啟兩個畫面
public/
  index.html, app.js, style.css        控制台（Route A）
  overlay.html, overlay.js, overlay.css 觀眾畫面（Route B）
  vj-sketch.js, vj-preview.js          VJ 背景的 p5.js 主程式與控制台預覽
  vj-scenes/                           各個生成式場景
  videos/                              影片素材（不進版控）
index.js           早期用 Pro DJ Link（rekordbox）的 POC，見 docs/prolink-notes.md
serato.js          serato-connect 的最小測試腳本（npm run serato）
```

## 已知限制

- Serato Remote 協定不傳曲長。串流曲目的曲長只能靠 iTunes 查詢，查不到時進度條會停在 0%。
- 判斷「哪個 deck 正在出聲」只看 upfader 和播放速度，不看 crossfader。
- YouTube MV 只會在換歌或切換風格時自動對位，播久了可能飄掉，需要手動校正。
