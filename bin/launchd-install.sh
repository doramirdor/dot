#!/usr/bin/env bash
#
# Install / uninstall Dot as a macOS launchd LaunchAgent.
#
# Usage:
#   ./bin/launchd-install.sh install     # create, load, and start
#   ./bin/launchd-install.sh uninstall   # unload and remove
#   ./bin/launchd-install.sh status      # show current status
#   ./bin/launchd-install.sh tail        # tail the runtime log
#
# Runs Dot in headless mode (no window, tray, or UI watchers). KeepAlive is
# on, so macOS will restart it if it crashes. RunAtLoad is on, so it starts
# on every login.
#
# Log files land in ~/.nina/logs/ (out + err).

set -euo pipefail

LABEL="com.dot.nina"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.nina/logs"
STDOUT_LOG="${LOG_DIR}/dot.out.log"
STDERR_LOG="${LOG_DIR}/dot.err.log"

# Resolve project dir from this script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# Use the real Electron binary inside the app bundle, not the sh shim at
# node_modules/.bin/electron — launchd can't always resolve the shim's
# relative sed-based path logic under its restricted spawn context.
ELECTRON_BIN="${PROJECT_DIR}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ENTRY="${PROJECT_DIR}/out/main/index.js"

cmd="${1:-}"

write_plist() {
  mkdir -p "$(dirname "$PLIST_PATH")"
  mkdir -p "$LOG_DIR"

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${ELECTRON_BIN}</string>
        <string>${ENTRY}</string>
        <string>--headless</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>

    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST
  echo "wrote $PLIST_PATH"
}

check_prereqs() {
  if [[ ! -x "$ELECTRON_BIN" ]]; then
    echo "error: electron binary not found at $ELECTRON_BIN" >&2
    echo "run 'npm install' in $PROJECT_DIR first." >&2
    exit 1
  fi
  if [[ ! -f "$ENTRY" ]]; then
    echo "error: build output not found at $ENTRY" >&2
    echo "run 'npm run build' in $PROJECT_DIR first." >&2
    exit 1
  fi
}

case "$cmd" in
  install)
    check_prereqs

    # Kill any stray headless dots we started manually
    if pgrep -f "electron.*out/main/index.js.*--headless" >/dev/null 2>&1; then
      echo "stopping existing headless Dot..."
      pkill -f "electron.*out/main/index.js.*--headless" || true
      sleep 1
    fi

    # Unload any previous agent under this label
    if [[ -f "$PLIST_PATH" ]]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
    fi

    write_plist
    launchctl load -w "$PLIST_PATH"
    echo "loaded launch agent: ${LABEL}"
    echo
    echo "Dot will now start on every login and restart on crash."
    echo "logs: $STDOUT_LOG"
    echo "      $STDERR_LOG"
    echo
    echo "next steps:"
    echo "  $0 status    # verify it's running"
    echo "  $0 tail      # watch the log"
    echo "  $0 uninstall # stop and remove"
    ;;

  uninstall)
    if [[ -f "$PLIST_PATH" ]]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      echo "removed $PLIST_PATH"
    else
      echo "no plist at $PLIST_PATH (nothing to remove)"
    fi
    # Belt-and-suspenders: kill any surviving process
    if pgrep -f "electron.*out/main/index.js.*--headless" >/dev/null 2>&1; then
      pkill -f "electron.*out/main/index.js.*--headless" || true
      echo "killed headless dot process"
    fi
    ;;

  status)
    if [[ -f "$PLIST_PATH" ]]; then
      echo "plist: $PLIST_PATH (present)"
    else
      echo "plist: not installed"
    fi
    echo
    echo "=== launchctl list ==="
    launchctl list 2>/dev/null | grep "$LABEL" || echo "$LABEL not loaded"
    echo
    echo "=== process ==="
    pgrep -fl "electron.*out/main/index.js" || echo "no dot process running"
    ;;

  tail)
    mkdir -p "$LOG_DIR"
    touch "$STDOUT_LOG" "$STDERR_LOG"
    echo "tailing $STDOUT_LOG + $STDERR_LOG (ctrl-c to stop)"
    tail -F "$STDOUT_LOG" "$STDERR_LOG"
    ;;

  *)
    echo "usage: $0 {install|uninstall|status|tail}" >&2
    exit 1
    ;;
esac
