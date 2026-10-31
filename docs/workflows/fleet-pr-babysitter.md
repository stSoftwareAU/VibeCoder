# Fleet PR babysitter MVP

The babysitter scans the repositories in `.config.json` for open fleet PRs
with merge conflicts or failed CI. By default it fixes candidates. It takes the same PR branch lock as the fleet's
CI and conflict workers, rechecks the head, and runs one Codex session in a
temporary clone. It runs the repository's `quality.sh`, rechecks the PR and
pushes only if the agent produced a descendant commit and the gate passed.

From the VibeCoder checkout:

```sh
# Interactive setup and preflight. It asks whether to install a launch agent;
# answer no until you have manually tested a fix.
./fleet-pr-babysitter/setup.sh

# Report candidates only; no model calls or PR changes.
./fleet-pr-babysitter/run.sh --dry-run

# Fix candidates in one pass.
./fleet-pr-babysitter/run.sh

# Limit a first execution to one monitored PR.
./fleet-pr-babysitter/run.sh --repo=owner/name --pr=123

# Repeat every five minutes, after each pass finishes.
./fleet-pr-babysitter/run.sh --watch
```

Setup prompts for the GitHub App ID and private-key path, discovers the App
installation, and verifies its permissions, repository access and GraphQL
quota without printing credentials. It checks the local fleet-lock identities
and required commands. For a non-interactive preflight, use `--check` and
`--app-id=<id>`; the key defaults to
`~/.vibe-coder/fleet-pr-babysitter.private-key.pem`, or pass `--key=<path>`.

On the always-on Mac, rerun setup after manual testing and answer yes to the
launch-agent question. You must also type `INSTALL` to confirm. Setup checks
that the signed-in `gh` account is a configured fleet identity, creates a new
launchd job and starts it; it refuses to overwrite an existing job. The agent
uses the signed-in `gh` account, not the App, until App authentication is
implemented. Every fleet host must trust that account's branch locks. To stop
the agent, use the `launchctl bootout` command printed by setup. Launchd starts
one pass every five minutes and starts another after a process failure.

Manual and launchd runs keep their output under
`~/.vibe-coder/fleet-pr-babysitter/logs`. Each completed pass is compressed;
the newest 30 compressed logs are retained, with each pass limited to 10 MiB
before compression. These logs may contain model output and are private to the
host user; do not publish them. If a process is interrupted or compression
fails, its uncompressed log remains available for diagnosis and the next pass
retries compression after confirming that its owner has exited.

An optional executable `~/.vibe-coder/fleet-pr-babysitter/health-hook` receives
the pass exit code as its sole argument. It is bounded to ten minutes; hook
failure is logged and the next pass retries. Organisation-specific extensions
can use this to publish a separate babysitter heartbeat and failure record.
Dry runs and runs limited to a repository or PR do not report service health.

The host needs `gh` authenticated as a fleet account, `git`, `deno`, `codex`
and RTK. Before execution, put that login in `service_accounts` or
`fleet_pr_authors` **on every fleet host**. Those workers only trust locks
written by known fleet accounts. The MVP checks the local configuration; it
cannot verify other hosts. Use a dedicated account with only the access it
needs. The agent is asked to use RTK; configure Codex's RTK hook as well.
Codex runs with `--full-auto` and is told not to ask questions. When a fix
needs a human decision, it should report the blocker and stop without a
commit. The sandbox still applies; an unavailable
permission or credential can stop a run and must be corrected by the operator.

Only fleet-authored, non-draft, same-repository PRs are considered. A failed
or unproductive agent attempt is recorded under
`${XDG_STATE_HOME:-$HOME/.local/state}/vibe-coder/fleet-pr-babysitter` and
is not retried on that host for the same PR head. Removing the matching state
file permits a retry. The shared lock prevents simultaneous work; this local
attempt record does not prevent a different host from retrying later.

This MVP uses the signed-in `gh` identity and Codex; it does not yet mint a
separate GitHub App token, select providers by remaining quota, handle
Dependabot, use per-repository quality commands, update a merely behind branch,
review PRs, or arm auto-merge. It requires `quality.sh` and refuses to push
when it is missing or fails. It does not change repository review or merge
rules. Test the read-only pass before running execution mode.

To prepare a separate GitHub identity and API quota, follow the
[babysitter GitHub App setup](fleet-pr-babysitter-github-app.md). App token
integration is still required before the runner can use it.
