# Prolink POC 使用說明（macOS）

## 前置需求

- Node.js 18+（`node -v` 確認）
- rekordbox（6.x）+ DDJ-400，先在 rekordbox 裡把兩個 deck 都載入歌曲並播放
- 這台 Mac 至少要有一張**啟用中的網路介面**（Wi-Fi 即可，不需要真的連到網際網路，
  但不能完全沒有網路介面 up，例如純飛航模式可能會有問題）

## 安裝

```bash
npm install
```

> 如果 `npm install` 卡在 `better-sqlite3` 之類的原生模組編譯，通常是因為缺 Xcode
> command line tools：`xcode-select --install`。

## 第一次執行（先不做任何網路 workaround，直接試）

```bash
npm start
```

### 情境 A：順利印出裝置與 status

代表 macOS 這台機器的 UDP socket 行為允許 rekordbox 跟你的腳本同時綁定同一組 port，
恭喜，可以跳過下面所有「同機衝突」的處理，直接往下一步做 metadata / artwork 的整合。

### 情境 B：卡在 `bringOnline()` 或 `autoconfigFromPeers()` 逾時 / 報錯

代表確實撞到 port 衝突（rekordbox 自己占用了 UDP 50000-50002）。這種情況下請照下面
步驟做網路介面分流：

```bash
# 1. 查看目前使用中的網路介面（通常是 en0）
ifconfig | grep -B1 "status: active"

# 2. 幫這張介面多加一個 IP alias，讓你的 Node 程式綁定這個新 IP
#    （子網段要跟你原本的 Wi-Fi/DHCP IP 一致，這裡假設是 192.168.1.x）
sudo ifconfig en0 alias 192.168.1.250 255.255.255.0

# 3. 確認 alias 生效
ifconfig en0
```

接著要讓 `prolink-connect` 手動指定用這個 alias 介面連線（而不是自動偵測），
把 `index.js` 裡的 `autoconfigFromPeers()` 那段改成手動設定，範例：

```js
const os = require('os');

const ifaces = os.networkInterfaces();
// 從 ifaces 裡找出剛剛 alias 出來的 192.168.1.250 對應的 NetworkInterfaceInfoIPv4 物件
const configuredIface = Object.values(ifaces)
  .flat()
  .find((i) => i.family === 'IPv4' && i.address === '192.168.1.250');

network.configure({ vcdjId: 5, iface: configuredIface });
network.connect();
```

> ⚠️ 這個 alias 方法是社群針對 **Windows（ForceBindIP）** 驗證過的作法搬過來的邏輯，
> macOS 上目前沒有查到其他人明確驗證過完全一樣的步驟是否有效。如果做完還是不通，
> 下一步建議直接考慮用 **rkbx_link**（見下方）取代這個協定層。

## 如果 Pro DJ Link 這條路在你的機器上完全不通：rkbx_link

有一套付費工具 `rkbx_link`（約 €25，https://griffindigicoustics.gumroad.com/l/rkbx_link）
是直接讀 rekordbox 程式的記憶體來拿播放進度 / beatgrid，**不透過網路協定**，
所以完全沒有「同機衝突」的問題，且被設計成本來就是要跟 rekordbox 同機執行。
它會輸出 OSC 訊息，你的 Node 後端可以用 `osc` 這個 npm 套件監聽。

缺點：
- 付費、非開源，沒辦法確認內部實作細節
- 主打的是「時間軸精準同步」（position / beatgrid），track 完整 metadata（作者、專輯）
  跟 artwork 不確定是否包含在 OSC 輸出裡，需要你实际申請試用版驗證

如果同機的 Pro DJ Link 卡關卡很久，這是一個務實的備案：拿 `rkbx_link` 做「秒數 / 波形同步」，
metadata / artwork 那塊改成直接讀音檔 ID3 tag（因為你知道正在播的是哪個檔案路徑的話，
其實也可以繞過協定直接拿本地檔案的 tag）。

## 下一步

跑完這支腳本後，把終端機輸出（尤其是有沒有看到 `[status]` 那行，以及 `nowPlaying` 有沒有
成功查到 metadata）貼給我，我們再決定要往哪個方向繼續蓋 backend。
