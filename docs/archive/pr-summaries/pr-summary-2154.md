# Add the `codegraph_context.enabled` host switch, default off

## Summary

Adds one validated `.config.json` block, `codegraph_context`, carrying a single
`enabled` boolean that defaults to `false`. A host that never writes the block
behaves byte-for-byte as it does today; a host that writes a malformed one is
refused at config load rather than reading as "off". This is the host gate for
the CodeGraph repo-context trial (#2145) — the run-time steps it describes land
with the milestone's remaining sub-issues. Closes #2154.

- `worker/deno/lib/codegraph_context_config.ts` (new) — the trust boundary:
  `parseCodegraphContext()` narrows the raw block, returning the first fault as
  an error naming `codegraph_context.enabled`. Only an **absent** key reads as
  the default; an explicit `null`, a non-object block, and a non-boolean
  `enabled` are each refused.
- `worker/deno/lib/config.ts` — parses the block beside the
  `include_codebase_map` read and throws the fault with the config path.
- `worker/deno/lib/config_unknown_keys.ts` — `codegraph_context` is a known
  top-level key, and a typo **inside** it now warns the way a top-level typo
  does (`codegraph_context.enabeld` → did you mean
  `codegraph_context.enabled`?). The suggestion machinery was factored into one
  `suggestFrom(key, candidates)` so both levels share it.
- `worker/deno/types.ts`, `worker/deno/lib/config_defaults.ts` — the typed
  `CodegraphContextConfig`, `WorkerConfig.codegraphContext`, and the single
  `{ enabled: false }` default in `OPERATIONAL_DEFAULTS`.
- `docs/CONFIGURATION.md` — the operator row beside `include_codebase_map`.
- `docs/audits/` — the new `lib/` module is claimed by the `top-up-2154` sweep
  slice, with its written record.

```mermaid
flowchart LR
    A[".config.json"] --> B["parseCodegraphContext()"]
    B -->|absent or {}| C["{ enabled: false }"]
    B -->|"{ enabled: true }"| D["{ enabled: true }"]
    B -->|null, non-object,<br/>non-boolean enabled| E["config load fails,<br/>naming codegraph_context.enabled"]
    A --> F["detectUnknownConfigKeys()"]
    F -->|unknown nested key| G["warning, load continues"]
```

## Evidence

Backend/config change with no web interface to screenshot. Evidence is the test
run and the full quality gate:

- `deno test tests/config_test.ts tests/config_unknown_keys_test.ts
  tests/codegraph_context_config_test.ts tests/lib_sweep_coverage_test.ts` —
  179 passed, 0 failed.
- `./quality.sh` — `Result: PASSED (with skipped checks)`; the one skip is
  `config integration`, which is skipped on this host for want of a live
  config, not by this change. `deno tests`, `deno lint`, `deno type check`,
  `deno fmt`, `completeness checks`, `markdownlint` and `semgrep` all PASSED.

**Not tested here:** the "both switches true" case. `graft_context` does not
exist anywhere on this branch (`grep -rn "graft_context"` returns nothing) —
#2098 landed it on `milestone/2060-add-graft-repo-context-injection-off-by-defau`
— so a test naming it would assert nothing about co-existence. The two blocks
are read independently: `parseCodegraphContext` looks at `codegraph_context`
alone, and `graft_context` is neither read nor referenced by it, so nothing in
this diff can make one switch interfere with the other.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — a `.config.json` without `codegraph_context` loads with
  `codegraphContext.enabled === false` and no warning — evidence:
  `worker/deno/tests/config_test.ts::config - codegraph_context absent defaults to off with no warning (Issue #2154)`
  (captures `console.error` and asserts it is empty) — reviewer: met
- **met** — `{ "codegraph_context": { "enabled": true } }` loads as enabled —
  evidence:
  `worker/deno/tests/config_test.ts::config - codegraph_context enabled true loads as on (Issue #2154)`
  — reviewer: met
- **met** — a malformed block fails config load with a message naming
  `codegraph_context.enabled` — evidence:
  `worker/deno/tests/codegraph_context_config_test.ts::parseCodegraphContext - a non-object block is refused, naming the key`
  and the two `config_test.ts` load-failure cases — reviewer: partial — reason:
  the reviewer saw the non-object fault naming only the block, and `null`
  reading as off; both were fixed in commit `2f827d29` — every refusal now
  names `codegraph_context.enabled`, and `null` is refused
- **partial** — both switches true on one config loads without error —
  evidence: `worker/deno/lib/codegraph_context_config.ts:56` reads only
  `codegraph_context` — reviewer: missing — reason: `graft_context` is on
  another milestone branch, so the issue's own instruction ("add this case when
  the Graft switch is present … otherwise note it in the PR summary") applies;
  the note is under **Evidence** above
- **met** — `docs/CONFIGURATION.md` documents the switch; `deno task test`,
  `deno task check`, `deno lint` pass — evidence: `docs/CONFIGURATION.md:1737`
  and the full `./quality.sh` run above — reviewer: met
- **unrequested** — the parse lives in a new module,
  `worker/deno/lib/codegraph_context_config.ts`, rather than inline in
  `config.ts` — reviewer: unrequested — reason: `config_unknown_keys.ts` needs
  the block's key set, and importing it from `config.ts` would be an import
  cycle; the module matches `container_extension_config.ts` and keeps a
  1,300-line file from growing
- **unrequested** — `KNOWN_NESTED_CONFIG_KEYS` plus the
  `suggestFrom`/`unknownKeyWarning` extraction generalise nested-key warnings
  beyond this one block — reviewer: unrequested — reason: the issue asked for a
  nested typo to "warn the way the top level does", and sharing the existing
  suggestion code was cheaper than a second copy of it; top-level behaviour is
  unchanged (all 26 pre-existing unknown-key tests pass)
- **unrequested** — `docs/audits/lib-sweep-coverage.json` +
  `docs/audits/security-sweep-2154-codegraph-context-config.md` —
  reviewer: unrequested — reason: a new `lib/` module claimed by no sweep slice
  makes `completeness checks` red; this is the repo's required record for it

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — `CodegraphContextConfig` was inserted between the `Result`
  JSDoc block and `export type Result`, orphaning `Result`'s documentation —
  evidence: `worker/deno/types.ts:607` — reason: fixed here; the interface now
  sits above the `Result` comment
- **violation** — the new `lib/` module was claimed by no sweep slice, so
  `deno task check:manifests` was red — evidence:
  `worker/deno/lib/codegraph_context_config.ts:1` — reason: fixed here by the
  `top-up-2154` slice and its written record
- **violation** — `codegraph_context: null` silently returned the default,
  contradicting the module's own fail-loud preamble and the docs row —
  evidence: `worker/deno/lib/codegraph_context_config.ts:62` — reason: fixed
  here; only `undefined` is silence, and a test pins it
- **violation** — the `false` default was written in more than one place —
  evidence: `worker/deno/lib/codegraph_context_config.ts:42` — reason: fixed
  here; `defaultCodegraphContext()` reads `OPERATIONAL_DEFAULTS`, which is the
  only literal
- **violation** — no test file for the new module, leaving the empty-block and
  `null` branches uncovered — evidence:
  `worker/deno/lib/codegraph_context_config.ts:56` — reason: fixed here by
  `worker/deno/tests/codegraph_context_config_test.ts` (9 tests)
- **violation** — the docs row pointed at `graft_context.enabled` as a sibling
  key that does not exist on this branch — evidence:
  `docs/CONFIGURATION.md:1737` — reason: fixed here; the row names milestone
  #2060 as where that key lives
- **violation** — no `docs/archive/pr-summaries/pr-summary-2154.md` —
  evidence: repository root — reason: fixed here; this file
- **clean** — Australian English throughout (`recognised`, `behaviour`);
  TDD with real-function tests (every test calls `loadConfig`,
  `parseCodegraphContext` or `detectUnknownConfigKeys` with real data — no
  source-grepping); fail-loud posture matching `container_extension_config.ts`;
  `Result<T, E>` and `unknown` at the trust boundary; fast self-contained unit
  tests with no sleeps, subprocesses or wall-clock assertions; additive-only
  config contract; no hidden paths staged; commits carry the issue number and a
  `Vibe-Coder-Run-Id` trailer

## Test Plan

Added:

- `worker/deno/tests/codegraph_context_config_test.ts` — 9 tests over the
  parser: absent, empty block, `true`/`false` round-trip, non-boolean `enabled`
  (string, number, null, array, object), non-object block, explicit `null`,
  unknown nested key not failing the parse, `defaultCodegraphContext()`
  following `OPERATIONAL_DEFAULTS` and returning a fresh object, and the
  accepted key set.
- `worker/deno/tests/config_test.ts` — 6 tests through `loadConfig`: absent →
  off with no warning, `enabled: true`, `enabled: false`, `enabled: "yes"` →
  load error naming `codegraph_context.enabled`, non-object block → load error,
  unknown nested key → one warning naming `codegraph_context.enabeld` and
  suggesting `enabled`, with the load still succeeding.
- `worker/deno/tests/config_unknown_keys_test.ts` — 4 tests:
  `codegraph_context` recognised at the top level, a nested typo warned with
  its block prefix and a block-qualified suggestion, a nested key with no close
  match warned without a suggestion, and a non-object block yielding no nested
  warnings.

Unmodified and still passing: the 26 pre-existing unknown-key tests (top-level
warning behaviour is unchanged) and `tests/lib_sweep_coverage_test.ts`.
