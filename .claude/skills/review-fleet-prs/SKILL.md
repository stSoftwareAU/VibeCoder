---
name: review-fleet-prs
description: Review open PRs by Dependabot and the VibeCoder fleet accounts across the monitored repos. Once CI is green, a Fable reviewer checks each PR; clean PRs are approved, PRs with blocking problems get a request for changes, and PRs that change an existing test in a meaningful way are held for the owner. Watches for new PRs every 5 minutes without spending tokens while there is nothing to review.
---

# Review fleet PRs

Reviews the open PRs that Dependabot and the fleet accounts raise across the
repos in this checkout's `.config.json`, as the signed-in `gh` user. The aim
is that most PRs are approved without the owner: CI is clean, new
functionality is tested where appropriate, no existing test is meaningfully
changed, and a Fable review is happy.

Start it once, in a Claude Code session opened in the VibeCoder checkout, and
leave the session running:

```
/review-fleet-prs
```

Optional argument: `owner/name` to review one repo only.

## Rules

1. **Only PRs into the default branch are reviewed.** A PR into a milestone
   branch needs no approval; the milestone's own PR into the default branch
   gets the review.
2. **Nothing is reviewed until CI is green.** Pending checks wait; failing
   checks, merge conflicts and drafts belong to the fleet, so leave them
   alone and post nothing.
3. **New functionality needs a test where appropriate.** Fable judges it: a
   refactor, docs, config or workflow change may not need one; new behaviour
   or a bug fix does.
4. **Meaningful changes to existing tests are the owner's call.** The PR is
   held for the owner with a comment-only review; it is neither approved nor
   sent back. A removed test file is always meaningful. Trivial edits
   (formatting, renames, imports, added cases, fixture paths) are not.
5. **Blocking problems go back to the fleet** as a request for changes. The
   worker acts on change requests from the reviewers in `pr_reviewers`.
6. **Otherwise approve.** Never approve on doubt.
7. **Review each head commit once.** A new push gets a fresh review.

## The loop

The gate script does the polling, not the model. With `--watch=300` it checks
every 5 minutes and **exits only when a PR is ready for review**, so an idle
night costs no tokens.

1. Start the gate in the background, from this skill's base directory, with
   the Bash tool's `run_in_background: true`:

   ```bash
   deno run --allow-run=gh --allow-read gate.ts --watch=300 [--repo=owner/name]
   ```

2. Do nothing until it finishes: you are re-invoked when it exits. Do not
   poll it, sleep, or schedule wake-ups.
3. When it exits 0, read its one line of JSON, `{ ready: [...], skipped: {...} }`,
   and review every `ready` PR (steps below).
4. Start step 1 again, adding `--sleep-first`. The PRs just reviewed are now
   `already-reviewed` at their head commit, so the gate does not report them
   again; one whose review failed, or that was over the per-round limit, is
   reported after the next interval rather than straight away.

If the gate exits non-zero it could not reach GitHub for an hour; report its
error and stop.

For a single pass instead of the loop, run it without `--watch`: it prints
the ready PRs (possibly none) and exits.

## Reviewing the ready PRs

### 1. Fable review

Take at most **5** PRs per round, so a backlog cannot burn a night's quota in
one go; the rest come back on the next gate run. Launch one Agent per PR in a
single message so they run in parallel, each with `model: "fable"` and
`subagent_type: "general-purpose"`, and this prompt (fill in the fields):

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
> 4. Check the tests. New behaviour and bug fixes need a test that would fail
>    without the change; a pure refactor, docs, config or workflow change may
>    not. {noTestAdded: "The PR changes code but adds no test: decide whether
>    one was needed."} A missing test that was needed is a finding.
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
that PR; the next gate run reports it again.

### 2. Decide and post

First re-read the head commit (`gh pr view {number} -R {repo} --json
headRefOid`). If it moved since the gate ran, post nothing; the next gate run
reports the new commit.

Treat the test changes as meaningful if Fable said `meaningful` **or** the
gate's `testChanges.removed` is not empty. Then, in this order:

| Outcome | Command |
|---|---|
| Fable `findings` not empty | `gh pr review {number} -R {repo} --request-changes --body-file <file>` |
| Meaningful test changes | `gh pr review {number} -R {repo} --comment --body-file <file>` |
| Anything else | `gh pr review {number} -R {repo} --approve --body-file <file>` |

Bodies:

- **Request changes:** each finding as `` `file:line` ``, the problem, then
  the fix. If there are also meaningful test changes, list them too, so the
  fix does not hide them.
- **Held for the owner:** start with `Held for owner review: this PR changes
  existing tests.` then each `testChangeNotes` entry (and each removed test
  file), then the summary. Use a comment-only review: the worker ignores
  those, so the fleet does not try to "fix" the hold.
- **Approve:** the summary.

Write bodies to a file in the scratchpad rather than inline, so backticks and
quotes survive. End every body with the line
`_Automated review by /review-fleet-prs (Fable)._`. The gate looks for that
marker to know a comment-only review was already posted for a commit.

### 3. Report

One short line per round: approved, changes requested, and held for the
owner, each with PR links. Then go back to the loop.

## Notes

- Approval counts only because `gh` is signed in as a reviewer the repos'
  rulesets accept (`pr_reviewers` in the config). A fleet PR with auto-merge
  armed merges soon after approval, so the review is the last line of
  defence.
- PRs authored by the signed-in user are never candidates: GitHub does not
  let an author approve their own PR.
- Cost while idle: one GraphQL search (about 2 points) every 5 minutes, and
  no model tokens. Each ready PR adds one REST call for its file list.
