---
name: review-fleet-prs
description: Review open PRs by Dependabot and the VibeCoder fleet accounts across the monitored repos. Once CI is green, a Fable reviewer checks each PR; clean PRs are approved, PRs with blocking problems get a request for changes, and PRs that change an existing test in a meaningful way are held for the owner. Run periodically with /loop.
---

# Review fleet PRs

Reviews the open PRs that Dependabot and the fleet accounts raise across the
repos in this checkout's `.config.json`, as the signed-in `gh` user. It is
built to run unattended, for example overnight, from a Claude Code session
started in the VibeCoder checkout:

```
/loop 30m /review-fleet-prs
```

Optional argument: `owner/name` to review one repo only.

## Rules

1. **Nothing is reviewed until CI is green.** Pending checks mean come back
   next pass; failing checks, merge conflicts and drafts belong to the fleet,
   so leave them alone and post nothing.
2. **New functionality needs tests.** A fleet PR that adds code without adding
   or extending a test gets a request for changes. Dependabot bumps are
   exempt.
3. **Meaningful changes to existing tests are the owner's call.** The PR is
   held for the owner with a comment-only review; it is neither approved nor
   sent back. A removed test file is always meaningful. Trivial edits
   (formatting, renames, imports, added cases, fixture paths) are not.
4. **Blocking problems go back to the fleet** as a request for changes. The
   worker acts on change requests from the reviewers in `pr_reviewers`.
5. **Otherwise approve.** Never approve on doubt.
6. **Review each head commit once.** A new push gets a fresh review.

## Steps

### 1. Run the gate

From this skill's base directory:

```bash
deno run --allow-run=gh --allow-read gate.ts [--repo=owner/name]
```

It prints `{ reviewer, candidates: [...] }` and posts nothing. Each candidate
has a `state`:

| state | action |
|---|---|
| `ready` | Fable review (step 2) |
| `missing-tests` | Request changes with the `reasons` (step 3), no model review |
| `waiting-ci`, `ci-failed`, `conflicting`, `draft`, `already-reviewed` | Nothing |

`testChanges` lists the existing test files the PR removes or edits.

If nothing is `ready` or `missing-tests`, report the counts per state in one
line and stop.

### 2. Fable review of each `ready` PR

Take at most **5** `ready` PRs per pass, oldest first, so a backlog cannot burn
a night's quota in one go. Launch one Agent per PR in a single message so
they run in parallel, each with `model: "fable"` and `subagent_type:
"general-purpose"`, and this prompt (fill in the fields):

> You are reviewing PR #{number} in {repo} ("{title}"), authored by {author}
> ({kind}), head commit {headSha}, base {baseRef}. CI has passed. You are a
> read-only reviewer: do not comment, review, push, edit files or change any
> state on GitHub. Read with `gh pr view`, `gh pr diff {number} -R {repo}`
> and `gh api repos/{repo}/contents/<path>?ref={headSha}`.
>
> 1. Read the linked issue (from the PR body or title) and the repo's
>    `AGENTS.md` / `CODING-STANDARDS.md` if they exist.
> 2. Check that the change does what the issue asks and nothing unrelated.
> 3. Look for correctness bugs, unhandled edge cases, security problems
>    (injection, secrets, unsafe permissions in workflows), race conditions
>    and regressions for existing callers.
> 4. Check the tests: the new behaviour must be exercised by a test that would
>    fail without the change.
> 5. Judge every change to an existing test: {testChanges}, plus any inline
>    test module (e.g. Rust `#[cfg(test)]`) the diff touches. A change is
>    **meaningful** if it removes a test case, weakens or deletes an
>    assertion, changes an expected value or expected behaviour, or skips or
>    loosens a test. It is **trivial** if it only reformats, renames,
>    updates imports or fixture paths, or adds cases or assertions.
> 6. For Dependabot: check the changelog or release notes for breaking changes
>    that affect how this repo uses the dependency, and that a major bump is
>    reflected in the code where needed.
>
> Only report **blocking** findings: things that are wrong, unsafe or
> untested. Style preferences and optional polish are not blocking. A
> meaningful test change is not a finding; report it under `testChanges`. Do
> not guess: every finding needs a file and line from the diff and a concrete
> failure scenario.
>
> Reply with only this JSON:
> `{"summary": "<one or two sentences>", "findings": [{"file": "...", "line": 0, "problem": "...", "fix": "..."}], "testChanges": "none" | "trivial" | "meaningful", "testChangeNotes": [{"file": "...", "line": 0, "change": "<what changed and why it matters>"}]}`

If an agent fails or returns something that isn't this JSON, post nothing for
that PR; it is retried next pass.

### 3. Decide and post

First re-read the head commit (`gh pr view {number} -R {repo} --json
headRefOid`). If it moved since the gate ran, post nothing; the next pass
reviews the new commit.

Treat the test changes as meaningful if Fable said `meaningful` **or** the
gate's `testChanges.removed` is not empty. Then, in this order:

| Outcome | Command |
|---|---|
| `missing-tests`, or Fable `findings` not empty | `gh pr review {number} -R {repo} --request-changes --body-file <file>` |
| Meaningful test changes | `gh pr review {number} -R {repo} --comment --body-file <file>` |
| Anything else | `gh pr review {number} -R {repo} --approve --body-file <file>` |

Bodies:

- **Request changes:** each finding as `` `file:line` ``, the problem, then
  the fix (or the gate's `reasons`: new code needs a test). If there are also
  meaningful test changes, list them too, so the fix does not hide them.
- **Held for the owner:** start with `Held for owner review: this PR changes
  existing tests.` then each `testChangeNotes` entry (and each removed test
  file), then the summary. Use a comment-only review: the worker ignores
  those, so the fleet does not try to "fix" the hold.
- **Approve:** the summary.

Write bodies to a file in the scratchpad rather than inline, so backticks and
quotes survive. End every body with the line
`_Automated review by /review-fleet-prs (Fable)._`. The gate looks for that
marker to know a comment-only review was already posted for a commit.

### 4. Report

One short summary per pass: approved, changes requested, and held for the
owner (with PR links), plus counts of the states that were skipped.

## Notes

- Approval counts only because `gh` is signed in as a reviewer the repos'
  rulesets accept (`pr_reviewers` in the config). A fleet PR with auto-merge
  armed merges soon after approval, so the gate and the review are the last
  line of defence.
- PRs authored by the signed-in user are never candidates: GitHub does not
  let an author approve their own PR.
- The gate reads only the config's `repos`, `fleet_pr_authors` and
  `service_accounts`. It uses about one GraphQL call per repo per pass, plus
  two REST calls per PR whose CI is green.
