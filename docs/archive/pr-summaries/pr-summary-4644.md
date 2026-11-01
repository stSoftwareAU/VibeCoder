# PR Summary — Issue #4644

## Summary

Treat a partial acceptance criterion as unmet when deciding whether a PR
closes its issue. PR assembly, later body synchronisation, closure recovery,
and merged-PR discovery share the same guard, so the original issue remains
queued until the remaining work is delivered. The issue and repair prompts and
operator guidance now describe the same rule.

Closes #4644

## Spec

### Intent and Rationale

A PR that reports a partial criterion must not close the only record of the
remaining work. No new gate or follow-up issue is introduced.

### Essential Design Decisions

The existing closure-block parser detects both partial and missing entries.
The existing body and merged-PR paths consume that signal, preserving the
current continuation mechanism and labels.

### Undiscoverable Facts

The owner confirmed that a safe partial PR may merge while the original issue
remains open, and that body repair must preserve this behaviour.

## Evidence

The focused tests exercise summary alignment, initial body assembly and a
subsequent body synchronisation with a partial criterion and a closing keyword.

## Test Plan

- `deno test -A tests/pr_body_sync_test.ts tests/missing_criterion_close_guard_3177_test.ts`: 73 passed.
- Full quality gate: see PR checks.

