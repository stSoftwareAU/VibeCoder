# Codex billing probe reads only the CODEX_HOME the child is given

## Summary

The Codex billing probe in `worker/deno/lib/agent_provider.ts` read
`CODEX_HOME` from the worker's environment, falling back to the agent-state
home. The child process is never given that fallback. When `CODEX_HOME` is
unset, `buildIsolatedCodexChildEnv` forwards nothing, so the Codex CLI uses
`$HOME/.codex`. The probe and the child could therefore disagree on which
login they describe, and a persisted ChatGPT login was reported as
`unknown` or as the wrong billing mode.

The probe now reads only an explicit, non-blank `CODEX_HOME`. A blank or
unset value returns `undefined`, and the classifier falls through to the
metered-key check. With an explicit home, the probe and the child read the
same directory. The change is in `resolveStoredBilling`, with a regression
test and an explicit-home test in `worker/deno/tests/provider_billing_test.ts`.

Closes #3955.

## Spec

### Intent and Rationale

- The billing classifier must describe the same credential the child will
  spend. A probe that reads a different home from the one the child is given
  can report a subscription login the run never uses, or hide one it does.
- Fail toward the metered-key check when the home is not explicit, rather
  than guessing a home the worker does not hand to the child.

### Essential Design Decisions

- Option (b): the probe reads only an explicit trimmed `CODEX_HOME`. Blank
  or unset returns `undefined`
  (`worker/deno/lib/agent_provider.ts:804`).
