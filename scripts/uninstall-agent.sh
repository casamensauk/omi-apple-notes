#!/usr/bin/env bash
# Remove the launchd service. Leaves your config and your notes untouched.
set -euo pipefail
LABEL="com.omi.notes.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL. Config at ~/.config/omi-notes/config.env was left in place."
