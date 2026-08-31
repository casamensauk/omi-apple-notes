#!/usr/bin/env bash
# One-shot finisher: pushes the agent token to Railway, installs the Mac agent, and
# smoke-tests the whole path. Safe to re-run.
#
# The token is generated locally and piped to Railway over stdin, so it never appears
# in a command line, a log, or a chat transcript.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-4923b99b-1b38-4ecb-b81d-d83324a97a4c}"
SERVICE="${SERVICE:-relay}"
CONFIG="$HOME/.config/omi-notes/config.env"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "checking local config"
if [[ ! -f "$CONFIG" ]]; then
  echo "No $CONFIG yet — creating one."
  read -r -p "  Relay URL: " RELAY_URL
  umask 077
  mkdir -p "$(dirname "$CONFIG")"
  printf 'RELAY_URL=%s\nAGENT_TOKEN=%s\nDEFAULT_FOLDER=\n' "$RELAY_URL" "$(openssl rand -hex 32)" > "$CONFIG"
  chmod 600 "$CONFIG"
fi
RELAY_URL="$(grep '^RELAY_URL=' "$CONFIG" | cut -d= -f2-)"
[[ -n "$RELAY_URL" ]] || { echo "RELAY_URL missing from $CONFIG"; exit 1; }
echo "  relay: $RELAY_URL"

step "checking Railway login"
if ! railway whoami >/dev/null 2>&1; then
  echo "  not logged in — opening browser"
  railway login
fi
railway whoami

step "linking the Railway service"
railway link --project "$PROJECT_ID" --service "$SERVICE" --environment production

step "pushing AGENT_TOKEN to Railway (value never printed)"
grep '^AGENT_TOKEN=' "$CONFIG" | cut -d= -f2- | tr -d '\n' | railway variables --set-from-stdin AGENT_TOKEN
echo "  set; Railway is redeploying"

step "waiting for the relay to come back with the token configured"
for i in $(seq 1 90); do
  BODY="$(curl -fsS --max-time 8 "$RELAY_URL/health" 2>/dev/null || true)"
  if [[ "$BODY" == *'"agentConfigured":true'* ]]; then
    echo "  $BODY"
    break
  fi
  [[ $i -eq 90 ]] && { echo "  timed out waiting for the relay"; exit 1; }
  sleep 5
done

step "installing the Mac agent"
./scripts/install-agent.sh

step "smoke test"
sleep 3
echo "  health: $(curl -fsS --max-time 10 "$RELAY_URL/health")"
echo
echo "Done. Last step is in the Omi app: create an app with the External Integration"
echo "capability pointing at:"
echo "  $RELAY_URL/.well-known/omi-tools.json"
echo
echo "Then say: \"Omi, add tent pegs to my camping list\""
echo "Watch it land:  tail -f ~/Library/Logs/omi-notes/agent.log"
