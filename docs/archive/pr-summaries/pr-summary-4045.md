## Summary

Closes #4045. A single module, `worker/deno/lib/egress_allowlist.ts`, owns the egress host list: GitHub and the package registries are always on, agent-provider hosts follow the enabled providers, the imgbb host follows imgbb being configured, and the `ANTHROPIC_BASE_URL` host is appended last. One config key, `egress_allow_hosts`, adds operator hosts. Each entry is validated and normalised, and an invalid entry makes config load throw, naming the entry, with no fallback to a partial list. Enforcement is NOT yet in place: the list is validated but not enforced, and enforcement is deferred to #4046 (CONNECT egress proxy). The trigger (a bad operator entry launching with a partial list) is closed. Validation runs before any host is used, and no path skips it: `loadConfig` in `worker/deno/lib/config.ts` is the only caller of `resolveEgressAllowlist`, no `return` precedes the call inside `loadConfig`, and a failure there rethrows as `Config file ... is invalid`. The new module is claimed by the lib-sweep top-up slice `docs/audits/lib-sweep-coverage/top-up-4045.json`, and `tests/egress_allowlist_test.ts` is registered in `WALL_CLOCK_TEST_FILES` (`worker/deno/lib/parallel_unsafe_test_manifest.ts`) because it uses `assertLinearGrowth`.

## Spec

### Intent and Rationale

