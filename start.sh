#!/data/data/com.termux/files/usr/bin/bash
# Starts the bot and auto-restarts it if it crashes. Ctrl+C to stop.
cd "$(dirname "$(readlink -f "$0")")"

if [ ! -f .env ]; then
  echo "[rbx] no .env found, run: bash install.sh"
  exit 1
fi
[ -d node_modules ] || npm install --omit=dev

# keep Android from killing Termux while the screen is off
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

trap 'command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock; exit 0' INT TERM

while true; do
  node bot.js
  echo "[rbx] bot stopped (exit $?), restarting in 5s... (ctrl+c to quit)"
  sleep 5
done
