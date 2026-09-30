# Security sweep — milestone fix PR (`milestone_fix_pr.ts`)

**Issue:** [#2907](https://github.com/stSoftwareAU/VibeCoder/issues/2907) (chunk
top-up-2907) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/milestone_fix_pr.ts` — added by #2907.

## `worker/deno/lib/milestone_fix_pr.ts`

The module raises (or reuses) a side-branch PR that lands a fix into a
ruleset-gated `milestone/**` branch, mirroring `raiseMilestoneSyncPr`
(Issue #589). The caller has already pushed the fix branch; this module only
calls `gh` to list, create, arm and comment on PRs and to clear stale review
requests.

Shapes checked:

| Property                                             | Result                                                                                                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo` is validated before use in any `gh` argv        | `raiseMilestoneFixPr` rejects any `repo` not matching `REPO_PATTERN` (`owner/repo`, GitHub's own character set) before it reaches a `gh` command                                                                          |
| branch/PR arguments never build a shell string         | every `gh` call is an argv array passed to the injected `deps.gh`, not a concatenated shell command — no injection surface even though branch names and PR bodies embed caller-supplied text                              |
| fix branches are namespaced and validated              | `milestoneFixBranchFor`/`milestoneFixPrefixFor` sanitise `milestoneBranch` and the discriminator to `[A-Za-z0-9._-]`, and `raiseMilestoneFixPr` refuses a `fixBranch` that does not start with `milestone-fix/` via `isMilestoneFixBranch` |
| the target must actually be a milestone branch         | `raiseMilestoneFixPr` refuses a `milestoneBranch` that does not start with `milestone/`, so it cannot be pointed at an arbitrary base branch                                                                              |
| one open fix PR per milestone PR                       | `findOpenMilestoneFixPr`/the inline listing in `raiseMilestoneFixPr` search for an already-open PR from the same branch prefix and reuse it rather than duplicate                                                          |
| auto-merge arming failures are never silent            | `armMilestoneFixPrAutoMerge` is best-effort by design (the fleet's Auto-Merge sweep retries), but every failure is both logged and posted as a PR comment; a failed comment post is itself logged, not swallowed          |
| PR listing/creation failures fail loud                 | every `gh` call and `JSON.parse` is wrapped in `try/catch` returning `Result.ok === false` with the underlying error attached; an unparsable or unexpected-shape listing is a hard error, never treated as "no PR exists" |
| no untrusted GitHub API data drives a decision          | the only inputs are `gh pr list --json number,url,headRefName` output (repo-owned PR metadata) and caller-supplied repo/branch/PR-number values, all validated above; nothing here reads external free-text content       |

No findings. The module has unit test coverage in
`worker/deno/tests/milestone_fix_pr_test.ts` and
`worker/deno/tests/pr_feedback_processor_milestone_fix_test.ts`.
