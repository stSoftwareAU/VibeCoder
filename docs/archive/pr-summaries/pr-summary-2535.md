# Post the held-issue gate comment from the scan and retire the stand-alone chain-root comment

## Summary

Every held `top-priority`/`work-on` issue now carries exactly one fleet comment
naming the gate that holds it, written from the scan once selection is settled,
edited in place when the gate moves, and never touching labels. The stand-alone
chain-root comment from #2496 is retired: its unworkable-root sentence is now the
`dependency` gate's sentence, and its fleet-authored leftovers are deleted once
the gate comment is written.

- **`worker/deno/lib/held_issue_gate_comment.ts`**
  - `heldIssueGateFor` turns a scan refusal into a gate. `pr-blocked` with its
    recorded PR (#2534) becomes `pr-open`. A `dependency-blocked` first blocker
    becomes `milestone-wait` (the cross-milestone hold) or `dependency`. The
    `dependency` gate carries the chain's unworkable root unless the fleet is
    already working that chain; the issue is still told which dependency it
    waits on either way.
  - `reportHeldIssueGate` checks a 24-hour memo in the issue cache
    (`held_issue_gate_<n>`) and reads no thread when the same gate was already
    confirmed. Otherwise it upserts the comment, and on `posted`/`edited` deletes
    fleet-authored `vibe-chain-root-unworkable` comments. A thread is remembered
    only once it is fully settled: a failed legacy delete is retried next time.
- **`worker/deno/lib/find_oldest_issue.ts`**
  - Collects the refusals of the two human-scheduled collectors (`gateHeld`).
  - Replaces the chain-root poster loop with one gate report per held issue per
    scan. The report is best effort: `findOldestIssue: gate comment failed` is
    logged and discovery carries on.
- **`worker/deno/lib/chain_root_comment.ts`**
  - Keeps only the marker (for the cleanup), `renderRef`, `reasonSentence` and
    their sanitisers.
  - `postChainRootUnworkableComment`, `buildChainRootUnworkableComment`,
    `CHAIN_ROOT_COMMENT_WINDOW_MS` and their types are removed.
- **Docs:**
  - `docs/INTERNALS.md` "Reporting a chain root nobody can move" is rewritten as
    "Naming the gate on a held issue".
  - `DESIGN-PRINCIPLES.md`'s chain-root paragraph and Mermaid now describe the
    gate comment.
  - The `docs/TROUBLESHOOTING.md` runbook steps now read the gate comment.

### The test file this branch arrived with

The branch's first commit added `find_oldest_issue_gate_comment_test.ts`
against an implementation that did not exist. Three of its tests were also
wrong in ways that would have passed a broken implementation or failed a
correct one. They are fixed here:

- **The edit test changed the blocked issue's body between scans.** The
  content-integrity gate correctly refuses an issue edited after its label was
  approved, so the gate could never change. The fix: the issue now depends on
  #200 and #300, and #200 closes between scans. Its thread fixtures were raw
  comments authored by a non-fleet login. They now use the `--jq` projection
  shape `fetchMarkerComments` returns, with a fleet author, and include the
  gate comment scan 1 posted. The shared cache's issue listing is invalidated
  between scans, as its TTL would do in real use.
- **The failure test checked `args.includes("/comments")`.** No argument is
  ever exactly `/comments`, so the injected failure never fired and the test
  passed vacuously. It now matches the endpoint argument.
- **The first-scan read count asserted exactly one thread read.** A first post
  also reads the thread for legacy comments, so it now asserts that the thread
  is read.

## Evidence

Backend-only change; there is no web interface to screenshot. All run from
`worker/deno/` on this HEAD.

- **Red → green.** `tests/find_oldest_issue_gate_comment_test.ts`, with the
  library changes stashed: `FAILED | 2 passed | 3 failed` ("posts one",
  "skips thread read", "edits … deletes legacy"). With them: `ok | 5 passed`.
- **`tests/find_oldest_issue_test.ts`: `ok | 41 passed`.** The four #2496 tests
  whose rule #2535 changes were updated to the new rule; none were deleted.
  - "fleet works the root" and "root promoted" now expect the dependency
    sentence without a root sentence.
  - "not repeated within 24 hours" now expects an existing gate comment with
    the same key to be left alone, with no edit and no delete.
- **`tests/chain_root_comment_test.ts`** is trimmed to what the module still
  does: the four reason sentences and the login and repository sanitisers. The
  retired poster's guarantees (later-page marker, foreign author neither
  trusted nor edited, unreadable thread fails loud) are pinned by
  `held_issue_gate_comment_test.ts`.
- **Related suites: `ok | 263 passed | 0 failed`.** That covers the finder, the
  gate comment, chain promotion and marker dedup.
- `deno lint`, `deno fmt --check` and `deno check` pass on the changed files.
- `markdownlint-cli2` reports `0 error(s)` on the three docs.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — after one scan every held `top-priority` issue carries exactly one
  fleet `vibe-held-issue-gate` comment naming its current gate, and a second
  scan with the same state makes no comment API write. Evidence:
  `tests/find_oldest_issue_gate_comment_test.ts::posts one held-issue gate
  comment for blocked top-priority` and `::skips thread read when gate unchanged
  within 24h (cache)`.
- **met** — when the gate moves, the existing comment is edited, not re-posted,
  and a fleet-authored `vibe-chain-root-unworkable` comment on that issue is
  deleted. Evidence: `::edits gate comment when gate changes, deletes legacy
  comment`.
- **met** — a held `low-priority` issue gets no comment. Evidence: `::does not
  post gate comment for held low-priority issue`.
- **met** — the tests pass and the two doc surfaces are updated. Evidence:
  263/263 related tests, lint/fmt/check clean, and `docs/INTERNALS.md` plus
  `DESIGN-PRINCIPLES.md` rewritten (with the TROUBLESHOOTING runbook). The full
  suite runs in CI.

## Standards Review

- **clean** — TDD: the corrected tests are red without the implementation and
  green with it.
- **clean** — tests exercise the real `findOldestIssue` and assert on the `gh`
  writes it makes, with no source-text assertions.
- **clean** — dead code removed: the retired poster, builder, window constant
  and their tests. No unused bindings remain.
- **clean** — no labels are ever applied. Only a fleet-authored comment is
  trusted, edited or deleted.
- **clean** — Australian English throughout.

## Test Plan

```bash
cd worker/deno
deno test -A tests/find_oldest_issue_gate_comment_test.ts tests/find_oldest_issue_test.ts \
  tests/chain_root_comment_test.ts tests/held_issue_gate_comment_test.ts
```
