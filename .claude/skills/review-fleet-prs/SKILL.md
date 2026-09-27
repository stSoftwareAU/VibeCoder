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
4. **A test is never removed or loosened to make the quality gate pass.** A
   test removed, skipped, weakened or loosened without the linked issue
   requiring it is a blocking finding: the PR goes back to the fleet to
   restore it. A deliberate change the issue does require (an expected value
   or behaviour the issue changes, or deleting a test that only pinned the
   old implementation) is the owner's call: the PR is held with a
   comment-only review, neither approved nor sent back. Trivial edits
   (formatting, renames, imports, added cases, fixture paths) are not, and
   neither are edits that only **tighten** a test (it now asserts more or
   allows less, as the issue asks): those are approved.
5. **Blocking problems go back to the fleet** as a request for changes. The
   worker acts on change requests from the reviewers in `pr_reviewers`.
6. **Otherwise approve.** Never approve on doubt.
7. **Review each head commit once.** A new push gets a fresh review. When
   the fleet pushes a fix to a PR that was sent back, the re-review checks
   the earlier findings were fixed, and approves once they are.

## The loop

The gate script does the polling, not the model. With `--watch=300` it checks
every 5 minutes and **exits only when a PR is ready for review**, so an idle
night costs no tokens.

1. Start the gate in the background, from this skill's base directory, with
   the Bash tool's `run_in_background: true`:

   ```bash
   deno run --allow-run=gh --allow-read --allow-write --allow-env=HOME gate.ts --watch=300 [--repo=owner/name]
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
>    updates imports or fixture paths, or adds cases or assertions. It is
>    **tightened** if an expected value or behaviour changes only to make
>    the test stricter, as the issue asks: it now asserts more, allows less
>    (e.g. no longer tolerates a permission or a call it used to allow), or
>    pins a stricter count, and nothing it used to check is dropped. A change
>    that tightens one thing and loosens another is **meaningful**.
>    If a test is removed, skipped, weakened or loosened and the linked
>    issue does not require it (for example it looks like it was changed to
>    make the build pass), report it as a blocking **finding** asking for the
>    test to be restored, not only under `testChanges`. Report it under
>    `testChanges` as **meaningful** only when the issue requires the change.
> 6. {previousFindings, if not empty: "An earlier review of this PR asked
>    for these fixes: {previousFindings}. Check each one is fixed; one that
>    is not is still a finding."}
> 7. For Dependabot: check the changelog or release notes for breaking changes
>    that affect how this repo uses the dependency, and that a major bump is
>    reflected in the code where needed.
>
> Only report **blocking** findings: things that are wrong, unsafe or
> untested. Style preferences and optional polish are not blocking. A
> meaningful test change the issue requires is not a finding; report it under
> `testChanges`. Do
> not guess: every finding needs a file and line from the diff and a concrete
> failure scenario.
>
> Reply with only this JSON:
> `{"summary": "<one or two sentences>", "findings": [{"file": "...", "line": 0, "problem": "...", "fix": "..."}], "testChanges": "none" | "trivial" | "tightened" | "meaningful", "testChangeNotes": [{"file": "...", "line": 0, "change": "<what changed and why it matters>"}]}`

If an agent fails or returns something that isn't this JSON, post nothing for
that PR; the next gate run reports it again.

### 2. Post

For each reply, write `{"pr": <the gate's ready entry>, "review": <Fable's
reply>}` to a file in the scratchpad and run, from this skill's base
directory:

```bash
deno run --allow-run=gh,osascript --allow-read --allow-write --allow-env=HOME post.ts --input=<file>
```

The script does the rest, so do not post anything yourself:

- It re-checks the head commit and posts nothing if it moved or the PR
  closed; the next gate pass picks up the new commit.
- It decides the outcome: Fable findings mean **request changes** (the
  worker acts on those); otherwise a meaningful test change or a removed
  test file means **held for the owner**, as a comment-only review the
  worker ignores; otherwise **approve**.
- It writes and posts the review body, appends the result to
  `~/.review-fleet-prs/log.jsonl`, refreshes
  `~/.review-fleet-prs/summary.md`, and raises a desktop notification when a
  PR is sent back or held.

It prints `{ posted, outcome?, reason? }`. Exit code 2 means Fable's reply
was malformed: nothing was posted, and the PR comes back on the next gate
pass.

### 3. Report

One short line per round: approved, sent back, and held for the owner, each
with PR links. Then go back to the loop.

When the round held a PR for the owner or sent one back to the fleet, also
send one PushNotification (status `proactive`) naming those PRs and why,
under 200 characters, e.g. `GRQ-AutoTrader#1521 held for you: 2 page tests
moved to the server; GRQ#5032 sent back: fresh-path test never inits the
market`. It reaches the owner's phone when this session has Remote Control
connected (`/remote-control` and the Claude app). Send nothing for rounds
that only approved or had nothing ready.

The owner's running view is `~/.review-fleet-prs/summary.md`: what is
waiting for them, what was sent back to the fleet, and what was approved in
the last 7 days. Every gate pass rewrites it at no token cost.

## Notes

- Approval counts only because `gh` is signed in as a reviewer the repos'
  rulesets accept (`pr_reviewers` in the config). A fleet PR with auto-merge
  armed merges soon after approval, so the review is the last line of
  defence.
- PRs authored by the signed-in user are never candidates: GitHub does not
  let an author approve their own PR.
- Cost while idle: one GraphQL search (about 2 points) every 5 minutes, and
  no model tokens. Each ready PR adds one REST call for its file list.
- The log and summary live in `~/.review-fleet-prs/`, outside the checkout,
  which the worker resets. Each machine keeps its own.
