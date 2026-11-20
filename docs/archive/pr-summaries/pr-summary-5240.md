# PR Summary — Issue #5240

## Summary

Adds `docs/CODE-MODE-EXPERIMENT.md`, which records Claude Code's Code Mode as
`Status: blocked` for fleet worker runs, and links it from the README
Documentation table beside the other trial pages. The CLI refuses Code Mode in a
`claude -p` session, and the worker runs every Claude session that way. Nothing
is wired: no worker, container or configuration file changes, and the Claude pin
in `container/tools.json` stays at 2.1.322. Closes #5240.

## Spec

### Intent and Rationale

- The grill-me rounds settled on observing first: record `blocked` or
  `feasible`, and wire `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` only once the
  status is `feasible`. The observation says `blocked`, so the deliverable is
  the record and the reproducing command.

### Essential Design Decisions

- The page refers to the #4959 trial by its issue number, not by name or by a
  link to its protocol page.
  `worker/deno/tests/token_economizer_trial_docs_test.ts` requires every live
  file matching `/token[-_ ]?economizer/i` (the link path included) to have a
  row on that trial's purge list. A purge row would tie this page to that
  trial's purge, and the page only needs the bar and the host.
- The page carries no docs-drift test. It records the pin and Containerfile line
  _on the observation date_, so a test pinning them to live values would break
  on the next routine pin bump without the page being wrong.
- The issue's host constraint ("does not choose GRQ-25 while #4959 is open") is
  recorded as: do not share a host and window with another running trial,
  because the #4959 trial's protocol names GRQ-25. #4959 is closed as of 20
  November 2026, while its protocol page still reads "not started" with GRQ-25
  as the host.

### Undiscoverable Facts

- Re-observed in this run (20 November 2026, CLI 2.1.322):
  `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude -p "Reply OK" --no-session-persistence`
  printed
  `Warning: Code Mode (experimental) isn't available: for now it only works in the interactive terminal. Starting with the ordinary tools.`
  and then `Not logged in · Please run /login`, exit code 1.
- The two further refusals are quoted from the 2.1.322 binary's reason table
  (`/usr/local/bin/claude`, the `case"no_flags"` and `case"model"` arms): "it
  needs settings that Claude Code downloads from Anthropic, and this session
  doesn't download them (DISABLE_TELEMETRY, DO_NOT_TRACK, …)" and "for now it
  only works with Opus 5.5 and Sonnet 5.5". Neither was observed firing, because
  the `-p` refusal comes first.
- The documented 2.1.323 minimum version comes from search summaries of the Code
  Mode docs page, which would not open from the worker sandbox in this run or in
  the grill-me rounds.

## Evidence

Docs-only change; there is no UI or code path to exercise. Each claim in the
page was checked against the head:

- `-p` spawn: `buildClaudeCliArgs` in `worker/deno/lib/agent_provider.ts` pushes
  `--output-format stream-json` and `-p`.
- `ENV DO_NOT_TRACK="1"` is at `container/Containerfile` line 269.
- The Claude pin is `"version": "2.1.322"` in `container/tools.json`, and
  `claude --version` reports `2.1.322 (Claude Code)`.
- Models: `PHASE_MODEL_TIERS` in `worker/deno/lib/phase_routing.ts` puts the
  eight planning-shaped phases on the `best` tier, and
  `DEFAULT_CLAUDE_MODEL_TOP_TIER = "fable"` in
  `worker/deno/lib/config_defaults.ts`. The `container/tools.json` notes record
  that 2.1.322 resolves `fable` to `claude-fable-5-2`.
  `.claude/skills/review-fleet-prs/SKILL.md` names a Claude Fable 5.2 reviewer.
- `git grep CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` finds no hit outside the new
  page, so the switch is set nowhere.
- `container/providers/codex.sh` holds the Codex code-mode host, which is out of
  scope.

Issue numbers the diff cites:

