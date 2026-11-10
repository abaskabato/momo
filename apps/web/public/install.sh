#!/bin/sh
# Installs Momo on this computer and starts it in the background (now, and
# whenever you log in). Mac or Linux. Run:  curl -fsSL <your Momo site>/install.sh | sh
# It needs the momo.env the setup page downloaded (looked for in ~/Downloads).
# Nothing is installed system-wide: everything lives in ~/.momo.
set -eu

DIR="${MOMO_HOME:-$HOME/.momo}"
REPO="${MOMO_REPO:-abaskabato/momo}"
REF="${MOMO_REF:-main}"
PORT="${PORT:-8787}"
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have curl || die "Momo's installer needs curl."
have tar || die "Momo's installer needs tar."
mkdir -p "$DIR" && chmod 700 "$DIR"

# 1. Settings
ENV_SRC="${MOMO_ENV:-}"
if [ -z "$ENV_SRC" ]; then
  for f in "$HOME/Downloads/momo.env" "$HOME/Downloads/momo (1).env" "./momo.env"; do
    [ -f "$f" ] && ENV_SRC="$f" && break
  done
fi
if [ -n "$ENV_SRC" ]; then
  cp "$ENV_SRC" "$DIR/momo.env.new" && chmod 600 "$DIR/momo.env.new"
  if [ -f "$DIR/momo.env" ] && grep -q '^MOMO_MASTER_KEY=' "$DIR/momo.env"; then
    # Keep the existing master key, or everything Momo saved would become unreadable.
    KEEP=$(grep '^MOMO_MASTER_KEY=' "$DIR/momo.env")
    grep -v '^MOMO_MASTER_KEY=' "$DIR/momo.env.new" > "$DIR/momo.env.tmp" && echo "$KEEP" >> "$DIR/momo.env.tmp"
    mv "$DIR/momo.env.tmp" "$DIR/momo.env.new"
  fi
  mv "$DIR/momo.env.new" "$DIR/momo.env"
  rm -f "$ENV_SRC"   # it holds your keys; the copy in ~/.momo is the one Momo uses
  say "Settings: saved to $DIR/momo.env"
elif [ -f "$DIR/momo.env" ]; then
  say "Settings: keeping $DIR/momo.env"
else
  die "Couldn't find momo.env. Download it from the setup page first (it goes to your Downloads folder)."
fi

# 2. Node.js 24+ (Momo's own copy unless you already have it)
OS=$(uname -s); ARCH=$(uname -m)
case "$OS" in Darwin) NOS=darwin ;; Linux) NOS=linux ;; *) die "This installer is for Mac and Linux. On Windows use install.ps1." ;; esac
case "$ARCH" in x86_64|amd64) NARCH=x64 ;; arm64|aarch64) NARCH=arm64 ;; *) die "Unsupported processor: $ARCH" ;; esac
NODE=""
if have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 24 ]; then
  NODE=$(command -v node)
elif [ -x "$DIR/node/bin/node" ]; then
  NODE="$DIR/node/bin/node"
else
  say "Downloading Node.js…"
  BASE="https://nodejs.org/dist/latest-v24.x"
  SUMS=$(curl -fsSL "$BASE/SHASUMS256.txt")
  FILE=$(echo "$SUMS" | awk '{print $2}' | grep -E "^node-v24\.[0-9.]+-$NOS-$NARCH\.tar\.gz$" | head -n1)
  [ -n "$FILE" ] || die "Couldn't find Node.js for $NOS-$NARCH."
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  WANT=$(echo "$SUMS" | grep " $FILE\$" | awk '{print $1}')
  if have sha256sum; then GOT=$(sha256sum "$TMP/$FILE" | awk '{print $1}'); else GOT=$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}'); fi
  [ "$WANT" = "$GOT" ] || die "Node.js download didn't verify."
  rm -rf "$DIR/node" && mkdir -p "$DIR/node"
  tar -xzf "$TMP/$FILE" -C "$DIR/node" --strip-components=1
  rm -rf "$TMP"
  NODE="$DIR/node/bin/node"
fi
NODE_BIN=$(dirname "$NODE")
export PATH="$NODE_BIN:$PATH"

