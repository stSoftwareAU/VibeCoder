#!/bin/bash

# Quality check script for auto-issue-worker
# Delegates to the Deno quality gate entry point (Issue #917).
# Falls back to running checks directly if Deno is not available.
#
# Usage:
#   ./quality.sh                      # Normal mode — parallel, skipped checks do not fail
#   ./quality.sh --strict             # Strict mode — skipped checks cause failure
#   ./quality.sh --sequential         # Force sequential execution
#   ./quality.sh --validate-prompts   # Also validate prompt template placeholders
#   QUALITY_STRICT=true ./quality.sh  # Same as --strict via env var

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export QUALITY_SCRIPT_DIR="$SCRIPT_DIR"

# Detect Deno
DENO_CMD=""
if command -v deno &>/dev/null; then
    DENO_CMD="deno"
elif [[ -x "$HOME/.deno/bin/deno" ]]; then
    DENO_CMD="$HOME/.deno/bin/deno"
elif [[ -x "/opt/homebrew/bin/deno" ]]; then
    DENO_CMD="/opt/homebrew/bin/deno"
elif [[ -x "/usr/local/bin/deno" ]]; then
    DENO_CMD="/usr/local/bin/deno"
fi

if [[ -n "$DENO_CMD" ]] && [[ -f "$SCRIPT_DIR/worker/deno/quality.ts" ]]; then
    # Delegate to Deno quality gate (Issue #917)
    # --frozen + --lock fail closed on dependency drift (Issues #2896, #3653),
    # matching setup.sh, run.sh and worker/shared/deno_bridge.sh.
    # Low scheduler priority for the whole gate (Issue #4258): the suite
    # saturates every vCPU for minutes at a stretch, and inside the
    # container that starves whatever else must stay responsive — the agent
    # driving the gate, and any heartbeat/health machinery in the runtime
    # (kill-on-unresponsive monitors exist in this ecosystem: vminitd's
    # vsock health checks; anthropics/claude-code#22715). nice is a
    # priority, not a quota: the gate still uses every idle core and only
    # yields under contention; where nice is absent the prefix is empty.
    NICE_PREFIX=()
    if command -v nice &>/dev/null; then
        NICE_PREFIX=(nice -n 10)
    fi
    # Sequential checks inside the container (Issue #4267): nice fixes CPU
    # priority only, and agent sessions were still SIGKILLed the moment
    # parallel-checks mode launched deno test, a whole-repo deno check,
    # lint, markdownlint and mermaid all at once inside the VM — a combined
    # memory/IO/process-churn spike no scheduler priority can soften. The
    # image stamp marks a container run; host/native runs keep parallel
    # mode, and an explicit --sequential from the caller is not duplicated.
    SEQUENTIAL_ARG=()
    if [[ -n "${VIBE_IMAGE_AGENT_PROVIDERS:-}" ]]; then
        SEQUENTIAL_ARG=(--sequential)
        for arg in "$@"; do
            if [[ "$arg" == "--sequential" ]]; then
                SEQUENTIAL_ARG=()
                break
            fi
        done
    fi
    exec ${NICE_PREFIX[@]+"${NICE_PREFIX[@]}"} "$DENO_CMD" run \
        --frozen --lock="$SCRIPT_DIR/worker/deno/deno.lock" \
        --allow-env --allow-read --allow-run --allow-write --allow-net \
        "$SCRIPT_DIR/worker/deno/quality.ts" "$@" \
        ${SEQUENTIAL_ARG[@]+"${SEQUENTIAL_ARG[@]}"}
else
    echo "ERROR: Deno is required but not installed"
    echo "Install with: curl -fsSL https://deno.land/install.sh | sh"
    exit 1
fi
