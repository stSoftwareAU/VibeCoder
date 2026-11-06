# Fleet PR babysitter MVP

The babysitter scans the repositories in `.config.json` for open fleet PRs with
merge conflicts, outdated branches, failed CI or requested review changes. By
default it fixes candidates. It takes the same PR branch lock as the fleet's CI
and conflict workers, rechecks the head, and runs one Codex session in a
temporary clone. Up to two independent PR repairs run at once, each with a
90-minute Codex limit and its own branch lock. While repairs run, it rescans
every five minutes and queues newly actionable PRs without starting two repairs
for the same PR. Before Codex starts, the babysitter merges the PR's latest base
into the temporary clone without committing, for every kind of repair, so the
agent works and runs its checks against up-to-date code and the fix and the
branch update reach GitHub in **one push**. A second push just to update the
branch would run the whole CI again and roughly double the Actions cost of the
repair. After Codex reports a completed fix, the babysitter commits the fix and
the merge together as one merge commit, checks the fix (not the base's own
changes) for whitespace errors and conflict markers, and rechecks the PR. It
pushes only if the PR still matches the original head. A base merge on its own
is also pushed when the agent made no change, so the branch is never left
behind. After a push, the babysitter synchronises the PR description from the
summary committed at the pushed head, then publishes any description the agent
proposed (see below), and dismisses an addressed review only if it is still the
current review and the PR head has not changed. A retry with no working-tree
changes also synchronises the body before dismissal, so a prior failed
publication can be repaired. A failed body publication or a stale repair
checkout leaves the review open. Harmless skips, such as an unrelated
marker-less PR or an already-current description, do not block dismissal. GitHub
CI then runs the repository's quality and regression checks on the updated
branch.

```mermaid
sequenceDiagram
    participant B as Babysitter
    participant G as GitHub
    B->>B: Validate and commit repair
    B->>G: Push updated branch
    B->>G: Rebuild and publish PR description
    B->>G: Confirm current head and review
    B->>G: Dismiss addressed review
```

The babysitter also arms auto-merge on every repair candidate that does not have
it yet, through the fleet's shared auto-merge helper, before any repair or
branch refresh. GitHub then merges the PR as soon as CI is green, the branch is
current and the review is approved; arming never bypasses those gates, and on a
base without required checks the helper uses its gated direct merge instead of a
blind `--auto`. Merging soon after the gates pass leaves less time for the base
to move on and cause conflicts. A failure to arm is logged as a WARNING and does
not stop the repair.

The shared repository list stays unchanged. The babysitter monitors only the
configured repositories accessible to its selected GitHub App installation and
logs each skipped repository. For example, an App installed only on
`stSoftwareAU` skips private `TitlePage` repositories in the same configuration.
Access is rediscovered at the start of each pass, including in `--watch` mode;
write tokens are scoped to the accessible configured subset. An explicitly
requested inaccessible `--repo` fails, as do discovery errors or an empty
accessible subset. Access changes during a pass remain API errors and are
re-evaluated on the next pass.

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
installation, and verifies its permissions, repository access and GraphQL quota
without printing credentials, then saves the App settings for run.sh and adds
its bot to this host's fleet-lock identities. It checks and required commands.
For a non-interactive preflight, use `--check` and `--app-id=<id>`; the key
defaults to `~/.vibe-coder/fleet-pr-babysitter.private-key.pem`, or pass
`--key=<path>`.

On the always-on Mac, rerun setup after manual testing and answer yes to the
launch-agent question. You must also type `INSTALL` to confirm. Setup checks
that the App bot is a configured fleet identity, creates a new launchd job and
starts it; it refuses to overwrite an existing job. Every fleet host must trust
the App's branch locks. To stop the agent, use the `launchctl bootout` command
printed by setup. Launchd starts one pass every five minutes and starts another
after a process failure.

Manual and launchd runs keep their output under
`~/.vibe-coder/fleet-pr-babysitter/logs`. Each completed pass is compressed; the
newest 30 compressed logs are retained, with each pass limited to 10 MiB before
compression. These logs may contain model output and are private to the host
user; do not publish them. If a process is interrupted or compression fails, its
uncompressed log remains available for diagnosis and the next pass retries
compression after confirming that its owner has exited. Each pass also removes
its temporary PR clones after use. A later pass removes clones left by an
interrupted babysitter after confirming their owner exited; it leaves live and
unrelated directories alone.

