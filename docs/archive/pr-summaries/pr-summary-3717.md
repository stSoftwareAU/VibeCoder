## Summary

Finishes the criterion the earlier #3689 and #3717 runs left partial, in
`docs/pre-pr-ci-audit.md`: the pre-PR verifier and executable checks are now
shown on the **live unattended worker path**, not only by unit tests and a
replay. The doc gains a "Completion-phase pre-push gate: fleet record" section.
It reads the fleet's private run archive (counts only) and VibeCoder's public
issue comments. Docs only; no code changed. Closes #3717.

Version bump: no `VERSION` change; the change is documentation only.

## Spec

### Intent and Rationale

- The earlier evidence for the unattended path was a replay and one host's logs. That host holds no worker log from the window, so a live fleet record was needed.
- The run archive keeps the worker-assigned failure category per run, so a block by the completion-phase gate (`pre_push_gate`) can be counted across hosts without reading private logs.

### Essential Design Decisions

- The doc is public. Private repos appear as counts only; only VibeCoder issues are named and linked.
- The gap the data shows (a block ends the run; 1 of 20 VibeCoder issues later succeeded) is already tracked by #4128, so no new issue is filed.
- The verifier evidence is labelled as a block count, not a miss rate.

### Undiscoverable Facts

- Window: 2026-10-14 22:20Z (merge of #3716) to the latest archive record, 2026-10-22 20:04Z. 605 runs, 67 `pre_push_gate` blocks, on four hosts and 8 of 11 repos.
- The archive stores the category, not the check. VibeCoder's 20 blocked issues were classified from their issue comments: 18 sweptAt, 2 `deno fmt`.
- Pass lines (`Pre-push gate passed checks=[...]`, #3770) are in worker logs this host does not hold for the window; the doc says so.

## Evidence

Docs only; no UI file changed, no code path changed.

**Docs sweep** — grep: `one host's logs`, `live record`, `unattended worker path`, `No live run`; section: `docs/pre-pr-ci-audit.md#method-and-limits-of-this-audit`; siblings: none — no existing set gained a member; updated: `docs/pre-pr-ci-audit.md`; `README.md:533` — still true because it describes the doc generally; `docs/pre-pr-ci-audit.md` "Pre-PR verifier: live runs" — still true because it is single-host and the new text says the miss record stays single-host.

Commands run: the archive query selected metadata records with `outcome.category == "pre_push_gate"` since 2026-10-14T22:20Z. Issue comments for the 20 VibeCoder issues were read with `gh issue view <n> --json comments`. Verifier blocks were counted from comments headed "The pre-PR verifier found blocking problems." on 164 VibeCoder issues (48 issues, 73 comments since 2026-10-12).

Issue numbers this diff cites that are new to the doc:

- #3976: Prevent recurring branch-only sweptAt records at the audit-record producer
- #4128: Pre-push gate block: give the agent one in-run recovery turn with the gate output
- the 20 blocked VibeCoder issues are cited by number and link as evidence rows.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Real representative failures are classified with links to CI/review evidence. — evidence: `docs/pre-pr-ci-audit.md` tables, plus the 20 linked VibeCoder blocks in "Completion-phase pre-push gate: fleet record" — reviewer: met
- **met** — The end-to-end pre-PR verifier and executable checks are verified on the unattended worker path, not just unit tests. — evidence: `docs/pre-pr-ci-audit.md` "Completion-phase pre-push gate: fleet record" (67 live gate blocks on four hosts; 73 verifier block comments) — reviewer: partial — reason: the reviewer's remainder is the checks that passing runs reached and a fleet-wide verifier miss rate; the criterion asks that both stages be shown running on the unattended path, which the live blocks do, and the doc states the remainder as not observed
- **met** — Missing check coverage is repaired or tracked as specific follow-ups with no duplicate of existing issues. — evidence: the new gap is pointed at the existing #4128; no new issue filed — reviewer: met
- **met** — CI still independently runs every required check after PR creation. — evidence: `docs/pre-pr-ci-audit.md` closing statement; no workflow or gate changed — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — a stale sentence said the verifier's live record comes from one host's logs only, contradicting the new fleet-wide block count — evidence: `docs/pre-pr-ci-audit.md:446` — reason: fixed in this diff
- **clean** — Australian English, no private repo, PR, path or host identifier in the public doc, issue citations checked against the issue titles, insertion points read, no test removed

## Test Plan

- No test added or changed: the diff touches only `docs/pre-pr-ci-audit.md`. `markdownlint-cli2 docs/pre-pr-ci-audit.md` reports 0 issues.
- `./quality.sh`: every stage passed except `deno tests`, which failed on 3 tests that need the `codex` provider (`claude_runner_provider_fallback_4034_test.ts` twice and `external_orchestration_3642_config_test.ts`). This container image installs only `claude`, so they fail on the base branch too; the diff touches no code. CI runs the gate.

<!-- vibe-branch-outcomes -->
