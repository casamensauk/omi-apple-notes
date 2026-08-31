#!/usr/bin/env bash
# Install the Apple Notes agent as a launchd service that starts at login.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

CONFIG_DIR="$HOME/.config/omi-notes"
CONFIG="$CONFIG_DIR/config.env"
LOG_DIR="$HOME/Library/Logs/omi-notes"
PLIST="$HOME/Library/LaunchAgents/com.omi.notes.agent.plist"
LABEL="com.omi.notes.agent"
NODE_BIN="$(command -v node)"

[[ -n "$NODE_BIN" ]] || { echo "node not found on PATH"; exit 1; }
mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"

if [[ ! -f "$CONFIG" ]]; then
  echo "No config at $CONFIG — let's create one."
  read -r -p "  Relay URL (e.g. https://your-app.up.railway.app): " RELAY_URL
  read -r -p "  AGENT_TOKEN (same value as on the relay): " AGENT_TOKEN
  read -r -p "  Apple Notes folder for new notes (blank = default): " DEFAULT_FOLDER
  cat > "$CONFIG" <<CONF
RELAY_URL=$RELAY_URL
AGENT_TOKEN=$AGENT_TOKEN
DEFAULT_FOLDER=$DEFAULT_FOLDER
CONF
  chmod 600 "$CONFIG"
  echo "  wrote $CONFIG (mode 600)"
else
  echo "Using existing config at $CONFIG"
fi

echo "==> building agent"
(cd agent && npm install --silent --no-audit --no-fund && npm run --silent build)

# Run once in the foreground first: this is what makes macOS show the Automation prompt
# for Apple Notes. A launchd-started process cannot surface that dialog reliably.
echo "==> checking Apple Notes access (approve the prompt if macOS asks)"
if OMI_NOTES_ENV="$CONFIG" node agent/dist/index.js --once; then
  echo "  Apple Notes access OK"
else
  echo "  Could not reach Apple Notes or the relay. Fix the error above, then re-run."
  exit 1
fi

echo "==> installing launchd service"
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__AGENT_DIR__|$REPO/agent|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__CONFIG__|$CONFIG|g" \
    scripts/com.omi.notes.agent.plist > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo
echo "Installed. The agent now runs at login."
echo "  logs:    tail -f $LOG_DIR/agent.log"
echo "  stop:    launchctl bootout gui/$(id -u)/$LABEL"
echo "  restart: launchctl kickstart -k gui/$(id -u)/$LABEL"
