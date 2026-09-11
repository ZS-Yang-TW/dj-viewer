#!/bin/bash
# 啟動 DJ Overlay 伺服器（會先關掉舊的，避免 port 被佔用）
cd "$(dirname "$0")"

PORT=4545

# 用 pkill 抓所有符合的 node server.js 程序（不是只挑目前佔著 4545 port 的那個），
# 避免重複快速重啟時，舊的程序沒真的死掉、卻又啟動一個新的，變成兩個同時在
# 廣播同一個 Serato Bonjour 服務名稱互相打架。
if pgrep -f "node server\.js" > /dev/null 2>&1; then
  echo "關閉舊的伺服器程序..."
  pkill -f "node server\.js"
  # 等到真的都死透了再繼續，最多等 5 秒
  for i in $(seq 1 10); do
    pgrep -f "node server\.js" > /dev/null 2>&1 || break
    sleep 0.5
  done
fi

nohup npm run web > server.log 2>&1 &
disown

# 等到 port 真的開始監聽，最多等 5 秒，而不是猜一個固定秒數
for i in $(seq 1 10); do
  lsof -i :$PORT -sTCP:LISTEN > /dev/null 2>&1 && break
  sleep 0.5
done

if lsof -i :$PORT -sTCP:LISTEN > /dev/null 2>&1; then
  echo "伺服器已啟動："
  echo "  Route A（控制台）  http://localhost:$PORT/"
  echo "  Route B（觀眾畫面） http://localhost:$PORT/overlay"

  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [ -x "$CHROME" ]; then
    # 控制台用 --app 模式開，去掉網址列/分頁列等 Chrome 原本的介面 layout
    "$CHROME" --app="http://localhost:$PORT/" > /dev/null 2>&1 &
    disown
    open -a "Google Chrome" "http://localhost:$PORT/overlay"
  else
    echo "找不到 Google Chrome，請手動用 Chrome 開啟上面兩個網址"
  fi
else
  echo "啟動失敗，請查看 server.log"
  tail -n 20 server.log
fi
