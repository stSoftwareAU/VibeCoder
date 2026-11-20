## Summary

Review-fix runs left a worker-built PR's title false. The `pr_feedback` prompt
said that for a worker-built description "the summary file is the only place to
change it", but never said the worker does not rebuild the title. One run read
that as "a title cannot be changed". The sentence now covers the body only, and
a new sentence gives the `gh pr edit <n> --title <title>` command for a title
that a fix makes false. The operator manual says the same. Closes #5239.

## Spec

### Intent and Rationale

- The body re-sync (`worker/deno/lib/pr_body_sync.ts`, called by
  `worker/deno/lib/pr_body_reconcile.ts`) edits only `--body-file` and never the
  title. So only the agent can correct a title, and the prompt has to say so.
- This uses the issue's proposed rewording almost word for word. It adds no
  check and no new duty: "Fix the defect everywhere it lives" already lists the
  PR title as a copy to fix.

### Essential Design Decisions

- The summary file is still the only way to change a worker-built **body**, and
  the agent still never edits that body directly. Only the title gets a direct
  `gh pr edit` path.
- The fix stays in `prompts/pr_feedback/prompt.md`. `prompts/ci_fix/prompt.md`
  already names the title (Issue #4893). `prompts/merge_conflict/prompt.md` has
  no "only place to change it" sentence, so it carries neither the gap nor the
  contradiction.

### Undiscoverable Facts

- The four examples in the issue come from private fleet repos that squash-merge
  with the PR title as the commit subject. A false title therefore becomes a
  false commit on the default branch.

## Evidence

Backend/prompt-only change, with no UI file touched.

- `prompts/pr_feedback/prompt.md` (**Making Changes** → "Keep the PR summary
  true to the head."): "do not edit it yourself" now reads "do not edit the body
  yourself". After it comes: "The worker does not rebuild a pull request's
  title: when your change makes the title false, update it with
  `gh pr edit <n> --title <title>` and name that in `.pr_response_message`."
- `docs/workflows/pr-feedback.md` (**Every finding ends fixed or rebutted**) now
  says the re-sync rebuilds the description only, never the title, and gives the
  same command.
- Claims checked against code:
  - `worker/deno/lib/pr_body_sync.ts:942-980` calls `gh pr edit … --body-file`
    only, and the file never mentions `title`.
  - `worker/deno/lib/pr_body_reconcile.ts` has no title handling of its own.
  - The review-fix turn disallows only `git push`, `gh pr merge` and `gh api`
    (`worker/deno/lib/pr_feedback_processor.ts:1451-1456`), so
    `gh pr edit --title` is allowed.
  - The gh guard leaves a title edit alone
    (`worker/deno/lib/gh_guard_decision.ts:930`).
- Related rules checked:
  - "Fix the defect everywhere it lives" in `prompts/pr_feedback/prompt.md`
    already lists the PR title, and agrees with the new sentence.
  - `prompts/ci_fix/prompt.md:106` already names the title.
  - `prompts/merge_conflict/prompt.md:123` makes no body-only claim.
  - No other prompt or `CODING-STANDARDS.md` rule says the summary file is the
    only place to change the PR page.
- Applied the new rule to this PR's own diff: it changes no PR title or body
  behaviour, and found nothing to fix.
- Docs sweep: grepped `prompts/`, `docs/` (excluding `docs/archive/`),
  `README.md` and `worker/deno/` for "only place to change it" and "do not edit
  it yourself". The only hits are the reworded sentence and this PR's own test.
- Issue numbers the diff cites: #5239 is this issue ("Review-fix runs leave a
  worker-built PR's title false…").

## Test Plan

- Added `worker/deno/tests/pr_feedback_title_not_rebuilt_5239_docs_test.ts` with
  two docs-drift tests, each scoped to its section:
  - The prompt's "Keep the PR summary true to the head." paragraph carries the
    body-only sentence, the title sentence and the
    `gh pr edit <n> --title <title>` command naming `.pr_response_message`, and
    no longer carries the old body-and-title wording.
  - The operator doc's **Every finding ends fixed or rebutted** section says the
    re-sync never rebuilds the title.
- Red on base: with `prompts/pr_feedback/prompt.md` and
  `docs/workflows/pr-feedback.md` restored from `origin/main`, both tests failed
  with missing-phrase assertions. On the head both pass
  (`deno test -A tests/pr_feedback_title_not_rebuilt_5239_docs_test.ts`: 2
  passed, 0 failed).
- Regression: ran `marker_less_body_rebuild_4515_docs_test.ts`,
  `pr_body_matches_final_diff_3015_test.ts`,
  `ci_fix_summary_additive_5023_docs_test.ts` and every test under
  `worker/deno/tests` that reads `prompts/pr_feedback/prompt.md`: 155 passed, 0
  failed. No existing test pinned the old sentence, so no existing test was
  edited.
- `./quality.sh < /dev/null` on the head: exited 0,
  `Result: PASSED (with skipped checks)`. Config integration and checkov were
  skipped by the gate itself; deno tests, lint, type check, fmt, markdownlint,
  mermaid, semgrep and gitleaks passed.

None left undone. Not checked: the behaviour of a live review-fix run on a real
PR. This is prompt guidance, and only a later fleet review can observe it.
