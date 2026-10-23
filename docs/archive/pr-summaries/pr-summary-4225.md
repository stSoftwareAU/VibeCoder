# Cap cargo build parallelism and log memory and CPU pressure on every liveness tick

## Summary

Refs #4225. The worker container froze under large agent `cargo test` /
`deno
test` builds on an 8 GiB guest with no swap, and was reaped only by the
11400 s watchdog. This change does the first three suggested fixes from the
issue:

1. `container/entrypoint.sh` exports `CARGO_BUILD_JOBS=2` and
   `CARGO_PROFILE_{DEV,TEST}_DEBUG=line-tables-only` unless the operator set
   them.
2. The issue, `ci_fix`, `merge_conflict` and `pr_feedback` prompts and
   `CODING-STANDARDS.md` tell the agent to run one suite at a time, in the
   foreground, scoped to the touched crates or files.
3. Each `[liveness] tick` line now ends with `mem_available_mib`,
   `mem_total_mib`, `psi_mem_some_avg10`, `psi_mem_full_avg10` and
   `psi_cpu_some_avg10`, read from `/proc/meminfo` and `/proc/pressure/*`. An
   unreadable source prints `unknown`, never `0`.

Not done here: gating heavy builds and slot concurrency on the pressure reading
(second half of suggested fix 3), and the kill-path investigation (suggested fix
4). The tick line is the evidence those need.

## Reproduction

- **symptom** — the guest freezes during a large cargo / deno test build, with
  no OOM kill and no in-guest record of the memory level when it froze
- **status** — `partial` — the freeze itself was not reproduced (it needs an 8
  GiB no-swap guest under a multi-crate build). The new observability and the
  entrypoint defaults were checked fail-before / pass-after: the new tests
  exercise functions and exports that do not exist on `main`, and each was
  flipped on purpose to confirm it goes red
- **reason** — a guest-wide stall cannot be staged in a unit test; whether
  `CARGO_BUILD_JOBS=2` removes the freeze is shown only by the next occurrences
  on GRQ-3, which the new tick fields will now record
- **regression test** —
  `worker/deno/tests/container_entrypoint_test.ts::entrypoint - cargo defaults to 2 build jobs and line-table debug info, honouring operator overrides (Issue #4225)`,
  `worker/deno/tests/liveness_tick_wiring_4225_test.ts::production deps - the liveness tick line carries every field, resource fields last (Issue #4225)`

## Docs sweep

**Docs sweep** — grep: `[liveness] tick`, `hook_fail_success`,
`CARGO_BUILD_JOBS`, `checkLivenessWindow`, `probeHostMemoryPressure`; section:
`docs/CALLBACKS.md` (the per-cycle liveness line bullet) and `docs/CONTAINER.md`
(memory-pressure probe paragraph, new cargo defaults table); siblings: the
`hook_fail_*` fields (the fixed-key-set convention, now also described for the
resource fields); updated: `docs/CALLBACKS.md`, `docs/CONTAINER.md`

Each hit was read in context: the `docs/CALLBACKS.md:366` diagram label is a
shorthand (`…`) and stays true; the line-375 bullet listed a stale field set and
now lists `alerted`, `last_idle_claimed` and the resource fields.

## Test Plan

No existing assertion is removed or edited: the diff to the test files is
additive only (`git diff main -- worker/deno/tests | grep '^-[^-]'` is empty).

- New: `worker/deno/tests/memory_pressure_test.ts` (PSI parser, probes, field
  formatter), `worker/deno/tests/liveness_guard_test.ts` (tick line format),
  `worker/deno/tests/container_entrypoint_test.ts` (cargo defaults and
  overrides), `worker/deno/tests/liveness_tick_wiring_4225_test.ts` (the
  production hook, through the real factory).

## Branch outcomes

**Branch outcomes:**

- `worker/deno/lib/memory_pressure.ts:222` — error (PSI text over
  `PSI_MAX_CHARS`) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to accept, test went red
- `worker/deno/lib/memory_pressure.ts:231` — error (repeated `some` line) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to accept, test went red
- `worker/deno/lib/memory_pressure.ts:233` — error (malformed `some` line) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to accept, test went red
- `worker/deno/lib/memory_pressure.ts:236` — error (repeated `full` line) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to accept, test went red
- `worker/deno/lib/memory_pressure.ts:238` — error (malformed `full` line) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to accept, test went red
- `worker/deno/lib/memory_pressure.ts:241` — error (unknown line kind) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to skip the line, test went red
- `worker/deno/lib/memory_pressure.ts:244` — absent (no `some` line) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to accept, test went red
- `worker/deno/lib/memory_pressure.ts:256` — error (repeated key on one line) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to accept, test went red
- `worker/deno/lib/memory_pressure.ts:261` — error (non-numeric or non-integer
  `total`) —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to accept, test went red
- `worker/deno/lib/memory_pressure.ts:272` — error (missing field on a PSI line)
  —
  `worker/deno/tests/memory_pressure_test.ts::parsePsi - malformed or empty text is null, never a zero (Issue #4225)`
  — flipped to a zero reading, test went red
- `worker/deno/lib/memory_pressure.ts:255` — exempt (untestable): the regex has
  both groups mandatory, so a match always carries a key and digits; the guard
  only narrows `string | undefined` under `noUncheckedIndexedAccess`, and the
  `parsePsi` tests in `worker/deno/tests/memory_pressure_test.ts` reach the
  no-match path through the `!valid` and unknown-key cases instead
