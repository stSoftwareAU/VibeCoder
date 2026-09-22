# Document dependency-chain promotion and the unworkable-root comment

Closes #2497

## Summary

Documents the dependency-chain promotion behaviour and the chain-root-unworkable
comment across the three operator-facing surfaces, so the `promoted-dependency=`
scan-log line and the comment can be understood without reading code.

- **`DESIGN-PRINCIPLES.md`** — new `### A blocked issue promotes its chain rather
  than yielding the fleet` in the deferral section: why a blocked `top-priority`
  issue promotes its chain instead of handing the host to `low-priority` work,
  the three boundaries that keep promotion honest (rank not eligibility, no
  labels written, an unreadable chain is never assumed closed), the log line, the
  four root classifications, and a Mermaid `flowchart TD` of the walk mirroring
  the one from #2493.
- **`docs/INTERNALS.md`** — new `#### 🔗 Dependency-chain promotion` covering
  `resolveChainPromotions()`, the exact
  `promoted-dependency=<owner/repo>#<N> for #<M>` format,
  `SelectionResult.unworkableChainRoots`, the four-row `ChainRootReason` table,
  and the fact that `configured-label-blocked=N` is unchanged by promotion. The
  existing `### 🔗 Forward dependencies` section now points at it.
- **`docs/TROUBLESHOOTING.md`** — new entry
  `### Top-priority issue blocked but fleet works low-priority` with a symptom,
  expected behaviour, a three-step diagnosis (scan log → comment → fleet-assignee
  silence) and the four-reason table.

Australian English throughout; all cross-document anchors verified to resolve.

**Note on commit history:** the worker's periodic auto-commit captured the bulk
of these edits as `2dcdd270`, whose message cites #4170 rather than #2497. That
commit was already pushed, so it was not amended or force-pushed; the follow-up
commit `cd0c7604` carries the `#2497` reference.

## Evidence

Cumulative diff against base `47ee34e`:

```text
DESIGN-PRINCIPLES.md    | 79 ++++++++++++++++++++++++++++++++++++++++++++
docs/INTERNALS.md       | 73 ++++++++++++++++++++++++++++++++++++++++
docs/TROUBLESHOOTING.md | 57 +++++++++++++++++++++++++++++++
3 files changed, 209 insertions(+)
```

Gates (all run with stdin redirected from `/dev/null`):

```text
mermaid: PASSED (3706 file(s), 991 block(s) checked)
markdownlint: PASSED (188 file(s) checked)
./quality.sh → Result: PASSED (with skipped checks), exit 0
```

Documentation-only change — no screenshots apply; the Mermaid validator is the
automated proof the diagrams parse.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **AC1 — all three documents mention `promoted-dependency=` and the
  chain-root-unworkable comment.** `reviewer: met`
- **AC2 — the Mermaid diagram renders on GitHub.** `reviewer: met` — the repo
  Mermaid validator passes (991 blocks across 3706 files); both new diagrams
  parse.
- **AC3 — `./quality.sh` (markdown lint) passes.** `reviewer: met` —
  markdownlint-cli2 reports 0 issues; the full gate exits 0.
- **`DESIGN-PRINCIPLES.md:2673-2685` — the "Three boundaries" block.**
  `reviewer: unrequested` — `reason:` the issue asked for the promotion rule and
  a diagram, not an explicit boundary list; kept because the boundaries
  (promotion changes rank not eligibility, no labels written, an unreadable chain
  is never assumed closed) are the design's actual invariants and omitting them
  invites operators to expect label changes.
- **`docs/TROUBLESHOOTING.md:689-691` — the ready-made `grep` recipe.**
  `reviewer: unrequested` — `reason:` the issue asked the entry to point at the
  log line; the concrete command is how a troubleshooting entry is actionable and
  matches the surrounding entries' style.

**Accuracy corrections applied after the review ran.** The spec reviewer found
six factual inaccuracies in the first draft; each was independently confirmed
against the source and fixed in `cd0c7604`, after the reviewer's verdicts above
were recorded: `chain-root-in-progress` is `ISSUE_FINDER_DEBUG`-gated (it routes
through `emit()`, unlike `logDependencyPromoted` which calls `write` directly);
`configured-label-blocked=N` counts work-on blocked candidates as well as
configured-label ones; that counter only appears on a `selection-reasoning` line,
which is conditional; "a cycle promotes nothing" was over-broad (it terminates on
its own members, off-cycle members still promote); "every blocked candidate" now
notes `noteChainBlocked` skips an entry naming no blocker; and the comment dedup
key includes the blocked issue number, not just root and reason.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **Missing `docs/archive/pr-summaries/pr-summary-2497.md`** — resolved by this
  file.
- **Commit `2dcdd270` cites #4170, not #2497** — that auto-commit was already
  pushed, so amending or force-pushing it is off the table; `cd0c7604` carries
  the `#2497` reference and the run-id trailer, and the discrepancy is recorded
  in the Summary above.
- **DRY: `docs/INTERNALS.md:1678-1691` overlaps the existing
  `#### 💬 Reporting a chain root nobody can move` section (2807-2852)** —
  **declined, recorded as a departure.** The overlap is a four-row table of the
  `ChainRootReason` enum values, which the issue asked to be documented alongside
  `resolveChainPromotions` and `unworkableChainRoots`; the comment *mechanics*
  are not restated — the section cross-links to 2807-2852, which remains their
  single source of truth.
- **DRY / token economy: the promotion behaviour is restated across
  `DESIGN-PRINCIPLES.md:2677-2704`, `docs/INTERNALS.md:1653-1671` and
  `docs/TROUBLESHOOTING.md:693-717`** — **declined, recorded as a deliberate
  departure.** The issue explicitly asks for the behaviour in all three
  documents, each addressing a different audience (why / how / what to do when it
  looks wrong). The three sections cross-link rather than duplicate detail:
  mechanics live in INTERNALS, rationale in DESIGN-PRINCIPLES, and the operator
  recipe in TROUBLESHOOTING.
- **Marginal file-size violation at `docs/INTERNALS.md:1632`** — not actioned.
  `docs/INTERNALS.md` is the established home for this material and splitting it
  is out of scope for a documentation issue; noted for a possible follow-up.
- **Clean areas:** Australian English, Mermaid conventions, markdownlint
  structural rules, link/anchor integrity, symbol accuracy, commit safety, Deno
  conventions, fail-loud.

## Test Plan

Documentation-only; no runtime code changed, so no unit tests were added.

1. `cd worker/deno && deno run -A mod.ts check-mermaid --script-dir <repo root> < /dev/null`
   → `mermaid: PASSED (3706 file(s), 991 block(s) checked)`.
2. `cd worker/deno && deno run -A mod.ts check-markdownlint --script-dir <repo root> < /dev/null`
   → `markdownlint: PASSED (188 file(s) checked)`.
3. `timeout 900 ./quality.sh < /dev/null` → `Result: PASSED (with skipped
   checks)`, exit 0 (only `config integration` skipped, as usual off-host).
4. Every new cross-document anchor
   (`#-dependency-chain-promotion`,
   `#-reporting-a-chain-root-nobody-can-move`,
   `#a-blocked-issue-promotes-its-chain-rather-than-yielding-the-fleet`,
   `#top-priority-issue-blocked-but-fleet-works-low-priority`) checked against
   its target heading.
