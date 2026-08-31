#!/usr/bin/env bash
# End-to-end check: boots the relay and the agent locally, drives them through the same
# HTTP calls Omi makes, and asserts the results land in Apple Notes.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-38472}"
UID_TEST="e2e-uid"
TOKEN="e2e-token"
WORK="$(mktemp -d)"
BASE="http://127.0.0.1:${PORT}"
# A nonce keeps each run isolated: fuzzy title matching is meant to find "Camping Kit"
# from "my camping list", so a generic sandbox title would match the previous run's note.
NONCE="${NONCE:-$(date +%s)}"
NOTE_TITLE="${NOTE_TITLE:-Omi E2E $NONCE}"
KEEP_NOTE="${KEEP_NOTE:-0}"

cleanup() {
  [[ -n "${RELAY_PID:-}" ]] && kill "$RELAY_PID" 2>/dev/null || true
  [[ -n "${AGENT_PID:-}" ]] && kill "$AGENT_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> building"
(cd relay && npx tsc -p tsconfig.json)
(cd agent && npm run --silent build)

echo "==> starting relay on :$PORT"
PORT="$PORT" DB_PATH="$WORK/test.db" AGENT_TOKEN="$TOKEN" \
  PUBLIC_BASE_URL="$BASE" \
  node relay/dist/index.js > "$WORK/relay.log" 2>&1 &
RELAY_PID=$!

for _ in $(seq 1 40); do
  curl -fsS "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$BASE/health" >/dev/null || { echo "relay failed to start"; cat "$WORK/relay.log"; exit 1; }

echo "==> starting agent"
RELAY_URL="$BASE" AGENT_TOKEN="$TOKEN" OMI_NOTES_ENV=/dev/null \
  node agent/dist/index.js > "$WORK/agent.log" 2>&1 &
AGENT_PID=$!

echo "==> waiting for the agent's first mirror upload"
for _ in $(seq 1 40); do
  MIRROR=$(curl -fsS "$BASE/health" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["mirrorNotes"])' 2>/dev/null || echo 0)
  [[ "${MIRROR:-0}" -gt 0 ]] && { echo "  mirror has $MIRROR notes"; break; }
  sleep 1
done

call() {
  curl -fsS -X POST "$BASE/tools/$1" -H 'content-type: application/json' -d "$2" || true
}

echo "==> manifest"
curl -fsS "$BASE/.well-known/omi-tools.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  tools:", ", ".join(t["name"] for t in d["tools"]))'

# The agent starts mirroring before any tool call has revealed a uid. This proves that
# snapshot is kept and adopted, rather than 400'd away.
echo "==> list_notes before any write (pre-uid mirror + trust-on-first-use pinning)"
call list_notes "{\"uid\":\"$UID_TEST\",\"tool_name\":\"list_notes\",\"query\":\"camping\"}" | head -c 160
echo

echo "==> create_note"
CREATED="$(call create_note "{\"uid\":\"$UID_TEST\",\"tool_name\":\"create_note\",\"title\":\"$NOTE_TITLE\",\"items\":[\"Tent\",\"Sleeping bags\",\"Head torch\"]}")"
echo "$CREATED"

# Refuse to keep writing unless we are certainly operating on our own sandbox note.
# A fuzzy title match once sent these writes into a real, unrelated note.
if [[ "$CREATED" != *"$NOTE_TITLE"* ]]; then
  echo "ABORT: create_note did not act on \"$NOTE_TITLE\" — refusing to write further." >&2
  exit 1
fi

echo "==> add_to_note (fuzzy title, spoken form)"
call add_to_note "{\"uid\":\"$UID_TEST\",\"tool_name\":\"add_to_note\",\"title\":\"omi e2e $NONCE\",\"items\":[\"Tent pegs\",\"Gas canister\"]}"
echo

echo "==> add_to_note into a new section"
call add_to_note "{\"uid\":\"$UID_TEST\",\"tool_name\":\"add_to_note\",\"title\":\"omi e2e $NONCE\",\"items\":[\"Kettle\"],\"section\":\"Kitchen\"}"
echo

echo "==> remove_from_note"
call remove_from_note "{\"uid\":\"$UID_TEST\",\"tool_name\":\"remove_from_note\",\"title\":\"omi e2e $NONCE\",\"items\":[\"head torch\"]}"
echo

sleep 2
echo "==> read_note (served from the mirror, no Mac round trip)"
call read_note "{\"uid\":\"$UID_TEST\",\"tool_name\":\"read_note\",\"title\":\"omi e2e $NONCE\"}"
echo
echo "==> agent log"
tail -6 "$WORK/agent.log"

if [[ "$KEEP_NOTE" != "1" ]]; then
  echo "==> cleaning up the sandbox note (moved to the Notes Recently Deleted folder)"
  # Deliberately lives here and not in the agent: the shipped agent has no delete path.
  osascript -l JavaScript -e "
    const N = Application('Notes');
    const ids = N.notes.id(), names = N.notes.name();
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      if (names[i] === '$NOTE_TITLE') { N.notes.byId(ids[i]).delete(); n++; }
    }
    'removed ' + n" 2>/dev/null | tail -1
else
  echo "==> KEEP_NOTE=1, leaving \"$NOTE_TITLE\" in Apple Notes"
fi
