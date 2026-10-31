#!/usr/bin/env bash
# Run one babysitter pass; pass --watch for the five-minute loop.
set -euo pipefail
CHECKOUT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$CHECKOUT"
exec "${DENO_EXECUTABLE:-deno}" run --allow-all worker/deno/commands/fleet_pr_babysitter_supervisor.ts "$@"
