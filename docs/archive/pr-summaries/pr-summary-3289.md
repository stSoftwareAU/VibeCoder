# PR summary: the review runner picks its Claude subscription like the worker (Issue #3289)

## Summary

Closes #3289.

`run.sh` started every headless review round with a bare `claude -p`, so a
round ran on whatever account the host's `claude` was signed in to. When that
subscription's window was exhausted the fleet review stopped, although the
host's credential pool held other subscriptions with budget. The worker
already discovers, probes and ranks that pool; the runner now calls the same
code.

- `claude_credential.ts` (new, in the skill) resolves the worker's credential
  directory, discovers `claude/provider*.env`, filters out excluded labels,
  and ranks the rest with `createClaudeBudgetTokenSelector` from
  `worker/deno/lib/claude_token_selection.ts`. It prints one JSON line with
  the winner's label, variable name and value, or `{"label":null}` when the
  pool holds nothing usable. With `--usage-limit-log=<file>` it prints whether
  the file holds the CLI's usage-limit refusal, through the worker's
  `detectUsageLimit`.
- `run.sh` selects before each round and exports the token to `claude` alone,
  inside the round's subshell with xtrace off. A round that fails with the
  usage-limit refusal is run once more on the next-ranked subscription (the
  spent label excluded), logged to `claude-retry.log`; no other subscription
  means the round stays failed and the log says so. Other failures are not
  retried. No pool means the host's `claude` login, as before.
- SKILL.md documents the host requirement and the selection and retry.

## Spec

### Intent and Rationale

- The owner: "The fleet review stopped because we were out of tokens but
  there were plenty on other tokens. We should choose the auth token like we
  do in Vibe Coder."
- Reuse, not reimplementation: the runner calls the worker's discovery,
  probe, ranking and usage-limit predicate, so the two surfaces pick alike
  and a change to the ranking rule reaches both.

### Essential Design Decisions

- One retry, on a different label only: a second refusal is a pass failure
  like any other, so a pool with every window spent cannot loop.
- The spent subscription is excluded by label for the retry rather than
  recorded in a state file: the probe on the next pass ranks it from the live
  headers anyway, so there is nothing to remember across passes.
- The token value is handled only with xtrace suspended and exported inside
  the round's subshell; the ranking log names labels only.

### Undiscoverable Facts

- The host's pool on GRQ-23 has three files (`provider.env`, `provider-2.env`,
  `provider-3.env`); the runner on GRQ-25 is where the stop was seen, on
  2026-10-06.
- The runner test stubs `deno` by script name, so the new script needed its
  own stub cases (`credential`, `credentialRetry` fixture parameters) for
  the existing tests to keep their "no pool" behaviour.

## Evidence

- `worker/deno/tests/review_fleet_prs_claude_credential_3289_test.ts` (4
  tests) was written first and failed on the missing module; it passes with
  it: the fuller subscription wins and the log names no token value; an
  excluded label is not even probed; one file is used without a probe and an
  empty or missing pool yields null; the usage-limit wording is recognised and
  other failures are not.
- `worker/deno/tests/review_fleet_prs_runner_test.ts`: 28 tests pass, six of
  them new: the token reaches `claude` and the label is logged; no pool means
  the host login; a usage-limit round is retried once on the next
  subscription and the pass succeeds; no retry without another subscription;
  no retry on another failure; `bash -x` never prints the token.
- `deno check` and `deno lint` pass on the new script; `bash -n` and
  `markdownlint-cli2` pass.
- **Docs sweep** — grep: `claude signed in`, `claude -p`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `provider-2.env`, `usage limit` over `.claude/skills/review-fleet-prs`,
  `docs/` (excluding `docs/archive/`) and `README.md`; section:
  `.claude/skills/review-fleet-prs/SKILL.md#running-unattended`; updated:
  `.claude/skills/review-fleet-prs/SKILL.md`; `docs/SETUP.md:875,945,957,987`
  — still true because they describe the pool files the runner now reads;
  `docs/CONTAINER.md`, `docs/DEPLOYMENT.md`, `docs/PROVIDER-PARITY.md` — still
  true because they describe the worker's own use of the pool, unchanged.

## Test Plan

- Added `worker/deno/tests/review_fleet_prs_claude_credential_3289_test.ts`.
- Extended `worker/deno/tests/review_fleet_prs_runner_test.ts` with the six
  tests above and the two fixture parameters.
