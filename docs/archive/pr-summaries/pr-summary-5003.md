# PR Summary — Issue #5003

## Summary

`normaliseGateOutputLines` in `worker/deno/lib/baseline_gate.ts` now normalises
two presentation-only footers, so a check that was already red on the default
branch is no longer read as `new_output` because of them:

- Maven's `Finished at:` footer (optional `[INFO]` prefix, ISO-8601 value)
  becomes `Finished at: <timestamp>`.
- pytest's `=`-padded result summary has its padding reduced to `= … =` and its
  `(H:MM:SS)` clock suffix dropped. This happens after the existing
  duration/clock masking, and the outcome counts are kept.

Both rules match whole lines only, so ordinary timestamps, `==` in assertions
and other separator lines stay in the comparison. `decidePreExistingGateFailure`
is unchanged and still fails closed. This also covers #5004, which was folded
into this issue. Closes #5003.

## Spec

### Intent and Rationale

- The issue asks for bounded, recognised-line fixes, not a global strip of
  punctuation or timestamps. Both new patterns are therefore anchored at the
  start and end of a line that has already been trimmed and single-spaced.
- The pytest summary rewrite also drops the `(<clock>)` suffix. pytest adds it
  only at 60 s and over, so a `59.87s` / `60.02s (0:01:00)` pair cannot compare
  as `pre_existing` while the suffix remains.

### Essential Design Decisions

- A pytest summary is recognised only when it has `=` padding on both sides and
  reads `no tests ran`, or a comma-separated list of `<count> <outcome>` items.
  The outcome words are `failed`, `passed`, `skipped`, `deselected`, `xfailed`,
  `xpassed`, `warning(s)`, `error(s)` and `rerun`. An unknown word (for example
  `1 exploded`) is left as printed.
- Assumption: the unpadded `pytest -q` summary is out of scope, because the
  issue names "outer separator padding". A `-q` run crossing 60 s still reads as
  new output.
- The Maven timestamp's offset is optional, and fractional seconds are accepted.
  Maven itself prints a seconds-precision value with `Z` or `±HH:MM`. Trailing
  text after the timestamp, or a prefix other than `[INFO]`, is not a footer.
- The twin normaliser `normaliseLogExcerpt` (`auto_fix_attempt_tracker.ts`) was
  checked and left alone. Nothing declares it a copy of this rule, and it
  already masks every ISO timestamp for its own fingerprinting purpose.

### Undiscoverable Facts

- Neither Maven nor pytest could be run here: `mvn` is not installed, and
  `python3 -m venv` failed with "ensurepip is not available". The fixtures
  follow the tools' source instead. pytest's `TerminalReporter.write_sep` pads
  with `(fullwidth - len(title) - 2) // 2` separators on each side, plus one
  extra on the right when the line still fits. Its `format_session_duration`
  adds `(H:MM:SS)` only at 60 s and over. Maven's `ExecutionEventLogger` prints
  `Finished at:` with `DateTimeFormatter.ISO_OFFSET_DATE_TIME`.

## Evidence

This is a backend-only change: no UI file is touched. The new tests were added
before the fix and run against the unfixed code: 23 passed, 3 failed. The three
failures:

- the Maven footer pair read `preExisting: false`;
- the first pytest pair (`9.87s` vs `10.02s`) read `new_output`;
- the literal check got
  `========================= 1 failed, 2 passed in <duration> ==========================`
  where `= 1 failed, 2 passed in <duration> =` was expected.

After the fix, `deno task test:unit tests/pre_existing_gate_failure_test.ts`
gives `ok | 26 passed | 0 failed`.

`./quality.sh < /dev/null` passed on the head commit, with two checks skipped by
the host:

- "config integration" was skipped because deno or `.config.json` was not
  available.
- "checkov" was skipped because no checkov binary or image was available. The CI
  checkov job stays authoritative.

Issue numbers this diff adds as provenance:

- #5003: Baseline comparison: ignore Maven finish timestamps and pytest summary
  padding without hiding new failures

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Normalise the timestamp only on a recognised Maven `Finished at:`
  footer with an ISO-8601 value, allowing its normal optional `[INFO]` prefix —
  evidence:
  `worker/deno/tests/pre_existing_gate_failure_test.ts::decidePreExistingGateFailure - Maven failure footers differing only in elapsed and finish times are pre-existing`
  — reviewer: met
- **met** — Normalise outer separator padding only on a recognised pytest
  result-summary line after the existing duration/clock handling. Preserve the
  outcome counts and meaningful diagnostic text — evidence:
  `worker/deno/tests/pre_existing_gate_failure_test.ts::decidePreExistingGateFailure - pytest summaries crossing duration-width and clock boundaries are pre-existing`
  — reviewer: met
- **met** — Do not globally remove punctuation or timestamps from arbitrary
  diagnostics: that could conceal a genuine new failure — evidence:
  `worker/deno/tests/pre_existing_gate_failure_test.ts::decidePreExistingGateFailure - Maven and pytest footer normalisation keeps real differences as new output`
  — reviewer: met
