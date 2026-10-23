# PR Summary — Issue #4081

## Summary

Comments that `pr_auto_merge.ts` posts into a target repository
(`gh pr comment --repo <target>`) no longer carry VibeCoder issue citations or a
bare `#N` milestone number, both of which GitHub autolinks against the target
repo's own issues and PRs.

- `postBehindSyncReason` drops `(Issue #2460)` from both outcome sentences and
  `(Issue #2005)` from the side-pick sentence; the provenance moves to a code
  comment.
- `postOpenChildrenLookupReason` names the milestone by its title in an inert
  code span (backticks in the title are swapped for `'`) plus an explicit
  `https://github.com/<repo>/milestone/<number>` link, rewrites the gate's
  `milestone #N` wording in the quoted detail to `this milestone`, and drops
  `(Issue #3909)`; that provenance moves to a code comment.

Closes #4081.

## Docs sweep

**Docs sweep** — grep: `armed anyway`, `side-picked`, `the gate refuses`, `could not be read`, `Issue #2460`, `milestone #`, `open-children count`, `declared dependencies`; section: `docs/INTERNALS.md` ("Unverifiable state blocks too") and `docs/MERGE.md#the-milestone-base-is-behind-the-default-branch`; siblings: none — no existing set gained a member; updated: none — every hit was read: the docs describe the behaviour (arm anyway, never side-picked, one comment naming the unreadable lookup) and cite issue numbers in manual prose, not the posted comment text; no sentence is made false, and no doc quotes the removed `(Issue #…)` suffixes or `milestone #N` wording.

## Test Plan

No assertion is removed from an existing test: the diff to `worker/deno/tests/pr_auto_merge_test.ts` only adds four tests.

- `pr_auto_merge - an unreadable open-children reason has no bare #N and links the milestone (Issue #4081)`
- `pr_auto_merge - an unreadable declared-dependencies reason has no bare #N and links the milestone (Issue #4081)`
- `pr_auto_merge - the armed in-cycle sync reason has no bare #N in the posted body (Issue #4081)`
- `pr_auto_merge - the unarmed in-cycle sync reason has no bare #N in the posted body (Issue #4081)`

**Branch outcomes:**
- `worker/deno/lib/pr_auto_merge.ts:285` — armed outcome text (`willArm` true) carries no `(Issue #2460)` — `worker/deno/tests/pr_auto_merge_test.ts::pr_auto_merge - the armed in-cycle sync reason has no bare #N in the posted body (Issue #4081)` — flipped by restoring `(Issue #2460)`, test went red
- `worker/deno/lib/pr_auto_merge.ts:289` — unarmed outcome text (`willArm` false) carries no `(Issue #2460)` — `worker/deno/tests/pr_auto_merge_test.ts::pr_auto_merge - the unarmed in-cycle sync reason has no bare #N in the posted body (Issue #4081)` — flipped by restoring `(Issue #2460)`, test went red
- `worker/deno/lib/pr_auto_merge.ts:425` — milestone title containing a backtick is neutralised in the code span — `worker/deno/tests/pr_auto_merge_test.ts::pr_auto_merge - an unreadable open-children reason has no bare #N and links the milestone (Issue #4081)` — flipped to keep the backtick, test went red
- `worker/deno/lib/pr_auto_merge.ts:427` — detail containing `milestone #N` is rewritten to `this milestone` (success) — `worker/deno/tests/pr_auto_merge_test.ts::pr_auto_merge - an unreadable open-children reason has no bare #N and links the milestone (Issue #4081)` — flipped to pass the detail through unchanged, test went red
- `worker/deno/lib/pr_auto_merge.ts:427` — detail without that phrase passes through unchanged (absent), a target-repo `#50` survives — `worker/deno/tests/pr_auto_merge_test.ts::pr_auto_merge - an unreadable declared-dependencies reason has no bare #N and links the milestone (Issue #4081)` — positive control `assertStringIncludes(body, "#50")`; the rewrite is a plain string replace of the exact phrase, so no flip of this outcome exists beyond the one above
- `worker/deno/lib/pr_auto_merge.ts:442` — milestone named by code span plus explicit link, no `#<number>` — `worker/deno/tests/pr_auto_merge_test.ts::pr_auto_merge - an unreadable declared-dependencies reason has no bare #N and links the milestone (Issue #4081)` — flipped (unlink and backtick flips above) and test went red
