#!/usr/bin/env bash
# Evopet uninstaller: undoes evopet-install.sh. Idempotent.
set -euo pipefail

LOCAL_DIR="$HOME/.claude/local"
SHIM_FILE="$LOCAL_DIR/optional-projects.sh"
BASH_PROFILE="$HOME/.bash_profile"
SETTINGS_FILE="$HOME/.claude/settings.json"

# Remove shim file.
if [ -f "$SHIM_FILE" ]; then
  rm -f "$SHIM_FILE"
  echo "[evopet-uninstall] removed $SHIM_FILE"
else
  echo "[evopet-uninstall] $SHIM_FILE absent, skipping"
fi

# Remove shim source line from .bash_profile (match by substring).
if [ -f "$BASH_PROFILE" ] && grep -F ".claude/local/optional-projects.sh" "$BASH_PROFILE" > /dev/null 2>&1; then
  sed -i '\|\.claude/local/optional-projects\.sh|d' "$BASH_PROFILE"
  echo "[evopet-uninstall] cleaned .bash_profile"
else
  echo "[evopet-uninstall] .bash_profile clean, skipping"
fi

# Remove statusLine from settings.json only if it matches our installed value.
if [ -f "$SETTINGS_FILE" ]; then
  node -e '
  const fs = require("fs");
  const path = process.argv[1];
  let obj = {};
  try { obj = JSON.parse(fs.readFileSync(path, "utf8") || "{}"); } catch (e) {
    console.error("[evopet-uninstall] settings.json parse failed: " + e.message);
    process.exit(0);
  }
  const expected = "python ~/.claude/base_statusline.py";
  if (obj.statusLine && obj.statusLine.command === expected) {
    delete obj.statusLine;
    fs.writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
    console.log("[evopet-uninstall] removed statusLine from settings.json");
  } else if (obj.statusLine) {
    console.log("[evopet-uninstall] statusLine customised by user, leaving alone");
  } else {
    console.log("[evopet-uninstall] settings.json has no statusLine, skipping");
  }
  ' "$SETTINGS_FILE"
fi

echo "[evopet-uninstall] complete. Restart your shell."
