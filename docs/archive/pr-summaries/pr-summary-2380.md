# Add the `rtk_output.enabled` host switch to `.config.json` (#2380)

## Summary

Adds the off-by-default `rtk_output` block to `.config.json`, parsed and
validated exactly as `codegraph_context` is. Nothing reads the switch yet — the
wiring sub-issues of #2328 consume `config.rtkOutput.enabled`. Closes #2380.

- `worker/deno/lib/rtk_output_config.ts` — `RTK_OUTPUT_KEYS`,
  `defaultRtkOutput()`, `parseRtkOutput()`. An absent block reads as off; a
  non-object block, a non-boolean `enabled`, or an explicit `null` block is
  refused with an error naming `rtk_output.enabled`.
- `worker/deno/types.ts` — `RtkOutputConfig`, `WorkerConfig.rtkOutput`,
  `ConfigFile.rtk_output?: unknown`, each beside its `codegraph_context`
  counterpart.
- `worker/deno/lib/config_defaults.ts` — `OPERATIONAL_DEFAULTS.rtkOutput`.
- `worker/deno/lib/config.ts` — the `parseRtkOutput(file.rtk_output)` call,
  throwing the same `Config file … is invalid: …` error on a fault.
- `worker/deno/lib/config_unknown_keys.ts` — `rtk_output` as a known top-level
  key, and `RTK_OUTPUT_KEYS` in `knownNestedConfigKeys()`.
- `docs/CONFIGURATION.md` — the reference row after the CodeGraph row.
- `docs/audits/security-sweep-2380-rtk-output-config.md` and its slice in
  `docs/audits/lib-sweep-coverage.json` — required of every new `lib/` module
  by the completeness gate.

Where the config value flows once wired:

```mermaid
flowchart LR
    A["`.config.json`<br/>rtk_output"] -->|unknown| B["parseRtkOutput()"]
    B -->|ok| C["config.rtkOutput.enabled"]
    B -->|error| D["config load throws,<br/>naming rtk_output.enabled"]
    C -.->|"wiring sub-issues of #2328"| E["PreToolUse Bash hook<br/>+ prompt line"]
```

## Evidence

Backend/config change with no web interface to screenshot. Verified by the
tests below and by the full gate:

```text
completeness checks   PASSED
deno tests            PASSED
deno lint             PASSED
deno type check       PASSED
deno fmt              PASSED
semgrep               PASSED
Result: PASSED (with skipped checks)
```

(`config integration` is SKIPPED on this machine — no `.config.json` present —
as it is for every run here.)

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — a `.config.json` with no `rtk_output` block loads with
  `config.rtkOutput.enabled === false` — evidence:
  `worker/deno/tests/config_test.ts::config - rtk_output absent defaults to off (Issue #2380)`
  — reviewer: met
- **met** — `{"rtk_output": {"enabled": "yes"}}` fails the config load with a
  message containing `rtk_output.enabled` — evidence:
  `worker/deno/tests/config_test.ts::config - a non-boolean rtk_output.enabled fails the load (Issue #2380)`
  — reviewer: met
- **met** — `rtk_output` is not reported as an unknown top-level key;
  `rtk_output.enabledd` is reported as an unknown nested key with a suggestion
  — evidence:
  `worker/deno/tests/rtk_output_config_test.ts::rtk_output - an unknown nested key is reported with a suggestion`
  — reviewer: met
- **met** — `docs/CONFIGURATION.md` carries the row and
  `config_docs_consistency_test.ts` passes — evidence:
  `docs/CONFIGURATION.md:1742`, `worker/deno/tests/config_docs_consistency_test.ts`
  (6 passed) — reviewer: met
- **met** — `deno test`, `deno lint`, `deno fmt --check` and the repo quality
  gate pass — evidence: the gate output above — reviewer: missing — reason: the
  reviewer ran against the diff before the sweep-ledger fix and saw
  `lib_sweep_coverage_test.ts` red on the unregistered module; that is exactly
  what it caught, and the slice plus its written sweep record were added in
  response, after which the full gate passes.
- **unrequested** — the `buildDefaultWorkerConfig()` entry in
  `worker/deno/lib/config_defaults.ts` — reviewer: unrequested — reason: forced
  by the new required `WorkerConfig.rtkOutput` field; without it the builder
  does not type-check.
