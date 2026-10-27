#!/usr/bin/env bash
# Runs the review-fleet-prs skill unattended, for ever, on an always-on host.
#
# Every 5 minutes it runs one gate pass (a GitHub search, no model). Each
# ready PR gets its own headless Claude round, in the Vibe Coder's worker
# container, with up to `pr_reviewer_parallel` (.config.json, default 3)
# rounds running at once, so a quick review posts without waiting for a slow
# one (Issue #4395). A slot that frees is filled at the next 30-second tick
# rather than after the full interval (Issue #4396). Learning from recurring
# findings runs in its own round, at most hourly and only after new
# send-backs (Issue #4397). An idle night still costs no tokens. With
# `pr_reviewer_app` in .config.json, reviews post as that GitHub App (see
# app_token.ts).
#
# Several hosts may run this at once (Issue #4398): each ready PR is claimed on
# GitHub before its round starts, and the claim is released when the round is
# over, so only one host reviews a PR at a time. runner.lock still guards one
# runner per machine; the claim guards one reviewer per PR across hosts.
#
#   run.sh [owner/name]           # loop for ever (all repos, or one)
#   run.sh --once [owner/name]    # one pass: gate, its rounds, then learning
#                                 # if due; waits for them all
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

SCRIPTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=$(cd "$SCRIPTS_DIR/../../../.." && pwd)
# The env overrides exist only so the tests need not wait minutes.
INTERVAL=${REVIEW_FLEET_PRS_INTERVAL:-300}
# How often the loop wakes to collect finished rounds and fill a freed slot.
TICK=${REVIEW_FLEET_PRS_TICK:-30}
LEARN_INTERVAL=${REVIEW_FLEET_PRS_LEARN_INTERVAL:-3600}
CONFIG=${REVIEW_FLEET_PRS_CONFIG:-$CHECKOUT/.config.json}
DEFAULT_PARALLEL=3
# A hung round must not wedge the loop, nor outlive its token. Overridable
# only so the tests can time a round out without waiting 50 minutes.
ROUND_TIMEOUT=${REVIEW_FLEET_PRS_ROUND_TIMEOUT:-3000}
# The longest lease claim.ts accepts (its MAX_CLAIM_SECONDS), so a longer round
# timeout still claims: the lease is the smaller of the two (Issue #4398).
MAX_CLAIM_TTL=7200
LABEL="au.com.stsoftware.review-fleet-prs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
# A step's stderr goes to the log and the terminal, so its reason is seen.
errors() { tee -a "$LOG" >&2; }
# The last non-blank line of a captured stderr file: a one-line failure gist.
last_error_line() { grep -v '^$' "$1" 2>/dev/null | tail -n1; }
# This host's name in its claims: short, and only characters a claim may
# carry (Issue #4398).
host_name() {
  local h
  h=$(hostname -s 2>/dev/null || hostname)
  printf '%s\n' "$h" | tr -c 'A-Za-z0-9._\n' '-'
}

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
  local args=("$SCRIPTS_DIR/run.sh" "$@")
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

