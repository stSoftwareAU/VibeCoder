# PR Summary — Issue #289

## Summary

The claim-runway floor decides whether the worker may start fresh implementation
work with the runway it has left in the cycle. Its two documented overrides were
read with `Deno.env.get` **inside** the worker container:

- `run_core_production_deps.ts` — `MIN_CLAIM_RUNWAY_SECONDS`
- `run_core_production_deps.ts` — `CLAIM_REQUIRE_FULL_EXECUTE_BUDGET`

`lib/container_launch.ts` forwards exactly five variables, all of which it sets
itself: `VIBE_BASE_DIR`, `CONFIG_PATH`, `VIBE_HOST_ID`,
`VIBE_HOST_DISK_AVAIL_BYTES`, `VIBE_HOST_DISK_TOTAL_BYTES`. Verified against the
live `container run` argv on host GRQ-23. No operator-set environment variable
reaches the containerised worker, so both overrides were inert in the default
run mode while `docs/CONFIGURATION.md` presented them as the supported
interface. The floor silently stayed at its 300 s default on every containerised
host.

The live cost, from `worker-20260822-020311.log`:

```text
02:49:42Z [s1] Processing issue stSoftwareAU/VibeCoder#207
02:50:14Z [s1] Execute timeout regime: deadline-bound — the cycle deadline
               bounds this run to 904s (configured 3600s)
03:00:38Z [s1] [agent-progress] 68 tool calls (last: Bash ./quality.sh …)
03:04:38Z [s1] [agent-progress] 68 tool calls (last: Bash ./quality.sh …, 4m0s ago)
03:05:18Z [s1] ERROR: Claude timed out after 904s — killing process tree
```

#207 was claimed with 15 minutes of runway, spent 10 minutes on a correct
implementation, and was killed 4.5 minutes into the quality gate — which inside
the container is deliberately `nice -n 10` and forced `--sequential` (Issues
#4258, #4267) and cannot finish in that window. It happened again on a second
host at 04:29Z. Two cycles, no PR.

`.config.json` is already mounted read-only into the container at `CONFIG_PATH`,
so this makes the floor a config setting:

- `min_claim_runway_seconds` (number, default `300`, `0` disables).
- `claim_require_full_execute_budget` (boolean, default `false`).

Both are threaded through `WorkerConfig` the way `claude_timeout` already is —
`ConfigFile`, `ConfigFileJson`, `KNOWN_CONFIG_KEYS`, `OPERATIONAL_DEFAULTS`,
`buildDefaultWorkerConfig` and the validator's number/boolean field lists.
`loadConfig` resolves config first, then the legacy environment variable, then
the default, so a native run keeps working exactly as before and a config key
always wins.

`OPERATIONAL_DEFAULTS.minClaimRunwaySeconds` re-exports
`DEFAULT_MIN_CLAIM_RUNWAY_SECONDS` from `claim_runway.ts` rather than repeating
`300`, keeping one definition. The new `readNonNegativeNumberEnv` helper is
deliberately distinct from `getEnvNumberOrDefault`: the caller must tell "the
operator set nothing" from "the operator set a value", so a config key can take
precedence without a sentinel default standing in for an absent variable.

`resolveClaimRunwayFloor` itself is unchanged — it was always correct, it was
just never given the operator's numbers.

`docs/CONFIGURATION.md` gains a row per key and a note that the two environment
variables are native-run fallbacks that do not cross the container boundary.

With `claude_timeout: 1800` and `claim_require_full_execute_budget: true`, a
3600 s cycle raises the floor to 1800 s: no new implementation claim in the last
half hour, and the cycle tail goes to cheap maintenance — what #4304 intended.

Closes #289.

## Evidence

Backend change with no web interface, so there is no screenshot to capture. The
evidence is the test runs below.

**The tests fail against the unfixed tree.** `config.minClaimRunwaySeconds` and
`config.claimRequireFullExecuteBudget` do not exist on `WorkerConfig` in
`origin/main`, so `deno check` rejects the new test file outright; run with
`--no-check`, both read `undefined` and every assertion fails.

**They pass on this branch:**

```text
$ deno test --allow-all tests/claim_runway_config_test.ts
claim runway #289 - the floor is read from .config.json with the environment unset ... ok (18ms)
claim runway #289 - the full-budget gate is read from .config.json with the environment unset ... ok (38ms)
claim runway #289 - absent keys and no environment give the documented defaults ... ok (28ms)
claim runway #289 - the environment still wins on a native run when no key is set ... ok (31ms)
claim runway #289 - a config key overrides the environment ... ok (1ms)
claim runway #289 - `0` disables the floor and is not mistaken for absent ... ok (1ms)
claim runway #289 - a junk environment value falls back to the default rather than NaN ... ok (1ms)
claim runway #289 - the #207 host settings refuse a late claim ... ok (1ms)

ok | 8 passed | 0 failed (160ms)
```

**No regression in the surrounding config suites:**

```text
$ deno test --allow-all tests/config_test.ts tests/config_defaults_test.ts \
    tests/config_validator_test.ts tests/config_unknown_keys_test.ts \
    tests/config_docs_consistency_test.ts tests/claim_runway_test.ts
ok | 251 passed | 0 failed (883ms)
```

**Full quality gate** (`./quality.sh`, host run): `deno type check` (1844 files),
`deno lint`, `deno fmt`, markdownlint, mermaid and every static chokepoint gate
PASSED. `deno tests` reports 12 failures, all pre-existing and none in the
changed area — 11 × `setup.ps1` (`NotFound: Failed to spawn 'pwsh'`,
environmental) and one process test (`runClaudeWithRetry - a SIGKILLed agent's
surviving descendant …`) that is timing-sensitive and failed only under a host
load average of 23.

## Test plan

`worker/deno/tests/claim_runway_config_test.ts` — 8 new cases:

| Case | Asserts |
| --- | --- |
| floor read from `.config.json` with the environment unset | The container path works: `min_claim_runway_seconds` resolves with no env var present |
| full-budget gate read from `.config.json` with the environment unset | Same for `claim_require_full_execute_budget` |
| absent keys and no environment | Falls back to `OPERATIONAL_DEFAULTS` — 300 and `false` |
| environment still wins on a native run | `MIN_CLAIM_RUNWAY_SECONDS=900` / `CLAIM_REQUIRE_FULL_EXECUTE_BUDGET=1` are honoured when no key is set |
| a config key overrides the environment | Config precedence, in both directions including `false` over `=1` |
| `0` disables the floor | `0` is not mistaken for absent — the bug a naive `??` on a falsy value would introduce |
| junk environment value | `MIN_CLAIM_RUNWAY_SECONDS=soon` falls back to the default rather than `NaN` |
| the #207 host settings refuse a late claim | End-to-end: `claude_timeout: 1800` + gate on + a 3600 s cycle gives `floorSeconds: 1800`, `fullBudgetGate: true`, and the 904 s runway #207 was claimed with is below it |

Each env-touching case saves, clears and restores both variables so the suite is
order-independent.

Acceptance criteria from the issue:

- *Honoured from `.config.json` inside the container, proven with the
  environment unset* — the first three cases.
- *The environment still wins on a native run when no config key is set* — the
  fourth case.
- *A claim whose runway cannot fit a full execute is refused, attributed to the
  full-budget gate* — the last case asserts `fullBudgetGate: true`.
- *`docs/CONFIGURATION.md` documents the keys and the container caveat* — two new
  rows and a note; `config_docs_consistency_test.ts` ties them back to
  `KNOWN_CONFIG_KEYS` and passes.