Each repository also has one bare mirror, kept at
`${XDG_STATE_HOME:-$HOME/.local/state}/vibe-coder/fleet-pr-babysitter/mirrors/<owner>--<repo>.git`.
The first repair of a repository downloads it once with `git clone --bare`,
bounded to 30 minutes. The download is built in a `.tmp` sibling and renamed
into place only when complete, so a failed download leaves no mirror. Each later
repair fetches heads and tags with `--no-auto-maintenance` in the mirror, then
runs automatic maintenance in the foreground before copying, serialised per
repository within the process. It then runs
`git clone --no-checkout --no-hardlinks <mirror> <dir>` to make its temporary
clone. That clone holds the full history, so merge bases and `git diff` against
the base work without lazy fetches; it is not a partial clone and does not
depend on the mirror afterwards. The clone's `origin` is then set back to the
GitHub URL: `git@github.com:<repo>.git` when
`gh config get git_protocol -h github.com` reports `ssh`, otherwise HTTPS. Each
fetch uses the currently resolved URL, even if the mirror was created with a
different protocol. If the fetch fails, the repair fails with git's cause, the
mirror is kept, and the next pass retries. Passes never remove mirrors; delete a
mirror directory to force a fresh download. Codex reads the filesystem under its
permissions profile, so it can read a mirror, but it cannot write to one because
its write grants are only the clone and scratch directory. Mirrors are not among
the `~/.vibe-coder/fleet-pr-babysitter*` denylist entries, so do not treat them
as credential-protected.

An optional executable `~/.vibe-coder/fleet-pr-babysitter/health-hook` receives
the pass exit code as its sole argument. It is bounded to ten minutes; hook
failure is logged and the next pass retries. Organisation-specific extensions
can use this to publish a separate babysitter heartbeat and failure record. Dry
runs and runs limited to a repository or PR do not report service health.

The host needs `gh`, `git` and `deno`. Codex CLI must be 0.164.0 or newer,
because older versions may silently ignore the permissions profile; a
pre-release counts when its base version is newer (0.166.0-alpha passes,
0.164.0-beta does not). Setup and each repair check the `codex` on PATH before
minting an agent token. When it is missing, too old or unrecognised, they
install the Codex version pinned in `container/tools.json` (CLI and code-mode
host, macOS or Linux, each archive verified against its pinned SHA-256) under
`~/.vibe-coder/codex/<version>-<target>/` and run that instead, so an unattended
host needs no manual upgrade. When RTK is available, each repair receives
instructions to use it; otherwise the babysitter logs a warning and continues
without it. Before execution, put the App's `<slug>[bot]` login in
`service_accounts` or `fleet_pr_authors` **on every fleet host**. Run setup on
each host (or deploy your organisation's fleet configuration) before starting
repairs. Those workers only trust locks written by known fleet accounts. The MVP
checks the local configuration; it cannot verify other hosts. Use a dedicated
account with only the access it needs. An operator may also configure a trusted
Codex RTK hook on each host. Each repair activates the worker-side GitHub write
allowlist for its target repository, including lock comments, branch updates and
review dismissals. Concurrent repairs use separate scopes. Codex runs with
approvals disabled, under a per-spawn Codex permissions profile
(`default_permissions` and a `permissions.<profile>.filesystem` inline table
passed as one `-c` value) that reads the filesystem, writes only the temporary
clone (its `.git` read-only) and scratch directory, and has no access (`none`)
to the babysitter App private key, the worker credential directory, the host
`gh` config directory, configured reviewer and worker App keys, configured
service-account SSH key, the `~/.vibe-coder/fleet-pr-babysitter*` entries and
their resolved symlink targets. Credential locations are read from the same
`CONFIG_PATH` file and host environment as the worker, including the documented
defaults `~/.vibe-coder/credentials` and `~/.config/gh`. The configured spelling
is resolved with filesystem traversal semantics, so `..` after a directory
symlink follows the target's parent. Normalised locations and their canonical
targets are also denied; missing tails are resolved through the longest existing
parent. These entries are denied because the agent shares the runner's OS user
and file modes alone do not protect them; it is also told not to ask questions.
When a fix needs a human decision, it should report the blocker and stop without
a commit. The sandbox still applies; an unavailable permission or credential can
stop a run and must be corrected by the operator. Codex gets its own
installation token, minted per repair for the target repository only, with
read-only permissions (contents, pull requests, issues, checks, actions). Every
GitHub write (lock, push, branch update, review dismissal, PR description) is
made by the runner with its own token. The runner restarts a session with a fresh repository-scoped read token
when its token approaches expiry, preserving the repair clone. When a review asks
for a description change, the agent writes the complete new description
(Markdown) to `.babysitter-pr-body` in the clone. The proposal is data, not
authority. The runner takes the file out of the clone before the change check,
so it is never committed. After the push, or on a no-change retry at the
unchanged head, the description steps run in order:

1. It synchronises the description from the summary committed at the pushed
   head. The sync is pinned to that commit: just before the edit, the checkout
   must still be at it and `git ls-remote` must still report the PR branch at
   it. The pinned-head skips (`checkout moved off the committed head`,
   `pushed head moved`, `pushed head could not be verified`) keep the review
   open. So does any skip outside the harmless set: `no worker marker`,
   `summary unchanged`, `summary file deleted`, `body already current` and
   `summary not committed at the pushed head`.
2. After a push, it waits for GitHub's PR view to report the pushed head before
   the sync in step 1 runs. It reads the view up to ten times, one second apart
   (`waitForPushedHead`). If the view never shows that head, the step fails and
   the review stays open. Publishing then reads the live description and
   requires its head to equal the pushed head. The proposal is published on top
   of the sync, except on a repair that pushed nothing where a summary committed
   at the head governs the body: the sync already rebuilt the body from that
   summary, so the proposal is not published. The finish throws
   `ProposalOverGoverningSummaryError` and the reviews stay open. A description
   change on such a PR belongs in the committed summary, which a repair that
   pushes publishes. With no proposal, the body is edited only to
   withhold a close that GitHub still honours.
3. It strips every complete hidden `<!-- vibe-… -->` marker from the proposal in
   one linear scan. A marker quoted in a Markdown code span in the live body is
   not copied. A stray unclosed `<!--` in the proposal is neutralised, so it
   cannot hide the appended reference or markers. It then appends the live
   body's markers (worker issue, summary digest, sub-agent tier and assignment
   id), so the digest reconcile keeps working.
