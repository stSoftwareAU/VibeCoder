## Summary

Adds the skills guide's triggering test for `review-fleet-prs`: 14
should-trigger and 16 should-not-trigger queries in
`.claude/skills/review-fleet-prs/references/trigger-queries.md`. The file
also holds a safe procedure for re-running them and a results table, and
`SKILL.md` links to it. Closes #3426, with one gap: the recorded result
comes from a stand-in judgement, not from live skill loads. This worker
run's nested `claude -p` session is not signed in. The live run is the
manual check the file describes, and its row replaces the stand-in row.

## Spec

### Intent and Rationale

- The frontmatter test checks the description's shape but not when it makes
  the skill load. The query lists make that a repeatable manual check.
- The stand-in found no under- or over-triggering (14 of 14, 0 of 16). The
  issue says to change the description only if a test shows a problem, so
  this PR leaves it alone. No "Do not use for …" clause was added on
  speculation.

### Essential Design Decisions

- The procedure stops each session as soon as you can see whether the skill
  loaded: Esc, or `--max-turns 1` with `Bash Edit Write` denied. A
  should-trigger query that runs to completion would review and approve real
  PRs.
- The new reference file is linked from `SKILL.md`. Rule (d) of
  `worker/deno/tests/review_fleet_prs_skill_links_3300_test.ts` requires
  every file under `references/` to be linked.

### Undiscoverable Facts

- `claude -p "start the review loop" … --max-turns 2 --disallowedTools "…"`
  in this worktree failed with `Not logged in · Please run /login`
  (`error: authentication_failed`). The worker gives child sessions no
  credentials, so this run made no attempt to sign one in.
- Stand-in method: one fresh sub-agent read the session's skill listing
  (with the current description) and the 30 queries, shuffled. It judged
  each query independently as the first message of a new session. This is a
  model judgement, not an observed `Skill` tool call.

## Evidence

Backend/docs-only change: no UI files.

Stand-in result (current description, no negative trigger):

| List | Loaded `review-fleet-prs` | Target |
| ---- | ------------------------- | ------ |
| Should trigger | 14 of 14 (100%) | ≥ 90% |
| Should not trigger | 0 of 16 | 0 |

The near misses went to `code-review` ("Review the PR I just opened", a PR
URL, "review the changes on my current branch"), `security-review`,
`dataviz`, or no skill. Hit rate before and after is the same, because the
description did not change.

**Docs sweep** — grep: `trigger-queries`, `references/{running-unattended`,
"triggering test\w*", "Building Skills"; section: `docs/REFERENCES.md`
(skills-guide row); updated: `docs/REFERENCES.md`,
`.claude/skills/review-fleet-prs/SKILL.md`, the module doc in
`worker/deno/tests/review_fleet_prs_skill_links_3300_test.ts`;
`docs/CONFIGURATION.md` — still true because its deep links into the skill
are unchanged.

## Test Plan

- `worker/deno/tests/review_fleet_prs_skill_links_3300_test.ts` and
  `worker/deno/tests/claude_skill_frontmatter_test.ts`: ran on the head,
  32 passed, 0 failed. The links test covers the new `SKILL.md` link
  and the new file's own links. No test was added: the behaviour under test
  needs a live model, and the issue sets it as a manual check. The only test
  file edit is a reworded doc comment, so no assertion was removed.
- `./quality.sh < /dev/null` on the head: `Result: PASSED (with skipped
  checks)`. Only `config integration` was skipped.

Branch outcomes: none added
