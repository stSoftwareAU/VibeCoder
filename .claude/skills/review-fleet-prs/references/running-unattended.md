# Running unattended

On an always-on host, `scripts/run.sh` under the skill directory
(`.claude/skills/review-fleet-prs/`) does the same without an open session.
Every 5 minutes it runs one gate pass on the host, and it starts a headless
`claude -p` round, in the Vibe Coder's worker container, only when a PR is
ready. It loops for ever, retries after a failed pass, kills a round that
runs over 50 minutes, and keeps one runner per machine.

```bash
.claude/skills/review-fleet-prs/scripts/run.sh --install   # start at login, restart on exit
.claude/skills/review-fleet-prs/scripts/run.sh --once      # one pass, in the foreground
```

A host installed before Issue #3299 moved `run.sh` into `scripts/` still
starts the old path; its service now only forwards to `scripts/run.sh`, so
re-run `--install` to point the service at `scripts/run.sh` directly.

`--install` registers a launchd agent on macOS or a systemd user service on
Linux. The host needs what the Vibe Coder worker on it already has: `deno`,
`jq`, `gh` signed in, the container runtime, the built worker image (the
worker's own `./run.sh` builds it), and the worker's credential directory
(`~/.vibe-coder/credentials/`, see [SETUP.md](../../../../docs/SETUP.md)). No
host `claude` login is used.
The log is `runner.log` in the log directory (`<logs>/review-fleet-prs/`, see
[notes.md](notes.md)). Every pass writes a
line to it: an idle pass logs `gate: nothing ready (...)` with the gate's
skip counts, so a quiet log still shows the gate running every 5 minutes.
A headless round cannot send the
PushNotification in [SKILL.md](../SKILL.md)'s step 4; `summary.md` still shows
what is waiting.

## Where a round runs, and on which Claude subscription

The gate and the escalation stay on the host: they make no model calls.
Each round runs as a `container run` of the worker image (Issue #3293),
built from the worker's own launch plan (`mod.ts container-launch-plan`), so
it gets the same image, credential mounts and entrypoint staging as the
worker. Two things differ from the worker's run:

- The worker's named volumes are not mounted: the worker's container may hold
  them, and a round needs none of its durable state.
- The reviewer App token reaches the round as `GH_TOKEN`, passed to the
  runtime by name (`--env GH_TOKEN`), so its value is never on a command
  line, in a `bash -x` trace or on disk.

Inside, the entrypoint's `review-round` mode runs `claude -p` on the
subscription the worker's Claude credential pool ranks first
(`worker/deno/lib/review_round.ts`). When a round ends with the CLI's
usage-limit refusal, it logs
`round hit the usage limit on subscription <label>`, and runs the round once
more on the next subscription with budget left, or says
`no other subscription has budget; the round stays failed`. Subscriptions are
logged by label (`provider`, `provider-2`, …), never by value.

The round is given container paths: the skill at
`/workspace/.claude/skills/review-fleet-prs`, and this state directory under
the worker's log mount, which `scripts/post.ts` is told with `--state-dir`.
The round's prompt is `prompt.md` in its round directory, beside
`claude.log`. When the worker image for the current checkout is not built
yet, the pass fails with `round not started: the worker image is not built`;
the worker's next launch builds it.

## As a GitHub App

With `pr_reviewer_app` in `.config.json` (see
[CONFIGURATION.md](../../../../docs/CONFIGURATION.md#-reviewer-app-for-fleet-pr-reviews)),
`scripts/run.sh` reviews as that App's bot instead of the `gh` user.
`scripts/app_token.ts` mints a fresh installation token for every pass, since
one lasts an hour. When minting fails, the pass is skipped; it never falls
back to posting as the `gh` user. The App needs **Pull requests**,
**Issues**, **Contents** and **Workflows** read and write, plus **Checks**
and **Commit statuses** read:
Contents write lets the Dependabot upkeep merge an already-clean PR with
`gh pr merge --auto` and arm auto-merge, and lets the skill bring an approved
fleet PR's branch up to date (`update-branch`); Workflows write lets it merge
Dependabot's GitHub Actions bumps, which change `.github/workflows/*`.
Installation is needed on every monitored repo and on
`stSoftwareAU/VibeCoder` (for improvement issues).
Add `<app-slug>[bot]` to `authorized_commenters` (not `pr_reviewers`,
which would make PR creation fail). An interactive `/review-fleet-prs`
session still reviews as the `gh` user.

The token must carry Pull requests write, Issues write, Contents write,
Workflows write, Checks read and Statuses read. `scripts/app_token.ts`
checks the minted token's `permissions` and fails the pass with one message
naming each missing permission. If the
App itself lacks a permission, the message points at the App's permission
settings page; if the App has it but the installation has not yet accepted
it, the message says to accept the new permissions on the installation page.

## Persistent failure escalation

A pass fails when the App token or the gate fails, when the round's
container cannot be started (`round not started: <why>`), or when the round
exits non-zero: it failed, or the 50-minute alarm killed it (and its
container, by name). `runner.log` then says `round failed (exit N)` or
`round timed out after 3000s` instead of `round done`.

After 12 consecutive failed passes (about an hour at the 5-minute interval),
`scripts/escalate.ts` opens one deduplicated issue in
`stSoftwareAU/VibeCoder`, titled `review-fleet-prs runner failing on <host>:
<error>`, using the host's own `gh` login rather than the App token. The
issue is public, so the error has secrets redacted and every repo reference
other than `stSoftwareAU/VibeCoder` replaced with `<repo>`, and the log path
is shown relative to the home directory; the host name is in the title, so
give the host a name that discloses nothing private. If the error changes,
it retitles the issue and comments on it. It appends a
`[review-fleet-prs-health] host=… status=unhealthy …` line to `health.log`
in the log directory, which is also echoed to `runner.log`. The first
successful pass after that comments, closes the issue and logs
`status=recovered`. State lives in `failures.json` in the log directory.
If the escalation itself fails, that is logged as "escalation failed" and
the next pass retries it.

`scripts/run.sh --once` runs the same housekeeping as the loop: pruning
rounds older than 30 days, rotating `runner.log` past 10 MB, and emptying
the service's own `service.out` in place past 10 MB (launchd holds it open,
and everything in it is also in `runner.log`). Running `bash -x run.sh` does
not print the minted token, since tracing is suspended around the mint.
