# PR Summary — Issue #3535

## Summary

When `docs/archive/pr-summaries/pr-summary-<N>.facts.json` exists, the worker
validates it with `parseSummaryFacts` and renders its `Branch outcomes:` list
into the PR body. The list replaces the first `<!-- vibe-branch-outcomes -->`
marker, or is appended when there is no marker. The gate then checks the
structured list:

- A cited test absent at HEAD blocks PR creation.
- A malformed, schema-invalid or unreadable facts file blocks PR creation. The
  reason names the facts file.
- A facts file beside a hand-written prose `Branch outcomes` list blocks.

With no facts file, behaviour is unchanged. The PR-body sync covers the facts
file too: it is part of the digest input and of the legacy diff, so a
review-fix push that changes only the facts file refreshes the body.

Closes #3535 ("Render branch outcomes from the facts file into the PR body and
gate on the structured form").

## Spec

### Intent and Rationale

- #3396 moves PR-summary facts from free text to structured data. #3534 added
  the schema, validator and renderer (`summary_facts.ts`). This PR wires them
  into PR creation and the PR-body sync.
- The facts path is opt-in. With no facts file, the completion phase and the
  sync take the existing prose path, so existing summaries keep working.

### Essential Design Decisions

- `worker/deno/lib/pr_summary_facts.ts` holds the shared pieces:
  `prSummaryFactsPath`, `loadPrSummaryFacts`, `resolveBranchOutcomesFacts`
  (`absent` / `error` / `valid`), `applyBranchOutcomesFacts` and
  `prSummaryDigestInput`. Both the completion phase and `pr_body_sync.ts` use
  them, so the two paths cannot drift.
- Only `NotFound` reads as absent. Any other read error is an `error` outcome,
  so an unreadable file fails loud rather than silently falling back to prose.
- A facts problem is folded into the existing `Branch outcomes:` gate result.
  It gets the gate's single in-run recovery and blocks PR creation like any
  other gate finding.
- With a valid facts file, named tests come from `namedTestPathsFromFacts`
  rather than from scraping the prose. Only the declared test paths are looked
  up at HEAD.
- In the sync, an invalid facts file returns `ok: false` with the facts reason
  rather than publishing a body without the list.

### Undiscoverable Facts

- Persisted data: the `prSummaryDigest` marker is stored in PR bodies. This PR
  chose to **read the old shape**. With no facts file, `prSummaryDigestInput`
  returns the summary unchanged, so every digest already in a PR body stays
  valid. The facts content is added to the digest input only when a facts file
  exists. The test `sync - with no facts file the digest input is the summary
  alone` pins this.
- Each new lib module needs a sweep-ledger slice, so
  `docs/audits/lib-sweep-coverage/top-up-3535.json` is added.

## Evidence

Backend-only change: no UI files are touched, so no screenshot.

- Issue numbers this diff adds as provenance: #3396, "Review learning loop:
  prefer deterministic checks, retire guidance that doesn't work, and make
  summary facts structured data"; #3535, "Render branch outcomes from the facts
  file into the PR body and gate on the structured form".

**Docs sweep** — grep: `facts.json`, `vibe-branch-outcomes`, `prSummaryDigest`, `Branch outcomes:`, `pr_body_sync`; section: `docs/workflows/issue-processing.md` "A branch outcome with no recorded test blocks the summary (Issue #3147)"; siblings: `pr_body_sync.ts`, `pr_summary_loader.ts`; updated: `docs/USAGE.md`, `docs/INTERNALS.md`, `docs/workflows/issue-processing.md`

Where each hit stands:

- **`docs/INTERNALS.md`.** The module table gains a `pr_summary_facts.ts` row
  next to its siblings `pr_body_sync.ts` and `pr_summary_loader.ts`. The
  `pr_body_sync.ts` row now says the facts file is part of the digest.
- **`docs/workflows/issue-processing.md`.** The Issue #3147 Branch outcomes section now
  describes the facts file, the marker and the three blocking cases.
- **`docs/USAGE.md`.** The PR-summary paragraph names the optional facts file.
- **`docs/workflows/pr-feedback.md` L508–526.** This passage describes the
  body refresh on a review-fix push. It is still true, because the digest now
  covers the facts file too, so it is unchanged.
