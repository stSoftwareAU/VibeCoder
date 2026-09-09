# 🔎 Security sweep — the claim-point PR state read (`pr_live_state.ts`)

**Issue:** [#1774](https://github.com/stSoftwareAU/VibeCoder/issues/1774)
(chunk 12p) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after chunk 12o recorded its coverage:

- `worker/deno/lib/pr_live_state.ts` — added by #1774.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure 12f's
own record documents. The module is claimed by **12p**, and this file is the
reading of it.

## `worker/deno/lib/pr_live_state.ts`

The module runs one `gh pr view <n> --repo <repo> --json state --jq .state` at
each PR pass's claim point and reports the PR as open, closed/merged, or
unknown. It is the gate that stops the CI-fix, review-feedback, merge-conflict
and auto-merge passes writing to a PR closed since the cached listing was taken.

Shapes checked (12a's — a module whose arguments reach a subprocess — 12c's
untrusted GitHub data, and 12e's):

| Property | Result |
| -------- | ------ |
| GitHub-chosen values cannot become `gh` options | ✅ the argv is a fixed array; the only interpolated values are `repo`, which the caller took from the monitored-repo allowlist, and `prNumber`, a `number` rendered with `String()` — neither can introduce a flag, and `--repo`/`--json`/`--jq` are positional constants |
| no shell, no string-built command line | ✅ the module spawns nothing itself: `gh` is an injected `(args: string[]) => Promise<string>` seam taking an argv array, so no value is ever concatenated into a command line |
| untrusted `gh` output cannot be mistaken for "open" | ✅ the raw `state` is passed through `classifyPrLiveState`, an allowlist of `OPEN`/`MERGED`/`CLOSED`; every other string — empty output, an error page, a value a future `gh` invents — becomes `{ unknown: true }`, and `unknown` is a skip at all four call sites. There is no path from an unrecognised value to `{ open: true }` |
| a lookup failure cannot read as success | ✅ a throwing `gh` is caught and returned as `{ unknown: true, error }` with the cause preserved, and `guardPrStillOpen` logs it at WARN. Absence of a failure marker is never success here: only the literal `OPEN` produces `open: true` |
| filesystem reach | ✅ none — the module reads and writes no files |
| environment and secrets | ✅ no `Deno.env` read, no credential handling. The only value logged from outside is the `gh` error message, which goes to the caller's logger and is redacted at that sink |
| blast radius of a wrong answer | ✅ bounded and fail-safe in the cheap direction — a wrong "not open" costs one skipped cycle with no retry, attempt or deferral charged, and the next scan retries. A wrong "open" would need `gh` itself to report `OPEN` for a closed PR |
| issue and PR lifecycle | ✅ the module writes nothing at all: it closes, comments, labels and merges nothing, and issues exactly one read-only `gh pr view` |

No findings.