4. It decides closing or non-closing for the governing issue: the worker marker
   in the live body, else the issue the worker branch (`issue-N-...`) names, so
   a body that lost its marker is still governed. A PR with neither is unrelated
   and only gets its dropped closing references restored. Closing (`Closes #N`)
   is kept only when the summary committed at the pushed head has no `partial`
   or `missing` criterion and the proposal, if any, has no `partial` or
   `missing` criterion of its own. The summary's own wording does not decide it:
   for a fully met summary the guard appends `Closes #N` unless the proposal
   already has a closing keyword for the issue. It differs from the canonical
   assembler on purpose: the assembler appends `Closes #N` whenever the summary
   has no closing keyword, even beside `Part of #N` or `Refs #N`, but the guard
   honours an explicit non-closing reference the agent chose, namely
   `Part of #N`, `Ref #N`, `Refs #N`, `Refs: #N`, `References #N`,
   `Related to #N` or `Relates to #N` (in this repository, or with no
   repository given). That can only leave the issue open, never close it, and a
   proposal is data and not authority to close, so that reference is not
   overridden with `Closes #N`. A bare mention such as
   "addresses the review on #N", or another repository's `owner/repo#N`, is not
   a closing claim and does not stop the append. The summary is read with the
   shared committed loader (`loadCommittedPrSummary`) at the verified pushed
   head sha, using `git ls-tree` and `git show`. The working tree is never read.
   The loader tries the same candidate paths as the sync, in order: the
   canonical `docs/archive/pr-summaries/pr-summary-<N>.md`, the legacy
   `docs/pr-summary-<N>.md`, then `.pr_summary`. A failed read leaves the review
   open. An unmet criterion, a missing committed summary or unknown evidence
   gives `Part of #N`. So does a negated sentence such as "does not close #N",
   which GitHub still honours as a closing reference, so that sentence is
   reworded. An association the proposal dropped entirely is restored in the
   form the evidence supports, and closing references to other issues that the
   proposal dropped are restored.
