## Summary

Two test files asserted wall-clock ratios and flaked in a large raw parallel
`deno test` run on a loaded host. Five of the six stopwatch tests in
`markdown_code_spans_test.ts` now assert on what the splitter produces for a
hang-sized input, so no clock is read. The two stopwatch tests that cannot be
made clock-free were reworked to be less load-sensitive. Test and comment
changes only; no production behaviour changes. Closes #4312.

## Spec

### Intent and Rationale

- Both files were already in `WALL_CLOCK_TEST_FILES`, so the gate and CI run
  them in the serial pass (`lib/unit_test_passes.ts`). The reported failure came
  from a raw parallel run outside that split. A test that fails there is a
  defect, so the tests themselves are changed.
- A super-linear regex on 1.2M characters needs about 10^12 steps and never
  returns, so output assertions at that size are a deterministic detector (the
  repository's "assert on what the code produces" form).

### Essential Design Decisions

- The distinct-length pairing test cannot be hang-sized: unmatched openers are
  bounded by sqrt(2n), so the old forward scan costs n^1.5. It now compares a
  hostile and a control input of the same size, interleaved, fastest of 5 each,
  and asserts hostile < 3x control. A cross-size ratio failed 5 of 12 runs at
  64x and 1 of 6 at 16x because the linear splitter itself grows faster than
  proportional (GC and memory).
- `prompt_leak_redaction_test.ts` keeps `assertLinearGrowth` at 4x and takes the
  fastest of 5 runs (was 2). A 16x factor measured 25x of base against a 32x
  allowance, so it was rejected.

### Undiscoverable Facts

- Classification check: `measuresWallClock` did not miss either file. Both are
  listed, and `tests/parallel_unsafe_test_manifest_test.ts` and
  `tests/parallel_safety_cap_test.ts` pass, so no classifier change was needed.
- The prompt-leak test remains a stopwatch and can still be beaten by extreme
  load. `lib/prompt_leak_redaction.ts` has no work counter and none was added
  for a test.

## Evidence

Reproduced on the base head under `/tmp`-spawned busy loops (60 spinners):
`markdown_code_spans_test.ts` failed 2 of 3 runs, e.g.
`150000 chars took 3 ms but 1200000 chars (8.0x) took 71 ms, over the 50 ms a linear rule allows`.

After the change, the full `markdown_code_spans_test.ts` passed 8 of 8 runs
under the same load. `prompt_leak_redaction_test.ts` passed 3 of 3 under load.

**Docs sweep** — grep: `scales linearly`, `assertLinearGrowth`,
`markdown_code_spans_test`, `only a growth measurement`; section: none — no
manual documents these two tests' timing; siblings: none — no existing set
gained a member; updated: `worker/deno/lib/parallel_unsafe_test_manifest.ts`
(comment above the `tests/markdown_code_spans_test.ts` entry);
`worker/deno/lib/parallel_unsafe_test_manifest.ts:281` — still true because the
file keeps one growth measurement; `worker/deno/tests/support/growth.ts` —
unchanged, still used by 30+ tests.

## Test Plan

- Modified `worker/deno/tests/markdown_code_spans_test.ts` and
  `worker/deno/tests/prompt_leak_redaction_test.ts`. Passed on the final head:
  `deno test` over both files plus
  `tests/parallel_unsafe_test_manifest_test.ts`,
  `tests/parallel_safety_cap_test.ts` and
  `tests/timing_assertion_policy_test.ts`: `ok | 111 passed | 0 failed`.
  `deno fmt --check` and `deno lint` clean.
- Removed from `worker/deno/tests/markdown_code_spans_test.ts`: `assertLinearGrowth( "parseFenceLine on a long run followed by a lone CR", build, (input) => parseFenceLine(input) !== null, { baseChars: 4_000, sizeFactor: 4 }, );`
  Required by: "Make both tests deterministic under load, for example by measuring operation counts or growth with an injected clock."
  Replaced by: ``assertEquals(parseFenceLine(input), { char: "`", length: HANG_SIZE_CHARS - 2, rest: "\rx", });``
- Removed from `worker/deno/tests/markdown_code_spans_test.ts`: `assertLinearGrowth( "splitMarkdownCode on many distinct-length unmatched runs", build, (input) => splitMarkdownCode(input).length, { baseChars: 150_000, sizeFactor: 16 }, );`
  Required by: "Make both tests deterministic under load, for example by measuring operation counts or growth with an injected clock."
  Replaced by: ``assert(elapsedHostile < 3 * elapsedControl, `not under 3x: ${readings}`);`` and `assertEquals(hostileSegments.map((s) => s.value).join(""), hostile);`
- Removed from `worker/deno/tests/markdown_code_spans_test.ts`: `assertLinearGrowth( "splitMarkdownCode on a long non-matching leading-whitespace run", build, (input) => splitMarkdownCode(input).length, { baseChars: 150_000, sizeFactor: 8 }, );`
  Required by: "Make both tests deterministic under load, for example by measuring operation counts or growth with an injected clock."
  Replaced by: ``assertHangSizedProse(`${" ".repeat(HANG_SIZE_CHARS - 1)}x`);``, which runs `assertEquals(segments.map((s) => s.value).join(""), text);`, `assertEquals(segments.filter((s) => s.inCode).length, 0);` and `assertEquals(segments.length, 1);` inside `assertHangSizedProse`
- Removed from `worker/deno/tests/markdown_code_spans_test.ts`: `assertLinearGrowth( "splitMarkdownCode on a long leading-whitespace run before a block quote marker", build, (input) => splitMarkdownCode(input).length, { baseChars: 150_000, sizeFactor: 8 }, );`
  Required by: "Make both tests deterministic under load, for example by measuring operation counts or growth with an injected clock."
  Replaced by: ``assertHangSizedProse(`${" ".repeat(HANG_SIZE_CHARS - 1)}>`);``, which runs `assertEquals(segments.map((s) => s.value).join(""), text);`, `assertEquals(segments.filter((s) => s.inCode).length, 0);` and `assertEquals(segments.length, 1);` inside `assertHangSizedProse`
- Removed from `worker/deno/tests/markdown_code_spans_test.ts`: `assertLinearGrowth( "splitMarkdownCode on a long dash run rejected by a trailing non-dash character", build, (input) => splitMarkdownCode(input).length, { baseChars: 150_000, sizeFactor: 8 }, );`
  Required by: "Make both tests deterministic under load, for example by measuring operation counts or growth with an injected clock."
  Replaced by: ``assertHangSizedProse(`${"-".repeat(HANG_SIZE_CHARS - 1)}x`);``, which runs `assertEquals(segments.map((s) => s.value).join(""), text);`, `assertEquals(segments.filter((s) => s.inCode).length, 0);` and `assertEquals(segments.length, 1);` inside `assertHangSizedProse`
- Removed from `worker/deno/tests/markdown_code_spans_test.ts`: `assertLinearGrowth( "splitMarkdownCode on a long repeated block-quote-marker prefix", build, (input) => splitMarkdownCode(input).length, { baseChars: 150_000, sizeFactor: 8 }, );`
  Required by: "Make both tests deterministic under load, for example by measuring operation counts or growth with an injected clock."
  Replaced by: ``assertHangSizedProse(`${">".repeat(HANG_SIZE_CHARS - 1)}x`);``, which runs `assertEquals(segments.map((s) => s.value).join(""), text);`, `assertEquals(segments.filter((s) => s.inCode).length, 0);` and `assertEquals(segments.length, 1);` inside `assertHangSizedProse`
- Removed from `worker/deno/tests/prompt_leak_redaction_test.ts`: `const out = assertLinearGrowth( "redactPromptLeakage over one unbroken block", (chars) => sentence.repeat(Math.ceil(chars / sentence.length)), (input) => redactPromptLeakage(input), { baseChars: 200_000 }, );`
  Required by: "Make both tests deterministic under load, for example by measuring operation counts or growth with an injected clock."
  Replaced by: `{ baseChars: 200_000, sizeFactor: 4, repeats: 5 }` in the same `assertLinearGrowth(` call (same file; the growth rule is kept, with the fastest of 5 runs per size so a loaded host cannot fail it)
- Red checks (each mutation made on `lib/markdown_code_spans.ts`, then
  restored): tail of `parseFenceLine` restored to `(.*)$` → CR test did not
  return (exit 124 at 60 s); `\1*` changed to `\1*\1*` → dash-run test exit 124;
  `[ \t]*` doubled in the ATX pattern → indent test exit 124; `nextSameLength`
  replaced by a forward scan → distinct-length test failed
  `not under 3x: hostile 540.3 ms, control 77.1 ms`. The block-quote-marker and
  block-quote-prefix tests were not mutated individually; they share
  `assertHangSizedProse` and `QUOTE_PREFIX_RE` with the indent test's path, so
  that coverage is by sibling only.
- Prompt-leak test: a quadratic loop in `matchesParaphrase` with
  `baseChars: 10_000` failed
  `10034 chars took 11 ms but 160022 chars (15.9x) took 2679 ms ... super-linear`;
  at the committed 200_000 chars the mutated run exceeded 120 s and gave no
  verdict. Not red-checked at the committed config.

- `./quality.sh < /dev/null` on the final head: every stage passed except
  `deno tests` (parallel pass: 15 failed, 30026 passed). The 15 failures are in
  files this change does not touch
  (`claude_runner_provider_fallback_4034_test.ts`,
  `codex_model_adaptation_test.ts`, `completion_phase_repo_formatters_test.ts`,
  `execute_claude_phase_*`, `external_orchestration_3642_*`,
  `run_core_production_deps_test.ts`, `execute_phase_assignment_3718_test.ts`).
  Fourteen fail with
  `The running container image did not install the "codex" coding-agent provider. Installed: claude`;
  the Rust-formatter case fails with `formatter should commit the Rust fix`.
  They are host-environment failures, not caused by this diff; neither changed
  test file appears in the failure list. The serial pass did not run because the
  parallel pass failed, so both changed files (listed in the serial pass) were
  run directly with the `deno test` command above.

<!-- vibe-branch-outcomes -->
