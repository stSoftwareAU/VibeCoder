## Summary

Closes #4028. Assesses Ponytail's review and audit finding format and records four decisions in the "review and audit format" row of "Read, not yet adopted" in `docs/REFERENCES.md`. Two parts are already in place; two are declined. No prompt changed. The row is updated to record the decisions and stays under "Read, not yet adopted".

## Spec

### Intent and Rationale

- The review and audit format sat in "Read, not yet adopted" with no recorded decision. This PR records one for each of the four parts, so the row is no longer an open question.
- Each part was checked against what the worker already does, so nothing is changed where the behaviour is already present.

### Essential Design Decisions

- (a) Reading beyond the diff: already in place. `pr_review_brief` checks regressions for existing callers, and the pre-PR verifier is handed the callers outside the diff of each changed function.
- (b) Four-part finding (what, problem, fix, cost of skipping): declined. Findings already carry problem, fix, file, line and a concrete failure scenario, which states the cost of skipping. The JSON is parsed by `worker/deno/lib/pre_pr_verifier.ts`, so a new field is risk without benefit.
- (c) Must/should/nice ranking: declined. Every review finding is blocking by design, so a lower tier contradicts that. The `severity:*` labels already triage audit and discovery issues.
- (d) Audit mapping entry points first: already in place for `prompts/security_scan/prompt.md` (Phase 1 inventory of entry points and trust boundaries). Expected-load mapping suits none of the other audits, so nothing more is adopted.
- Twin surfaces `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` are untouched, because no rule was adopted (#3732).

### Undiscoverable Facts

- Decisions (a) and (b) depend on the current `pr_review_brief` and pre-PR verifier behaviour. If either changes, the row's claims need rechecking.

## Evidence

- Docs-only change; no UI, no screenshot.
- Docs sweep: grep "ponytail", "review and audit format", "must/should/nice", "cost of skipping", "entry points", "callers outside the diff"; section: "Read, not yet adopted"; siblings: the "Anthropic context editing" row and the main ponytail row at `docs/REFERENCES.md:76` (still accurate, untouched); updated: `docs/REFERENCES.md`.
- Cited issues:
  - #4028: Assess Ponytail's review/audit finding format (what, problem, fix, cost of skipping; must/should/nice)
  - #3732: Fleet PRs change one copy of a rule with a declared twin and leave the other stale
- Related rules checked: REFERENCES rules (prompts stay pure, nothing fetched at run time, a human approves every idea before it lands, credit-list tests ignore the "Read, not yet adopted" table).
- Apply-the-rule-to-own-diff check: nothing found.

## Test Plan

- `deno task test:unit tests/references_doc_test.ts tests/references_refresh_test.ts tests/references_source_probe_test.ts`: 59 passed, 0 failed

<!-- vibe-branch-outcomes -->
Branch outcomes: none added

## Skipped / not checked / remaining risk

- `deno fmt` not run on docs: it already fails at HEAD, and running it would reflow the pinned phrases.
- Full `./quality.sh` not run locally.
- The row's middle cell is long; this is a style point only.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
