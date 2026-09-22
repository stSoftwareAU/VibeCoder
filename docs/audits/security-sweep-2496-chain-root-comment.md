# 🔎 Security sweep — chain-root report (`chain_root_comment.ts`)

**Issue:** [#2496](https://github.com/stSoftwareAU/VibeCoder/issues/2496) (chunk
top-up-2496) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2496:

- `worker/deno/lib/chain_root_comment.ts`

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
