# 🔎 Security sweep — environment, configuration and secret-sink coverage in `worker/deno/lib/`

**Issue:** [#1217](https://github.com/stSoftwareAU/VibeCoder/issues/1217) (chunk
12d) · **Parent:** #1209 `security-scan-overflow: 4 chunks not reached` ·
**Siblings:** [chunk 12a](security-sweep-1214-subprocess-argv.md) (subprocess and
argv), [chunk 12b](filesystem-path-temp-sweep-1215.md) (filesystem and paths),
[chunk 12c](security-sweep-1216-untrusted-github-ingestion.md) (untrusted GitHub
ingestion) — disjoint by construction

This record exists so a later run can tell a **swept** path from an unswept one.
The parent scan swept `lib/secret_redaction.ts` itself (chunk 5) and found the
redactor sound. A redactor is only as good as the set of paths that route
through it, and **that set had never been enumerated**. This slice enumerates it,
and reviews every remaining `Deno.env` reader in `lib/` at its environment and
config-load sites.

## Scope and method

The slice is the env-reading `lib/` modules **minus** the three sibling slices,
regenerated with the commands each sibling issue specifies:

```bash
cd worker/deno
grep -rl "Deno.env" lib/ --include='*.ts' | grep -v '_test\.ts$' | sort > env.txt
grep -rl "Deno.Command" lib/ --include='*.ts' | grep -v '_test\.ts$' | sort > subproc.txt
comm -23 <(grep -rl "Deno.writeTextFile\|Deno.writeFile\|Deno.remove\|Deno.mkdir\|Deno.makeTempDir\|Deno.symlink\|Deno.open" lib/ --include='*.ts' | grep -v '_test\.ts$' | sort) subproc.txt > fs.txt
comm -23 <(grep -rl "gh_spawn\|runGhOrThrow\|spawnGh\|JSON.parse" lib/ --include='*.ts' | grep -v '_test\.ts$' | sort) <(cat subproc.txt fs.txt | sort) > ingest.txt
comm -23 env.txt <(cat subproc.txt fs.txt ingest.txt | sort -u)
```

`env.txt` holds **95** modules; subtracting the 304 files already covered by
chunks 12a/12b/12c leaves **45** for this slice. All 45 were read at their
`Deno.env` reads and config-load sites against four questions: fail-open config
parsing, env-var trust for security decisions, secret material reaching a sink,
and a token written to disk or placed on a command line.

The **sink enumeration** is repo-wide by necessity — a sink that bypasses the
redactor is the finding whether or not its module reads the environment — and
covers `lib/`, `commands/`, `mod.ts` and `quality.ts`.

Triage followed the Phase 3 discipline of [`SECURITY-SCAN.md`](../SECURITY-SCAN.md):
refute-unless-proven. A candidate that could not be traced from a named
attacker- or non-operator-controlled input to a concrete bad outcome was dropped
rather than filed.

> **This is not an empty result.** The issue asks that an empty result be stated
> explicitly; it was not empty.

## The class fixed in this sweep

### SEC-1217-01 — the published failure comment truncates before it redacts

`severity:high` · `confidence:high` · **fixed in this PR**

`SECURITY.md` has required redact-before-truncate since Issue #207, and Issue
#3636 applied it to the no-changes comment in `handle_no_changes_phase.ts`:

```ts
// worker/deno/lib/phases/handle_no_changes_phase.ts — the correct ordering
function publishableSnippet(claudeOutput: string): string {
  return redactSecrets(claudeOutput).slice(-3000);
}
```

Ten sibling call sites in the same phase modules used the **inverted** ordering.
They cut the agent's stdout to a 500-character tail and relied on the redaction
that runs later, in `label_failure.ts`, when the failure comment is built:

```ts
lastOutputSnippet: state.claudeOutput.slice(-500) || undefined,
```

The traced path, end to end:

```mermaid
flowchart LR
    A["agent stdout<br/>(inherits GH_TOKEN, sk-ant-…)"] --> B["slice(-500)<br/>execute_phase / handle_no_changes"]
    B --> C["formatDetailedFailureMessage"]
    C --> D["result.reason"]
    D --> E["label_failure.buildErrorSection<br/>redactSecrets()"]
    E --> F["public issue comment"]
    style B fill:#b23a48,stroke:#7d1128,color:#fff
```

Every signature rule in `secret_redaction.ts` is anchored on the credential's
**leading** bytes — `ghp_`, `github_pat_`, `sk-ant-`, `AIzaSy`, the `AKIA…` id
that precedes an AWS secret access key, the `Bearer` scheme, the `TOKEN=` key of
an assignment. A tail cut lands wherever it lands, so a credential straddling the
boundary arrives at `buildErrorSection` with its anchor gone. `redactSecrets`
matches nothing and the fragment is published to a world-readable comment. The
AWS pair is the total case: the secret access key is 40 characters of base64
alphabet with no shape of its own, matched only via the access-key id that
precedes it, so a cut between the two publishes the whole secret verbatim.

The same inversion capped the kill-time diagnostics
(`failure_message.ts`, `killDiagnostics.slice(0, 2000)`). That text is the
`ps -eo pid,ppid,rss,etime,args` table from `kill_diagnostics.ts` — **every**
process's argv, so a token any process on the host was handed on its command
line lands in it.

**Fixed at the type level, not per call site.** Per-call-site redaction is
exactly what drifted here: ten sites forgot the rule while their neighbour in the
same file applied it. `worker/deno/lib/redacted_text.ts` introduces
`RedactedText`, a branded string only `redactedTail()`, `redactedHead()` and
`joinRedacted()` can mint — and each redacts the whole input **before** it trims.
`FailureDiagnosticContext.lastOutputSnippet` now carries that brand, so
`claudeOutput.slice(-500)` no longer compiles. The build fails at `deno check`,
which is a stage of `./quality.sh`.

This is the durable form the issue's **Failure Detection** section asks for. It
is the same intent as `gh_spawn_chokepoint_check.ts` (Issue #3703) — a
whole-codebase invariant enforced by the quality gate — realised as a type rather
than a regex scan, so it has no false positives and cannot be defeated by a
spelling the pattern did not anticipate.

**Fail direction stated:** the regression tests assert the fake token is
**absent** from the emitted output, so a broken ordering fails them rather than
passing quietly. `tests/redacted_text_test.ts::failure message - kill
diagnostics are redacted before the 2000-character cap` was observed failing
against the unfixed `formatDetailedFailureMessage` and passing after the fix.

## Sink enumeration — every path that can emit secret material

_(populated below)_

## Coverage — the 45 modules in this slice

_(populated below)_