- #5240: Try Claude Code's Code Mode as a fleet experiment (blocked for
  `claude -p`)
- #4959: TokenEconomizer: run the agreed trial to an automatic keep-or-purge
  verdict (closed)

Docs read: the README Documentation table (trial rows) and
`docs/MODEL-AND-CACHING.md`, Phase-Specific Defaults. No other manual describes
Code Mode: `git grep -i "code mode\|code-mode"` outside `docs/archive/` hits
this page, the README row and Codex's code-mode host:
`container/providers/codex.sh`, `docs/CONTAINER.md`, the run-outcome classifier
and its tests.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A page `docs/CODE-MODE-EXPERIMENT.md` exists with a
  `Status: blocked` line and records: - the warning above, verbatim, with the
  CLI version it was observed on (2.1.322) and the date (18 November 2026); -
  the command that reproduces it,
  `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude -p "Reply OK" --no-session-persistence`,
  and the fact that the warning is printed before the CLI checks its login, so
  the command needs no credential; - two further refusal reasons the 2.1.322
  binary lists and the fleet configuration meets, each marked as read from the
  binary and not observed: `DO_NOT_TRACK=1`, set image-wide at
  `container/Containerfile` line 269, stops the CLI downloading the settings
  Code Mode needs; and Code Mode works only with Opus 5.5 and Sonnet 5.5, which
  excludes the review and planning runs on Fable 5.2; - the documented minimum
  CLI version, 2.1.323, beside the `container/tools.json` Claude pin on the
  observation date, 2.1.322; - the pass bar for an experiment once the status is
  `feasible` (see Assumptions); - the restart rule: a person runs the
  reproducing command, and once the warning is absent a new issue restarts the
  experiment — evidence: `docs/CODE-MODE-EXPERIMENT.md` (§2.1–§2.3, §3, §4, §5)
  — reviewer: met
- **met** — The Documentation table in `README.md` has a row linking to the
  page, as it has for the sibling pages `docs/TOKEN-ECONOMIZER-TRIAL.md` and
  `docs/RTK-OUTPUT-TRIAL.md` — evidence: `README.md:481`,
  `worker/deno/tests/readme_docs_reachability_test.ts` — reviewer: met
- **met** — The pull request changes no worker, container or configuration file:
  the switch is not wired while the status is `blocked`, the Claude pin in
  `container/tools.json` stays at 2.1.322, and no build step or scheduled task
  runs the reproducing command — evidence: `git diff --name-only` lists only
  `README.md`, `docs/CODE-MODE-EXPERIMENT.md` and this summary;
  `container/tools.json:53` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — spelling (no American forms in the added lines), KISS/DRY (the
  page refers to #4959 by issue rather than copying its protocol), docs match
  the code (Containerfile line 269, the 2.1.322 pin, `buildClaudeCliArgs`,
  `PHASE_MODEL_TIERS`, no `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` outside the new
  files), the docs-drift test omission and its stated reason, TDD for a
  docs-only change, and the PR summary structure and evidence rules.

## Test Plan

No test was added or edited; the reasons are under Essential Design Decisions.

- `markdownlint-cli2 README.md docs/CODE-MODE-EXPERIMENT.md`: 0 issues.
- `deno test -A tests/readme_docs_reachability_test.ts`: 3 passed.
- `deno test -A tests/token_economizer_trial_docs_test.ts`: 31 passed. The first
  gate run failed 21 of these tests because the page named the plugin. The page
  now refers to that trial by issue number.
- `./quality.sh < /dev/null` on `313f686ac`: Result PASSED (with skipped
  checks). Config integration was skipped because `.config.json` is not
  available, and checkov was skipped because it is not installed on this host.

Not checked: the Code Mode docs page itself (it would not open from the
sandbox), and whether the `DO_NOT_TRACK` and model refusals fire in an
interactive or pseudo-terminal session (not observed).
