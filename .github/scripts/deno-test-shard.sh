#!/bin/bash
# Run one shard of the Deno UNIT suite (Issue #4334, PR #1170).
#
# The full suite (~1,260 files) took ~5.5 of the ~7 minutes of the `validate`
# check, running serially in ONE process. Sharding by FILE into separate CI
# jobs — each its own process — shrinks the wall time without changing what
# any test sees.
#
# What the shard runs is NOT "every file in tests/". PR #1170: this script
# built its own list with `find`, so the gate that decides a merge ran a
# different suite from `deno task test:unit`, over a different scope.
#
#   * The 27 integration suites (INTEGRATION_TEST_FILES, #907) were in the
#     merge gate. They copy the repository's own `.sh`/`.ps1` into a temp
#     tree and spawn `bash` or `pwsh` — which is why every shard job had to
#     install PowerShell before it could start — and they are excluded from
#     every quality run for exactly that cost. They now run in the
#     `integration tests` job, which is not a required check.
#   * The 42 files in PARALLEL_UNSAFE_TEST_FILES (#880, #940) ran in the same
#     invocation as everything else. They are listed because they mutate
#     process state, measure a real elapsed reading, or race a real
#     subprocess, so they get their own serial invocation here — the same
#     split `lib/unit_test_passes.ts` builds for the gate.
#
# The split is not restated here. `test_shard_files.ts` prints it from the two
# manifests, so this script and `deno task test:unit` cannot disagree about
# what a unit test is. Every pass runs the same `deno task test` the local
# quality gate runs (Issue #2194), so the permission set can never drift
# between CI and quality_gate.ts.
#
# Usage: deno-test-shard.sh <index> <count>   (index is 0-based)
set -euo pipefail
index="${1:?shard index required}"
count="${2:?shard count required}"
script="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# Run the shard in its own session (PR #498 CI).
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
# shard outside the runner's group, so the blast radius of anything a future
# test sends is the shard itself. `--wait` keeps the exit status, so a failing
# shard still fails the job. No silent fallback: a missing `setsid` fails loud
# rather than quietly running without containment. The trade is that a
# cancelled job can no longer reach the tests with a group signal either; the
# hosted VM is discarded at the end of the job, so nothing outlives it.
#
# The re-exec is what puts BOTH passes inside one session. `exec setsid` on a
# single `deno test` could not, and a second invocation outside the session
# would be the containment hole this exists to close.
if [[ "${VIBE_DENO_SHARD_SESSION:-}" != "1" ]]; then
  if ! command -v setsid > /dev/null 2>&1; then
    echo "setsid is required to isolate the test session from the CI runner" >&2
    exit 127
  fi
  export VIBE_DENO_SHARD_SESSION=1
  exec setsid --wait "$script" "$index" "$count"
fi

cd "$(dirname "$script")/../../worker/deno"

# A file, not a pipeline: `set -e` cannot see a process substitution fail, and
# a plan that failed to generate would look exactly like an empty shard.
plan="$(mktemp -t deno-test-shard.XXXXXX)"
trap 'rm -f "$plan"' EXIT
deno run --frozen --lock=deno.lock --allow-read test_shard_files.ts \
  "$index" "$count" > "$plan"

parallel_files=()
serial_files=()
integration_files=()
while IFS=$'\t' read -r pass file; do
  [[ -z "$pass" ]] && continue
  case "$pass" in
    parallel) parallel_files+=("$file") ;;
    serial) serial_files+=("$file") ;;
    integration) integration_files+=("$file") ;;
    *)
      echo "test_shard_files.ts named an unknown pass: $pass" >&2
      exit 1
      ;;
  esac
done < "$plan"

echo "=== deno unit test shard ${index}/${count}:" \
  "${#parallel_files[@]} parallel + ${#serial_files[@]} serial ==="
echo "=== ${#integration_files[@]} integration suites are excluded here and" \
  "run in the 'integration tests' job (CODING-STANDARDS.md, #907) ==="

if (( ${#parallel_files[@]} > 0 )); then
  echo "--- parallel pass: ${#parallel_files[@]} files"
  deno task test --parallel ${parallel_files[@]+"${parallel_files[@]}"}
fi

# No --parallel: these are the files that cannot share a process. Sharding is
# still safe, because each shard is a separate job on a separate machine.
if (( ${#serial_files[@]} > 0 )); then
  echo "--- serial pass: ${#serial_files[@]} files"
  deno task test ${serial_files[@]+"${serial_files[@]}"}
fi

if (( ${#parallel_files[@]} == 0 && ${#serial_files[@]} == 0 )); then
  echo "shard has no files"
fi