- Egress hosts were spread across the code, so a change to one provider could leave the others out of step. One module holds the whole list, and one key lets an operator add hosts without editing code.
- A bad operator entry must stop the worker at config load. Launching with a partial list would look like a working allowlist while missing hosts.
- Enforcement is a separate step (#4046). This PR only makes the list single-sourced and checked, so the enforcing change has one list to read.

### Essential Design Decisions

- The list is built in a fixed order: GitHub, enabled providers, imgbb (when configured), registries, `ANTHROPIC_BASE_URL` host, then `egress_allow_hosts` extras. The first occurrence of a host wins, and duplicates collapse.
- Only enabled providers contribute hosts. Unknown provider ids contribute nothing (`Object.hasOwn` guard).
- `validateEgressHost` rejects an invalid entry with a message naming the entry and the rule it broke.
- Config load calls `resolveEgressAllowlist` and discards the result until #4046 consumes it.

### Undiscoverable Facts

- Provider hostnames are hardcoded in `egress_allowlist.ts` and were NOT confirmed against the provider modules: `api.anthropic.com`, `api.openai.com`, `chatgpt.com`, `generativelanguage.googleapis.com`, `api.imgbb.com`. The DeepSeek host is taken from `DEEPSEEK_ANTHROPIC_BASE_URL` (`deepseek_env.ts`) and was not checked against its provider module either.
- The OAuth hosts are unverified: `auth.openai.com`, `oauth2.googleapis.com`, `console.anthropic.com`, `platform.claude.com`, `cloudcode-pa.googleapis.com`.
- A local-host `ANTHROPIC_BASE_URL` is skipped. Local means a single-label host (`localhost`, `[::1]`) or a numeric last label. This is a minor deviation from the issue text, which did not name these cases.
- The `reason` and `provider` fields on `EgressHostRule` are set but not read by code (checked: no `.reason` or `.provider` reads in `egress_allowlist.ts`, `config.ts` or `agent_provider.ts`).
- Validation rules for an `egress_allow_hosts` entry:
  - Lower-case; a `:443` suffix is stripped; any other port is refused.
  - Wildcard only as `*.hostname`; no bare `*`.
  - No IP literals (last label all digits).
  - At least two labels; each label matches `^[a-z0-9-]{1,63}$` with no leading or trailing `-`.
  - At most 253 characters; no whitespace or control characters; no empty string; non-string entries refused.

## Evidence

- Backend-only / docs-only change; no UI, no screenshot.
- Docs sweep: section: `docs/CONTAINMENT.md` "Egress allowlist" and the `egress_allow_hosts` row in `docs/CONFIGURATION.md`; grep "egress_allow_hosts", "egress allowlist", "allowlist" over `docs`, `README.md`, `prompts`, `worker/deno/lib`; siblings: `agent_providers`, `imgbb_api_key`, `agent_provider_fallback`; updated: docs/CONFIGURATION.md, docs/CONTAINMENT.md, worker/deno/types.ts, worker/deno/lib/config_unknown_keys.ts, worker/deno/lib/parallel_unsafe_test_manifest.ts, docs/audits/lib-sweep-coverage/top-up-4045.json; left alone: the general-egress sentences in `docs/THREAT-MODEL.md` and the default-deny fragment in `docs/SETUP.md` — still true, because each says general egress stays open until #3698 and none describes the host list.
- Security-fix evidence: `worker/deno/tests/config_test.ts::config - egress_allow_hosts rejects an IP literal (Issue #4045)` is the evidence test. Recorded as red on the base and green at head.
- The trigger is closed with no trivial bypass: mixed case is normalised to lower case and `:443` is stripped; any other port, whitespace, control characters and IP literals are refused by tests, and config load throws on any invalid entry.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->
- **met** — A disabled provider contributes no hosts, and an enabled provider contributes exactly its documented hosts. — evidence: `worker/deno/tests/egress_allowlist_test.ts::resolveEgressAllowlist - a disabled provider contributes no hosts (Issue #4045)`; `worker/deno/tests/egress_allowlist_test.ts::resolveEgressAllowlist - each enabled provider contributes exactly its documented hosts (Issue #4045)` — reviewer: met
- **met** — The `ANTHROPIC_BASE_URL` host and `egress_allow_hosts` entries are added, and duplicates collapse. — evidence: `worker/deno/tests/egress_allowlist_test.ts::resolveEgressAllowlist - ANTHROPIC_BASE_URL host is added, lower-cased (Issue #4045)`; `worker/deno/tests/egress_allowlist_test.ts::resolveEgressAllowlist - operator extras are appended after the base URL host (Issue #4045)`; `worker/deno/tests/egress_allowlist_test.ts::resolveEgressAllowlist - duplicates collapse to one entry each, first occurrence wins (Issue #4045)` — reviewer: met
- **met** — An invalid entry fails config load with an error naming the entry. — evidence: `worker/deno/tests/config_test.ts::config - egress_allow_hosts rejects an IP literal (Issue #4045)`; `worker/deno/tests/egress_allowlist_test.ts::validateEgressHost - each refusal names the entry and its rule, and the legal twin is accepted (Issue #4045)` — reviewer: met
- **met** — The docs-drift test fails both ways. — evidence: `worker/deno/tests/containment_docs_test.ts::CONTAINMENT.md's egress allowlist lists exactly the module's hosts`; `worker/deno/tests/containment_docs_test.ts::CONTAINMENT.md says the egress allowlist is not enforced until #4046` — reviewer: met
- **met** — The quality gate passes. — evidence: `./quality.sh` ended "Result: PASSED (with skipped checks)"; the only skip is the config integration check, which needs a local `.config.json` this checkout does not have — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->
- **violation** — A refusal test must be refused by the rule it names: the refusal tests lacked per-rule assertions and legal twins — evidence: `worker/deno/tests/egress_allowlist_test.ts` — reason: fixed in this diff — each refusal now asserts the entry and its rule, and the same input made legal is accepted.
- **clean** — Tests exercise real code, docs follow the code change, commit safety, Deno tooling only, and input validation at the config trust boundary. Open notes: the `reason` and `provider` fields are unread by code (recorded under Undiscoverable Facts).

## Test Plan

<!-- vibe-branch-outcomes -->

- `./quality.sh`: "Result: PASSED (with skipped checks)"; config integration skipped (no `.config.json`).
- `deno task check:manifests` passed (793 entries), and the registry tests passed (70 tests).
- `deno test` on `worker/deno/tests/egress_allowlist_test.ts`, `worker/deno/tests/containment_docs_test.ts` and `worker/deno/tests/config_test.ts`: 156 passed, 0 failed. `deno fmt --check` and `deno lint` clean on `worker/deno/lib/egress_allowlist.ts` and `worker/deno/lib/config.ts`. `docs/CONTAINMENT.md` has a pre-existing `deno fmt --check` failure at the base, left alone.
- Named tests (repo-root paths):
  - `worker/deno/tests/egress_allowlist_test.ts`: 18 tests, all "(Issue #4045)".
  - `worker/deno/tests/config_test.ts`: "config - egress_allow_hosts rejects an IP literal (Issue #4045)".
  - `worker/deno/tests/containment_docs_test.ts`: "CONTAINMENT.md's egress allowlist lists exactly the module's hosts" and "CONTAINMENT.md says the egress allowlist is not enforced until #4046".
- Drift pins verified ABSENT on base: "nothing enforces it yet" and "#4046" in the CONTAINMENT.md egress section (checked with `git show milestone/agent-containment-egress-and-credential-isolation:docs/CONTAINMENT.md`, not present).
- Red-check: non-443 port message. Recorded result: 3 tests went red when the port message was broken. Flips for the other refusal branches were not run individually.
- Hostile regex tests use `assertLinearGrowth` (LABEL_PATTERN, DIGITS_ONLY, WHITESPACE_OR_CONTROL).
- Evidence test red on base, green at head: recorded result.

## Skipped / not checked / remaining risk

- Enforcement is not done; it is deferred to #4046.
- Provider and OAuth hostnames are unverified against the provider modules.
- The two imgbb operands in `loadConfig` are recorded as exempt (untestable) in the facts file.
- `loadConfig` discards the resolved list until #4046.
- Local-host skip for `ANTHROPIC_BASE_URL` is a minor deviation from the issue text.
- The quality gate's config integration check was skipped: no `.config.json` in this checkout.
- Most refusal-branch flips were not run individually; only the non-443 port flip is recorded.
