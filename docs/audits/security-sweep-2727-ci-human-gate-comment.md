# 🔎 Security sweep — human-gate CI comment (`ci_human_gate_comment.ts`)

**Issue:** [#2727](https://github.com/stSoftwareAU/VibeCoder/issues/2727) (chunk
top-up-2727) · **Parent:** #2683

This is the written record for the one module that entered `worker/deno/lib/`
under #2727:

- `worker/deno/lib/ci_human_gate_comment.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2727**, and this file is the reading of it.

## `worker/deno/lib/ci_human_gate_comment.ts`

The module builds the one comment the CI-fix lane posts for a check that prints
`vibe-human-gate: <step>`. It is pure: it builds a string, spawns nothing, reads
no file and makes no network call.

| Input       | Source                                         | Handling                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| human step  | the failing check's log (PR-author-influenced) | already flattened, marker-neutralised, secret-redacted and bounded by the classifier. Rendered by `inertCodeSpan` in a code span whose fence is one backtick longer than the longest run inside it, so it cannot close the span, open Markdown or `@`-mention |
| check name  | the workflow (fork-chosen on a `pull_request`) | the caller passes `inertCheckName`'s output, whose HTML-comment delimiters are already inert (Issue #2260)                                                                                                                                                    |
| gate marker | `buildCiHumanGateMarker`                       | the check name inside it is stripped of quotes and angle brackets and bounded, so it cannot end the attribute or the comment                                                                                                                                  |

The caller (`_parkHumanGate` in `pr_ci_processor.ts`) routes the finished body
through `redactSecrets()` before `gh pr comment`, as a new outbound sink must
(SECURITY.md). A body that cannot be posted is logged at error level and the
pass reports `processed: false`, so nothing is recorded as a silent success.
