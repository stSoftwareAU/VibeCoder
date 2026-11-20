# PR Summary — Issue #5236

## Summary

`scanDummyTests` now costs time in proportion to the diff for the two shapes the
issue measured. Each helper's assertions are worked out once per file per scan,
not once for every test that calls it. An inline test body is judged from
per-hunk indexes of its calls, assertions, `ignore: true` markers and lines, so
a body nested inside another is no longer sliced and read again. Verdicts are
unchanged. Closes #5236.

## Spec

### Intent and Rationale

- The diff is untrusted input to the fleet reviewer gate and the pre-PR
  verifier. Before this change, a 550 KB diff could stall either one for tens
  of seconds.
- Memoising by callee name removes the tests × helper-size cost. A positional
  index per hunk, read with binary searches and prefix counts, removes the
  re-read of enclosing bodies. Both keep the existing readers, so no verdict
  rule is rewritten.

### Essential Design Decisions

- **Exact equivalence is a requirement.** The index must read what
  `calleesIn(masked.slice(open, close + 1))` reads. `sliceCalls` re-reads the
  few calls that differ where the registration's own `test(` consumes the `(`
  the slice can use as a prefix. One example is `test(label(1), …)`, where the
  slice reads `label` and the whole hunk does not. After that, the hunk index
  is used.
- **Strength lists are deduplicated (`distinct`) and summarised as bits.** The
  bits are `WEAK`, `STRONG` and `UNSEEN`. Only "is there any", "are all weak"
  and "is a call unseen" are ever read, so neither change can alter a verdict.
- **What still reads bodies as strings:** named callbacks, helper-call
  registrations (`spans`), Rust tests and the deferred-candidate pass. None of
  them is a shape the issue measured.
- **Each sorted position is visited once** (`visitOnce`) for the interaction
  notes and the `ignore: true` refusals. Every repeat call of `note` or `add` on
  the same line was already a no-op, so the order of findings and notes is
  unchanged.

### Undiscoverable Facts

- `check(` is itself an assertion-helper name (`HELPER_CALL`). For that reason
  the growth fixture's helper is called `probe`: with `check`, the weak variant
  could never produce a finding.
- One known way the index could still disagree with the string reading is
  mismatched brackets inside an assertion's arguments. There, `tsStrength`
  reads the hunk's bracket table instead of scanning the slice. The corpus run
  below found no case where this happens.

## Evidence

The change is backend only, and the issue is a performance fix, so the evidence
is behavioural and timing is indicative:

- **Growth guards:** `worker/deno/tests/dummy_test_scan_growth_5236_test.ts`
  drives `scanDummyTests` through `assertLinearGrowth` for both shapes.
- **Red on base:** with the base branch's `lib/dummy_test_scan.ts` restored,
  5 of 8 tests failed. The 3 output pins passed. One failure line:
  `helper called by every test: 38668 chars took 210 ms but 159075 chars (4.1x)
  took 3139 ms, over the 1732 ms a linear rule allows — the rule is
  super-linear`. The nested shape failed the same way: 34053 chars took 266 ms
  and 139054 chars took 4175 ms.
- **Equivalence corpus:** I scanned every tracked `.ts`, `.tsx`, `.js` and
  `.rs` file (3,899 files) twice with both the base scan and the head scan:
  once as a new-file diff, and once as an edited diff with every third line as
  context. All 7,798 outputs were identical (`diff: 0`).
- **Indicative timings** (shared, parallel host, never asserted), measured
  through `scanDummyTests`:

  | Shape | Size | Base | Head |
  | --- | --- | --- | --- |
  | Helper | 4,000 tests, 281 KB | 9,579 ms | 69 ms |
  | Nested | 4,000 levels, 111 KB | 2,800 ms | 31 ms |

```mermaid
flowchart LR
    H[hunk masked once] --> CI[call index]
    H --> AI[assertion index]
    H --> IV[ignore and interaction positions]
    CI --> SC[sliceCalls: re-read only at the opening bracket]
    SC --> J[judge inline body: binary search and prefix OR]
    AI --> J
    M[callee memo per file] --> J
    IV --> V[visitOnce: each line or marker once]
```

## Test Plan

All the test files below are under `worker/deno/tests/`:

- **Added** `dummy_test_scan_growth_5236_test.ts`:
  - Two growth guards for the helper shape: strong (no findings) and weak
    (`MAX_DUMMY_TEST_FINDINGS` `success-only`).
  - Three growth guards for the nested shape: strong, weak, and no assertion,
    with the first finding on line 1.
  - Pins for `test(label(1), …)` in an edited file: an `unseen` note, against
    a control that gives `no-assertion`.
  - Pins for `test(g(f()), …)`: `g` is read as a call and `f` is not.
  - A pin of the nested `ignore: true` and interaction output.
- **Added** `support/new_file_diff.ts`: the `added` diff builder, moved out of
  `dummy_test_scan_5016_test.ts`. That file now imports it and its tests are
  otherwise unchanged. No assertion was removed.
- **Changed** `worker/deno/lib/parallel_unsafe_test_manifest.ts`: the new
  growth test is listed in `WALL_CLOCK_TEST_FILES`, beside
  `dummy_test_scan_5016_test.ts`, so it runs in the serial pass. The first
  gate run flagged it under `parallel_unsafe_test_manifest_test.ts`.
- **Ran:** `deno task test:unit tests/dummy_test_scan_growth_5236_test.ts
  tests/dummy_test_scan_5016_test.ts
  tests/dummy_test_scan_wiring_5016_test.ts` on the head. Result: 11 passed in
  the parallel pass, 63 passed in total, 0 failed.
- **Ran:** `deno fmt --check` and `deno lint` on the changed files. Both are
  clean.
- **Ran:** `./quality.sh < /dev/null` on the head. Result: PASSED.

## Not done or not checked

- The tool's own bounds on findings and notes are unchanged.
- On the first gate run, `tests/pr_summary_ci_workflow_3768_test.ts` failed
  because this host has no DNS (`Failed caching npm package
  'entities@3.0.1'`). I seeded the host's `~/.cache/deno` from the worker
  cache; that is not a repository change. The test then passed (11 passed).
- No new reviewer sub-agents were run, because the issue has no
  acceptance-criteria list.
- The Rust and named-callback paths still read their bodies as strings.
  Neither is a measured shape.
