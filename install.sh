#!/data/data/com.termux/files/usr/bin/bash
# One-time install for rbxjoiner on Termux. After this, just type: rbxjoiner
set -e
cd "$(dirname "$(readlink -f "$0")")"
DIR="$(pwd)"

echo "[rbx] installing packages..."
pkg update -y
pkg install -y nodejs git
command -v am >/dev/null 2>&1 || pkg install -y termux-am

echo "[rbx] installing node modules..."
npm install --omit=dev

# make `rbxjoiner` a real command
chmod +x "$DIR/rbxjoiner"
ln -sf "$DIR/rbxjoiner" "$PREFIX/bin/rbxjoiner"

# clean up the old alias from earlier versions
[ -f "$HOME/.bashrc" ] && sed -i '/alias rbxjoin=/d' "$HOME/.bashrc"

"$DIR/rbxjoiner" setup

echo "[rbx] all set. type: rbxjoiner"