- `worker/deno/lib/memory_pressure.ts:287` — absent (unparseable file reads as
  unknown) —
  `worker/deno/tests/memory_pressure_test.ts::probePsi - a missing or unreadable file is unknown, not a zero (Issue #4225)`
  — flipped to return the parse result as-is, test went red
- `worker/deno/lib/memory_pressure.ts:289` — error (read failure) —
  `worker/deno/tests/memory_pressure_test.ts::probePsi - a missing or unreadable file is unknown, not a zero (Issue #4225)`
  — flipped to rethrow, test went red
- `worker/deno/lib/memory_pressure.ts:335` — absent (no byte count) —
  `worker/deno/tests/memory_pressure_test.ts::livenessResourceLogFields - an unreadable source is written as unknown, never zero (Issue #4225)`
  — flipped to the wrong sentinel, test went red
- `worker/deno/lib/memory_pressure.ts:337` — absent (no PSI line) —
  `worker/deno/tests/memory_pressure_test.ts::livenessResourceLogFields - an unreadable source is written as unknown, never zero (Issue #4225)`
  — flipped to the wrong sentinel, test went red
- `worker/deno/lib/run_core_production_deps.ts:6419` — success (state write ok)
  —
  `worker/deno/tests/liveness_tick_wiring_4225_test.ts::production deps - the liveness tick line carries every field, resource fields last (Issue #4225)`
  — flipped to `!result.ok`, test went red
- `worker/deno/lib/run_core_production_deps.ts:6454` — error (state write fails)
  —
  `worker/deno/tests/liveness_tick_wiring_4225_test.ts::production deps - a failed state write still logs the resource fields (Issue #4225)`
  — flipped to `!result.ok`, test went red
- `container/entrypoint.sh:264` — default and operator override for
  `CARGO_BUILD_JOBS` —
  `worker/deno/tests/container_entrypoint_test.ts::entrypoint - cargo defaults to 2 build jobs and line-table debug info, honouring operator overrides (Issue #4225)`
  — changed the default, test went red
- `container/entrypoint.sh:265` — default and operator override for
  `CARGO_PROFILE_DEV_DEBUG` —
  `worker/deno/tests/container_entrypoint_test.ts::entrypoint - cargo defaults to 2 build jobs and line-table debug info, honouring operator overrides (Issue #4225)`
  — changed the default, test went red
- `container/entrypoint.sh:266` — default for `CARGO_PROFILE_TEST_DEBUG` —
  `worker/deno/tests/container_entrypoint_test.ts::entrypoint - cargo defaults to 2 build jobs and line-table debug info, honouring operator overrides (Issue #4225)`
  — changed the default, test went red

## Mutation check

The nine surviving mutants were addressed, not exempted:

- `memory_pressure.ts` (old line 270, `return null` in `parsePsiFields`) was
  masked by `?? undefined` at both call sites, so `null` and `undefined` behaved
  the same. The callers now test `=== null`, and the malformed-input test gains
  a bad `full` line and a bad `some` line followed by a good one.
- `memory_pressure.ts` (old line 316, the outer `catch` in
  `probeLivenessResources`) was dead: `probeMemoryPressure` and `probePsi` each
  catch their own read failure and cannot throw. The `try`/`catch` is removed.
- `run_core_production_deps.ts` (lines 6444–6450, 6456, the
  `formatLivenessTickLine` arguments and the `resources` warn field) are pinned
  by `worker/deno/tests/liveness_tick_wiring_4225_test.ts`, which drives the
  real factory and hook. Deleting each property in turn was confirmed to turn a
  test red.
- Also removed: the equivalent `|| text.length === 0` clause in `parsePsi` (an
  empty string already fails the `some` check). Added tests for a repeated
  `full` line, an unknown line kind after valid lines, and a valid but oversized
  file.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Cap build parallelism in the entrypoint (`CARGO_BUILD_JOBS`,
  `CARGO_PROFILE_*_DEBUG=line-tables-only`) — evidence:
  `container/entrypoint.sh:264-266`,
  `worker/deno/tests/container_entrypoint_test.ts::entrypoint - cargo defaults to 2 build jobs and line-table debug info, honouring operator overrides (Issue #4225)`
  — reviewer: met
- **met** — Prompts and standards tell agents to run one suite at a time, in the
  foreground, scoped to touched crates — evidence: `prompts/issue/prompt.md`,
  `prompts/ci_fix/prompt.md`, `prompts/merge_conflict/prompt.md`,
  `prompts/pr_feedback/prompt.md`, `CODING-STANDARDS.md` — reviewer: met
- **partial** — Log `/proc/pressure/memory`, `/proc/pressure/cpu` and
  `MemAvailable` on every `[liveness]` tick, and gate heavy builds and slot
  concurrency on them — evidence: `worker/deno/lib/memory_pressure.ts`,
  `worker/deno/tests/liveness_tick_wiring_4225_test.ts::production deps - the liveness tick line carries every field, resource fields last (Issue #4225)`
  — reviewer: partial — reason: logging is done; gating builds and slot
  concurrency on the reading is not
- **missing** — Investigate why the process-tree kill path stops the worker
  completely — reviewer: missing — reason: an investigation needing a live
  reproduction on the affected host, left for a follow-up

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — TDD, Australian English, KISS/DRY and the quality-gate areas of
  the diff were checked; no violations. Two items in the first review pass (an
  equivalent `?? undefined`, a dead `catch`) were fixed in this diff.
