#!/data/data/com.termux/files/usr/bin/bash
# One-time setup for rbx-autojoin on Termux.
set -e
cd "$(dirname "$(readlink -f "$0")")"
DIR="$(pwd)"

echo "[rbx] installing packages..."
pkg update -y
pkg install -y nodejs git
command -v am >/dev/null 2>&1 || pkg install -y termux-am

echo "[rbx] installing node modules..."
npm install --omit=dev

if [ ! -f .env ]; then
  echo
  read -rsp "Discord bot token (hidden): " TOKEN; echo
  read -rp "Channel ID(s) to watch, comma-separated (blank = all): " CHANNELS
  cat > .env <<EOF
DISCORD_TOKEN=$TOKEN
PLACE_ID=142823291
CHANNEL_IDS=$CHANNELS
LINK_STYLE=experiences
DEDUPE_MS=60000
EOF
  chmod 600 .env
  echo "[rbx] saved .env"
else
  echo "[rbx] .env already exists, leaving it alone"
fi

chmod +x start.sh
if ! grep -q "alias rbxjoin=" "$HOME/.bashrc" 2>/dev/null; then
  echo "alias rbxjoin='bash \"$DIR/start.sh\"'" >> "$HOME/.bashrc"
fi

echo
echo "[rbx] done. restart Termux (or run: source ~/.bashrc), then type: rbxjoin"
