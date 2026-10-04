#!/usr/bin/env bash
# Runs the review-fleet-prs skill unattended, for ever, on an always-on host.
#
# Every 5 minutes it runs one gate pass (a GitHub search, no model). Only
# when a PR is ready is a headless Claude session started to review that
# round, so an idle night costs no tokens. With `pr_reviewer_app` in
# .config.json, reviews post as that GitHub App (see app_token.ts).
#
#   run.sh [owner/name]           # loop for ever (all repos, or one)
#   run.sh --once [owner/name]    # one pass: gate, then at most one round
#   run.sh --install [owner/name] # run at login, restart on exit
#                                 # (launchd on macOS, systemd on Linux)
#
# Logs sit beside the Vibe Coder's own, in <log_dir>/review-fleet-prs/
# (~/logs/review-fleet-prs with the fleet's config): runner.log, and each
# round's files in rounds/<timestamp>/.
set -uo pipefail

# Service managers start us with a bare PATH. Appended, so a caller's PATH
# still wins.
export PATH="$PATH:$HOME/.deno/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=$(cd "$SKILL_DIR/../../.." && pwd)
INTERVAL=300
# A hung round must not wedge the loop, nor outlive its token. Overridable
# only so the tests can time a round out without waiting 50 minutes.
ROUND_TIMEOUT=${REVIEW_FLEET_PRS_ROUND_TIMEOUT:-3000}
LABEL="au.com.stsoftware.review-fleet-prs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
# A step's stderr goes to the log and the terminal, so its reason is seen.
errors() { tee -a "$LOG" >&2; }
# The last non-blank line of a captured stderr file: a one-line failure gist.
last_error_line() { grep -v '^$' "$1" 2>/dev/null | tail -n1; }

# Running for ever means the log and round files must not grow for ever.
housekeep() {
  find "$STATE_DIR/rounds" -mindepth 1 -maxdepth 1 -mtime +30 \
    -exec rm -rf {} + 2>/dev/null
  if [[ -f "$LOG" && $(wc -c <"$LOG") -gt 10000000 ]]; then
    mv "$LOG" "$LOG.1"
  fi
  # The service manager holds service.out open, so a rename would leave it
  # writing to the old file: empty it in place instead. Everything in it is
  # also in runner.log.
  if [[ -f "$SERVICE_OUT" && $(wc -c <"$SERVICE_OUT") -gt 10000000 ]]; then
    : >"$SERVICE_OUT"
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
      echo "  <key>StandardOutPath</key><string>$SERVICE_OUT</string>"
      echo "  <key>StandardErrorPath</key><string>$SERVICE_OUT</string>"
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

# One pass: a gate check, then a Claude round if anything is ready.
# Returns non-zero when the App token, the gate or the Claude round failed;
# sets $LAST_ERROR to a one-line gist of why, for escalate_result to report.
pass() {
  local reviewer=() ready dir prompt minted errfile token_rc gate_rc round_rc
  LAST_ERROR=""
  errfile="$STATE_DIR/last-error"
  # Reviews post as the reviewer App when .config.json sets pr_reviewer_app.
  # Its token lasts an hour, so every pass mints a fresh one; a failure skips
  # the pass rather than post as the gh user instead.
  unset GH_TOKEN
  # The minted token must never appear under `bash -x`: xtrace is suspended
  # from here until the App's login has been extracted from it.
  { local xtrace=$-; set +x; } 2>/dev/null
  minted=$(cd "$SKILL_DIR" && deno run --allow-read \
    --allow-net=api.github.com --allow-env app_token.ts 2>"$errfile")
  token_rc=$?
  # Replayed regardless of exit code: non-fatal diagnostics on the success
  # path must still reach the log and the terminal.
  [[ -s "$errfile" ]] && errors <"$errfile"
  if [[ $token_rc -ne 0 ]]; then
    LAST_ERROR="reviewer App token failed: $(last_error_line "$errfile")"
    log "reviewer App token failed; skipping this pass"
    [[ $xtrace == *x* ]] && set -x
    return 1
  fi
  if [[ -n "$minted" ]]; then
    GH_TOKEN=$(jq -r .token <<<"$minted")
    export GH_TOKEN
    reviewer=("--reviewer=$(jq -r .login <<<"$minted")")
  fi
  [[ $xtrace == *x* ]] && set -x

  ready=$(cd "$SKILL_DIR" && deno run --allow-run=gh --allow-read \
    --allow-write --allow-env=HOME,XDG_STATE_HOME gate.ts \
    ${reviewer[@]+"${reviewer[@]}"} ${repo_arg[@]+"${repo_arg[@]}"} \
    2>"$errfile")
  gate_rc=$?
  # Same reasoning as the App token call above: gate.ts logs non-fatal
  # upkeep failures (rebase/auto-merge) to stderr on its success path too.
  [[ -s "$errfile" ]] && errors <"$errfile"
  if [[ $gate_rc -ne 0 ]]; then
    LAST_ERROR="gate failed: $(last_error_line "$errfile")"
    log "gate failed; skipping this pass"
    return 1
  fi
  if [[ $(jq '.ready | length' <<<"$ready" 2>/dev/null) == 0 ]]; then
    # One short line per idle pass, so the log shows the gate is running.
    log "gate: nothing ready ($(jq -r '.skipped | to_entries
      | map("\(.key) \(.value)") | join(", ")' <<<"$ready" 2>/dev/null))"
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

Follow the skill's 'Reviewing the ready PRs' section (Review, post,
learn from recurring findings, report) for the ready PRs above. Run post.ts
from $SKILL_DIR and write its input files under $dir. Skip the
PushNotification step: this session is headless. Finish with the one-line
round report."

  # `exec ... or die`: a bare exec that cannot start `claude` (not on PATH)
  # falls through and perl exits 0, which would read as a completed round.
  # `claude -p` otherwise kills its reviewer agents 600s in and ends the
  # round with their PRs unreviewed; the alarm is the round's only limit.
  (cd "$CHECKOUT" && CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 perl -e 'alarm shift; exec @ARGV or die "cannot run $ARGV[0]: $!\n"' \
    "$ROUND_TIMEOUT" \
    claude -p "$prompt" \
    --model claude-opus-5-5 --effort xhigh \
    --allowedTools "Agent" "Read" "Grep" "Glob" "Edit(/$dir/**)" \
    "Bash(deno run:*)" "Bash(gh:*)" "Bash(jq:*)" "Bash(cat:*)" \
    2>&1) | tee -a "$LOG" "$dir/claude.log"
  # The round's own status, not tee's: a killed or failed round is a failed
  # pass, so escalate_result counts it rather than seeing an ok.
  round_rc=${PIPESTATUS[0]}
  if [[ $round_rc -eq 142 ]]; then
    # 128 + SIGALRM: the alarm above killed a hung round.
    LAST_ERROR="round timed out after ${ROUND_TIMEOUT}s"
    log "round timed out after ${ROUND_TIMEOUT}s: $dir"
    return 1
  fi
  if [[ $round_rc -ne 0 ]]; then
    LAST_ERROR="round failed (exit $round_rc): $(last_error_line "$dir/claude.log")"
    log "round failed (exit $round_rc): $dir"
    return 1
  fi
  log "round done: $dir"
}

