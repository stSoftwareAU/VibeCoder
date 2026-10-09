#!/usr/bin/env bash
# Forwarding shim (Issue #3299): the runner moved to scripts/run.sh. Hosts
# installed before the move still start this path; re-run --install to point
# the service at scripts/run.sh directly.
exec "$(dirname "${BASH_SOURCE[0]}")/scripts/run.sh" "$@"