5. It verifies before dismissal. The live head is checked before the edit and
   again after it. When an edit was made, the description read back must match
   what was published. When the close is withheld, GitHub's
   `closingIssuesReferences` must not list the issue as closed by the PR; this
   check runs only in that case. The body reads must include
   `closingIssuesReferences` as an array: a missing key is rejected, not read as
   "no references". Dismissal then waits up to ten reads, one second apart, for
   the PR head to show the pushed head, and dismisses only the reviews that are
   still requested.

A proposal over GitHub's 65,536-character limit is rejected at intake, once
surrounding whitespace is trimmed, and the review stays open. The composed
description is checked against the same limit again when it is published, after
the push and the sync. The limit applies to the whole description, including the
appended references and markers, so a proposal under the limit can still be
refused. A refusal leaves the review open.

Any failure leaves the review open, and a later eligible scan retries on the pushed
head, except a proposal refused over a governing summary (step 2), which a
retry would refuse again: its pending record is cleared and the review stays
open until the committed summary changes. A repair that addresses reviews writes a
pending-publication record, `<attempt key>--publication.json` in the same state
directory, before the sync. It holds the proposal and whether the repair pushed
the head. The next eligible scan finds the record before it merges the base or starts the
agent, and runs the publication again from a clean clone at the PR head; the
record is removed once the reviews are dismissed, or when the proposal is
refused over a governing summary. It is found only while the
scan still sees the same requested review at that head. The retry is idempotent:
a body that is already current is not edited again. A legacy body that has the
worker marker but no summary digest is synchronised through the before-push
diff. On a no-change retry there is no earlier head, so the diff runs against
git's empty tree: the committed summary counts as changed, and the sync still
edits only when the rebuilt body differs from the live one. The recoverable next
action is the thrown error, the open review and the pending-publication record;
when the proposal was refused over a governing summary the record is cleared, so
it is the error and the open review, and the fix is to change the committed
summary and push.
The guard is `worker/deno/lib/babysitter_pr_body_guard.ts`, and the close
decision uses the close guard (#3177/#4644) in
`worker/deno/lib/missing_criterion_close_guard.ts`.

The runner and the agent exchange files through a runner-owned exchange
directory that the agent cannot write, outside its clone and scratch grants. The
runner stages the PR description it applies there before
`gh pr edit --body-file`, and it passes Codex a `--output-last-message` file
there for the final message that ends with the completion marker. The agent can
write `.babysitter-pr-body` in the clone, so the runner reads that file, and the
final message, through a no-follow, regular-file, size-bounded reader. A
symlink, FIFO, hard link or oversized file fails the repair before anything is
published. The bounded reader opens read-write, so a FIFO raced in before the
open does not block on Unix; it then refuses the non-regular descriptor. This
also requires write permission on the output file. Another special file can
still leave an open pending after the timeout; it cannot be cancelled and can
keep a process alive. The non-watch pass explicitly exits after cleanup so it
cannot hold the supervisor. Watch mode continues running with the pending open;
if it eventually completes, its descriptor is closed. A repair that fails this
way publishes no PR description and dismisses no review. It is recorded as a
failed attempt for that head, so it is not retried on this host until its state
file is removed, as described above; a new head or a new review gets its own
attempt. The design relies on Codex writing `--output-last-message` from outside
the agent's permissions profile. That behaviour is taken from the issue and has
not been checked against an installed Codex, so confirm it on each host, as for
the key check in "Verifying the credential boundary" below.

The profile explicitly enables network access so the agent can fetch GitHub
feedback and check details. Host `[sandbox_workspace_write]` settings do not
apply to this profile: `network_access` and `writable_roots` are not inherited,
and `/tmp` is not automatically writable. The agent can write to its assigned
clone and scratch directory instead; the runner-owned exchange directory that
holds the final message and the staged PR description is not among them.

**Verifying the credential boundary.** The permissions-profile keys were written
without an installed Codex to test against. The paths are passed as the keys of
one inline-table value, not as dotted `-c` keys, because Codex splits a `-c` key
on every dot and every protected path contains dots. After upgrading Codex or
changing the key path, confirm on the host that the agent cannot read the key:
run a one-off `codex exec` with the same `-c` overrides the babysitter passes
(built by `buildBabysitterSandboxArgs` in
`worker/deno/lib/fleet_babysitter_sandbox.ts`), ask it to `cat` the App private
key, and expect a denied read. The GitHub token handed to the agent stays
read-only. This is a path denylist derived from the worker configuration and
documented host defaults, not a guarantee that every credential on a host is
unreadable.

Fleet-wide scans consider only fleet-authored, non-draft, same-repository PRs. A
PR labelled `needs-human` is never a candidate: it waits on a person, for
example a check that declared a human gate. An explicitly selected `--repo`
scans that repository regardless of PR author; `--pr` narrows the scan to one
PR. Both retain the same lock and validation. A red check whose workflow runs
were cancelled rather than failed (every run on the head finished, one or more
cancelled, none failed) starts no agent: the runner asks GitHub to re-run the
cancelled runs, once per head. That needs the App's `actions: write` permission;
with `actions: read` the re-run is refused and logged as a WARNING naming the
permission. A PR that a fleet worker holds a live PR-feedback lease claim on
(`PR_COMMENT_CLAIM` with an unexpired `PR_COMMENT_CLAIM_LEASE`) is skipped for
that pass, so the babysitter never repairs beside a worker that is about to
push.

Retry records live under
`${XDG_STATE_HOME:-$HOME/.local/state}/vibe-coder/fleet-pr-babysitter` as
versioned, atomically replaced JSON. Each record binds the repository, PR,
stable failure identity, observed and pushed heads, blocker class, last outcome,
infrastructure and substantive attempt counts, next eligible time, next action,
and reconciliation state. The identity survives repair pushes; a new change
request review gets a separate identity. A legacy create-only attempt file is
migrated to a five-minute cooldown and then becomes eligible again. No manual
state-file deletion is part of normal recovery.

Completed repair attempts carry a separate
`vibe-babysitter-attempt` marker in a fleet-authored PR comment. Hosts count only
markers written by configured fleet authors, so the configured repair limit
is shared across hosts and survives a restart. Only consecutive no-change or
failed outcomes count; a successful push resets the no-progress budget.
Infrastructure and capability failures do not add an attempt marker. These
markers cannot be mistaken for a CI escalation that lifts a human hold.

A failure is classified from where it is raised: a structured cause (agent
killed by a signal or exit 137/143, a lock that could not be renewed, a head
that moved) first, and the error text only as a fallback. Infrastructure, host
capability (missing tool, full disk) and head or lock races receive bounded
cooldowns without spending the substantive repair budget and post no attempt
marker. Codex diagnostics classify provider, authentication, quota, rate-limit,
network and memory failures as infrastructure; an unreadable or empty
diagnostic on a non-zero exit is also infrastructure. A reported quota reset
or retry-after time delays the next attempt. Code failures, runner
session-budget exhaustion and no-progress
outcomes spend that budget. A changed head bypasses the old cooldown while
keeping the attempt history. The retry
record is saved before any best-effort marker write, and a failed marker write
never replaces the repair's real error.

When substantive attempts reach the configured `maxAutoFixAttempts` limit, the
record keeps the newest five redacted evidence lines, and the babysitter posts
an auto-fix cap marker for failed CI or a separate babysitter handoff marker
for other incidents. Further sessions for that incident stop until
the head or requested review changes, including green review-feedback and
merge-conflict incidents. A failed handoff is retried without another agent
session. The shared tally also bounds sessions on a different host. A moved
head retains the attempt history and receives a changed-diagnosis prompt with
fenced, redacted prior evidence.

A fleet-authored marker deduplicates the handoff across hosts and restarts.
The stall self-repair ladder consumes the CI cap for eligible blocking red-CI stalls and
skips its first trip. Green review-feedback and conflict lanes do not consume
that cap, and non-blocking red-CI incidents do not enter the ladder; their safety bound is the paused babysitter incident. No separate
escalation issue is created. The comment identifies the babysitter handoff, so
it does not claim ownership of a human `needs-human` label. Explicit human
holds stay paused until cleared. Waiting paths release the branch lock; the
next scan logs the cause, next action, and eligible time.

Local git validation, staging, commit and merge failures are code failures even
when the diagnostic contains transport words in file paths or source text.
Clone, fetch and push failures default to infrastructure after capability
checks. A push `[rejected]` is a race; `[remote rejected]`, a declined
pre-receive hook and GH0xx rule violations are code failures. Git disk-full
and spawn failures count as capability failures for
every operation. A pending-CI observation preserves an escalated incident's
handoff head until repair consumes the head change. Handoff markers use that
incident head, independent of any older successful push on a host.

After a successful push the state records the pushed head and waits for CI and
independent review. Each later scan observes the PR without taking a lock:
pending CI, a pending or dismissed review, a draft, a cross-repository PR, a
repository with `skip_auto_merge` and a `needs-human` hold are each recorded as
what the PR waits on. A green, approved, clean PR is recorded as
`handed-to-auto-merge-owner`: the shared auto-merge policy and worker sweep
handle landing it. The babysitter arms candidates through that shared policy
before repair, subject to its existing gates.
Failed checks and new requested changes return to the repair scan. A later scan
reads tracked PRs even when they are no longer in the first page of open
candidates, and clears retry state after GitHub reports `MERGED` or `CLOSED`.
A push, a hand-off or a dismissed review is never a merged outcome. Closed
records are not re-read on later scans; a reopened PR appears in the open list.

```mermaid
stateDiagram-v2
    [*] --> Eligible
    Eligible --> Repairing: acquire branch lock and recheck head
    Repairing --> CoolingDown: infrastructure, capability, race, or failure
    CoolingDown --> Eligible: next eligible time reached
    Repairing --> WaitingForChecks: repair pushed
    WaitingForChecks --> Repairing: failed check or new review finding
    WaitingForChecks --> WaitingForChecks: pending CI or independent review
    WaitingForChecks --> Merged: GitHub reports MERGED
    WaitingForChecks --> ClosedUnmerged: GitHub reports closed without merge
    Repairing --> OwnerHold: explicit needs-human hold
```

Repository mirrors live in the same state directory, under `mirrors/`, as
described above.

## Shift-left detection

A fleet PR that fails CI costs a CI run and a second agent session to repair it.
Each pass, before it starts repairs, the babysitter looks for CI failures that
keep recurring on fleet PRs and that a check on the Mac could have caught before
the PR was raised (Issue #4610). It does not weaken any check; it moves the same
check earlier.

- It reads the PR workflow runs that failed since its last scan and records one
  observation per failed job of a fleet PR. A job counts only when its failed
  step runs a recognised local tool (`cargo clippy`, `cargo fmt`,
  `cargo mutants`, `cargo llvm-cov`, `deno test`, `markdownlint` and so on) and
  the CI failure classifier calls it a code fault. Infrastructure, timing,
  aggregator and deployment-state failures never count.
- When the same check and step fail on 3 or more distinct fleet PRs within 7
  days, it files one issue in the repository that owns the fix:

  | Situation                                                                                                       | Filed in                           |
  | --------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
  | Most failing heads were pushed by the babysitter itself                                                         | VibeCoder                          |
  | The repository's `quality.sh` already runs the tool, so the fleet raised or pushed without a passing local gate | VibeCoder                          |
  | CI runs the tool but no local gate does, in 2 or more repositories                                              | VibeCoder, once (a fleet-wide gap) |
  | CI runs the tool but this repository's local gate does not                                                      | That repository                    |

- A repository's VibeCoder-routed checks are filed as one issue that lists every
  tool, because they share one cause.
- Issues carry the `idle-task` label, so the fleet picks them up without a human
  label. A recurrence adds at most one comment a day to the open issue; a
  recurrence after the issue was closed files a new issue that links the old
  one. A VibeCoder issue about a private repository names neither the repository
  nor its PRs.
- Each pass inspects at most 40 failed runs per repository and remembers the
  runs it has scanned, so a busy repository's backlog does not delay repairs;
  later passes pick up the rest.
- The ledger is `shift-left-ledger.json` in the babysitter state directory. A
  dry run records observations and reports what it would file, but writes
  nothing to GitHub. A run limited with `--pr` skips detection.

Each repair also re-runs its checks locally before it reports ready: a CI repair
reproduces the failing step with the command the workflow runs and confirms it
passes, and review and conflict repairs run the formatter, linter and type or
compile check for the code they touched.

This MVP uses the configured GitHub App and Codex; it does not yet select
providers by remaining quota, handle Dependabot, use per-repository quality
commands, or review PRs. It does not change repository CI, review, or merge
rules. Test the read-only pass before running execution mode.

To prepare a separate GitHub identity and API quota, follow the
[babysitter GitHub App setup](fleet-pr-babysitter-github-app.md).
