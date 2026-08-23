# PR Summary — Issue #324

## Summary

On 2026-08-22 both pool slots wedged, and in both cases the agent had written
an **unbounded bash busy-wait** and was still inside it when the cycle was
killed 2h26m later:

```text
[s1 GRQ#4307]      Bash while [ ! -s /tmp/unit_out2.txt ] || ! grep -qE "^(ok|FAILED|error)" …
[s2 NEAT-AI#3840]  Bash until ! pgrep -f "quality.sh" > /dev/null; do sleep 30; done; …
```

Both had backgrounded work and were spin-waiting for it. Neither loop has a
timeout, and **s1's has no `sleep` at all** — a tight `while` re-running `grep`
as fast as the shell can, pinning a core. The VM sat at ~700% CPU for hours,
the worker's own watchdogs fired 1350 s and 2737 s late, `vminitd` stopped
answering, and a human had to kill the host.

This addresses both halves: stop an agent being *able* to starve the runtime,
and tell it not to write the loop in the first place.

### The agent now runs at a lower scheduler priority

`quality.sh` already nices itself for exactly this reason, and the Containerfile
names the hazard outright:

> …inside the container that starves whatever else must stay responsive — the
> agent driving the gate, and any heartbeat/health machinery in the runtime
> (**kill-on-unresponsive monitors exist in this ecosystem: vminitd's vsock
> health checks**)

The agent — and every shell it spawns, since priority is inherited — was the
other way the container gets saturated, and it was not covered. `nice` is a
priority, not a quota: the agent still gets every idle core and only yields
under contention, so a healthy run is unaffected. It `execvp`s, so the child
PID is still the agent's and the existing process-tree kill is unchanged.

`VIBE_AGENT_NICE` overrides the default of 5. `0` or an unparseable value means
"do not wrap", so a typo degrades to today's behaviour rather than to something
surprising. Negative values are refused: raising the agent *above* the worker
is the opposite of the point.

**`nice` is resolved by absolute path, never through `PATH`.** The agent is
spawned with `clearEnv: true` and a curated environment, so a `PATH` lookup
depends on that environment containing a directory it was never guaranteed to
have. The first cut of this change did exactly that and broke every
`withGhLessStubClaude` test, whose `PATH` holds only the stub — a test caught
it, and there is now a test that pins the absolute-path rule.

### The guidance now forbids the loop

New `prompts/coding_guidelines/v41.md` (published versions are immutable, so
this is a new version rather than an edit to v40) adds a rule under
**Long-Horizon Runs**: never spin-wait on a background job. It shows the two
real shapes from the incident, says what to do instead — run in the foreground,
or bound the poll to a fixed number of iterations and **report giving up** —
and states the reason: something that never finishes must fail loudly, not
quietly consume the host.

The guidance stops the common case; the priority change stops the rest.

Closes #324.

## Evidence

Backend/prompt change with no web interface, so there is no screenshot.

**The new tests fail against `origin/main`** — neither `resolveAgentNiceness`
nor `resolveNiceBinary` exists there, and v41 does not exist, so the guidance
assertions fail on v40.

**They pass here:**

```text
$ deno test --allow-all tests/agent_niceness_test.ts tests/coding_guidelines_spin_wait_test.ts
ok | 13 passed | 0 failed
```

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED,
including `prompt immutability` — v40 is untouched — and `docs prompt
versions`.

`deno tests` reports the 11 pre-existing `setup.ps1` failures and, on one of
two runs, `runClaudeWithRetry - a SIGKILLed agent's surviving descendant …
(Issue #4382)`. That case passes in isolation and passed on the second
whole-file run of identical code, so it is the known timing flake in that file
under load — not a deterministic failure. Its earlier *deterministic* failure
on `main` was a different problem, fixed by #325 and now in this branch's base.

## Test plan

`worker/deno/tests/agent_niceness_test.ts` — 10 cases:

| Case | Asserts |
| --- | --- |
| the agent is niced by default | Unset and empty both give the default |
| an operator can raise the niceness | `VIBE_AGENT_NICE=12` |
| zero means do not wrap, not `nice -n 0` | The off switch does not add a pointless process to the tree |
| a negative niceness is refused | Raising the agent above the worker is the opposite of the point |
| an unparseable value degrades to today's behaviour | A typo must not become a surprising priority |
| clamped to the POSIX maximum | `99` → `19` |
| a fractional value is floored | `7.9` → `7` |
| **nice is resolved by absolute path, never through PATH** | Every probed candidate starts with `/` — the rule the first cut broke |
| an absent nice means unwrapped | Behaviour is exactly as before where `nice` is missing |
| the first present candidate wins | `/usr/bin/nice` then `/bin/nice` |

`worker/deno/tests/coding_guidelines_spin_wait_test.ts` — 3 cases, pinning the
rule by phrase rather than wording, following the best-practices bucket tests'
approach. They read the **highest** `vN.md`, so a future v42 that drops the
rule fails rather than silently losing it:

| Case | Asserts |
| --- | --- |
| the latest guidelines forbid spin-waiting | The rule is present |
| the rule names the bounded alternative | A ban with no alternative gets worked around — `foreground` and a bounded poll must both appear |
| the rule shows the real shapes | `pgrep` and `sleep 30`, copied from the log, so the rule is recognisable rather than abstract |

## Scope

This bounds the *blast radius* and discourages the pattern. It does not add a
per-tool-call timeout — the harness bounds the agent run, not an individual
`Bash` call, and adding that is a larger change to the runner's contract with
the provider. With the priority change the worst case is a slow container
rather than a starved one, and #322's supervisor deadline now ends the cycle
regardless.
