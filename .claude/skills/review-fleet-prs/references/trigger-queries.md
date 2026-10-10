# Triggering queries

The skills guide's triggering test for this skill: two query lists, and a
record of how often the `description` in [../SKILL.md](../SKILL.md) makes a
fresh session load the skill. The target is at least 90% of the
should-trigger queries, and none of the should-not-trigger ones. Rerun it
whenever the `description` changes, and add a row to [Results](#results).

No test in CI can do this: it needs a live model. The frontmatter test
(`worker/deno/tests/claude_skill_frontmatter_test.ts`) checks only the
description's shape.

## Should trigger

1. Start the review loop.
2. Approve the green fleet PRs.
3. Run the unattended review loop.
4. Go through the open Dependabot PRs across our repos and approve the ones
   that pass review.
5. Install the review loop so it keeps running without an open session.
6. Can you review whatever the VibeCoder bots have raised across the
   monitored repos?
7. Check the fleet's pull requests and approve the clean ones.
8. Kick off the fleet PR reviewer and leave it running.
9. Review the Dependabot and fleet PRs in stSoftwareAU/VibeCoder only.
10. There's a backlog of bot PRs waiting for approval; work through them.
11. Keep an eye on new fleet PRs and review them as they come in.
12. Set up scripts/run.sh so fleet PR review runs on a schedule.
13. Review all the open PRs the Vibe Coder workers raised today.
14. Approve the Dependabot dependency-bump PRs once their CI is green.

## Should not trigger

Near misses first, then unrelated tasks.

1. Review the PR I just opened.
2. Review this PR: https://github.com/stSoftwareAU/VibeCoder/pull/3600
3. Review the changes on my current branch before I open a PR.
4. Respond to the review comments on my PR.
5. Summarise the review comments left on PR 3541.
6. Check why CI is red on PR 3528.
7. Fix the failing CI on my pull request.
8. List the open Dependabot PRs.
9. How many PRs has the fleet opened this week?
10. Explain how the fleet's merge enforcement works.
11. Draw a chart of how long fleet PRs take to merge.
12. Do a security review of the pending changes on this branch.
13. Fix the failing test in
    worker/deno/tests/claude_skill_frontmatter_test.ts.
14. Bump the Deno dependencies in this repo.
15. Rebase my branch onto main.
16. Open a PR for the changes I have made.

## Running it

Run each query as the first message of a fresh Claude Code session opened in
the VibeCoder checkout, and note whether the session loads
`review-fleet-prs` (a `Skill` tool call naming it) before doing anything
else.

A should-trigger query that loads the skill goes on to act: it would review,
approve and post on real PRs. Stop each session as soon as you see whether
the skill loaded — press Esc in an interactive session, or in print mode
cap the run at one turn and deny the tools that act:

```sh
claude -p "Start the review loop." --max-turns 1 \
  --disallowedTools "Bash Edit Write" --output-format stream-json --verbose
```

If too few should-trigger queries load the skill, add their phrasing to the
description. If any should-not-trigger query loads it, add a "Do not use
for …" clause. The frontmatter test holds the description to 1,024
characters.

## Results

| Date | Description | Method | Should trigger | Should not trigger |
| ---- | ----------- | ------ | -------------- | ------------------ |
| 2026-10-10 | As of #3426 (no negative trigger) | Stand-in: one fresh sub-agent judged every query against the session's skill listing | 14 of 14 loaded (100%) | 0 of 16 loaded |

The 2026-10-10 row is a stand-in, not an observed load: the worker run that
added this file could not start a signed-in `claude` session (`Not logged
in · Please run /login`). The near misses went to `code-review` (queries 1
to 3), `security-review` (12), `dataviz` (11) or no skill. No change to the
description followed. The first live run replaces it.
