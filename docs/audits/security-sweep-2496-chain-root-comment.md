# 🔎 Security sweep — chain-root report and held-issue gate comment

**Issue:** [#2496](https://github.com/stSoftwareAU/VibeCoder/issues/2496) (chunk
top-up-2496) · **Parent:** #1209 · extended by
[#2531](https://github.com/stSoftwareAU/VibeCoder/issues/2531)

This is the written record for the modules that entered `worker/deno/lib/` under
#2496 and its follow-on #2531 — both are comment writers keyed by a hidden
marker, so they share one reading:

- `worker/deno/lib/chain_root_comment.ts` (#2496)
- `worker/deno/lib/held_issue_gate_comment.ts` (#2531)

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2496**, and this file is the reading of it.

## `worker/deno/lib/chain_root_comment.ts`

Two exports with behaviour: `buildChainRootUnworkableComment` (pure; renders a
Markdown body and a dedup key) and `postChainRootUnworkableComment` (reads the
blocked issue's comment thread, then posts at most one comment). It is the
first module in the chain-promotion milestone that **writes** to GitHub, so
the reading below is about two surfaces: what reaches the comment body, and
what can stop the comment being written.

| Input                                                | Decision                            | Handling                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root.repo` (parsed from an attacker-writable body)   | rendered, and keyed on              | `safeRepo` keeps only `[A-Za-z0-9._/-]`, capped at 120 chars, so a crafted reference can neither close the marker's `key="…"` attribute nor open a second HTML comment                                                                 |
| `detail` for `assigned` (an assignee login)           | rendered as an `@mention`           | `safeLogin` keeps only GitHub's own login alphabet `[A-Za-z0-9-]`, capped at 39 chars; an empty result renders "an unnamed account" rather than a bare `@`                                                                              |
| `detail` for every other reason                       | not rendered                        | the wording for `no-discovery-label`, `needs-human` and `cross-repo-unmonitored` is fixed text plus the sanitised ref, so a label list never reaches the body                                                                           |
| `reason`                                              | selects the sentence                | a closed union (`ChainRootReason`) the resolver produces, never free text                                                                                                                                                              |
| the `gh` invocation                                   | argv array                          | `["api", "-X", "POST", "repos/<repo>/issues/<n>/comments", "-f", "body=…"]` — no shell, no string-built command, so the body cannot become an argument or a flag                                                                        |
| an existing marker comment                            | may suppress for 24 h               | only when `isFleetAuthor(author, fleetAuthors)` holds. A comment body is text anyone who can comment may write and only the author is authenticated, so an unauthenticated marker match is discarded and the report is posted           |
| `fleetAuthors`                                        | required, not optional              | an empty or unresolved set suppresses nothing, so the failure direction is a duplicate comment rather than a silently suppressed one (`marker_dedup_author_cap_test.ts` caps this class tree-wide)                                      |
| an unreadable or unparseable comment thread           | throws                              | `fetchMarkerComments` fails loud; a blind read must never pass as "no marker", which is how the branch-lock and PR-claim markers leaked (#2265/#2266). The caller (`findOldestIssue`) logs at WARNING and carries on                    |
| an unparseable `created_at`                           | posts                               | `Date.parse` yields `NaN`, the comparison is false, and the comment is posted — a duplicate informational comment is a smaller harm than a suppressed one                                                                               |

**No label is applied, ever.** The module imports neither `escalateToHuman`,
`escalateUnworkableWorkOn` nor `addLabelToIssue`, and the body names no
workflow label as a request. The only GitHub state it changes is one issue
comment on the blocked issue, which is the least privilege the report needs:
the worker cannot apply `top-priority`, and `needs-human` stays behind its own
chokepoint (`needs_human_direct_label_check.ts` is the standing gate).

**Blast radius of a wrong verdict.** The worst outcome is a comment that names
the wrong root or repeats itself: no candidate changes tier, no issue changes
state, and nothing is claimed or released. The caller wraps the whole report in
a `try`/`catch` and logs at WARNING, so a failing report cannot cost the scan
its selection — pinned by `find_oldest_issue_test.ts::a failed chain-root
comment never costs the scan its selection`.

## `worker/deno/lib/held_issue_gate_comment.ts`

Two exports with behaviour: `buildHeldIssueGateComment` (pure; renders the body
and the gate key) and `upsertHeldIssueGateComment` (reads the held issue's
thread, then writes **at most one** comment — POST when there is none, PATCH
when the gate moved on, nothing when it did not). It is the first module in the
fleet that **edits** an existing comment, so the reading adds one surface the
chain-root sweep above did not have: which comment id the fleet is willing to
rewrite.

| Input                                                      | Decision                     | Handling                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependency.repo` / `root.repo` (parsed from a body)       | rendered, and keyed on       | both go through `renderRef`, which is `chain_root_comment.ts`'s own `safeRepo` — the sanitiser is reused, not restated, so the two modules cannot drift                                                          |
| `milestone` (a GitHub API title)                           | rendered, and keyed on       | `safeMilestone` keeps `[A-Za-z0-9._/ -]`, capped at 120 chars: spaces and slashes survive because real milestone names use them, while `"`, `<`, `>` and newlines cannot close the `key="…"` attribute            |
| `rootDetail` (a login, repo or label)                      | rendered, and keyed on       | the visible sentence sanitises it through `reasonSentence`; the key takes its own `safeDetail` pass (`[A-Za-z0-9._/-]`, 60 chars) because the key interpolates the raw value rather than the rendered sentence    |
| `prNumber` / `issueNumber` / `dependency.number`           | rendered, and keyed on       | typed `number`, never free text                                                                                                                                                                                 |
| `rootReason`                                               | selects the sentence         | the same closed `ChainRootReason` union the resolver produces                                                                                                                                                    |
| the `gh` invocations                                       | argv arrays                  | POST and PATCH are both argv, no shell; `-f body=…` is a raw field with no `@file` expansion, so a body beginning `@` cannot read a local file                                                                    |
| an existing marker comment                                 | may suppress or be rewritten | only when `isFleetAuthor(author, fleetAuthors)` holds. A stranger's marker neither suppresses the post nor — the sharper harm, new to this module — hands the fleet a comment id to overwrite                     |
| `fleetAuthors`                                             | required, not optional       | an empty set trusts nothing and posts, so the failure direction is a duplicate rather than an edit of someone else's comment (`marker_dedup_author_cap_test.ts` caps this class tree-wide)                        |
| several fleet markers on one thread                        | edits the newest             | `fetchMarkerComments` returns page order, so the newest is `ours.at(-1)`; older ones are left alone rather than deleted, because deletion is outside this module's three-outcome contract                        |
| an unreadable or unparseable comment thread                | throws                       | as above, a blind read must never pass as "no marker" (#2265/#2266)                                                                                                                                              |
| a refused `PATCH`                                          | throws                       | `updateIssueComment` returns `Promise<void>` rather than mirroring `deleteIssueComment`'s `Error \| null`: a swallowed edit would leave the stale gate on the thread reading as current                           |

**No label is applied, ever**, and the body says so in as many words. The
module imports no labelling helper, and the only GitHub state it changes is one
comment on the held issue.

**Blast radius of a wrong verdict.** The worst outcome is one comment naming a
gate that has since moved: no tier changes, nothing is claimed or released. The
module has no production caller yet by design — the scan wiring is a separate
sub-issue — so today the blast radius is bounded by its tests.
