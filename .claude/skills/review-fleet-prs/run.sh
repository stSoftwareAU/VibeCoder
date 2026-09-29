#!/usr/bin/env bash
# Runs the review-fleet-prs skill unattended, for ever, on an always-on host.
#
# The gate (gate.ts --watch) does the polling for free: it checks every
# 5 minutes and only exits when a PR is ready for review. Only then is a
# headless Claude session started to review that round, so an idle night
# costs no tokens.
#
#   run.sh [owner/name]           # loop for ever (all repos, or one)
#   run.sh --once [owner/name]    # one gate pass and at most one round
#   run.sh --install [owner/name] # run at login, restart on exit
#                                 # (launchd on macOS, systemd on Linux)
#
# Log: ~/.review-fleet-prs/runner.log; each round's files in
# ~/.review-fleet-prs/rounds/<timestamp>/.
set -uo pipefail

# Service managers start us with a bare PATH. Appended, so a caller's PATH
# still wins.
export PATH="$PATH:$HOME/.deno/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=$(cd "$SKILL_DIR/../../.." && pwd)
STATE_DIR="$HOME/.review-fleet-prs"
LOG="$STATE_DIR/runner.log"
LOCK="$STATE_DIR/runner.lock"
INTERVAL=300
ROUND_TIMEOUT=3600 # a hung Claude session must not wedge the loop
LABEL="au.com.stsoftware.review-fleet-prs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Running for ever means the log and round files must not grow for ever.
housekeep() {
  find "$STATE_DIR/rounds" -mindepth 1 -maxdepth 1 -mtime +30 \
    -exec rm -rf {} + 2>/dev/null
  if [[ -f "$LOG" && $(wc -c <"$LOG") -gt 10000000 ]]; then
    mv "$LOG" "$LOG.1"
  fi
}

install_service() {
  local args=("$SKILL_DIR/run.sh" "$@")
  mkdir -p "$STATE_DIR"
  case "$(uname -s)" in
  Darwin)
    local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$(dirname "$plist")"
    {
      echo '<?xml version="1.0" encoding="UTF-8"?>'
      echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
      echo '<plist version="1.0"><dict>'
      echo "  <key>Label</key><string>$LABEL</string>"
      echo '  <key>ProgramArguments</key><array><string>/bin/bash</string>'
      for a in "${args[@]}"; do echo "    <string>$a</string>"; done
      echo '  </array>'
      echo '  <key>RunAtLoad</key><true/>'
      echo '  <key>KeepAlive</key><true/>'
      echo '  <key>ThrottleInterval</key><integer>60</integer>'
      echo "  <key>StandardOutPath</key><string>$STATE_DIR/service.out</string>"
      echo "  <key>StandardErrorPath</key><string>$STATE_DIR/service.out</string>"
      echo '</dict></plist>'
    } >"$plist"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist" || return 1
    echo "Installed $plist"
    echo "Stop: launchctl bootout gui/$(id -u)/$LABEL"
    ;;
  Linux)
    local unit="$HOME/.config/systemd/user/review-fleet-prs.service"
    mkdir -p "$(dirname "$unit")"
    cat >"$unit" <<EOF
[Unit]
Description=Review fleet PRs (VibeCoder review-fleet-prs skill)
After=network-online.target

[Service]
ExecStart=/bin/bash ${args[*]}
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload &&
      systemctl --user enable --now review-fleet-prs.service || return 1
    # Without linger the service stops when the user logs out.
    loginctl enable-linger "$USER" 2>/dev/null ||
      echo "Run 'sudo loginctl enable-linger $USER' so it survives logout."
    echo "Installed $unit"
    echo "Stop: systemctl --user disable --now review-fleet-prs.service"
    ;;
  *)
    echo "--install supports macOS and Linux only" >&2
    return 1
    ;;
  esac
  echo "Log:  tail -f $LOG"
}

# One round: wait for the gate, then have Claude review what it found.
# Returns non-zero when the gate failed.
round() {
  local watch=() ready dir prompt
  if [[ $once == false ]]; then
    watch=("--watch=$INTERVAL")
    [[ -n $sleep_first ]] && watch+=("$sleep_first")
  fi
  log "gate: waiting for a PR that is ready for review"
  if ! ready=$(cd "$SKILL_DIR" && deno run --allow-run=gh --allow-read \
    --allow-write --allow-env=HOME gate.ts ${watch[@]+"${watch[@]}"} \
    ${repo_arg[@]+"${repo_arg[@]}"} 2>>"$LOG"); then
    log "gate failed (see above)"
    return 1
  fi
  if [[ $(jq '.ready | length' <<<"$ready" 2>/dev/null) == 0 ]]; then
    log "gate: nothing ready"
    return 0
  fi

  dir="$STATE_DIR/rounds/$(date '+%Y%m%d-%H%M%S')"
  mkdir -p "$dir"
  echo "$ready" >"$dir/gate.json"
  log "gate: $(jq -r '[.ready[] | "\(.repo)#\(.number)"] | join(", ")' \
    <<<"$ready" 2>/dev/null || echo "$ready")"

  prompt="Use the review-fleet-prs skill to review ONE round, then stop.
The gate has already run for you; do NOT start gate.ts or the loop.
Its output is:

$ready

Follow the skill's 'Reviewing the ready PRs' section (Fable review, post,
learn from recurring findings, report) for the ready PRs above. Run post.ts
from $SKILL_DIR and write its input files under $dir. Skip the
PushNotification step: this session is headless. Finish with the one-line
round report."

  (cd "$CHECKOUT" && perl -e 'alarm shift; exec @ARGV' "$ROUND_TIMEOUT" \
    claude -p "$prompt" \
    --allowedTools "Agent" "Read" "Grep" "Glob" "Write($dir/**)" \
    "Bash(deno run:*)" "Bash(gh:*)" "Bash(jq:*)" "Bash(cat:*)" \
    2>&1) | tee -a "$LOG" "$dir/claude.log"
  log "round done: $dir"
}

main() {
  once=false
  sleep_first=""
  repo_arg=()
  case "${1:-}" in
  --install)
    shift
    install_service "$@"
    return
    ;;
  --once)
    once=true
    shift
    ;;
  esac
  [[ -n "${1:-}" ]] && repo_arg=("--repo=$1")

  mkdir -p "$STATE_DIR/rounds"
  # One runner per machine: two would review the same PRs twice.
  if ! mkdir "$LOCK" 2>/dev/null; then
    local pid
    pid=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "review-fleet-prs runner is already running (pid $pid)" >&2
      return 1
    fi
    # Stale lock from a runner that died: take it over.
  fi
  echo $$ >"$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT

  if [[ $once == true ]]; then
    round
    return
  fi
  while true; do
    housekeep
    if round; then
      sleep_first="--sleep-first"
    else
      # The gate gives up after an hour without GitHub. Keep going rather
      # than wait for someone to restart this by hand.
      sleep_first=""
      sleep "$INTERVAL"
    fi
  done
}

# Parsed in full before it runs: the worker hard-resets this checkout
# hourly, and bash would otherwise read the rewritten file mid-loop.
main "$@"
exit
