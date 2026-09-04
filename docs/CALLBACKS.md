# 🪝 Post-Run Callbacks — the extension contract

Optional executables the worker runs after a **terminal issue run**, following
Jenkins `post { success / failure / always }` and Azure Pipelines
`succeeded() / failed() / always()` semantics. They are the public extension
point for fleet-specific reporting — health records, session-log archival,
spend accounting — so none of that policy has to live in VibeCoder.

This page is the **contract**: what fires, what a hook receives, what is
guaranteed, and what a third-party extension is responsible for. The
configuration keys are also summarised in
[Configuration — Post-Run Callbacks](CONFIGURATION.md#-post-run-callbacks);
the contract is documented once, here.

Every property below is provable where you deploy — see
[The conformance fixture](#the-conformance-fixture).

## Configuration

```json
{
  "callbacks": {
    "success": "/opt/vibe-hooks/success.sh",
    "failure": "/opt/vibe-hooks/failure.sh",
    "always": "/opt/vibe-hooks/always.sh",
    "timeout_seconds": 60
  }
}
```

Every entry is optional, and a configuration without a `callbacks` block
behaves exactly as before. A **malformed** block fails the config load rather
than leaving an operator with a hook that silently never runs.

## Ordering and exactly-once scope

```mermaid
flowchart LR
    R["Issue run terminates"] --> D{Result}
    D -- success --> S["callbacks.success"]
    D -- failure --> F["callbacks.failure"]
    S --> A["callbacks.always"]
    F --> A
    A --> O["Original VibeCoder outcome — unchanged"]
```

- `success` runs only after a terminal **successful** issue run; `failure` only
  after a terminal **failed** one. Exactly one of the two runs.
- `always` runs after the applicable outcome hook, in both cases — including
  when that hook exited non-zero, timed out or could not be spawned at all.
- A hook that is not configured is a no-op, and its absence never skips the
  others.
- **The unit is one claimed issue run, not one worker cycle.** A claim that was
  skipped — rejected, or already held by another worker — runs no callbacks:
  no run happened to report. An idle cycle that claimed nothing runs none
  either.
- A shutdown or an exception after a claim takes the failure/`always` path
  **exactly once**: the claim release, the slot-level catch and the shutdown
  drain share one guard, so a hook is never invoked twice for the same claim.
- Concurrent issue slots each receive their own context; hooks never share
  state between slots, and each slot's `always` runs for that slot alone.

## Invocation and path rules

- The configured path is executed **directly** — no shell, no `sh -c`, no
  arguments — so no issue or repository text can ever be parsed as a command.
- The hook is responsible for its own interpreter: a shell hook needs a
  `#!/bin/sh` shebang and the execute bit.
- Paths must be **absolute** and POSIX. A relative or `~`-relative path is
  rejected at config load, because the worker's working directory changes
  between runs and would resolve the same hook differently each time.

What is rejected, and where:

| Fault                                        | Rejected at   | Effect                                     |
| -------------------------------------------- | ------------- | ------------------------------------------ |
| non-string, empty or blank path               | config load   | the worker stops; no issue is claimed      |
| path containing a NUL character               | config load   | the worker stops                           |
| relative, `~`-relative or non-POSIX path      | config load   | the worker stops                           |
| unknown key inside the `callbacks` block      | config load   | the worker stops, naming the recognised keys |
| `timeout_seconds` outside 1…3600, or fractional | config load | the worker stops                           |
| missing, non-executable or un-spawnable path  | invocation    | recorded `spawn_failed`, reported loudly, `always` still runs |

A non-executable path is **never** retried through a shell: there is no
fallback path in which a hook's text could be interpreted as a command. The
execute bit and the file's presence are properties of the filesystem the
worker sees at invocation time, not of the config file, so check them where
the worker runs — [the conformance fixture](#the-conformance-fixture) spawns
the hooks you name and fails on a path that cannot run.

## Filesystem visibility

The worker runs **inside the container** — that is the only run mode
([Containment](CONTAINMENT.md)) — so a hook path is resolved on the filesystem
the container sees, and a host path that is not mounted in is not visible to
it.

```mermaid
flowchart LR
    subgraph host ["🖥️ Host"]
        HP["/opt/vibe-hooks on the host<br/>❌ not visible"]
    end
    subgraph box ["🐳 vibe-coder container"]
        W["worker"] --> H1["/workspace/… (ro)"]
        W --> H2["/home/vibe/auto-issue-work/… (rw volume)"]
    end
    HP -. no callback-specific mount .-x box
```

- **Configuring a callback adds no mount.** The mount set is fixed and built by
  one audited module, so a hook path cannot widen the containment boundary: it
  can only name a path that is already inside it. A path outside the mount set
  simply fails to spawn and is reported — it does not silently escape.
- Practical homes for a hook are therefore the worker checkout mounted
  read-only at `/workspace` (a hook committed to the repository you deploy) or
  the work volume under `/home/vibe/auto-issue-work` (a hook your own
  provisioning writes there).
- The child environment is **cleared** (see below), so a hook inherits none of
  the worker's credential plumbing. A hook that talks to a remote must
  establish its own credentials explicitly — an opt-in, never an accident.

## Timeout, output capture and failure policy

- Every hook is bounded by `timeout_seconds` (default `60`, maximum `3600`).
  A hook that exceeds it is terminated with `SIGTERM` and recorded as
  `timed_out` with exit code `124`. A hook that traps `SIGTERM`, or that forks
  a child holding its output pipes, can outlive that signal — write hooks that
  terminate on it.
- stdout, stderr, the exit code and the duration are captured, passed through
  the worker's secret redaction, truncated to 4,000 characters per stream, and
  logged — including whatever a timed-out hook printed before it was killed.
- **A callback never rewrites the run's own result.** A hook that fails, hangs
  or cannot be spawned is reported loudly, alongside the unchanged VibeCoder
  outcome. Nothing a hook does can turn a failed run green or a successful run
  red.
- Statuses a hook invocation can record: `ok`, `failed`, `timed_out`,
  `spawn_failed`.

## What a hook receives

The environment is **cleared** before it is populated: only `PATH`, `HOME`,
`LANG`, `TZ` and `TMPDIR` are inherited from the worker, so no credential
crosses into a callback. Prompt bodies and transcript contents are never
exported.

`VIBECODER_CALLBACK_CONTEXT` names a versioned JSON document written for that
invocation (mode `0600`) and removed after it exits:

```json
{
  "schemaVersion": 1,
  "event": "success",
  "runId": "vibe-mtk92vcu-ebcc11",
  "result": "success",
  "repository": "owner/repo",
  "issueNumber": 807,
  "host": "worker-1",
  "workerName": "fleet-a",
  "provider": "claude",
  "sessionId": "…",
  "sessionLogPath": "/home/vibe/logs/agent-vibe-mtk92vcu-ebcc11-807.jsonl",
  "startedAt": "2026-09-03T01:00:00.000Z",
  "finishedAt": "2026-09-03T01:31:12.000Z",
  "durationSeconds": 1872,
  "exitCode": 0,
  "telemetry": {
    "inputTokens": 1200,
    "outputTokens": 340,
    "cacheCreationTokens": 90,
    "cacheReadTokens": 20,
    "estimatedCostUsd": 0.42
  }
}
```

The same facts are exported as scalars, one variable each:

| Environment variable                 | JSON field                     | Always present | Meaning                                             |
| ------------------------------------ | ------------------------------ | -------------- | --------------------------------------------------- |
| `VIBECODER_CALLBACK_SCHEMA_VERSION`  | `schemaVersion`                | yes            | Contract version; refuse a version you do not know   |
| `VIBECODER_CALLBACK_EVENT`           | `event`                        | yes            | `success`, `failure` or `always`                     |
| `VIBECODER_CALLBACK_CONTEXT`         | —                              | yes            | Path to the JSON document for this invocation        |
| `VIBECODER_RUN_ID`                   | `runId`                        | yes            | Worker run id                                        |
| `VIBECODER_RESULT`                   | `result`                       | yes            | The run's own result: `success` or `failure`         |
| `VIBECODER_REPOSITORY`               | `repository`                   | yes            | `owner/repo` the run worked                          |
| `VIBECODER_ISSUE_NUMBER`             | `issueNumber`                  | yes            | Issue number the run worked                          |
| `VIBECODER_HOST`                     | `host`                         | yes            | Host the worker runs on                              |
| `VIBECODER_WORKER_NAME`              | `workerName`                   | no             | Operator-configured worker name                      |
| `VIBECODER_PROVIDER`                 | `provider`                     | no             | Agent provider that served the run                   |
| `VIBECODER_SESSION_ID`               | `sessionId`                    | no             | Agent session id                                     |
| `VIBECODER_SESSION_LOG_PATH`         | `sessionLogPath`               | no             | Absolute path to this run's transcript, verified on disk |
| `VIBECODER_STARTED_AT`               | `startedAt`                    | yes            | ISO-8601 claim time                                  |
| `VIBECODER_FINISHED_AT`              | `finishedAt`                   | yes            | ISO-8601 termination time                            |
| `VIBECODER_DURATION_SECONDS`         | `durationSeconds`              | yes            | Wall-clock seconds from claim to termination         |
| `VIBECODER_EXIT_CODE`                | `exitCode`                     | yes            | `0` on success, non-zero on failure                  |
| `VIBECODER_INPUT_TOKENS`             | `telemetry.inputTokens`        | no             | Input tokens the run reported                        |
| `VIBECODER_OUTPUT_TOKENS`            | `telemetry.outputTokens`       | no             | Output tokens the run reported                       |
| `VIBECODER_CACHE_CREATION_TOKENS`    | `telemetry.cacheCreationTokens` | no            | Cache-creation tokens                                |
| `VIBECODER_CACHE_READ_TOKENS`        | `telemetry.cacheReadTokens`    | no             | Cache-read tokens                                    |
| `VIBECODER_ESTIMATED_COST_USD`       | `telemetry.estimatedCostUsd`   | no             | Estimated spend in USD                               |

A fact the run could not supply — no provider, no session, no parseable token
usage, no transcript — is **omitted** from both the document and the
environment rather than emitted empty, so `[ -n "$VIBECODER_SESSION_ID" ]` is
a truthful test. Bump-worthy changes to a field's meaning raise
`schemaVersion`, so a hook that checks it can refuse a contract it does not
understand instead of misreading it.

## Session logs are sensitive — redaction is the hook author's job

`VIBECODER_SESSION_LOG_PATH` is present only when the agent transcript tee was
enabled for that run **and** the file exists on disk. When it is present:

- The transcript is the **raw agent stream** for that run: model output, issue
  and repository text, file contents the agent read, and command output. It is
  written through the worker's console secret redaction, which is a safety net
  for known credential shapes — **not** a guarantee that the file carries no
  sensitive repository content.
- Only the **path** is exported. VibeCoder never puts transcript contents into
  the environment or the context document; reading the file is the hook's
  decision.
- **A hook that exports a transcript anywhere — a health repository, an
  archive bucket, a chat channel — owns the redaction of what it exports.**
  Treat the file as private repository data: redact before export, restrict who
  can read the destination, and apply your own retention.
- The path belongs to **that run**: it embeds the run id and issue number. A
  hook must not infer another run's transcript from it, and a concurrent slot's
  hook receives its own path or none.
- The transcript is worker-managed: log cleanup and rotation age it out, so a
  hook that wants a durable copy must take one during its invocation rather
  than record the path for later.

## Minimal portable hooks

POSIX `/bin/sh`, no bashisms, safe under an unattended worker. Each needs the
execute bit (`chmod 700`) and an absolute path inside the container.

`success.sh` — record a run that finished cleanly:

```sh
#!/bin/sh
set -eu
printf '%s %s#%s ok in %ss\n' \
  "$VIBECODER_FINISHED_AT" "$VIBECODER_REPOSITORY" \
  "$VIBECODER_ISSUE_NUMBER" "$VIBECODER_DURATION_SECONDS" \
  >> "$HOME/auto-issue-work/vibe-runs.log"
```

`failure.sh` — record a failed run, with the spend it still cost:

```sh
#!/bin/sh
set -eu
cost="${VIBECODER_ESTIMATED_COST_USD:-unknown}"
printf '%s %s#%s FAILED (exit %s, cost %s)\n' \
  "$VIBECODER_FINISHED_AT" "$VIBECODER_REPOSITORY" \
  "$VIBECODER_ISSUE_NUMBER" "$VIBECODER_EXIT_CODE" "$cost" \
  >> "$HOME/auto-issue-work/vibe-runs.log"
```

`always.sh` — keep the whole context document, whatever the outcome:

```sh
#!/bin/sh
set -eu
archive="$HOME/auto-issue-work/vibe-contexts"
mkdir -p "$archive"
# Copy, never move: the worker removes the original after this hook exits.
cp "$VIBECODER_CALLBACK_CONTEXT" \
  "$archive/$VIBECODER_RUN_ID-$VIBECODER_ISSUE_NUMBER-$VIBECODER_CALLBACK_EVENT.json"
```

Notes that apply to all three:

- `set -eu` so the hook **fails loud**; its non-zero exit is captured and
  reported, and never changes the run's own result.
- Finish well inside `timeout_seconds`, and do not fork a background child that
  outlives the hook — it will hold the output pipes past the timeout.
- Do not assume any environment beyond `PATH`, `HOME`, `LANG`, `TZ`, `TMPDIR`
  and the `VIBECODER_*` set above.

## The conformance fixture

Reading a contract is not the same as proving it. The worker ships a fixture
that drives the **production** callback runner over **real** subprocesses and
reports a verdict per property:

```bash
cd worker/deno
deno task callback-conformance                       # prove the contract here
deno task callback-conformance \
  --success /opt/vibe-hooks/success.sh \
  --failure /opt/vibe-hooks/failure.sh \
  --always  /opt/vibe-hooks/always.sh                # …against your own hooks
```

It exits non-zero when any check fails, so an extension can run it as a gate in
its own CI. Run it **inside the container**, where the hooks will really run.
Hook paths are validated by the same parser `.config.json` uses, so a path the
fixture accepts is a path the worker will load. `--timeout-seconds` overrides
the budget the fixture gives each hook (its own default is 10 seconds — short,
because a conformance run should not take a minute to fail; the contract's
own default remains 60).

| Check                                | Proves                                                        |
| ------------------------------------ | ------------------------------------------------------------- |
| `success-then-always`                | a successful run fires `success`, then `always`, once each     |
| `failure-then-always`                | a failed run fires `failure`, then `always`, once each         |
| `always-after-outcome-fault`         | `always` still runs after an outcome hook that failed or timed out |
| `result-unchanged-by-callback-fault` | a callback fault leaves the original VibeCoder result unchanged |
| `concurrent-context-isolation`       | context fields identify the correct concurrent run             |
| `session-log-belongs-to-run`         | the transcript path, when present, belongs to that run — and its contents are never exported |

With no hook paths the fixture uses its own portable `/bin/sh` hooks. With them
it drives your executables for the two ordering checks and your `always` hook
for the fault check; checks that need a **deliberate** fault (a hook told to
exit non-zero or hang) always inject a fixture hook, since your hook cannot be
asked to fail on demand, and the two observation checks use fixture hooks that
report what they saw.

Sample output:

```text
Post-run callback conformance: 6/6 checks passed
PASS success-then-always — a successful run runs success, then always
     success=ok(exit 0) → always=ok(exit 0), exactly once each
…
```

## Migrating from `fleet_health_dir` / `fleet_health_repo`

The built-in health tracking (`fleet_health_repo`, optionally
`fleet_health_dir` — see
[Configuration](CONFIGURATION.md#-configuration-defaults)) clones an operator's
health repository into the work volume and runs **that repository's own report
script** on each priority-loop iteration and at the end of a run. It works, but
the schedule, the clone and the timeout all live in VibeCoder, and the reported
facts are whatever that one script happens to collect.

A callback moves the reporting policy out: the hook decides what a record
contains and where it lands, and VibeCoder needs no setting for it.

> **📣 The migration in release order** — which edit lands before the pin move,
> which has to land with it, what to observe on the canary before the rest of
> the fleet follows, and how to roll back — is
> [Release notes — 1.2.0](RELEASE-NOTES.md). This section is the before/after
> mapping.

| Built-in health tracking                          | Callback equivalent                                    |
| ------------------------------------------------- | ------------------------------------------------------ |
| `fleet_health_repo` / `fleet_health_dir` (clone)   | nothing — the hook owns its own checkout and paths       |
| `FLEET_HEALTH_TIMEOUT_MS`                          | `callbacks.timeout_seconds`                             |
| host identity resolved by the worker               | `VIBECODER_HOST`, `VIBECODER_WORKER_NAME`               |
| per-iteration heartbeat and end-of-run report      | one invocation per **terminal issue run**               |
| facts the report script collects for itself        | the context document and the `VIBECODER_*` scalars      |
| errors swallowed as best-effort                    | every fault reported loudly; the run's result unchanged |

Steps:

1. Write an `always` hook that records what your fleet actually wants, using
   the [portable examples](#minimal-portable-hooks) as the starting point.
2. Put it at an absolute path visible **inside the container** — committed to
   the worker checkout under `/workspace`, or provisioned into the work volume.
3. Add the `callbacks` block naming it, and set `timeout_seconds` to whatever
   your recording actually needs.
4. Prove it with `deno task callback-conformance --always <path>` before you
   rely on it.
5. Once the hook covers your reporting, clear `fleet_health_repo` (the
   interactive setup accepts `-` to turn tracking off) so the built-in
   heartbeat stops.

Two differences to plan for:

- **Cadence.** The built-in reports on every loop iteration, so it keeps a
  heartbeat alive on a host doing nothing; callbacks fire only when an issue
  run terminates. A fleet that needs a liveness signal from an idle host still
  needs something else for that — a callback is not a heartbeat.
- **Credentials.** The report script inherits the worker's environment; a hook
  does not. A hook that pushes to a git remote must establish its own
  credentials rather than expecting the worker's to be there.

## Reference

| Concern                          | Implementation                                    |
| -------------------------------- | ------------------------------------------------- |
| `callbacks` block and validation | `worker/deno/lib/run_callbacks_config.ts`         |
| The runner, environment, capture | `worker/deno/lib/run_callbacks.ts`                |
| Context assembly and transcript  | `worker/deno/lib/run_callback_context.ts`         |
| Exactly-once guard               | `worker/deno/lib/issue_callback_guard.ts`         |
| Conformance fixture              | `worker/deno/lib/callback_conformance.ts`         |
| `callback-conformance` command   | `worker/deno/commands/callback_conformance.ts`    |
