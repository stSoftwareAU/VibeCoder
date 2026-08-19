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
deno task test "${files[@]}"
