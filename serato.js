/**
 * Serato PoC —— 驗證能不能從 Serato DJ 拿到即時播放狀態。
 *
 * 用 serato-connect 的 SeratoRemoteClient：透過 Bonjour/mDNS 廣播一個
 * `_SeratoIOSRemote._tcp` 服務（本來是給 Serato 官方 iOS 遙控 App 用的協定），
 * Serato DJ 偵測到後會自動連線過來，用 OSC-over-TCP 即時推播每個 deck 的
 * 曲目、播放進度、loop、mixer 狀態。不用 root、不用綁定 UDP 50000 那些
 * 會撞 port 的東西，也不需要 Serato 端額外設定。
 */
const { SeratoRemoteClient } = require('serato-connect');

async function main() {
  console.log('[1/2] 啟動 Serato Remote 監聽...');

  const remote = new SeratoRemoteClient({ peerName: 'dj-viewer' });

  remote.on('deckChange', ({ deckId, track }) => {
    if (!track) {
      console.log(`\n⏹  Deck ${deckId} 沒有載入曲目`);
      return;
    }
    console.log(`\n🎵 Deck ${deckId}：${track.artist ?? '(未知藝人)'} - ${track.title ?? '(未知曲名)'}`);
  });

  remote.on('loopChange', (payload) => {
    console.log(`🔁 loop 狀態變化：`, payload);
  });

  remote.on('error', (err) => {
    console.error('❌ Serato Remote 發生錯誤：', err);
  });

  const { port, instanceName } = await remote.start();
  console.log(`[2/2] 已廣播服務 "${instanceName}"（port ${port}），等待 Serato DJ 自動連線...`);
  console.log('請打開 Serato DJ 並載入/播放曲目，它會自動連過來。Ctrl+C 結束。\n');
}

main().catch((err) => {
  console.error('未預期的錯誤：', err);
  process.exit(1);
});
