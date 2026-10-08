# PR Summary — Issue #3401

## Summary

Adds the `issue_sub_agent_tier` config key (`"sonnet"` | `"haiku"`), host-wide
and per repository under `repo_config`, wired through the same places as
`issue_executor_split` (#2341). The new
`worker/deno/lib/issue_sub_agent_tier.ts` exports
`resolveIssueSubAgentTier(hostConfig, repoConfig, log)`: a valid repo value
wins, and an invalid value (repo or host) logs a warning naming the key and
value while the host value (or the `sonnet` default) stands. Nothing consumes
the tier yet; S4 of #3385 does. Closes #3401.

## Spec

### Intent and Rationale

- #3385 trials Claude Haiku 5.5 for cheaper `issue`-phase executor sub-agents; this key lets an operator pick the tier host-wide and per repository before any consumer reads it.
- Modelled on `isIssueExecutorSplitEnabled` so the two Advisor/Executor keys resolve the same way.

### Essential Design Decisions

- A bad value warns and falls back; it never fails validation. `loadConfig` throws on any validation error, so failing would take the worker down over a model-tier typo. `validation.ts` types the key as `unknown`.
- `loadConfig` resolves the host value once (`resolveHostIssueSubAgentTier`), and `resolveIssueSubAgentTier` re-validates it, because callers can hand-build a `WorkerConfig`.
- `RepoConfig.issueSubAgentTier` is `unknown`, so the resolver, not the type, is the one place a repo value is checked.
- Persisted data: config only, nothing persisted beyond one process, so no key bump and no old-shape read.

### Undiscoverable Facts

- `lib_sweep_coverage_test.ts` requires every new `worker/deno/lib/` module to be claimed by a sweep slice, so `docs/audits/lib-sweep-coverage/top-up-3401.json` claims `issue_sub_agent_tier.ts`, following `top-up-3383.json`.
- `deno fmt --check` already fails on `docs/CONFIGURATION.md` on the base branch; this change does not add to it.

## Evidence

Backend only, no UI file touched.

**Docs sweep** — grep: `issue_executor_split` and `issue_sub_agent_tier` over `README.md`, `CODING-STANDARDS.md` and `docs/` (excluding `docs/archive/`); new rows at `docs/CONFIGURATION.md:453` (host table) and `:4488` (`repo_config` table); sibling hits still true because the tier has no consumer yet: `docs/CUSTOM-PROMPTS.md:271` (executor-split placeholder), `docs/CONFIGURATION.md:452`, `:4487` (sibling rows), `docs/MODEL-AND-CACHING.md:321,472,516,521,536,553,559,633,2710` (describe the split, not the tier), `docs/audits/security-sweep-*` (historical audit records); section: host config table and `repo_config` table in `docs/CONFIGURATION.md`.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Unset everywhere → `sonnet`. — evidence: `worker/deno/lib/issue_sub_agent_tier.ts:44`; `worker/deno/lib/config_defaults.ts:488`; test "unset everywhere resolves to sonnet without warning" — reviewer: met
- **met** — Host `haiku`, repo unset → `haiku`; host `haiku`, repo `sonnet` → `sonnet`. — evidence: `worker/deno/lib/issue_sub_agent_tier.ts:80-81`; tests "host haiku, repo unset or empty resolves to haiku" and "a valid repo value beats the host-wide value" — reviewer: met
- **met** — Repo `"opus"` (invalid) → warning logged, host value used. — evidence: `worker/deno/lib/issue_sub_agent_tier.ts:83-89`; test "an invalid repo value is refused loudly" — reviewer: met
- **met** — Config validation rejects/warns on a non-string or unknown value without crashing the worker. — evidence: warn branch at `worker/deno/lib/issue_sub_agent_tier.ts:47-53`, `worker/deno/lib/config.ts:921-922`; tests "validateConfigFileJson accepts a bad value (never fails validation)", "loadConfig never throws on a bad host value", "a non-string repo value falls back to the host value" — reviewer: met
- **met** — `config_docs_consistency_test.ts` passes with the new row. — evidence: rows at `docs/CONFIGURATION.md:453` and `:4488` — reviewer: met — reason: the reviewer saw only the diff; the test run (18 passed with `issue_sub_agent_tier_test.ts`) and the full gate were run here

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — no material departures. The named test file exists, spelling is Australian English, and the stub, workflow and drift-test rules do not apply. Optional notes, kept as is: the `unknown` (`RepoConfig`) versus `string` (`ConfigFile`) type asymmetry is intentional, and the two warn-and-fallback blocks stay separate because their messages differ.

## Test Plan

- From `worker/deno`: `deno task test:unit tests/config_docs_consistency_test.ts tests/issue_sub_agent_tier_test.ts` → 18 passed, 0 failed.
- `deno task test:unit tests/lib_sweep_coverage_test.ts` → 39 passed; `deno task check:manifests` → PASSED.
- `deno task check` clean; `deno.lock` unchanged.
- `./quality.sh < /dev/null` → GATE_RESULT_PLACEHOLDER
- Callers and entry points: no consumer yet (S4). Entry points checked: the `loadConfig` host load (`worker/deno/lib/config.ts:921-922`) and the `REPO_CONFIG_KEY_MAP` entry (`worker/deno/lib/config.ts:215`); reverting either turns a test red (below).
- Related rules checked: the `issue_executor_split` config pattern (#2341), "A Code Change Owes a Docs Change" and "Adding a member owes a docs change". Applied to this PR's own diff: both config tables name the new key, and `KNOWN_CONFIG_KEYS` lists it; nothing found.
- No existing test edited, so no assertion is removed.

Branch outcomes:

- `worker/deno/lib/issue_sub_agent_tier.ts:44` — host unset → `sonnet` — "resolveHostIssueSubAgentTier: undefined resolves to sonnet without warning", "unset everywhere resolves to sonnet without warning" — flipping went red
- `worker/deno/lib/issue_sub_agent_tier.ts:45` — valid host value returned — "resolveHostIssueSubAgentTier: haiku resolves to haiku" — flipping went red
- `worker/deno/lib/issue_sub_agent_tier.ts:47-53` — invalid host value warns, default used — "an invalid host value falls back to the default", "loadConfig never throws on a bad host value" — removing the warning went red (2 tests)
- `worker/deno/lib/issue_sub_agent_tier.ts:80` — repo unset → host tier — "host haiku, repo unset or empty resolves to haiku" — flipping went red
- `worker/deno/lib/issue_sub_agent_tier.ts:81` — valid repo value wins — "a valid repo value beats the host-wide value" — flipping went red
- `worker/deno/lib/issue_sub_agent_tier.ts:83-89` — invalid repo value warns, host tier used — "an invalid repo value is refused loudly", "a non-string repo value falls back to the host value" — removing the branch went red (2 tests)
- `worker/deno/lib/config.ts:215` — repo key mapped — "loadConfig end-to-end resolves host and repo overrides" — removing the entry went red
- `worker/deno/lib/config.ts:921-922` — host value resolved at load — "loadConfig end-to-end resolves host and repo overrides"; dropping the return-object field fails `deno check` (TS2741)
- `worker/deno/lib/config_unknown_keys.ts:81` — key recognised — "is a recognised config key" — removing it went red