- **met** — Retain fail-closed behaviour when the baseline or per-check evidence
  is unavailable, and when a new check or substantive output appears — evidence:
  `decidePreExistingGateFailure` is unchanged; the existing
  `worker/deno/tests/pre_existing_gate_failure_test.ts` no-baseline,
  passing-baseline, no-recorded-checks, green-at-baseline and new-line tests
  pass — reviewer: met
- **met** — Full Maven failure-footer pairs differing only in elapsed and finish
  times classify as `pre_existing` — evidence:
  `worker/deno/tests/pre_existing_gate_failure_test.ts::decidePreExistingGateFailure - Maven failure footers differing only in elapsed and finish times are pre-existing`
  — reviewer: met
- **met** — Pytest summary pairs crossing duration-width and clock-format
  boundaries classify as `pre_existing` — evidence:
  `worker/deno/tests/pre_existing_gate_failure_test.ts::decidePreExistingGateFailure - pytest summaries crossing duration-width and clock boundaries are pre-existing`
  — reviewer: met
- **met** — Changed test counts, a new diagnostic, a changed ordinary timestamp,
  or meaningful separators in ordinary diagnostics still classify as new output
  — evidence:
  `worker/deno/tests/pre_existing_gate_failure_test.ts::decidePreExistingGateFailure - Maven and pytest footer normalisation keeps real differences as new output`
  — reviewer: met
- **met** — Cover bounded handling of long rejected inputs for the affected
  patterns — evidence:
  `worker/deno/tests/pre_existing_gate_failure_test.ts::normaliseGateOutputLines - Maven and pytest footer patterns handle long rejected inputs`
  — reviewer: met
- **met** — Exercise the decision function, not only normalised string equality
  — evidence: every new positive and negative case calls
  `decidePreExistingGateFailure` in
  `worker/deno/tests/pre_existing_gate_failure_test.ts` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Every outcome of a branch you add needs a test that reaches
  it: the `no tests ran` form of `PYTEST_SUMMARY_RE` had no test, and the docs
  sentence omitted it — evidence: `worker/deno/lib/baseline_gate.ts:370` —
  reason: fixed in this diff (a `no tests ran` pair was added to the pytest
  pre-existing test, and `docs/INTERNALS.md` now names that form and the outcome
  words)
- **clean** — one hostile case per new pattern (leading `=` run, trailing `=`
  run, repeated outcome list, Maven digit tail); negative fixtures that hold the
  forbidden input; no edited existing expectations; insertion points; Australian
  English; caller list (`normaliseGateOutputLines` is called only by
  `decidePreExistingGateFailure`); twin-rule check; docs updated. The reviewer
  found no rule worded as enforced by review only; it checked "Check where you
  insert", which no linter catches.

## Test Plan

- Added four tests to `worker/deno/tests/pre_existing_gate_failure_test.ts`:
  - `decidePreExistingGateFailure - Maven failure footers differing only in elapsed and finish times are pre-existing`:
    a full seven-line footer, with and without the `[INFO]` prefix.
  - `decidePreExistingGateFailure - pytest summaries crossing duration-width and clock boundaries are pre-existing`:
    `9.87s`/`10.02s`, `99.98s`/`100.02s`, `59.87s`/`60.02s (0:01:00)`,
    `no tests ran`, and a mixed-outcome list. Each pair asserts that the raw `=`
    counts differ, as a positive control.
  - `decidePreExistingGateFailure - Maven and pytest footer normalisation keeps real differences as new output`:
    - changed counts;
    - an added `FAILED` line;
    - a timestamped diagnostic;
    - `Finished at: … with errors`;
    - an `[ERROR] Finished at:` line;
    - `==`/`===` in an assertion;
    - `== ERRORS ==` and `short test summary info` padding;
    - an unknown outcome word.

    Each asserts `new_output` and that `newLines` names the line. The test also
    checks two literal normalised values.
  - `normaliseGateOutputLines - Maven and pytest footer patterns handle long rejected inputs`:
    a long run of the shared character, then a rejected character, for each new
    pattern, asserting the exact output.
- No existing test or assertion was edited or removed. The existing unpadded
  pytest fixtures do not match the new `^=+` anchor, so they still reach the
  assertions they make.
- Docs: in `docs/INTERNALS.md`, I read the section "Pre-existing gate failure
  (Issue #1852)" and updated it. Grepping `README.md`, `docs/*.md` and
  `prompts/` for `normaliseGateOutputLines`, `Total time` and the pre-existing
  comparison found no other description.
- `deno task test:unit tests/pre_existing_gate_failure_test.ts` passed (26
  passed, 0 failed). `./quality.sh < /dev/null` passed, with the two host skips
  listed under Evidence.

Not checked: real Maven and pytest runs (neither tool could be installed here),
and the unpadded `pytest -q` summary, which this change leaves as it was.