# 3. Momo
say "Downloading Momo…"
TMP=$(mktemp -d)
if [ -n "${MOMO_TARBALL:-}" ]; then cp "$MOMO_TARBALL" "$TMP/momo.tgz"   # a local copy (offline, or testing)
else curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" -o "$TMP/momo.tgz"; fi
mkdir -p "$TMP/app" && tar -xzf "$TMP/momo.tgz" -C "$TMP/app" --strip-components=1
rm -rf "$DIR/app.old"; [ -d "$DIR/app" ] && mv "$DIR/app" "$DIR/app.old"
mv "$TMP/app" "$DIR/app" && rm -rf "$TMP" "$DIR/app.old"
say "Installing (a minute or two)…"
(cd "$DIR/app" && npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error)
export PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers"
"$NODE" "$DIR/app/node_modules/playwright-core/cli.js" install chromium-headless-shell >/dev/null
TOOLS_BIN=""
if grep -q '^MOMO_DESKTOP=local' "$DIR/momo.env"; then
  say "Installing agent-desktop (so Momo can use apps on this screen)…"
  npm install --prefix "$DIR/tools" --no-audit --no-fund --no-update-notifier --loglevel=error agent-desktop >/dev/null
  TOOLS_BIN="$DIR/tools/node_modules/.bin:"
  if [ "$NOS" = darwin ]; then
    say "macOS needs your permission for Momo to use the screen. Follow the guide, then come back:"
    "$DIR/tools/node_modules/.bin/agent-desktop" permissions --guide </dev/null || true
  fi
fi
SVC_PATH="$TOOLS_BIN$NODE_BIN:/usr/local/bin:/usr/bin:/bin"
MAIN="$DIR/app/packages/cloud/src/main.ts"
LOG="$DIR/momo.log"
: > "$LOG"
STOP=""

# 4. Start in the background, and at every login
if [ -n "${MOMO_NO_SERVICE:-}" ]; then
  NOSVC=1
elif [ "$NOS" = darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/ai.momo.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.momo</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--env-file=$DIR/momo.env</string><string>$MAIN</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>MOMO_HOME</key><string>$DIR</string>
    <key>PLAYWRIGHT_BROWSERS_PATH</key><string>$DIR/browsers</string>
    <key>PATH</key><string>$SVC_PATH</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  STOP="launchctl bootout gui/$(id -u) $PLIST"
elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/momo.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UN
[Unit]
Description=Momo: text it, things get done
After=network-online.target

[Service]
ExecStart=$NODE --env-file=$DIR/momo.env $MAIN
Environment=MOMO_HOME=$DIR
Environment=PLAYWRIGHT_BROWSERS_PATH=$DIR/browsers
Environment=PATH=$SVC_PATH
Environment=PORT=$PORT
Restart=always
RestartSec=5
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=default.target
UN
  systemctl --user daemon-reload
  systemctl --user enable momo >/dev/null 2>&1
  systemctl --user restart momo
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true   # keep running when logged out, if allowed
  STOP="systemctl --user disable --now momo"
fi
if [ -n "${NOSVC:-}" ] || { [ "$NOS" = linux ] && [ -z "${STOP:-}" ]; }; then
  # No service manager (or MOMO_NO_SERVICE): start it now; it won't come back after a restart.
  pkill -f "$MAIN" 2>/dev/null || true
  MOMO_HOME="$DIR" PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers" PATH="$SVC_PATH" PORT="$PORT" \
    nohup "$NODE" --env-file="$DIR/momo.env" "$MAIN" >>"$LOG" 2>&1 &
  STOP="pkill -f $MAIN"
  [ -n "${NOSVC:-}" ] || say "Note: started Momo, but couldn't set it to start at login (no systemd). Run this installer again after a restart."
fi

# 5. Wait for it to say hello
i=0
while [ $i -lt 60 ]; do
  if grep -q "Telegram: text" "$LOG" 2>/dev/null; then break; fi
  if grep -qiE "^Error|error:|Unauthorized" "$LOG" 2>/dev/null; then break; fi
  i=$((i + 1)); sleep 1
done
echo
if grep -q "Telegram: text" "$LOG"; then
  say "Momo is running."
  grep "Telegram: text" "$LOG" | tail -n1 | sed 's/^ *//'
  echo "Say hi to your bot. Leave this computer on: Momo works while it's awake."
else
  echo "Momo didn't start cleanly. The last lines of its log ($LOG):"
  tail -n 15 "$LOG"
  if [ "$NOS" = linux ]; then echo "If it mentions missing libraries for Chromium, run: sudo $NODE $DIR/app/node_modules/playwright-core/cli.js install-deps chromium-headless-shell"; fi
  exit 1
fi
echo "Logs: $LOG    Stop: $STOP    Update: run this installer again"
