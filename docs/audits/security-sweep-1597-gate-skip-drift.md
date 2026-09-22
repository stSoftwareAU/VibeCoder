# 🔎 Security sweep — gate-skip drift audit (`gate_skip_drift_*`)

**Issue:** [#1597](https://github.com/stSoftwareAU/VibeCoder/issues/1597)
(chunk 12i) · **Parent:** #1209

This is the written record for the two modules that entered
`worker/deno/lib/` with #1597, after the chunk-12 slices (12a–12h) recorded
their coverage:

- `worker/deno/lib/gate_skip_drift_scanner.ts` — added by #1597.
- `worker/deno/lib/idle_task_templates/gate_skip_drift_template.ts` — added by
  #1597.

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
(12g) and
[`security-sweep-1631-worker-record-block.md`](security-sweep-1631-worker-record-block.md)
(12h).

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before that module existed makes
`diffCoverage` green on a record that never read it — the false-record failure
12f documents. Both modules are claimed by **12i**, and this file is the
reading of them.

## `worker/deno/lib/gate_skip_drift_scanner.ts`

Pure static inspection of a checkout: it reads the repository's `quality.sh`
and the workflow files, and correlates the tools the gate skips with the tools
CI runs. Nothing is executed, nothing is fetched, and no credential or
configuration value is read.

Shapes checked (12a subprocess/argv, 12b filesystem paths, 12c untrusted
GitHub data):

| Property | Result |
| -------- | ------- |
| no subprocess (12a) | ✅ no `Deno.Command`, no `gh`, no shell — the gate script is read as text, never sourced or run |
| filesystem reach is bounded (12b) | ✅ two reads only: `${repoPath}/${name}` for the caller-supplied gate names (default `quality.sh`) and the workflow files `readWorkflowFiles` collects; no path is taken from the scanned content |
| untrusted input is data (12c) | ✅ the gate script and workflow YAML come from a monitored repository, so both are treated as data: the script is matched against fixed patterns, the YAML is parsed by the shared reader and read only through `isRecord`/`typeof` guards, and no value is interpolated into a command |
| no catastrophic backtracking | ✅ every pattern (`GUARD`, `SKIP_ECHO`, `HARD_FAIL`, `INSTALL_COMMAND`) is a flat alternation with no nested quantifier, applied per line, and the guard walk is capped at `MAX_GUARD_BLOCK_LINES` |
| fail-loud on a read/parse failure | ✅ an unreadable-but-present gate script and an unparseable `container/tools.json` both return `ok: false`; a `NotFound` gate is the one benign case and yields no finding rather than a false one. An unreadable workflow file is now a loud `read` error too (this issue) |
| no secret reaches a sink | ✅ the module logs nothing and returns only line numbers and the trimmed lines it cited |

## `worker/deno/lib/idle_task_templates/gate_skip_drift_template.ts`

The idle-task wrapper around that scanner: it ensures the label, snapshots open
findings, runs the scanner, files at most one issue, and snapshots again.

Shapes checked (12a subprocess/argv, 12c untrusted GitHub data, 12d
environment/config):

| Property | Result |
| -------- | ------- |
| argv, not a shell string (12a) | ✅ every `gh` call is an argument array through the injected `ghCommandFn`; labels go through `guardedLabelArgs`, so a reserved workflow label cannot be self-applied |
| scanner output is inert in the body (12c) | ✅ scanned lines are rendered inside backticks in a Markdown body passed as an argv element — never as a command, a path, or a `--jq` expression |
| wrapper dedup is author-verified (12c) | ✅ `shouldFile` gates on `hasFleetAuthoredOpenIssueTitled`, so a planted title from outside the fleet cannot silence the scan; pinned by `wrapper dedup - every registered template is covered` |
| environment reach (12d) | ✅ one variable, `VIBE_RUN_ID`, read for the attribution footer and defaulted to `"unknown"`; no credential, token or config file is read here |
| repo isolation | ✅ issue-only — the template opens no pull request and touches no other repository; the fix rides the normal `work-on` pipeline |
| fail-loud | ✅ a scanner failure returns `ok: false` with the error in the summary, and a throw is caught into `ok: false` rather than a green no-op |

No findings. The residual is the scanner's own precision: a skip whose tool CI
never runs is deliberately not reported, and a repository can waive a tool with
an attributed `best-practice-ignore: BP-GATE-SKIP-<TOOL>` comment, which is the
governed waiver grammar the rest of the fleet's scans already use.