# The container a round runs in (Issue #3293): the worker's own launch plan
# (mod.ts container-launch-plan, the module run.sh at the checkout root
# executes), so the round gets the worker image, its credential mounts and the
# entrypoint's staging, and the driver's own Claude credential pool picks the
# subscription and rotates past a spent one. Two changes to the worker's run:
# its named volumes are left out, because the worker's container may hold
# them and a round needs none of its durable state; and the reviewer App token
# is passed by name alone (`--env GH_TOKEN`), so its value is never on a
# command line, in a trace or on disk. Sets RUNTIME, ROUND_ARGS (everything up
# to and including the image), C_BASE (the checkout inside the container) and
# C_STATE_DIR (this state directory inside it). Returns non-zero, with
# LAST_ERROR set, when the plan or the image is not usable.
round_container() {
  local name=$1 planfile token key value i arg src
  local exists_args=() ensure_dirs=() volumes=() run_args=()
  planfile="$STATE_DIR/round-plan"
  RUNTIME="" ROUND_ARGS=() C_BASE="" C_STATE_DIR=""
  if ! (cd "$CHECKOUT" && deno run --frozen --lock=worker/deno/deno.lock \
    --allow-env --allow-read --allow-run \
    --allow-sys=hostname,systemMemoryInfo \
    --allow-write="$planfile,$planfile.Containerfile,$HOME/.vibe-coder/run-config" \
    worker/deno/mod.ts container-launch-plan --base-dir "$CHECKOUT" \
    --container-name "$name" --out "$planfile" </dev/null >"$errfile" \
    2>&1); then
    errors <"$errfile"
    LAST_ERROR="worker container plan failed: $(last_error_line "$errfile")"
    return 1
  fi
  while IFS= read -r -d '' token; do
    key="${token%%=*}"
    value="${token#*=}"
    case "$key" in
    runtime) RUNTIME=$value ;;
    exists) exists_args+=("$value") ;;
    ensure) ensure_dirs+=("$value") ;;
    volume | volume-resettable) volumes+=("$value") ;;
    run) run_args+=("$value") ;;
    esac
  done <"$planfile"
  if [[ -z $RUNTIME || ${#run_args[@]} -eq 0 || ${#exists_args[@]} -eq 0 ]]; then
    LAST_ERROR="worker container plan is incomplete"
    return 1
  fi
  if ! command -v "$RUNTIME" >/dev/null; then
    LAST_ERROR="cannot run $RUNTIME: the container runtime is not on PATH"
    return 1
  fi
  if ! "$RUNTIME" "${exists_args[@]}" >/dev/null 2>&1; then
    LAST_ERROR="the worker image is not built; start the Vibe Coder (./run.sh) once to build it"
    return 1
  fi
  for arg in ${ensure_dirs[@]+"${ensure_dirs[@]}"}; do mkdir -p "$arg"; done
  # The plan's last argument is the image; the round's own go after it.
  for ((i = 0; i < ${#run_args[@]} - 1; i++)); do
    arg=${run_args[i]}
    if [[ $arg == --volume ]]; then
      src=${run_args[i + 1]%%:*}
      if [[ " ${volumes[*]} " == *" $src "* ]]; then
        i=$((i + 1))
        continue
      fi
      # The log directory's mount carries this state directory.
      if [[ $src == "$(dirname "$STATE_DIR")" ]]; then
        value=${run_args[i + 1]#*:}
        C_STATE_DIR="${value%%:*}/$(basename "$STATE_DIR")"
      fi
    fi
    [[ $i -gt 0 && ${run_args[i - 1]} == --workdir ]] && C_BASE=$arg
    ROUND_ARGS+=("$arg")
  done
  if [[ -z $C_STATE_DIR || -z $C_BASE ]]; then
    LAST_ERROR="the worker container does not mount $STATE_DIR"
    return 1
  fi
  # Tested by name, not value: `bash -x` would print the value.
  [[ -n ${GH_TOKEN+set} ]] && ROUND_ARGS+=(--env GH_TOKEN)
  ROUND_ARGS+=("${run_args[${#run_args[@]} - 1]}")
  return 0
}

# One headless Claude round in the worker container, logged to $1.
#
# `exec ... or die`: a bare exec that cannot start the runtime (not on PATH)
# falls through and perl exits 0, which would read as a completed round. The
# alarm is the round's only limit; it kills the runtime's client, so the
# container itself is then killed by name.
run_round() {
  local log=$1 tag=$2 rc claude_args
  # stream-json: the round's own result carries its per-model usage, which
  # price_round turns into each review's cost; the driver keeps the full
  # stream in the round's directory and logs only its readable lines.
  claude_args=$(jq -nc --arg edit "Edit(/$C_DIR/**)" '["--model",
    "claude-opus-5-5", "--effort", "xhigh", "--output-format", "stream-json",
    "--verbose", "--allowedTools", "Agent",
    "Read", "Grep", "Glob", $edit, "Bash(deno run:*)", "Bash(gh:*)",
    "Bash(jq:*)", "Bash(cat:*)"]')
  perl -e 'alarm shift; exec @ARGV or die "cannot run $ARGV[0]: $!\n"' \
    "$ROUND_TIMEOUT" "$RUNTIME" "${ROUND_ARGS[@]}" review-round \
    --prompt-file "$C_DIR/prompt.md" --claude-args "$claude_args" \
    2>&1 | tee -a "$log" |
    TAG=$tag perl -ne '$|=1; print "[$ENV{TAG}] $_"' | tee -a "$LOG"
  # The round's own status, not tee's: a killed or failed round is a failed
  # pass, so escalate_result counts it rather than seeing an ok. Rounds run
  # side by side, so each line in runner.log is tagged with its PR.
  rc=${PIPESTATUS[0]}
  [[ $rc -eq 142 ]] && "$RUNTIME" kill "$ROUND_NAME" >/dev/null 2>&1
  return "$rc"
}

# Adds each review the round posted its share of the round's estimated cost
# (review_cost.ts), now the round's own result says what it used. Runs after
# every round, as the reviewer App that posted the reviews; a review it
# cannot price or update keeps "cost unknown", and never fails the pass.
price_round() {
  local dir=$1 out
  out=$(cd "$SCRIPTS_DIR" && deno run --allow-run=gh --allow-read --allow-write \
    review_cost.ts --round-dir="$dir" 2>"$dir/price-error")
  [[ -s "$dir/price-error" ]] && errors <"$dir/price-error"
  [[ -n "$out" ]] && log "round cost: $out"
  return 0
}

# Gives a PR's claim back, so another host may review it (Issue #4398). Best
# effort: a failure is logged and changes nothing else. Bounded by an alarm,
# since stop_rounds calls it from the EXIT trap. Skipped without a host name.
release_claim() {
  local repo=$1 number=$2 err rc reason
  [[ -n ${HOST_NAME:-} ]] || return 0
  err=$(cd "$SCRIPTS_DIR" && perl -e 'alarm shift; exec @ARGV or die "cannot run $ARGV[0]: $!\n"' \
    30 deno run --allow-run=gh claim.ts release --repo="$repo" \
    --number="$number" --host="$HOST_NAME" 2>&1 >/dev/null)
  rc=$?
  if [[ $rc -ne 0 ]]; then
    reason=$(printf '%s\n' "$err" | grep -v '^$' | tail -n1)
    log "$repo#$number: could not release the claim: ${reason:-exit $rc}"
  fi
  return 0
}

# The pool of rounds running in the background: one entry per round, by
# index. Plain indexed arrays, since macOS's /bin/bash is 3.2.
POOL_PIDS=() POOL_KEYS=() POOL_DIRS=() POOL_NAMES=()
REAPED_OK=0 REAPED_ERRORS=()

# How many rounds may run at once: `pr_reviewer_parallel` in .config.json.
parallel_setting() {
  local v
  v=$(jq -r '.pr_reviewer_parallel // empty' "$CONFIG" 2>/dev/null)
  if [[ -z $v ]]; then
    echo "$DEFAULT_PARALLEL"
  elif [[ $v =~ ^[1-9][0-9]*$ ]]; then
    echo "$v"
  else
    log "pr_reviewer_parallel must be a whole number above 0, not '$v';" \
      "using $DEFAULT_PARALLEL" >&2
    echo "$DEFAULT_PARALLEL"
  fi
}

# The PRs (owner/name#n) in a round right now, comma-separated, for the gate.
in_flight_list() {
  local i out=""
  for ((i = 0; i < ${#POOL_KEYS[@]}; i++)); do
    [[ ${POOL_KEYS[i]} == *#* ]] && out+="${out:+,}${POOL_KEYS[i]}"
  done
  echo "$out"
}

in_flight() {
  local i
  for ((i = 0; i < ${#POOL_KEYS[@]}; i++)); do
    [[ ${POOL_KEYS[i]} == "$1" ]] && return 0
  done
  return 1
}

# One round in the background (a subshell): run it, price it, and leave its
# outcome in its directory for reap. $3 is "review" or "learn".
round_job() {
  local dir=$1 key=$2 kind=$3 rc err=""
  run_round "$dir/claude.log" "$key"
  rc=$?
  if [[ $kind == review ]]; then
    price_round "$dir"
    # Whatever the round's outcome, its PR is free for another host (Issue #4398).
    release_claim "${key%#*}" "${key##*#}"
  fi
  if [[ $rc -eq 142 ]]; then
    # 128 + SIGALRM: the alarm killed a hung round.
    err="round timed out after ${ROUND_TIMEOUT}s"
    log "$key: round timed out after ${ROUND_TIMEOUT}s: $dir"
  elif [[ $rc -ne 0 ]]; then
    err="round failed (exit $rc): $(last_error_line "$dir/claude.log")"
    log "$key: round failed (exit $rc): $dir"
  else
    log "$key: round done: $dir"
    # A learning round that finished has covered these log lines.
    [[ $kind == learn ]] && echo "$LEARN_UPTO" >"$STATE_DIR/learned-lines"
  fi
  printf '%s' "$err" >"$dir/error"
  echo "$rc" >"$dir/rc"
  return "$rc"
}

# Starts the round whose container, directory and prompt are ready.
launch() {
  local key=$1 dir=$2 kind=$3
  (
    trap - EXIT INT TERM
    round_job "$dir" "$key" "$kind"
  ) &
  POOL_PIDS+=("$!")
  POOL_KEYS+=("$key")
  POOL_DIRS+=("$dir")
  POOL_NAMES+=("$ROUND_NAME")
}

# Collects the rounds that have finished: REAPED_OK counts the ones that
# succeeded, REAPED_ERRORS holds a one-line reason for each that failed.
reap() {
  local i rc err pids=() keys=() dirs=() names=()
  REAPED_OK=0 REAPED_ERRORS=()
  for ((i = 0; i < ${#POOL_PIDS[@]}; i++)); do
    if [[ ! -f ${POOL_DIRS[i]}/rc ]] && kill -0 "${POOL_PIDS[i]}" 2>/dev/null; then
      pids+=("${POOL_PIDS[i]}") keys+=("${POOL_KEYS[i]}")
      dirs+=("${POOL_DIRS[i]}") names+=("${POOL_NAMES[i]}")
      continue
    fi
    wait "${POOL_PIDS[i]}" 2>/dev/null
    rc=$(cat "${POOL_DIRS[i]}/rc" 2>/dev/null || echo 1)
    if [[ $rc == 0 ]]; then
      REAPED_OK=$((REAPED_OK + 1))
    else
      # No PR name: an escalation lands in the public VibeCoder repo, and
      # the PR may be in a private one. runner.log names it.
      err=$(cat "${POOL_DIRS[i]}/error" 2>/dev/null)
      REAPED_ERRORS+=("${err:-round failed (exit $rc)}")
    fi
  done
  POOL_PIDS=(${pids[@]+"${pids[@]}"}) POOL_KEYS=(${keys[@]+"${keys[@]}"})
  POOL_DIRS=(${dirs[@]+"${dirs[@]}"}) POOL_NAMES=(${names[@]+"${names[@]}"})
}

# On exit, a round left running would be started again by the next runner.
# shellcheck disable=SC2329 # invoked from the EXIT trap
stop_rounds() {
  local i
  for ((i = 0; i < ${#POOL_PIDS[@]}; i++)); do
    kill "${POOL_PIDS[i]}" 2>/dev/null
    [[ -n ${RUNTIME:-} ]] && "$RUNTIME" kill "${POOL_NAMES[i]}" >/dev/null 2>&1
  done
  # A round stopped here never reaches its own release (Issue #4398).
  for ((i = 0; i < ${#POOL_KEYS[@]}; i++)); do
    if [[ ${POOL_KEYS[i]} == *#* ]]; then
      release_claim "${POOL_KEYS[i]%#*}" "${POOL_KEYS[i]##*#}"
    fi
  done
}

# Mints the reviewer App token for this pass, when one is configured: sets
# GH_TOKEN and REVIEWER. Its token lasts an hour, so every gate pass mints a
# fresh one, and each round keeps the token it started with (a round is cut
# off at 50 minutes); a failure skips the pass rather than post as the gh
# user instead.
mint_token() {
  local minted token_rc
  REVIEWER=()
  unset GH_TOKEN
  # The minted token must never appear under `bash -x`: xtrace is suspended
  # from here until the App's login has been extracted from it.
  { local xtrace=$-; set +x; } 2>/dev/null
  minted=$(cd "$SCRIPTS_DIR" && deno run --allow-read \
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
    REVIEWER=("--reviewer=$(jq -r .login <<<"$minted")")
  fi
  [[ $xtrace == *x* ]] && set -x
  return 0
}

# One gate pass with room for $1 new rounds: posts any audit send-backs, then
# starts a round for each ready PR. Returns non-zero, with LAST_ERROR set,
# when the App token, the gate or starting a round failed. Sets OVER_LIMIT
# to the number of PRs left waiting for a slot.
gate_pass() {
  local free=$1 ready entry input errfile gate_rc in_flight_arg=() rc=0
  local list
  LAST_ERROR="" OVER_LIMIT=0
  errfile="$STATE_DIR/last-error"
  mint_token || return 1
  list=$(in_flight_list)
  [[ -n $list ]] && in_flight_arg=("--in-flight=$list")

  ready=$(cd "$SCRIPTS_DIR" && deno run --allow-run=gh --allow-read \
    --allow-write --allow-env=HOME,XDG_STATE_HOME gate.ts --limit="$free" \
    --host="$HOST_NAME" ${REVIEWER[@]+"${REVIEWER[@]}"} ${repo_arg[@]+"${repo_arg[@]}"} \
    ${in_flight_arg[@]+"${in_flight_arg[@]}"} 2>"$errfile")
  gate_rc=$?
  # Same reasoning as the App token call: gate.ts logs non-fatal upkeep
  # failures (rebase/auto-merge) to stderr on its success path too.
  [[ -s "$errfile" ]] && errors <"$errfile"
  if [[ $gate_rc -ne 0 ]]; then
    LAST_ERROR="gate failed: $(last_error_line "$errfile")"
    log "gate failed; skipping this pass"
    return 1
  fi
  # Issue #3142: a red dependency audit CI-fix could not clear is sent back
  # with the gate's ready-made review; post.ts posts it, no model round.
  input="$STATE_DIR/audit-blocked.json"
  while IFS= read -r entry; do
    jq -c '{pr: del(.review), review}' <<<"$entry" >"$input"
    log "audit send-back: $(jq -r '"\(.repo)#\(.number)"' <<<"$entry"): $(
      cd "$SCRIPTS_DIR" && deno run --allow-run=gh,osascript --allow-read \
        --allow-write --allow-env=HOME,XDG_STATE_HOME post.ts \
        --input="$input" --no-model 2>&1)"
  done < <(jq -c '.auditBlocked[]?' <<<"$ready" 2>/dev/null)
  OVER_LIMIT=$(jq -r '.skipped["over-limit"] // 0' <<<"$ready" 2>/dev/null)
  [[ $OVER_LIMIT =~ ^[0-9]+$ ]] || OVER_LIMIT=0
  if [[ $(jq '.ready | length' <<<"$ready" 2>/dev/null) == 0 ]]; then
    # One short line per idle pass, so the log shows the gate is running.
    log "gate: nothing ready ($(jq -r '.skipped | to_entries
      | map("\(.key) \(.value)") | join(", ")' <<<"$ready" 2>/dev/null))"
    return 0
  fi
  log "gate: $(jq -r '[.ready[] | "\(.repo)#\(.number)"] | join(", ")' \
    <<<"$ready" 2>/dev/null || echo "$ready")"
  while IFS= read -r entry; do
    if ! start_review "$entry"; then
      LAST_ERROR="${LAST_ERROR:+$LAST_ERROR; }$ROUND_ERROR"
      rc=1
    fi
  done < <(jq -c '.ready[]' <<<"$ready" 2>/dev/null)
  return "$rc"
}

# A round's directory: the time it started plus what it is for, so rounds
# started in the same second never share one (or a container name).
round_dir() {
  echo "$STATE_DIR/rounds/$(date '+%Y%m%d-%H%M%S')-${1//[^A-Za-z0-9_.-]/-}"
}

# The container name for the round in directory $1 (Issue #4409). The runtime
# takes at most 64 characters and the egress launch adds `-proxy`, so a name
# past 58 keeps its readable start and ends in a hash of the whole, which
# keeps two rounds' names apart.
round_name() {
  local name hash
  name="review-fleet-prs-$(basename "$1")"
  if [[ ${#name} -gt 58 ]]; then
    hash=$(printf '%s' "$name" | cksum | cut -d' ' -f1)
    name="${name:0:$((57 - ${#hash}))}-$hash"
  fi
  printf '%s\n' "$name"
}

# Starts one round for one ready PR (a gate entry). Returns non-zero, with
# ROUND_ERROR set, when its claim or its container cannot be made. A PR another
# host has claimed gets no round and no error (Issue #4398).
start_review() {
  local entry=$1 key dir repo number sha claim_json claim_rc won
  local errfile="$STATE_DIR/last-error"
  ROUND_ERROR=""
  key=$(jq -r '"\(.repo)#\(.number)"' <<<"$entry")
  # Belt and braces: the gate already skips a PR given in --in-flight.
  if in_flight "$key"; then
    log "$key: already in a round; not started twice"
    return 0
  fi
  repo=$(jq -r .repo <<<"$entry")
  number=$(jq -r .number <<<"$entry")
  sha=$(jq -r .headSha <<<"$entry")
  # Claimed before any round work, so only one host reviews this PR (Issue
  # #4398). A failed claim is an error: the round is not started.
  claim_ttl=$((ROUND_TIMEOUT < MAX_CLAIM_TTL ? ROUND_TIMEOUT : MAX_CLAIM_TTL))
  claim_json=$(cd "$SCRIPTS_DIR" && deno run --allow-run=gh claim.ts claim \
    --repo="$repo" --number="$number" --sha="$sha" --host="$HOST_NAME" \
    --ttl="$claim_ttl" 2>"$errfile")
  claim_rc=$?
  [[ -s "$errfile" ]] && errors <"$errfile"
  if [[ $claim_rc -ne 0 ]]; then
    ROUND_ERROR="claim failed: $(last_error_line "$errfile")"
    log "$key: round not started: $ROUND_ERROR"
    return 1
  fi
  won=$(jq -r 'if (.won | type) == "boolean" then (.won | tostring) else "malformed" end' \
    <<<"$claim_json" 2>/dev/null)
  case $won in
  true) ;;
  false)
    log "$key: claimed by another host; not started"
    return 0
    ;;
  *)
    ROUND_ERROR="claim failed: malformed claim output"
    log "$key: round not started: $ROUND_ERROR"
    return 1
    ;;
  esac
  dir=$(round_dir "$(jq -r '"\(.repo)-\(.number)"' <<<"$entry")")
  mkdir -p "$dir"
  jq -c '{ready: [.]}' <<<"$entry" >"$dir/gate.json"
  ROUND_NAME=$(round_name "$dir")
  if ! round_container "$ROUND_NAME"; then
    ROUND_ERROR="$LAST_ERROR"
    log "$key: round not started: $ROUND_ERROR"
    release_claim "$repo" "$number"
    return 1
  fi
  C_DIR="$C_STATE_DIR/rounds/$(basename "$dir")"
  # The round runs in the container, so every path it is given is the
  # container's; the prompt is a file in the round's own directory.
  cat >"$dir/prompt.md" <<PROMPT
Use the review-fleet-prs skill to review ONE round, then stop.
The gate has already run for you; do NOT start gate.ts or the loop.
Its output is:

$(cat "$dir/gate.json")

Follow the skill's 'Reviewing the ready PRs' section for the ready PR above:
steps 1. Review, 2. Post and 4. Report. Skip step 3 (Learn from recurring
findings): the runner does that in a round of its own. Run post.ts from
$C_BASE/.claude/skills/review-fleet-prs/scripts with --state-dir=$C_STATE_DIR,
and write its input files directly in $C_DIR (not a sub-directory: post.ts
reads the round's attempt log beside its input). Skip the PushNotification step: this
session is headless. Finish with the one-line round report.
PROMPT
  log "$key: round started: $dir"
  launch "$key" "$dir" review
}

# Whether a learning round is due: reviews were sent back since the last one
# (records in log.jsonl after the line in learned-lines). Sets LEARN_FROM and
# LEARN_UPTO, the log lines it should cover.
learn_due() {
  local logf="$STATE_DIR/log.jsonl" total covered sent
  [[ -f $logf ]] || return 1
  total=$(wc -l <"$logf" | tr -d ' ')
  covered=$(cat "$STATE_DIR/learned-lines" 2>/dev/null)
  [[ $covered =~ ^[0-9]+$ ]] || covered=$total
  # The log was trimmed or replaced: start again from its top.
  [[ $covered -gt $total ]] && covered=0
  sent=$(tail -n +"$((covered + 1))" "$logf" |
    jq -c 'select(.outcome == "changes_requested")' 2>/dev/null | wc -l |
    tr -d ' ')
  [[ $sent -gt 0 ]] || return 1
  LEARN_FROM=$covered LEARN_UPTO=$total
}

# Starts the round that learns from recurring findings (the skill's step 3),
# which review rounds no longer do (Issue #4397). Returns non-zero, with
# ROUND_ERROR set, when its container cannot be started.
start_learn() {
  local dir errfile="$STATE_DIR/last-error"
  ROUND_ERROR=""
  dir=$(round_dir learn)
  mkdir -p "$dir"
  ROUND_NAME=$(round_name "$dir")
  if ! round_container "$ROUND_NAME"; then
    ROUND_ERROR="learning $LAST_ERROR"
    log "learn: round not started: $LAST_ERROR"
    return 1
  fi
  C_DIR="$C_STATE_DIR/rounds/$(basename "$dir")"
  cat >"$dir/prompt.md" <<PROMPT
Use the review-fleet-prs skill's step '3. Learn from recurring findings',
and only that step, then stop. Do NOT start gate.ts, and do not review or
post any PR: the review rounds have already posted their reviews.

The reviews to learn from are the records after line $LEARN_FROM of
$C_STATE_DIR/log.jsonl (lines $((LEARN_FROM + 1)) to $LEARN_UPTO); compare
them with the earlier records as the step says. Run guidance.ts from
$C_BASE/.claude/skills/review-fleet-prs/scripts with --state-dir=$C_STATE_DIR,
and write any files you need directly in $C_DIR. Skip the PushNotification
step: this session is headless. Finish with one line naming any issues filed
and any recurring guidance entries from guidance.ts due, or saying there was
nothing to learn.
PROMPT
  log "learn: round started for log.jsonl lines $((LEARN_FROM + 1))-$LEARN_UPTO: $dir"
  launch learn "$dir" learn
}

# Reports one pass's outcome (ok, or fail with its reason) to escalate.ts, so
# a persistent run of failures is noticed even with nobody watching the logs.
# Runs as the gh user, not the reviewer App: the App has no issue-comment scope.
escalate_result() {
  local rc=$1 err=$2 out erc host
  host=$(hostname -s 2>/dev/null || hostname)
  if [[ $rc -eq 0 ]]; then
    out=$(cd "$SCRIPTS_DIR" && env -u GH_TOKEN deno run --allow-run=gh \
      --allow-read --allow-write escalate.ts --state-dir="$STATE_DIR" \
      --host="$host" --result=ok 2>"$STATE_DIR/escalate-error")
  else
    out=$(cd "$SCRIPTS_DIR" && env -u GH_TOKEN deno run --allow-run=gh \
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

# Reports one tick's errors (none means ok) to escalate_result.
report() {
  local IFS='|' joined
  if [[ $# -eq 0 ]]; then
    escalate_result 0 ""
    return 0
  fi
  joined="$*"
  escalate_result 1 "${joined//|/; }"
  return 1
}

# Waits for every round in the pool, collecting their failures in ERRS.
drain() {
  while [[ ${#POOL_PIDS[@]} -gt 0 ]]; do
    sleep 1
    reap
    ERRS+=(${REAPED_ERRORS[@]+"${REAPED_ERRORS[@]}"})
  done
}

main() {
  local once=false parallel free now last_gate=0 last_learn=0 regate=false
  local did
  repo_arg=()
  # The Vibe Coder's log directory, as the worker resolves it (review_log.ts).
  STATE_DIR=$(cd "$SCRIPTS_DIR" && deno run --allow-read \
    --allow-env=HOME,XDG_STATE_HOME review_log.ts) || {
    echo "cannot resolve the log directory (see above)" >&2
    return 1
  }
  LOG="$STATE_DIR/runner.log"
  LOCK="$STATE_DIR/runner.lock"
  SERVICE_OUT="$STATE_DIR/service.out"
  HOST_NAME=$(host_name)
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
  # One runner per machine: two would start rounds for the same PRs.
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
  trap 'stop_rounds; rm -rf "$LOCK"' EXIT
  # So a service stop still runs the EXIT trap and stops its rounds.
  trap 'exit 143' TERM
  trap 'exit 130' INT
  parallel=$(parallel_setting)
  # A first start learns only from reviews posted from now on, not the whole
  # history (which earlier rounds already learned from).
  [[ -f $STATE_DIR/learned-lines || ! -f $STATE_DIR/log.jsonl ]] ||
    wc -l <"$STATE_DIR/log.jsonl" | tr -d ' ' >"$STATE_DIR/learned-lines"

  if [[ $once == true ]]; then
    ERRS=()
    housekeep
    gate_pass "$parallel" || ERRS+=("$LAST_ERROR")
    drain
    if learn_due; then
      start_learn || ERRS+=("$ROUND_ERROR")
      drain
    fi
    report ${ERRS[@]+"${ERRS[@]}"}
    return
  fi
  log "runner started (up to $parallel rounds at once)"
  # Each tick collects finished rounds. The gate runs every INTERVAL, and
  # straight away when a round has just succeeded or PRs were left waiting
  # for a slot, so a freed slot is not left empty for minutes. A failed round
  # waits for the interval, so a PR that keeps failing is not retried hot.
  # A failed pass (GitHub unreachable, a bad token) is retried the same way
  # rather than waiting for someone to restart this by hand.
  while true; do
    ERRS=()
    did=false
    reap
    if [[ $REAPED_OK -gt 0 || ${#REAPED_ERRORS[@]} -gt 0 ]]; then
      did=true
      ERRS+=(${REAPED_ERRORS[@]+"${REAPED_ERRORS[@]}"})
    fi
    [[ $REAPED_OK -gt 0 ]] && regate=true
    now=$(date +%s)
    free=$((parallel - ${#POOL_PIDS[@]}))
    if [[ $((now - last_gate)) -ge $INTERVAL ]] ||
      [[ $regate == true && $free -gt 0 ]]; then
      did=true
      last_gate=$now
      housekeep
      if gate_pass "$free"; then
        # PRs still waiting: come back as soon as a slot frees.
        [[ $OVER_LIMIT -gt 0 ]] && regate=true || regate=false
      else
        ERRS+=("$LAST_ERROR")
        regate=false
      fi
    fi
    free=$((parallel - ${#POOL_PIDS[@]}))
    if [[ $free -gt 0 && $((now - last_learn)) -ge $LEARN_INTERVAL ]] &&
      learn_due; then
      did=true
      last_learn=$now
      start_learn || ERRS+=("$ROUND_ERROR")
    fi
    [[ $did == true ]] && report ${ERRS[@]+"${ERRS[@]}"}
    sleep "$TICK"
  done
}

# Parsed in full before it runs: the worker hard-resets this checkout
# hourly, and bash would otherwise read the rewritten file mid-loop.
main "$@"
exit
