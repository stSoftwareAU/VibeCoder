# Best-practices scan: flag quality gates that list every passing test

Closes #2430

The every-change gate runs many times a run and its output is quoted back into
prompts, so a line per passing test is paid for over and over — one green
`./quality.sh` here printed roughly 23,000 of them and said nothing. This adds
the detection to the best-practices scan, writes the rule down once in
`CODING-STANDARDS.md`, and fixes VibeCoder's own gate in the same PR.

## What changed

| Surface | Change |
| --- | --- |
| `prompts/best_practices/buckets/general.md` | New check 19 — a green gate prints no per-test pass line; a red one prints every failure in full. |
| `prompts/best_practices/buckets/typescript.md` | New check 28 — `deno test` / `vitest run` / `jest` left on the default reporter. |
| `prompts/best_practices/buckets/rust.md` | New check 32 — `cargo test` / `cargo nextest run` with no quiet or failures-only flag. |
| `prompts/best_practices/buckets/java.md` | New check 13 — `mvn test` / `mvn verify` / `gradle test` with no failures-only reporting. |
| `prompts/best_practices/buckets/react.md` | New check 14 — `vitest run` / `jest` / `react-scripts test` on the default reporter. |
| `CODING-STANDARDS.md` (`## Quality Gates`) | New paragraph: a green gate says nothing, a red one says everything. |
| `worker/deno/lib/unit_test_passes.ts` | `TEST_REPORTER_FLAG = "--reporter=dot"` on both unit passes; new `unitTestPassTranscript` helper. |
| `worker/deno/lib/quality_gate.ts` | `runDenoTests` keeps a failing pass's transcript and drops a passing one's. |

## Scope of the check

Only the **every-change gate** (the quality script or the default test task) and
**CI steps that run on pull requests** are in scope — an on-demand test task a
developer invokes deliberately is not. `severity:medium` when the noisy
invocation is the every-change gate or a per-PR CI step, `severity:low`
otherwise, matching the neighbouring checks 16–18.

**Static evidence only.** The finding cites the script, task or workflow line
that invokes the test runner without a quiet or failures-only reporter. The scan
never runs the suite to measure what it prints — that is stated in every one of
the five checks, and `general.md`'s section already carries the same hard
constraint.

## Why `--reporter=dot` plus a transcript trim, not a reporter alone

`deno test --reporter` accepts exactly four values on Deno 2.9.6 — `pretty`,
`dot`, `junit`, `tap`. Each was measured against a two-test fixture (one passing,
one failing) outside the repo:

| Reporter | Green run | Red run |
| --- | --- | --- |
| `pretty` (default) | one `NAME ... ok (Nms)` line per test | full failure detail |
| `dot` | one `.` per test (own line, non-TTY) + `ok \| 5 passed \| 0 failed` | full ERRORS block — test name, `AssertionError`, the `[Diff]` block, the stack trace, FAILURES block, `FAILED \| 1 passed \| 1 failed` |
| `tap` | `ok N - <name>` per test — worse than `dot` | — |
| `junit` | a `<testcase …>` element (2 lines) per test on stdout — worse | — |

So **no reporter Deno offers emits zero per-test output on a green run.** `dot`
is the minimum, and it is the only quiet option that keeps the whole failure —
verified on a deliberately failing test, which still printed
`fails B => ./b_test.ts:3:6`, `error: AssertionError: Values are not equal: b was wrong`,
the actual/expected diff and both stack frames.

Because `dot` still marks each passing test, the flag is paired with a trim
where the output is collected. `unitTestPassTranscript(label, exitCode, output)`
returns `[]` for a pass that succeeded (exit 0) or never ran (`null`), and the
full `=== deno tests: <label> pass ===` block plus output for one that failed.
`runDenoTests` pushes its result instead of the previous unconditional pair, so a
green gate contributes nothing per test from either unit pass while a red one is
unchanged. Filtering happens at the collection point rather than by post-parsing
the runner's text, so a failure can never be swallowed by a pattern that stopped
matching.

`integrationTestPass()` is deliberately untouched — the issue scopes the fix to
the two unit passes.

## Tests

- `worker/deno/tests/unit_test_passes_test.ts` — five new cases: both passes
  carry `--reporter=dot`; `args.slice(1, 4)` is still
  `["test", "--frozen", "--lock=deno.lock"]` so the flag does not displace the
  extra args the Issue #940 case pins; and `unitTestPassTranscript` returns `[]`
  green, `[]` for a never-ran pass, and the labelled block when red.
- `deno task test tests/unit_test_passes_test.ts` → `ok | 33 passed | 0 failed`.
- `deno task test tests/quality_gate_test.ts` → `ok | 34 passed | 0 failed`.
- Bucket check numbering verified gapless across all nine guides with
  `findCheckNumberingIssues` (`general OK … terraform OK`).
- `markdownlint-cli2` over the edited pages reports no new issue. (The one
  MD018 it reports on `CODING-STANDARDS.md` pre-exists on `main` and sits
  outside the gate's configured globs.)

## Security self-check

- No new external input, no new SQL/shell/HTTP call, no new dependency.
- No secrets or hidden files staged; the change is documentation plus one
  reporter flag and a pure string helper.
- Failure output is preserved in full — the trim drops only output from a pass
  that positively succeeded, so nothing fails silently.
