## Summary

Closes #4020. Refreshes the Ponytail row in `docs/REFERENCES.md` for 5.x (v5.3.2, 2026-10-16; v5.0.0 2026-10-08; cites the 2026-10-07 Opus 5.5 benchmark, 39 tasks × 5 runs), adopts two rules into both twins (`prompts/coding_guidelines/prompt.md` and `CODING-STANDARDS.md`): (1) KISS read-first sentence ("read the code the change touches — its callers, the helpers it could reuse and the tests that cover it: be lazy about the solution, never about the reading"); (2) "End with what you did not do" run-summary rule. Declines the 5.3 band/board cost display (interactive Claude Code only, one provider; telemetry already records cost) and the one-test floor (more specific testing rules exist). Tracks the two not-yet-adopted ideas as "Read, not yet adopted" rows: #4027 (debt ledger) and #4028 (review/audit finding format). No plugin installed; nothing fetched at run time; REFERENCES rules 1–3 unchanged.

## Spec

### Intent and Rationale

- Ponytail 5.x shipped after #2322 adopted its ladder. The Ponytail row still described the old Haiku-only benchmark, so it now records the version and benchmark that were actually assessed.
- Two 5.x ideas change how any task is worked (read before choosing a fix, state what was not checked), so they belong in the shared guidelines rather than in a tool or plugin.
- Every other 5.x idea is either declined with a reason or recorded as a "Read, not yet adopted" row with a tracking issue, so none is left unaccounted for.

### Essential Design Decisions

- The run-summary bullet sits in "Long-Horizon Runs" (`prompts/coding_guidelines/prompt.md`) and "Prompt Engineering Guidance" (`CODING-STANDARDS.md`), not Working Style. Working Style pins "Four standing directives" (`prompts/coding_guidelines/prompt.md:61`, `prompts/coding_guidelines_claude/prompt.md:3`, `docs/REFERENCES.md:68`), so a fifth directive there would break those pins.
- Both twins change in the same PR, as #3732 requires.
- The read-first sentence sits before the ladder inside the KISS bullet. The "smallest-change-first ladder" phrase stays on one line for the drift test.

### Undiscoverable Facts

- Ponytail 5.x facts (versions, dates, benchmark, rule list) come from the issue body; nothing was fetched at run time.
- The three docs already fail `deno fmt --check` at HEAD, so `deno fmt` was not run. It would also reflow the ladder phrase the drift test pins.

## Evidence

- Backend-only / docs-only; no UI, no screenshot.
- Docs sweep: grep "standing directives", "smallest-change-first ladder", "ponytail", "run summary", "lazy about"; section: KISS, Long-Horizon Runs, Prompt Engineering Guidance, REFERENCES "Adopted" and "Read, not yet adopted"; siblings: "Investigate before you answer", "Clean up after yourself", "Mind the token economy"; updated: docs/REFERENCES.md, CODING-STANDARDS.md, prompts/coding_guidelines/prompt.md
- Cited issues:
  - #4020: Assess Ponytail 5.x for prompt ideas and refresh its docs/REFERENCES.md row
  - #4027: Report-only idle task listing every SIMPLE-ON-PURPOSE marker (Ponytail debt ledger)
  - #4028: Assess Ponytail's review/audit finding format (what, problem, fix, cost of skipping; must/should/nice)
  - #2322: Adopt ponytail's smallest-change-first ladder in the shared guidelines
  - #3732: Fleet PRs change one copy of a rule with a declared twin and leave the other stale (VibeCoder#3283, #3707 and a private fleet PR)
- Related rules checked: the gate-level "not checked" reporting rule in `CODING-STANDARDS.md` and "Investigate before you answer". The new rule agrees with each; the `prompts/coding_guidelines/prompt.md` bullet says so explicitly.
- Applied the new run-summary rule to this PR's own summary: it ends with the Skipped / not checked section below.

## Test Plan

- `deno test` worker/deno/tests/coding_guidelines_twin_drift_test.ts: 9 passed
- worker/deno/tests/references_doc_test.ts: 16 passed
- worker/deno/tests/references_refresh_test.ts: 24 passed
- `./quality.sh < /dev/null`: PASSED (exit 0), including deno tests (full suite, 526.0s), deno lint, deno type check, deno fmt, markdownlint, mermaid and semgrep; config integration SKIPPED (deno or .config.json not available)

<!-- vibe-branch-outcomes -->
Branch outcomes: none added

## Skipped / not checked / remaining risk

- `deno fmt` not run on the three docs: they already fail `deno fmt --check` at HEAD, and running it reflows unrelated lines and splits the ladder phrase the drift test pins.
- Ponytail 5.x version, date and benchmark claims are taken from the issue body and were not independently fetched (no network fetch by rule).
- No Ponytail plugin or skill installed or exercised.
- quality.sh config integration check skipped (no .config.json in the worktree).
- Summary claim check (#3257) not run locally; the worker runs it at PR time.
- Remaining risk: the two new rules are prose; their effect on agent behaviour is unmeasured.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