- No prompt under `prompts/` mentions the facts file or the marker yet.
  Teaching agents to write the facts file is a later part of #3396.

### Author's own checks (not from the independent reviewer)

- Callers checked: `resolveBranchOutcomesFacts` and `prSummaryDigestInput`
  have two callers, the completion phase and `pr_body_sync.ts`. Both pass the
  facts content. `namedTestPaths` and `parseBranchOutcomes` are only read, not
  changed.
- Guards kept on the new path: the facts problem goes through the existing
  gate. That means the same single in-run recovery, the same block on PR
  creation and the same named-test lookup at HEAD. No early return skips them.
- With no facts file, `completion_phase_branch_outcomes_test.ts` and
  `branch_outcomes_gate_test.ts` are not edited by this diff, and they pass.

## Test Plan

Paths are relative to the repository root:

- `PSF` is `worker/deno/lib/pr_summary_facts.ts`.
- `CP` is `worker/deno/lib/phases/completion_phase.ts`.
- `SY` is `worker/deno/lib/pr_body_sync.ts`.
- `TF` is `worker/deno/tests/pr_summary_facts_test.ts`.
- `TC` is `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts`.
- `TS` is `worker/deno/tests/pr_body_sync_test.ts`.

Results:

- The 8 tests in TC, the 8 in TF and the new sync tests in TS pass.
- The existing `worker/deno/tests/completion_phase_branch_outcomes_test.ts`
  and `worker/deno/tests/branch_outcomes_gate_test.ts` pass unchanged.
- Each branch below was reverted on its own, and at least one test went red.
- `sync - with no facts file the digest input is the summary alone` is a
  compatibility pin. It is green on base by design.

Red-checks:

| Revert | Tests that went red |
| --- | --- |
| Facts removed from the digest input | TS `sync - a facts-only change refreshes the body (Issue #3535)`, TS `sync - valid facts render the Branch outcomes list into the rebuilt body` |
| Facts path removed from the legacy pathspec | TS `sync - a legacy body's before-push diff includes the facts file path (Issue #3535)` |
| `applyBranchOutcomesFacts` call removed in the sync | TS `sync - valid facts render the Branch outcomes list into the rebuilt body` |
| Error return removed in the sync | TS `sync - an invalid facts file fails loud` |

Branch outcomes:

- PSF:41 — NotFound → absent (null) — TF `loadPrSummaryFacts returns null when the file is missing` — flip went red
- PSF:62 — marker found → replaced — TF `applyBranchOutcomesFacts replaces the first marker only` — flip went red
- PSF:66 — empty summary → just the list — TF `applyBranchOutcomesFacts returns just the list for an empty summary` — flip went red
- PSF:78 — no facts → digest input is the summary — TF `prSummaryDigestInput leaves the summary unchanged without facts` — flip went red
- PSF:107 — read error → error naming the file — TF `loadPrSummaryFacts reports an unreadable path, naming it` — flip went red
- PSF:116 — no file → absent — TC `completion facts - valid facts render in place of the marker (Issue #3535)` — flip went red
- PSF:119 — parse or schema error → error — TC `completion facts - schema-invalid facts block, naming the facts file (Issue #3535)` — flip went red
- CP:2125 — valid facts → rendered into the body — TC `completion facts - valid facts without a marker are appended (Issue #3535)` — flip went red
- CP:2133 — unusable facts → warning, then blocked — TC `completion facts - malformed JSON blocks, naming the facts file (Issue #3535)` — flip went red
- CP:2191 — digest input includes the facts — TS `sync - a facts-only change refreshes the body (Issue #3535)` — flip went red
- CP:2699 — valid facts → declared tests looked up at HEAD — TC `completion facts - only the declared test paths are looked up at HEAD (Issue #3535)` — flip went red
- CP:2712 — facts error → gate problem — TC `completion facts - an unreadable facts file blocks rather than reading as absent (Issue #3535)` — flip went red
- CP:2715 — valid facts plus prose list → blocked — TC `completion facts - a facts file beside a hand-written Branch outcomes list blocks (Issue #3535)` — flip went red
- CP:2721 — facts problem → blocked — TC `completion facts - a cited test absent at HEAD blocks, naming it (Issue #3535)` — flip went red
- CP:2897 — facts problem folded into the gate result — TC `completion facts - malformed JSON blocks, naming the facts file (Issue #3535)` — flip went red
- SY:449 — facts path in the legacy diff pathspec — TS `sync - a legacy body's before-push diff includes the facts file path (Issue #3535)` — flip went red
- SY:496 — invalid facts → `ok: false` — TS `sync - an invalid facts file fails loud` — flip went red
- SY:501 — digest input includes the facts — TS `sync - a facts-only change refreshes the body (Issue #3535)` — flip went red
- SY:506 — valid facts → list rendered — TS `sync - valid facts render the Branch outcomes list into the rebuilt body` — flip went red

