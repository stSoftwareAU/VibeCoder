#!/bin/bash
# Run one shard of the Deno test suite (Issue #4334).
#
# The full suite (~940 files) took ~5.5 of the ~7 minutes of the `validate`
# check, running serially in ONE process. Deno's --parallel is not safe here:
# ~60 test files mutate the process environment (15 swap PATH to inject stub
# binaries), and --parallel shares Deno.env across threads. Sharding by FILE
# into separate CI jobs — each its own process — is env-isolated, so the
# suite's semantics are unchanged; only the wall time shrinks.
#
# Files are sorted for a deterministic split, and every shard runs the same
# `deno task test` the local quality gate runs (Issue #2194), so the
# permission set can never drift between CI and quality_gate.ts.
#
# Usage: deno-test-shard.sh <index> <count>   (index is 0-based)
set -euo pipefail
index="${1:?shard index required}"
count="${2:?shard count required}"
cd "$(dirname "$0")/../../worker/deno"

all=()
while IFS= read -r f; do all+=("$f"); done < <(find tests -maxdepth 1 -name '*_test.ts' -type f | LC_ALL=C sort)
files=()
for i in "${!all[@]}"; do
  if (( i % count == index )); then files+=("${all[$i]}"); fi
done
echo "=== deno test shard ${index}/${count}: ${#files[@]} of ${#all[@]} files ==="
if (( ${#files[@]} == 0 )); then
  echo "shard has no files"; exit 0
fi

# Run the suite in its own session (PR #498 CI).
#
# Several tests drive the worker's process-tree killer against real stub
# agents, so real signals are sent during the run. On a GitHub-hosted runner
# the step's shell, `deno test` and the runner service itself all sit in ONE
# process group, so any signal that escapes the agent's own tree lands on the
# runner: `validate (tests 4/4)` died that way four times, at the instant of a
# stub kill, with "The runner has received a shutdown signal".
#
# No test may fire a process-GROUP signal any more (see CODING-STANDARDS.md,
# "Never fire a real process-group signal from a test"), which is the actual
# fix. This session is the belt to that braces: a new session puts the whole
# suite outside the runner's group, so the blast radius of anything a future
# test sends is the suite itself. `--wait` keeps the exit status, so a failing
# shard still fails the job. No silent fallback: a missing `setsid` fails loud
# rather than quietly running without containment. The trade is that a
# cancelled job can no longer reach the tests with a group signal either; the
# hosted VM is discarded at the end of the job, so nothing outlives it.
if ! command -v setsid > /dev/null 2>&1; then
  echo "setsid is required to isolate the test session from the CI runner" >&2
  exit 127
fi
exec setsid --wait deno task test "${files[@]}"
