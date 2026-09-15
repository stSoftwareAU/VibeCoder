#!/usr/bin/env bash
#
# The aggregate gate for the Quality workflow.
#
# GitHub reports a required check that never ran as satisfied, so a job
# disabled by an `if:`, cancelled mid-run, or deleted from the workflow would
# otherwise leave a green pull request that nothing inspected. This script is
# the one required check: it reads the `needs` context and exits non-zero
# unless every job it depends on reported exactly `success`.
#
# `failure`, `cancelled` and `skipped` all close the gate, and so does a
# `needs` context that is empty, unparseable, or carries a job with no
# `result` — an unread result is never reported as a passed one.
#
# Cross-platform: POSIX-compatible constructs only, so it runs on macOS
# (bash 3.2), Ubuntu and AWS Linux.
set -euo pipefail

# Populated from `toJSON(needs)` by the workflow.
needs_json="${NEEDS_JSON:-}"

if ! command -v jq > /dev/null 2>&1; then
    printf 'error: jq is required to read the needs context but was not found.\n' >&2
    printf 'install it with: brew install jq, apt-get install jq or dnf install jq\n' >&2
    printf '(GitHub-hosted runners have it preinstalled)\n' >&2
    exit 1
fi

# `[ -z ]` after stripping whitespace: a blank context is not an empty pass.
if [ -z "$(printf '%s' "$needs_json" | tr -d '[:space:]')" ]; then
    printf 'error: NEEDS_JSON is empty, so the gate depends on nothing it can check.\n' >&2
    printf 'the gate job must set NEEDS_JSON from the toJSON(needs) expression.\n' >&2
    exit 1
fi

# The shape is checked before the contents, so an empty mapping is reported as
# "no jobs" rather than as unparseable JSON.
if ! kind="$(printf '%s' "$needs_json" | jq -r 'type' 2> /dev/null)"; then
    printf 'error: NEEDS_JSON is not valid JSON.\n' >&2
    printf 'received: %s\n' "$needs_json" >&2
    exit 1
fi
if [ "$kind" != "object" ]; then
    printf 'error: NEEDS_JSON is of type %s, not a mapping of job id to result.\n' "$kind" >&2
    printf 'received: %s\n' "$needs_json" >&2
    exit 1
fi

# A missing `result` becomes NO_RESULT rather than a default of `success`: it
# is a shape this gate does not model, and it must fail rather than pass.
if ! reported="$(printf '%s' "$needs_json" \
    | jq -r 'to_entries[] | "\(.key) \(.value.result // "NO_RESULT")"' 2>&1)"; then
    printf 'error: NEEDS_JSON is not a mapping of job id to a result: %s\n' "$reported" >&2
    printf 'received: %s\n' "$needs_json" >&2
    exit 1
fi

printf 'Quality gate — the result of every job it depends on:\n\n'

failed=""
considered=0
# A here-document, not a pipe: a pipeline would run the loop in a subshell and
# the recorded failures would be discarded with it.
while IFS=' ' read -r job result; do
    [ -n "$job" ] || continue
    considered=$((considered + 1))
    printf '  %-20s %s\n' "$job" "$result"
    if [ "$result" != "success" ]; then
        failed="${failed} ${job}=${result}"
    fi
done <<EOF
$reported
EOF

printf '\n'

if [ "$considered" -eq 0 ]; then
    printf 'error: the needs context named no jobs, so nothing was checked.\n' >&2
    exit 1
fi

if [ -n "$failed" ]; then
    printf 'QUALITY GATE CLOSED: %d job(s) did not report success.\n' \
        "$(printf '%s' "$failed" | wc -w | tr -d ' ')" >&2
    for entry in $failed; do
        printf '  - %s\n' "$entry" >&2
    done
    printf '\nA cancelled or skipped job is not a passed one: fix, re-run or re-enable\n' >&2
    printf 'the job above rather than merging on a check that never inspected it.\n' >&2
    exit 1
fi

printf 'QUALITY GATE PASSED: all %d job(s) reported success.\n' "$considered"
