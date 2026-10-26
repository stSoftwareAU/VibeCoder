# PR Summary — Issues #4395, #4396, #4397

## Summary

The unattended `review-fleet-prs` runner (`scripts/run.sh`) was slow to work
through a backlog. Up to five PRs shared one round, so each waited for the
slowest review and for the learning step. After every round the loop also
slept a full 5 minutes. This PR changes three things:

- **One round per PR, several at once (#4395).** Each ready PR gets its own
  worker container. Up to `pr_reviewer_parallel` rounds run together
  (`.config.json`, default 3). Each PR posts when its own review ends. The
  gate takes `--in-flight=<owner/name#n>,...` and skips those PRs as
  `in-flight`, so one host never reviews a PR twice at once.
- **Fill a freed slot at once (#4396).** The loop wakes every 30 seconds to
  collect finished rounds. It gates again straight away after a round succeeds
  or when PRs were left `over-limit`. Idle passes still run every 5 minutes. A
  failed round still waits the full interval, so a failing PR is not retried
  hot.
- **Learning in its own round (#4397).** Review rounds now do steps 1, 2 and
  4 only. Step 3 (learn from recurring findings) runs in a separate round, at
  most hourly, and only when `log.jsonl` has a new send-back. `learned-lines`
  advances only when that round succeeds.

Closes #4395. Closes #4396. Closes #4397. The cross-host claim (#4398) is not
part of this PR.

## Spec

### Intent and Rationale

- The owner reported long waits for reviews and chose these three changes,
  leaving the cross-host claim (#4398) for later.
- Every rule of the review is unchanged. Only how rounds are scheduled
  changes, plus where step 3 runs.

### Essential Design Decisions

- Rounds run as background subshells tracked in plain indexed arrays. A round
  writes `rc` and `error` files into its directory, and the loop reads them.
  This keeps `run.sh` working on macOS's `/bin/bash` 3.2: no associative
  arrays and no `wait -n`.
- An escalated error never names the PR. Escalations are filed in the public
  VibeCoder repo, and the PR may be in a private one. `runner.log` names it,
  tagging each round's lines with `[owner/repo#n]`.
- Round directories and container names include the PR, so two rounds started
  in the same second cannot collide.
- On exit (including SIGTERM from launchd or systemd), the runner kills its
  rounds' containers. Otherwise the next runner would start the same PRs again.

### Undiscoverable Facts

- A runner's first start sets `learned-lines` to the current length of
  `log.jsonl`. Earlier history was already learned from by the old per-round
  step 3.

## Evidence

Read `references/running-unattended.md`, `SKILL.md` and the `run.sh` header
before changing them. Updated: `running-unattended.md` (pool, re-gate,
learning round, multi-host caveat), `SKILL.md` (pointer and the note in step
3), `docs/CONFIGURATION.md` (new `pr_reviewer_parallel` section) and
`config_unknown_keys.ts` (registers the key).

Run locally: every `review_fleet_prs_*_test.ts` suite, `config_unknown_keys_test.ts`,
`deno fmt --check`, `deno lint`, `shellcheck -e SC1091 -e SC2034` on
`run.sh`, and markdownlint on the changed docs all pass. JSR is unreachable
from the authoring sandbox, so the tests used a local stand-in for
`@std/assert`, `@std/crypto` and `@std/yaml`. Not checked locally:
`./quality.sh` as a whole and `deno task check:manifests`, which both need
JSR; CI runs them. Not checked: `run.sh` under bash 3.2 (none available in
the sandbox).

## Test Plan

- `review_fleet_prs_runner_test.ts`, 11 new tests:
  - two ready PRs get two rounds that run at the same time, each prompt
    holding one PR;
  - container and directory names carry the PR;
  - `--limit` follows `pr_reviewer_parallel` (default 3; an invalid value
    falls back with a log line);
  - a review round's prompt skips step 3;
  - the gate gets `--in-flight`, a PR is never started twice, and stopping
    the runner kills its round's container;
  - the loop re-gates at the next tick after a successful round, but not
    after a failed one;
  - a learning round runs after a new send-back and covers the right lines;
  - no learning round runs without a new send-back;
  - a failed learning round does not advance `learned-lines`;
  - a first start learns only from new reviews.
- The existing timeout test (`--error=round timed out after 1s`) already
  pins that an escalated error carries no PR name.
- `review_fleet_prs_backlog_3225_test.ts`: `pass` skips an `inFlight` PR as
  `in-flight`, without reading its file list and without it taking a slot.
