## Summary

Closes #4370.

The direct-merge REST fallback now reads every check run before it judges
CI. When the batched GraphQL rollup fails, `checkCiStatus` asks
`repos/{repo}/commits/{sha}/check-runs` for `per_page=100` with
`--paginate`, merges the pages, and passes that set to `determineCiStatus`.
A page that cannot be parsed, pages that disagree on `total_count`, or a
merged run count that does not equal `total_count` is a lookup failure.
The gate retries. A short page is not treated as the full set, so a failed
or still-running run past the first page cannot come back as `passed`.

## Spec

### Intent and Rationale

- The fallback is the CI read behind `enforcePreMergeRequirements` whenever
  the GraphQL rollup fails. Judging the first page alone let a red or
  pending run past that page read as `passed`, and the gate then allowed
  the merge.

### Essential Design Decisions

- Keep the existing `--jq` projection and add `per_page=100` plus
  `--paginate`. `gh` applies `--jq` per page and prints one JSON object per
  line (`--slurp` is refused alongside `--jq`), so the merge is in process.
- Fail the lookup when the pages cannot be completed. Do not call
  `determineCiStatus` on a short set. The allowlist inside
  `determineCiStatus` is unchanged, and the GraphQL path is unchanged.
- A run that is not an object fails the lookup. Field-level conclusions
  stay with `determineCiStatus`.

### Undiscoverable Facts

- GitHub's default page size for this endpoint is 30. On the previous
  fallback, `total_count` was used to decide whether any checks existed,
  not whether the returned `check_runs` array was the full set.
- The issue was filed from the review of VibeCoder#4350. On `main` the same
  unpaginated fallback still runs when the GraphQL read fails, including a
  rate limit, an outage, or a schema error.

## Evidence

No UI change, so there is no screenshot. The behaviour is the REST fallback
inside `checkCiStatus`.

Before the fix, `deno test` of the new cases in
`worker/deno/tests/direct_merge_test.ts` reported 1 passed and 2 failed.
The failing-run case and the short-page case both returned `passed`. The
all-green case, as first written, also returned `passed` from the first
page alone, so it was changed to require `--paginate` and `per_page=100`
as well as a `passed` verdict.

After the fix, from `worker/deno`:

`deno test --frozen --lock=deno.lock --allow-read --allow-env --allow-run --allow-write --allow-sys=hostname tests/direct_merge_test.ts tests/merge_head_pin_test.ts`

77 passed, 0 failed.

`deno fmt` and `deno lint` on `worker/deno/lib/direct_merge.ts` and
`worker/deno/tests/direct_merge_test.ts` reported no problems.

**Docs sweep** — grep: `checkCiStatus`, `determineCiStatus`, `check-runs`,
`--paginate`; section: `docs/MERGE.md` "The CI verdict is an allowlist";
siblings: none — no existing set gained a member; updated: `docs/MERGE.md`.
`DESIGN-PRINCIPLES.md` (backstop and allowlist bullets) was read and left
unchanged: it still says the gate refuses unless CI is `passed`, and the
allowlist is unchanged. `docs/GH-API-OPTIMISATION.md` (the `--paginate` /
`--jq` rule) was read and left unchanged: this read follows that rule, one
JSON object per line, and throws on a page that cannot be parsed.

## Test Plan

- `worker/deno/tests/direct_merge_test.ts`: REST fallback with GraphQL
  forced to fail.
  - A `total_count` of 31, thirty green runs on page one and the failing
    run on page two, is `failed` (not `passed`). The stub returns page two
    when the call includes `--paginate` and `per_page=100`.
  - The same shape with a green run on page two is `passed`, and the call
    includes `--paginate` and `per_page=100`.
  - A single page of thirty green runs with `total_count` 31 is a lookup
    failure whose message includes `incomplete`.
  - Unreadable pages fail closed: malformed JSON, blank output, a JSON
    array, `null`, a string, a non-numeric `total_count`, a missing
    `check_runs` array, disagreeing totals, a numeric run, and a null run.
- Existing direct-merge and merge-head-pin tests still pass (77 passed,
  0 failed, both files together).

**Branch outcomes:**

- `worker/deno/lib/direct_merge.ts:298` — a blank line between pages is
  skipped — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback passes when every check run across pages is green (Issue #4370)` — deleting `continue` parses the trailing newline as JSON and the green test fails
- `worker/deno/lib/direct_merge.ts:302` — no pages is a lookup failure —
  `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on blank (Issue #4370)` — deleting the throw leaves a message that does not include `no pages`
- `worker/deno/lib/direct_merge.ts:307` — pages that disagree on
  `total_count` fail the lookup — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on disagreeing totals (Issue #4370)` — deleting the check reports `incomplete` instead of `disagree`
- `worker/deno/lib/direct_merge.ts:314` — merged length other than
  `total_count` fails the lookup — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed when a check-run page is short of total_count (Issue #4370)` — deleting the check returns `passed` for thirty green runs of `total_count` 31
- `worker/deno/lib/direct_merge.ts:327` — a page that is not JSON fails the
  lookup — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on malformed JSON (Issue #4370)` — deleting the catch reports the parser's own message, which does not include `not JSON`
- `worker/deno/lib/direct_merge.ts:331` — a string page is not a
  check-runs object — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on string (Issue #4370)` — deleting the `typeof` operand reports `no numeric total_count`
- `worker/deno/lib/direct_merge.ts:331` — `null` is not a check-runs
  object — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on null (Issue #4370)` — deleting the `null` operand throws on property access
- `worker/deno/lib/direct_merge.ts:331` — a JSON array is not a
  check-runs object — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on JSON array (Issue #4370)` — deleting the `Array.isArray` operand reports `no numeric total_count`
- `worker/deno/lib/direct_merge.ts:335` — a non-numeric `total_count`
  fails the lookup — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on non-numeric total_count (Issue #4370)` — deleting the check reports `incomplete`
- `worker/deno/lib/direct_merge.ts:338` — a missing `check_runs` array
  fails the lookup — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on missing check_runs (Issue #4370)` — deleting the check throws while flattening
- `worker/deno/lib/direct_merge.ts:342` — a numeric run fails the lookup —
  `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on numeric run (Issue #4370)` — deleting the `typeof` operand returns `ok: true` (`failed`), not a lookup error
- `worker/deno/lib/direct_merge.ts:342` — a null run fails the lookup —
  `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback fails closed on null run (Issue #4370)` — deleting the `null` operand throws while reading `conclusion`
- `worker/deno/lib/direct_merge.ts:439` — the REST call requests
  `per_page=100` and `--paginate` — `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback passes when every check run across pages is green (Issue #4370)` — without those arguments the stub withholds page two
- `worker/deno/tests/direct_merge_test.ts::direct_merge - REST fallback does not pass when the failing run is only on the second page (Issue #4370)` — the merged set is judged `failed`
