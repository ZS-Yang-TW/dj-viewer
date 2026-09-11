/**
 * Prolink POC —— 驗證能不能從 rekordbox（DDJ-400）拿到即時播放狀態。
 *
 * rekordbox 自己會綁死 UDP 50000/50001/50002（Pro DJ Link 用的 port），
 * 而且它的 socket 沒開 SO_REUSEPORT，所以任何用 dgram bind 同一台機器的
 * 方式（包含 prolink-connect 內建的 bringOnline()）都會撞 EADDRINUSE。
 *
 * 這支腳本改用封包截取（libpcap/BPF）被動監聽網卡上的封包，完全不 bind
 * 任何 port，所以不會跟 rekordbox 衝突。缺點是需要 root 權限讀取 BPF
 * 裝置，所以要用 `sudo npm start` 執行。
 *
 * 拿到的原始封包丟給 prolink-connect 匯出的 deviceFromPacket /
 * statusFromPacket 解析，再餵給 MixstatusProcessor 判斷 nowPlaying。
 */
const { Cap, decoders } = require('cap');
const { deviceFromPacket, statusFromPacket, MixstatusProcessor } = require('prolink-connect');

const PROTOCOL = decoders.PROTOCOL;
const ANNOUNCE_PORT = 50000;
const STATUS_PORT = 50002;
const IFACE_NAME = 'en0';

function main() {
  console.log(`[1/2] 在網卡 ${IFACE_NAME} 上被動截取 Pro DJ Link 封包...`);

  const device = Cap.deviceList().find((d) => d.name === IFACE_NAME);
  if (!device) {
    console.error(`❌ 找不到網路介面 ${IFACE_NAME}，請用 Cap.deviceList() 確認正確的網卡名稱。`);
    process.exit(1);
  }

  const cap = new Cap();
  const filter = `udp and (dst port ${ANNOUNCE_PORT} or dst port ${STATUS_PORT})`;
  const buffer = Buffer.alloc(65535);

  let linkType;
  try {
    linkType = cap.open(device.name, filter, 10 * 1024 * 1024, buffer);
  } catch (err) {
    console.error('❌ 開啟封包截取失敗。BPF 裝置需要 root 權限，請用 `sudo npm start` 執行。');
    console.error(err);
    process.exit(1);
  }

  if (linkType !== 'ETHERNET') {
    console.error(`❌ 非預期的 link type：${linkType}（預期是 ETHERNET）`);
    process.exit(1);
  }

  console.log('✅ 已開始監聽（請確認 rekordbox 已開啟並載歌，Ctrl+C 結束）...\n');

  const mixstatus = new MixstatusProcessor();
  const knownDevices = new Map();

  mixstatus.on('nowPlaying', (state) => {
    console.log(
      `\n🎵 nowPlaying 觸發：device=${state.deviceId} trackId=${state.trackId} ` +
        `trackSlot=${state.trackSlot} trackType=${state.trackType}`
    );
  });

  mixstatus.on('stopped', ({ deviceId }) => {
    console.log(`⏹  device ${deviceId} 已停止 / 離開 on-air`);
  });

  cap.on('packet', () => {
    let ret = decoders.Ethernet(buffer);
    if (ret.info.type !== PROTOCOL.ETHERNET.IPV4) return;

    ret = decoders.IPV4(buffer, ret.offset);
    if (ret.info.protocol !== PROTOCOL.IP.UDP) return;

    ret = decoders.UDP(buffer, ret.offset);
    const dstport = ret.info.dstport;
    const payload = buffer.subarray(ret.offset, ret.offset + ret.info.length);

    if (dstport === ANNOUNCE_PORT) {
      const dev = deviceFromPacket(payload);
      if (dev && !knownDevices.has(dev.id)) {
        knownDevices.set(dev.id, dev);
        console.log('🔌 偵測到裝置：', { id: dev.id, name: dev.name, type: dev.type });
      }
      return;
    }

    if (dstport === STATUS_PORT) {
      const status = statusFromPacket(payload);
      if (!status) return;
      const pitch = typeof status.effectivePitch === 'number' ? status.effectivePitch.toFixed(2) : 'n/a';
      console.log(
        `[status] device=${status.deviceId} playState=${status.playState} ` +
          `trackId=${status.trackId} bpm=${status.trackBPM} pitch=${pitch}`
      );
      mixstatus.handleState(status);
    }
  });
}

main();
