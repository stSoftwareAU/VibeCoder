## Summary

`docs/workflows/issue-processing.md` no longer lists `failed` as a label that
blocks pickup. Since Issue #4158 the worker never applies `failed`, and a
leftover one is stripped as stale rather than skipped. Two bullets changed:

- **Trigger:** `failed` is out of the blocker list. A new sentence says a
  leftover `failed` does not block, because the next scan strips it and the
  issue can be claimed.
- **Fleet-viable** (finish a started milestone): `failed` is out of the list.
  A new sentence says a leftover `failed` never makes an issue non-viable,
  because it is not a blocking label and the collectors for the labelled tiers
  strip it before filtering.

Closes #5370.

## Spec

### Intent and Rationale

- An operator reading these trigger conditions would think that adding or
  leaving `failed` on an issue keeps the worker away from it. In fact the
  worker strips the label on the next scan and claims the issue.
  `docs/TROUBLESHOOTING.md`, `docs/USAGE.md`, `docs/CUSTOM-PROMPTS.md` and
  `README.md` already describe the current behaviour. This brings the workflow
  page into line with them.

### Essential Design Decisions

- I checked line 122 against the milestone close-out code, as the issue asked.
  `buildCloseOutMilestones` (`worker/deno/lib/issue_priority.ts`) treats an
  issue as fleet-viable only when it is among the admitted candidates.
  `FilterLabels` in `worker/deno/lib/issue_filter.ts` has no `failed` field. The
  work-on, label, low-priority and idle-task collectors call `cleanStaleLabels`
  before filtering (`collect_work_on_candidates.ts`,
  `collect_label_candidates.ts`, `collect_low_priority_candidates.ts`,
  `collect_idle_task_candidates.ts`). The self-diagnostic collector does not
  strip the label, but it does not block on it either, so the new sentence
  says "the labelled tiers' collectors" rather than "every collector".
- I left `issue-processing.md`'s `low-priority` → `idle-task` handoff-label
  list (which includes `failed`) unchanged. That list describes a census taken
  from the raw list before `cleanStaleLabels`, not a pickup block, so the issue
  does not cover it.

### Undiscoverable Facts

None.

## Evidence

This changes documentation only, with no code or UI files. Code read to confirm
each new sentence:

- `worker/deno/lib/issue_filter.ts`: the `FilterLabels` doc comment says
  "Issue #4158: `failed` is not among them … a leftover `failed` is stripped as
  stale by `cleanStaleLabels`". The `findStaleLabels` doc comment says
  "`failed` is always stale".
- `worker/deno/lib/issue_priority.ts` `buildCloseOutMilestones`, and its call in
  `worker/deno/lib/find_oldest_issue.ts`, which passes the admitted label,
  work-on, self-diagnostic, low-priority and idle-task candidates.
- `worker/deno/lib/collect_self_diagnostic_candidates.ts`: its filter labels
  are refine-issue, planning, question, needs-revision and needs-human, with no
  `failed`.

Docs sweep: I grepped `README.md` and `docs/`, excluding `docs/archive/` and
`docs/audits/`, for `failed` near "block" or "skip". The only stale hits were
the two lines fixed here.

Issues cited as provenance:

- #4158: Never park an assigned issue: drop the terminal `failed` label and the
  repeated-failure needs-human hand-off.

## Test Plan

- This changes documentation only, so no test was added or changed.
- `markdownlint-cli2` from the repository root: `Summary: 0 issues in 0 files`.
- `./quality.sh < /dev/null` with the final doc edits: `Result: PASSED (with
  skipped checks)`, exit 0. Config integration and checkov were skipped.
