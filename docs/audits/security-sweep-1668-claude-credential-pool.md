# 🔎 Security sweep — the Claude credential pool (`claude_credential_pool.ts`)

**Issue:** [#1668](https://github.com/stSoftwareAU/VibeCoder/issues/1668)
(chunk 12k) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12j) recorded their coverage:

- `worker/deno/lib/claude_credential_pool.ts` — added by #1668.

Siblings:
[`security-sweep-1214-subprocess-argv.md`](security-sweep-1214-subprocess-argv.md)
(12a),
[`filesystem-path-temp-sweep-1215.md`](filesystem-path-temp-sweep-1215.md)
(12b),
[`security-sweep-1216-untrusted-github-ingestion.md`](security-sweep-1216-untrusted-github-ingestion.md)
(12c),
[`security-sweep-1217-env-config-secrets.md`](security-sweep-1217-env-config-secrets.md)
(12d),
[`security-sweep-1219-lib-closing-pass.md`](security-sweep-1219-lib-closing-pass.md)
(12e),
[`security-sweep-1325-gh-body-file-io-and-timeout.md`](security-sweep-1325-gh-body-file-io-and-timeout.md)
(12f),
[`security-sweep-1443-ignored-path-clean.md`](security-sweep-1443-ignored-path-clean.md)
(12g),
[`security-sweep-1631-worker-record-block.md`](security-sweep-1631-worker-record-block.md)
(12h),
[`security-sweep-1597-gate-skip-drift.md`](security-sweep-1597-gate-skip-drift.md)
(12i) and
[`security-sweep-1661-worker-state-paths.md`](security-sweep-1661-worker-state-paths.md)
(12j).

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12k**, and this file is
the reading of it.

## `worker/deno/lib/claude_credential_pool.ts`

The module holds one budget snapshot per Claude subscription token, refreshes
a stale one through `probeClaudeTokenBudget` (12e), ranks the pool with
`rankClaudeTokenBudgets` (12e), and replaces the run's single exported token
variable. It therefore *handles* token values, which is what this reading is
about. It spawns nothing and writes no file; its only I/O is the probe's
single bounded request, and the credential directory read it delegates to
`discoverProviderTokenFiles` (12d).

Shapes checked (12d's — a module holding secret material — and 12e's):

| Property | Result |
| -------- | ------ |
| no token value reaches a log line | ✅ every line is built from labels and ranked figures: `formatClaudeTokenSelectionLog` takes the ranking, whose `label` comes from the file stem, and the two lines this module composes itself interpolate `token.label` and the variable *name* only. The token value is not an input to any of them. Pinned by `claude credential pool - 0% and 60% five-hour: the 60% token wins and both shares are logged`, which asserts the value's absence |
| no token value reaches an error message | ✅ both `throw` sites interpolate `label` alone; the probe's own failure detail is scrubbed by `claude_token_budget.ts` before it is stored, and this module stores it without re-formatting |
| the switch cannot set an arbitrary variable | ✅ `applySelection` writes `token.name`, which `parseProviderCredentialEntries` only ever sets to a name on the provider's `envVars` allowlist, narrowed again to the `tokenPool.envVars` by the `poolMember` guard. A hostile credential file cannot name `PATH` or `GH_TOKEN` and have it exported |
| exactly one token variable is exported | ✅ one `setEnv` call, replacing rather than adding, and nothing else is written — the Issue #919 guarantee. Pinned by `claude credential pool - applySelection leaves exactly one Claude token variable` |
| a hostile filename cannot join the pool | ✅ candidacy is `poolMember && value`, and `poolMember` is set only for a file discovery accepted: the primary `provider.env` or a name matching the anchored `^provider-(\d+)\.env$`. An arbitrary stem is never a candidate, so it never reaches a log line either |
| the request count is bounded | ✅ at most one probe per stale candidate per selection, each bounded by the probe's own timeout with no retry loop, and concurrent selections share one in-flight promise per token rather than issuing one each. Pinned by `claude credential pool - a stale snapshot costs one probe per candidate, even concurrently` |
| failure is loud, never assumed | ✅ a probe failure is stored as an explicit `{ known: false }` that ranks last; an exhaustion naming no window and a switch to a file carrying no subscription token both throw rather than quietly doing nothing |
| unbounded state | ✅ `snapshots` and `inFlight` are keyed by label and bounded by the number of credential files on the host; the in-flight entry is deleted in a `finally`, so a rejected probe cannot pin one |
| no untrusted input decides the switch | ✅ the figures come from Anthropic's own response headers, parsed and range-checked by `claude_token_budget.ts`; a value outside `[0, 1]` is an unknown budget, not a ranking input |

No findings. The accepted residual is the one Issue #1668 states in its own
assumption: the process environment is shared by every slot on the host, so a
switch affects spawns that start after it while an agent already running keeps
the environment it was given. That is the existing mount-versus-environment
boundary recorded as R9 in
[the threat model](../THREAT-MODEL.md#-residual-risks), not a new exposure —
the pool narrows what the environment carries, it never widens it.