# Reports one pass's outcome (ok, or fail with its reason) to escalate.ts, so
# a persistent run of failures is noticed even with nobody watching the logs.
# Runs as the gh user, not the reviewer App: the App has no issue-comment scope.
escalate_result() {
  local rc=$1 err=$2 out erc host
  host=$(hostname -s 2>/dev/null || hostname)
  if [[ $rc -eq 0 ]]; then
    out=$(cd "$SKILL_DIR" && env -u GH_TOKEN deno run --allow-run=gh \
      --allow-read --allow-write escalate.ts --state-dir="$STATE_DIR" \
      --host="$host" --result=ok 2>"$STATE_DIR/escalate-error")
  else
    out=$(cd "$SKILL_DIR" && env -u GH_TOKEN deno run --allow-run=gh \
      --allow-read --allow-write escalate.ts --state-dir="$STATE_DIR" \
      --host="$host" --result=fail --error="$err" \
      2>"$STATE_DIR/escalate-error")
  fi
  erc=$?
  [[ -n "$out" ]] && log "$out"
  if [[ $erc -ne 0 ]]; then
    { echo "escalation failed:"; cat "$STATE_DIR/escalate-error"; } | errors
  fi
}

main() {
  local once=false
  repo_arg=()
  # The Vibe Coder's log directory, as the worker resolves it (review_log.ts).
  STATE_DIR=$(cd "$SKILL_DIR" && deno run --allow-read \
    --allow-env=HOME,XDG_STATE_HOME review_log.ts) || {
    echo "cannot resolve the log directory (see above)" >&2
    return 1
  }
  LOG="$STATE_DIR/runner.log"
  LOCK="$STATE_DIR/runner.lock"
  SERVICE_OUT="$STATE_DIR/service.out"
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
    housekeep
    pass
    local rc=$?
    escalate_result "$rc" "$LAST_ERROR"
    return $rc
  fi
  log "runner started"
  # A failed pass (GitHub unreachable, a bad token) is retried next interval
  # rather than waiting for someone to restart this by hand.
  while true; do
    housekeep
    pass
    local rc=$?
    escalate_result "$rc" "$LAST_ERROR"
    sleep "$INTERVAL"
  done
}

# Parsed in full before it runs: the worker hard-resets this checkout
# hourly, and bash would otherwise read the rewritten file mid-loop.
main "$@"
exit
