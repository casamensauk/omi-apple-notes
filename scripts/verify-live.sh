#!/usr/bin/env bash
# Prove the deployed relay + the Mac agent actually work together, end to end.
#
# This pins a throwaway uid on the relay, so it ALWAYS resets it afterwards — otherwise
# trust-on-first-use would lock your real Omi account out.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="$HOME/.config/omi-notes/config.env"
RELAY_URL="$(grep '^RELAY_URL=' "$CONFIG" | cut -d= -f2-)"
NONCE="$(date +%s)"
TITLE="Omi Live Check $NONCE"
UID_TEST="verify-$NONCE"

reset_uid() {
  echo "==> resetting the pinned uid so your Omi account can claim the relay"
  # `read` reports failure at EOF when the value has no trailing newline, which under
  # `set -e` would kill this subshell before curl ran — and silently leave the throwaway
  # uid pinned. Piping keeps the token out of the process arguments.
  grep '^AGENT_TOKEN=' "$CONFIG" | cut -d= -f2- | tr -d '\n' | {
    read -r TOKEN || true
    curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$RELAY_URL/agent/reset-uid" \
      || echo "WARNING: could not reset the pinned uid — do it manually before using Omi" >&2
  }
  echo
}
trap reset_uid EXIT

echo "==> relay health"
curl -fsS --max-time 10 "$RELAY_URL/health"; echo

echo "==> create_note through the deployed relay"
RESULT=$(curl -fsS --max-time 20 -X POST "$RELAY_URL/tools/create_note" \
  -H 'content-type: application/json' \
  -d "{\"uid\":\"$UID_TEST\",\"tool_name\":\"create_note\",\"title\":\"$TITLE\",\"items\":[\"Tent\",\"Head torch\"]}")
echo "  $RESULT"

if [[ "$RESULT" != *"$TITLE"* ]]; then
  echo "ABORT: the relay did not act on \"$TITLE\" — not writing further." >&2
  exit 1
fi

echo "==> add_to_note through the deployed relay"
curl -fsS --max-time 20 -X POST "$RELAY_URL/tools/add_to_note" \
  -H 'content-type: application/json' \
  -d "{\"uid\":\"$UID_TEST\",\"tool_name\":\"add_to_note\",\"title\":\"$TITLE\",\"items\":[\"Gas canister\"]}"
echo

echo "==> trigger webhook through the deployed relay (real-time transcript shape)"
curl -fsS --max-time 20 -X POST "$RELAY_URL/omi/webhook?uid=$UID_TEST" \
  -H 'content-type: application/json' \
  -d "[{\"text\":\"Omi, add a folding chair to my $TITLE\",\"is_user\":true,\"start\":1,\"end\":3}]"
echo

echo "==> ordinary conversation must be ignored"
curl -fsS --max-time 20 -X POST "$RELAY_URL/omi/webhook?uid=$UID_TEST" \
  -H 'content-type: application/json' \
  -d '[{"text":"we should add some pegs to the order before Friday","is_user":true}]'
echo

echo "==> confirming it landed in Apple Notes itself"
osascript -l JavaScript -e "
  const N = Application('Notes');
  const ids = N.notes.id(), names = N.notes.name();
  for (let i = 0; i < ids.length; i++) {
    if (names[i] === '$TITLE') { N.notes.byId(ids[i]).body(); }
  }
  const hit = names.indexOf('$TITLE');
  hit === -1 ? 'NOT FOUND' : N.notes.byId(ids[hit]).body().replace(/\n/g, ' ')
" 2>/dev/null | tail -1

echo "==> cleaning up the check note"
osascript -l JavaScript -e "
  const N = Application('Notes');
  const ids = N.notes.id(), names = N.notes.name();
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (names[i] === '$TITLE') { N.notes.byId(ids[i]).delete(); n++; }
  }
  'removed ' + n" 2>/dev/null | tail -1
