#!/usr/bin/env bash
# Interactive setup; pass --check for a non-interactive preflight.
set -euo pipefail
CHECKOUT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$CHECKOUT"
exec "${DENO_EXECUTABLE:-deno}" run --allow-all worker/deno/commands/fleet_pr_babysitter_setup.ts "$@"
