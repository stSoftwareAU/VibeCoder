# Bound four backtracking regexes on the untrusted-text path (Issue #1274)

## Summary

Four regexes reachable from attacker-writable text — an issue body, a comment,
a referenced child issue's body, the agent's own turn output — backtracked
super-linearly with no length cap on the way in, on the worker's single thread.
One issue body of `"<".repeat(65536)` (GitHub's own body limit) stalled the
worker for 23 s, and the issues stay open to be re-scanned on every cycle.

Each site is fixed by removing the ambiguity, not by capping the input:

| Site | Was | Now |
| --- | --- | --- |
| `lib/prompt_delimiter.ts` angle passes | outer `(<{2,})` re-backtracked at every offset inside a run of `<` | each pass opens with `(?<!<)`, so a run is entered only at its first character |
| `lib/prompt_delimiter.ts` `---BEGIN … CONTENT` | `\s+` beside an unbounded `[\s\S]*?` over the same characters | one fixed-width `\s` then a gap bounded at 512 |
| `lib/issue_dependencies.ts` `hasBackReference` | `parent\s*:?\s*#` — two unbounded whitespace runs, ambiguous split | every run bounded at eight characters |
| `lib/suspicious_image_handoff.ts` `MARKER_RE` | uncapped `[^]*?` rescanned to end-of-string per opening tag | opening tag matched by regex, closing `-->` found with `indexOf` |
| `lib/security.ts` `SUSPICIOUS_PATTERN` | four rules chained two or three `.{0,200}` gaps — nested quantifiers, up to 200³ per start offset | each later token anchored to the head token by its own bounded lookahead (`proximityRule`) — additive, and a strict superset of the old rule set |

**No scanner caps its own input.** Truncating would hand the tail of a body
through unsanitised (site 1), drop a genuine back-reference (site 2), or lose a
genuine hand-off marker (sites 3–4) — the tail is exactly where a payload would
then go. This is the same reasoning `redactSecrets` already documents in
SECURITY.md: bound the *pattern*, never the *input*.

Closes #1274.

## Evidence

Backend/CLI only — no web interface to screenshot. Measured on this host with
`deno run`, same inputs before and after the change:

| Input | Before | After |
| --- | --- | --- |
| `sanitiseDelimiterPatterns("<" × 16 000)` | 1 483 ms | < 1 ms |
| `sanitiseDelimiterPatterns("<" × 65 536)` — the issue's trigger | ~23 s (12 s in the test harness) | 1 ms |
| `sanitiseDelimiterPatterns("---BEGIN " + 65 000 spaces)` | 169 ms | < 1 ms |
| `hasBackReference("Parent" + 65 000 spaces)` | 4 672 ms | < 1 ms |
| `detectSuspiciousImageFlag(1 MiB of unclosed marker tags)` | 2.6 s | 1 ms |
| `detectSuspiciousPatterns` over a 50 KB dense `what`/`are`/`your` blob | 124 ms | 1 ms |
| `detectSuspiciousPatterns` over 50 KB of `what-are-your…` | 49 ms | 4 ms |

The whole new suite runs in **9 ms** after the fix and **28 s** against the
unfixed modules (12 s in a single case), on the same machine in the same
session.

### Why the guards are behavioural, not timed

`CODING-STANDARDS.md` ("Guard super-linearity by behaviour first") is explicit:
PR #1170 moved twelve ReDoS suites off millisecond budgets *and* off ratio
assertions, because a host 8 % slower reported one as a correctness error and a
loaded laptop read 30 ms against 355 ms for linear work. So every case here
feeds the adversarial shape and asserts what the function **produces**; a
super-linear regression does not return, and the runner's own timeout is the
detector, on every machine under every load.

The issue suggested shipping `assertLinearGrowth` cases instead. That form was
run during development as the fail-before check (below) but is deliberately not
shipped — a new clock-reading suite would also have to join
`WALL_CLOCK_TEST_FILES` and the serial pass, which is the debt #1170 spent a
whole PR draining.

### Fail-before / pass-after

- Against the **unfixed** code, the `assertLinearGrowth` form of these same four
  shapes went red on all four: *"sanitiseDelimiterPatterns over a padded
  ---BEGIN gap: 16010 chars took 5 ms but 64010 chars (4.0x) took 78 ms, over
  the 50 ms a linear rule allows — the rule is super-linear"*, and likewise for
  the angle run, `hasBackReference` (126 ms → 2 031 ms) and
  `detectSuspiciousImageFlag` (23 ms → 355 ms). After the fix all four are
  green, and the same work is unmeasurably fast.
- The shipped suite is the behavioural form of those four shapes: it passes
  after the fix in 9 ms, and against the unfixed modules the same file takes
  28 s — one case alone 12 s, past the 10-second unit-test target that a hung
  ReDoS guard is meant to breach.
- Regression test naming the linkage:
  `worker/deno/tests/untrusted_text_redos_1274_test.ts::"1274/1 - a body of nothing but opening angles is sanitised promptly"`
  reproduces the reported trigger — a 65 536-character body of `<` — costing
  12 s against the unfixed sanitiser and 1 ms after the fix.

### Original trigger closed, no trivial bypass

The reported trigger (an issue body of `"<".repeat(65536)`, and the padded
`Parent`, marker-tag and `what/are/your` variants) is closed at the pattern, not
at the input, so there is no padding, repetition or interleaving that restores
the cost: the lookbehind rejects every re-entry into an angle run in constant
time, the whitespace and gap quantifiers are bounded by construction, the marker
scan is a single `indexOf`, and the pattern rules are additive. Because nothing
truncates its input, the classic cap bypass — put the payload past the cap —
does not exist here either, and the sanitiser still neutralises every marker it
did before (`1274/1 - a marker sharing an angle run with 64 Ki of padding is
still neutralised`, `1274/2 - a real back-reference after 64 Ki of padding is
still found`, `1274/3 - a genuine marker after a wall of unclosed tags is still
detected`).

## Test Plan

New: `worker/deno/tests/untrusted_text_redos_1274_test.ts` — 15 cases, each
calling the real function with an adversarial input and asserting the produced
output:

- **Site 1** — a 64 Ki run of `<` is returned unchanged and promptly; a marker
  sharing that run, and one on the next line, are still neutralised; a padded
  `---BEGIN … CONTENT` gap is prompt; a newline-split marker and the real
  `---BEGIN … UNTRUSTED … BOUNDARY_… ---` boundary are still neutralised at any
  padding.
- **Site 2** — a `Parent` link padded to the body limit is scanned promptly; a
  real back-reference after 64 Ki of padding is still found; all six real
  spellings still match and the two near-misses still do not.
- **Site 3** — a megabyte of unclosed marker tags is scanned promptly; a genuine
  marker after 10 000 of them is still detected with its attributes; attributes
  are still read up to the first closing tag.
- **Site 4** — a dense 50 KB near-miss blob is scanned promptly and not flagged;
  all ten chained-token rules still fire with each token at the 200-character
  bound; tokens beyond the window are still not flagged.

Existing suites re-run green: `prompt_delimiter_test.ts`, `security_test.ts`,
`security_multiline_3665_test.ts`, `issue_dependencies_test.ts`,
`issue_dependency_cycles_test.ts`, `blocked_outcome_test.ts`,
`suspicious_image_handoff_test.ts`, `security_untrusted_ingestion_1249_test.ts`,
`parallel_unsafe_test_manifest_test.ts`, `parallel_safety_cap_test.ts`.

Full gate: `./quality.sh` — **PASSED** (semgrep included; the
`detect-non-literal-regexp` warning it raised on the pre-existing
`extractSubIssueReferences` URL pattern is suppressed with the justification
that the only interpolated value is the repo slug, escaped on the line above).

## Security self-check

- **Input validation** — unchanged; every function keeps its existing guards.
- **Secrets** — no credentials, keys or hidden paths staged.
- **Injection surface** — no new SQL, shell, filesystem or HTTP calls; one
  pre-existing dynamic `RegExp` reviewed and its escaping confirmed.
- **Output encoding** — the sanitiser's fullwidth substitutions are unchanged.
- **Error handling** — no failure is swallowed; no new catch blocks.
- **Dependencies** — none added.
