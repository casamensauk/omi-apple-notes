#!/usr/bin/env bash
# Rebuild the agent and restart the launchd service so the running process picks it up.
# Node loads dist/ once at startup, so a rebuild alone leaves the old code running.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd agent && npm run --silent build)
launchctl kickstart -k "gui/$(id -u)/com.omi.notes.agent"
echo "agent rebuilt and restarted"