- Option (a) was rejected. Giving the child the agent-state home would mean
  setting `CODEX_HOME` on the child. `buildChildEnv` has no `workDir`, and a
  selected `CODEX_HOME` withholds `OPENAI_API_KEY` and `CODEX_API_KEY`
  (#1924), which changes what the child can spend.
- An explicit home still resolves through `resolveCodexAuthMode` with the
  environment withheld, matching the child env. A `chatgpt` result is
  `fixed-subscription` (`worker/deno/lib/agent_provider.ts:813`).

### Undiscoverable Facts

- `buildIsolatedCodexChildEnv` (`worker/deno/lib/codex_env.ts`) forwards
  `CODEX_HOME` only when the parent environment sets it. The worker's
  agent-state home is never the child's home.
- The Codex CLI falls back to `$HOME/.codex` when `CODEX_HOME` is unset.
  The worker does not probe that path, so an unset home is `unknown` to the
  probe, not a subscription login.
- `resolveCodexHome` in `worker/deno/lib/codex_auth_mode.ts` is kept. Its
  remaining caller is `codexStatus` in
  `worker/deno/lib/provider_auto_runtime.ts` (imported as `codexHome` at
  line 31, called at line 261), which resolves the home with the agent-state
  fallback and passes it to `CodexBudgetAdapter`. Only the billing probe
  stopped using it.

## Evidence

**Docs sweep** — grep: `CODEX_HOME`, `resolveCodexHome`,
`resolveCodexAuthMode`, `resolveStoredBilling`, `buildIsolatedCodexChildEnv`;
section: the billing and auth sections of the docs listed below, and the
comments in the lib files that name the probe; siblings: the budget adapter
and the subscription-auth documents, which share the `CODEX_HOME` term but
not the probe's fallback.

In-scope hits, all left unchanged unless noted:

- `README.md:475`: still true. The "Codex subscription auth" row names
  `OPENAI_API_KEY` and `CODEX_API_KEY` as withheld for a subscription login.
  This fix does not change the child env.
- `docs/CODEX-SUBSCRIPTION-AUTH.md:10-24, 61-68`: still true. They describe
  an explicit, non-blank `CODEX_HOME` and the child receiving only that home.
  The probe now matches that rule.
- `docs/PROVIDER-PARITY.md:51-53, 70, 83, 184, 193`: still true. They describe
  the child env and the budget adapter's unknown state for a new home.
- `docs/CODEX-BUDGET-SOURCES.md:21, 29, 51, 98, 117, 149, 154, 174, 180`:
  still true. They describe the budget adapter's rollout and `auth.json`
  reads under `CODEX_HOME`, which the fix does not touch.
- `docs/audits/security-sweep-1697-codex-budget.md:44, 57, 71, 73, 75, 80`:
  still true. They are the budget adapter's audit, and `resolveCodexAuthMode`
  is unchanged.
- `docs/audits/security-sweep-1923-provider-billing.md:24-26, 35-36, 57-60`:
  changed by this PR to name the explicit-home rule (Issue #3955). The other
  lines in this file (43, 46, 50, 51) describe the same classifier order and
  remain true.
- `docs/audits/security-sweep-1926-auto-provider-routing.md:24, 67-68`,
  `docs/audits/security-sweep-1927-subscription-soak.md:30, 39, 42`,
  `docs/audits/security-sweep-2183-lib-delta-12d-12f.md:124, 281, 389-396`,
  `docs/audits/security-sweep-2184-commands-setup-delta.md:113`,
  `docs/audits/security-sweep-2757-lib-delta-12d-12f.md:124`: still true.
  They audit the child env, `codex_env.ts`, or the budget command, none of
  which changed.
- `docs/SUBSCRIPTION-SOAK.md`, `docs/CONTAINER.md`, `docs/CONTAINMENT.md`,
  `docs/DEPLOYMENT.md`, `docs/QUORUM.md`, `docs/SETUP.md` and
  `docs/workflows/resilience-and-concurrency.md` do not contain
  `CODEX_HOME`. They name only the Codex key variables or the
  `codex/provider.env` file (for example `docs/SETUP.md:936`,
  `docs/CONTAINER.md:2004`, `docs/QUORUM.md:231, 237`), so none describes
  the probe's fallback and none needed a change.
- Source comments, still true: `worker/deno/lib/agent_provider.ts:277`
  (interface doc on `resolveStoredBilling`, now names the explicit-home rule),
  `:794-796` (the probe reads only an explicit home, Issue #3955),
  `worker/deno/lib/codex_env.ts:102-114, 127-134` (child env rule),
  `worker/deno/lib/codex_auth_mode.ts:15, 71-78, 160-167` (resolver
  behaviour, unchanged; doc comment edited only),
  `worker/deno/lib/codex_budget.ts`, `codex_budget_source.ts`,
  `worker/deno/commands/codex_budget.ts` (budget adapter),
  `worker/deno/lib/provider_auto_runtime.ts:17-18, 311`,
  `provider_auto_selection.ts:11`, `provider_billing.ts:38, 135`,
  `container_launch.ts:19, 282, 479`, `agent_state_dir.ts:39, 51`,
  `claude_env.ts:165`, `codex_auth.ts:28, 83`, `root_filesystem_fault.ts:16`,
  `secret_redaction.ts:412`, `session_manager.ts:52`,
  `tabletop_container_runner.ts:265`. Each describes the child env, the budget
  adapter, or a container home, none of which changed.
- Test files: the `provider_billing_test.ts` names and comments are the
  regression and explicit-home tests in this PR, and the rest describe
  behaviour that is unchanged.

**Callers checked**: `resolveStoredBilling` is called from
`worker/deno/lib/provider_billing.ts` (`classifyProviderBilling`), with
`context.env` and `context.workDir`. `resolveCodexAuthMode` is also called by
the budget adapter (`worker/deno/lib/codex_budget.ts:461`), and its behaviour
is unchanged. `resolveCodexHome` is still used by `codexStatus` in
`worker/deno/lib/provider_auto_runtime.ts:31, 261`, which builds the
`CodexBudgetAdapter` from the resolved home.

## Reproduction

- symptom: with `CODEX_HOME` unset, the billing probe reported
  `fixed-subscription` from the agent-state home, while the child is given no
  home and reads `$HOME/.codex`, so the classifier described a login the run
  does not use.
- status: verified
- regression test: `worker/deno/tests/provider_billing_test.ts` —
  `classifyProviderBilling - with CODEX_HOME unset the billing evidence and the child env name the same home (Issue #3955)`

- Against the pre-fix `agent_provider.ts` (HEAD before this change), the
  regression test `classifyProviderBilling - with CODEX_HOME unset the billing
  evidence and the child env name the same home (Issue #3955)` failed at
  `worker/deno/tests/provider_billing_test.ts:219`, with the probe reporting
  `fixed-subscription` where the expected result was `unknown`.
- With the fix, the same test passes.
- The explicit-home test `classifyProviderBilling - an explicit CODEX_HOME is
  the home both the probe and the child use (Issue #3955)` is the flip check.
  Forcing the explicit branch to `undefined` made it fail at
  `worker/deno/tests/provider_billing_test.ts:247`.

## Test Plan

- `cd worker/deno && deno test --frozen --lock=deno.lock --allow-read
  --allow-env --allow-run --allow-write --allow-sys=hostname
  tests/provider_billing_test.ts < /dev/null` runs the two Issue #3955 tests
  above and the rest of the billing suite.
- The regression test is `classifyProviderBilling - with CODEX_HOME unset the
  billing evidence and the child env name the same home (Issue #3955)`.
- The explicit-home test is `classifyProviderBilling - an explicit CODEX_HOME
  is the home both the probe and the child use (Issue #3955)`.
- `deno test tests/codex_auth_mode_test.ts tests/docs_sweep_hits_test.ts
  tests/doc_prose_claims_test.ts tests/lib_sweep_coverage_test.ts
  tests/markdown_anchors_test.ts < /dev/null` covers the resolver and the
  docs validators touched by the sweep.
- `cd worker/deno && deno task pr-summary-check --base origin/main
  --issue-body-file /tmp/issue-3955-body.md --labels bug,top-priority
  ../../docs/archive/pr-summaries/pr-summary-3955.md < /dev/null`.

<!-- vibe-branch-outcomes -->