- `./quality.sh < /dev/null` on the final head: `Result: PASSED (with skipped checks)` — exit 0; deno tests, lint, type check and fmt all passed; only config integration was skipped

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A valid facts file produces a PR body containing the rendered list, and blocks when a cited test is absent at HEAD. — evidence: `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts::completion facts - valid facts render in place of the marker (Issue #3535); ::completion facts - a cited test absent at HEAD blocks, naming it (Issue #3535)` — reviewer: met
- **met** — A malformed, schema-invalid or unreadable facts file each block PR creation with a reason naming the facts file, one test per case. — evidence: `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts::completion facts - malformed JSON blocks, naming the facts file (Issue #3535); ::completion facts - schema-invalid facts block, naming the facts file (Issue #3535); ::completion facts - an unreadable facts file blocks rather than reading as absent (Issue #3535)` — reviewer: met
- **met** — A facts file alongside a hand-written prose Branch outcomes list blocks. — evidence: `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts::completion facts - a facts file beside a hand-written Branch outcomes list blocks (Issue #3535)` — reviewer: met
- **met** — With no facts file, the existing completion_phase_branch_outcomes_test.ts and branch_outcomes_gate_test.ts pass unchanged. — evidence: `worker/deno/tests/completion_phase_branch_outcomes_test.ts; worker/deno/tests/branch_outcomes_gate_test.ts` (not edited by this diff) — reviewer: partial — reason: the reviewer confirmed that neither file is edited and that the prose path is unchanged, but did not run them; they pass under `./quality.sh`
- **met** — A review-fix push that changes only the facts file refreshes the PR body (digest test). — evidence: `worker/deno/tests/pr_body_sync_test.ts::sync - a facts-only change refreshes the body (Issue #3535)` — reviewer: met
- **met** — The quality gate passes. — evidence: `./quality.sh < /dev/null` — reviewer: partial — reason: the reviewer judged the diff before the gate ran; the result is recorded in the Test Plan
- **unrequested** — Sweep-ledger slice, facts path in the legacy diff pathspec, docs edits, `pr_summary_facts_test.ts` and the extra sync tests. — evidence: `docs/audits/lib-sweep-coverage/top-up-3535.json; worker/deno/lib/pr_body_sync.ts; docs/USAGE.md; docs/INTERNALS.md; docs/workflows/issue-processing.md; worker/deno/tests/pr_summary_facts_test.ts` — reviewer: unrequested — reason: the ledger slice is required by the sweep gate; the pathspec keeps legacy bodies refreshing on a facts-only push; the docs edits follow the docs-change rule

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — A Code Change Owes a Docs Change: the operator docs describe the facts file. No prompt under `prompts/` tells agents to write it yet; the file is opt-in, and teaching agents to write it is a later part of #3396, outside this issue. — evidence: `docs/workflows/issue-processing.md; docs/USAGE.md; docs/INTERNALS.md` — reviewer: clean
- **clean** — Fail loud: an unreadable file is an error, not absent. Persisted digest: the old shape is read and pinned by a test. Named tests exist. No test-only members. Australian English. — evidence: `worker/deno/tests/pr_body_sync_test.ts::sync - with no facts file the digest input is the summary alone; worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts::completion facts - an unreadable facts file blocks rather than reading as absent (Issue #3535)` — reviewer: clean
- **clean** — An orphaned doc comment in the completion facts test was found and removed. — evidence: `worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts` — reviewer: clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