- **unrequested** — `docs/audits/security-sweep-2380-rtk-output-config.md` and
  the `top-up-2380` slice in `docs/audits/lib-sweep-coverage.json` — reviewer:
  unrequested — reason: the completeness gate fails any new `lib/` module that
  no sweep slice claims, so the issue's fifth criterion cannot be met without
  them.
- **unrequested** — the `docs/CONFIGURATION.md` row describes runtime behaviour
  no code in this diff implements — reviewer: unrequested — reason: the issue
  asked for that prose, and the row now opens by saying plainly that the key is
  config surface only until the #2328 wiring lands, so an operator is not told a
  no-op is live.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — the new `lib/` module was claimed by no sweep slice, so
  `deno task check:manifests` was red — evidence:
  `worker/deno/lib/rtk_output_config.ts:1` — reason: fixed here; the
  `top-up-2380` slice and `docs/audits/security-sweep-2380-rtk-output-config.md`
  were added, and the gate now passes.
- **violation** — `docs/CONFIGURATION.md` documented behaviour that does not
  exist, so an operator setting the key would get a silent no-op — evidence:
  `docs/CONFIGURATION.md:1742` — reason: fixed here; the row now states up front
  that the key is parsed and validated only until the #2328 wiring lands.
- **violation** — the new `config_test.ts` banner was inserted mid-section,
  leaving a pre-existing codegraph test under the RTK heading — evidence:
  `worker/deno/tests/config_test.ts:2000` — reason: fixed here; the RTK block
  now sits after the codegraph section ends.
- **violation** — DRY: `parseRtkOutput` is executable-code-identical to
  `parseCodegraphContext`, and `isPlainObject` / `describe` are duplicated a
  sixth time — evidence: `worker/deno/lib/rtk_output_config.ts:29` — reason:
  stands. A shared `parseBooleanSwitchBlock()` would rewrite
  `codegraph_context_config.ts` and the four other `*_config.ts` parsers, which
  is outside this issue's scope; the issue asks for a mirror of the codegraph
  module and the fleet's Change Scope rule forbids refactoring adjacent working
  code. Noted for a follow-up.
- **violation** — the row cites `RTK-OUTPUT-TRIAL.md`, which does not exist yet
  — evidence: `docs/CONFIGURATION.md:1742` — reason: stands by instruction; the
  issue requires the page be named in prose **without a link**, because the
  sub-issue that writes the page adds the link. Written as bare text, so no link
  checker is misled.
- **clean** — Australian English throughout (no `color`/`behavior`/`organiz`/…
  hits); no hidden paths staged; tests call real code (`parseRtkOutput`,
  `defaultRtkOutput`, `detectUnknownConfigKeys`, and the real `loadConfig`
  against a temp file) rather than grepping source; happy, error and edge paths
  all covered; fail-loud error handling with no catch-and-ignore; `Result<T, E>`
  rather than throwing for control flow; the default stated once in
  `OPERATIONAL_DEFAULTS`; `ConfigFile.rtk_output` typed `unknown` at the trust
  boundary; purely additive, so an unset block behaves exactly as before; commit
  carries the `Vibe-Coder-Run-Id` trailer.

## Test Plan

Added `worker/deno/tests/rtk_output_config_test.ts` (11 tests):

- absent block → off; empty block → off; `enabled` true/false round-trip.
- a non-boolean `enabled` (`"yes"`, `1`, `null`, `[]`, `{}`) is refused naming
  `rtk_output.enabled`, with the rejected value's JSON **type** in the message
  and never its value.
- a non-object block (`"on"`, `1`, `true`, `["enabled"]`) is refused naming the
  key; an explicit `null` block is refused, not read as off.
- an unknown nested key does not fail the parse.
- `defaultRtkOutput()` follows `OPERATIONAL_DEFAULTS` and returns a fresh object
  each call (asserted by mutating one and re-reading).
- `RTK_OUTPUT_KEYS` accepts only `enabled`.
- `rtk_output` is a recognised top-level key raising no warning, and
  `rtk_output.enabledd` is reported with the suggestion `rtk_output.enabled`.

Added to `worker/deno/tests/config_test.ts` (3 tests): an absent block loads as
off, `{enabled: true}` loads as on, and `{enabled: "yes"}` fails the load with
`rtk_output.enabled` in the message.

No existing test was removed, disabled or modified.
