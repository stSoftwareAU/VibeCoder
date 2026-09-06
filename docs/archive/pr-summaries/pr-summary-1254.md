# Scan file and stdin `gh` bodies at the worker chokepoint

## Summary

`spawnGh` called `redactGhBodyArgs(args)` with **no file reader**, so the whole
`--body-file` / `-F <path>` / `-F key=@path` / `--input <file>` branch of the
redactor was dead code for every worker `gh` call: a file body was neither
scanned **nor** refused, and `UnredactableBodyError` — the control that exists so
"unparseable never means unscanned" — could not fire. A body piped on **stdin**
(`gh api … --input -`, used by the SARIF upload and the ruleset writes) was seen
by no redactor at all, because `redactGhBodyArgs` only ever sees argv.

This change gives the worker chokepoint the same coverage the agent's guard
child already had:

- `spawnGh` now supplies the production reader and writer — extracted to
  `worker/deno/lib/gh_body_file_io.ts` so `gh_guard_cli.ts` and `gh_spawn.ts`
  share one implementation and cannot drift apart again.
- The stdin body goes through `redactSecrets()` before it is written to the
  child, at the chokepoint (not inside the production runner), so the retry path
  and every injected runner see the masked bytes.
- `redactGhBodyArgs` takes a `stdinScanned` flag. A `-` body source still fails
  closed for every caller that does **not** own stdin; only a caller that
  genuinely scans those bytes itself (`spawnGh`) is allowed past it, so
  `gh api --input -` is scanned rather than refused.
- `UnredactableBodyError` propagates out of `spawnGh` — the call fails, the body
  is not published.

One enabling fix rides along, without which the change breaks repo hardening:
the `secret-assignment` rule in `worker/deno/lib/secret_redaction.ts` now ignores
a value that opens `{` or `[`. The body `repo_settings_harden.ts` PATCHes to
enable secret scanning is `{"security_and_analysis":{"secret_scanning":{…}}}` —
the rule's `\S+` branch swallowed the brace and left truncated, invalid JSON, so
the new fail-closed scan refused a body that contains no secret at all. A
credential never opens with `{` or `[`, and a secret nested inside the object is
still masked by the rule's own pass over the inner `"key": "value"`.

Closes #1254.

```mermaid
flowchart LR
    C["worker call sites"] --> S["spawnGh()"]
    S --> A["enforceGhWriteAllowlist"]
    A -->|allowed| R["redactGhBodyArgs + reader/writer<br/>argv, --body-file, --input file"]
    S --> ST["redactSecrets(stdin)<br/>--input - bodies"]
    R -->|unscannable| X["UnredactableBodyError<br/>call fails, nothing published"]
    R --> P["gh subprocess → GitHub"]
    ST --> P
```

## Evidence

Backend/CLI change with no web interface, so there is nothing to screenshot. The
evidence is the test suite: each regression test below was run against the
unfixed code and observed failing, then run again after the fix and observed
passing.

Against the **unfixed** code (`deno test --filter "1254" tests/gh_spawn_test.ts`):

```text
spawnGh - masks a secret read from a --body-file body (Issue #1254) => FAILED
spawnGh - refuses a body file it cannot read rather than publishing it unscanned (Issue #1254) => FAILED
spawnGh - masks an --input file body into a fresh file (Issue #1254) => FAILED
spawnGh - redacts the stdin body of an --input - call (Issue #1254) => FAILED
  [Diff] Actual / Expected
  -   {"body":"token ghp_a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5a1B2c3D4e5"}
  +   {"body":"token ***REDACTED***"}
FAILED | 0 passed | 4 failed
```

After the fix:

```text
ok | 5 passed | 0 failed | 14 filtered out
```

Full gate: `./quality.sh` — **PASSED** (semgrep, markdownlint, mermaid, deno
tests/lint/type check/fmt; `config integration`, `pages-liquid` and
`mermaid built output` skipped as usual on this host).

**The original trigger is closed, with no trivial bypass.** Every body class that
reaches GitHub through `spawnGh` is now either scanned or refused before the
subprocess starts: argv bodies (`--body`, `-b`, `--body=`, `-f/-F body=`) as
before; file bodies (`--body-file`, `--body-file=`, `-F <path>`, `-F body=@path`,
`--input <file>`, `--input=<file>`) through the injected reader, with a masked
`--input` body materialised into a fresh file rather than the caller's; and the
stdin body through `redactSecrets()` at the same chokepoint. The remaining
`-` fail-closed path is not a bypass: it is skipped only when `options.stdin` is
set, which is precisely the case where `spawnGh` holds and redacts those bytes.
A caller cannot reach `gh` without passing through `spawnGh` — the
`gh spawn chokepoint` quality check (PASSED above) fails the build on any direct
`new Deno.Command("gh", …)` elsewhere in `worker/deno/` — and an unscannable body
raises `UnredactableBodyError`, which is not caught anywhere on the `spawnGh`
path, so a failed control fails the call rather than publishing.

## Test Plan

Added (all fail against the unfixed code, pass after the fix):

- `worker/deno/tests/gh_spawn_test.ts::spawnGh - masks a secret read from a --body-file body (Issue #1254)`
  — the file body is scanned and published as a masked inline `--body`; the
  caller's own file is left byte-for-byte alone.
- `worker/deno/tests/gh_spawn_test.ts::spawnGh - refuses a body file it cannot read rather than publishing it unscanned (Issue #1254)`
  — `UnredactableBodyError` propagates and no subprocess starts.
- `worker/deno/tests/gh_spawn_test.ts::spawnGh - masks an --input file body into a fresh file (Issue #1254)`
  — the masked JSON lands in a new file and `--input` is repointed at it.
- `worker/deno/tests/gh_spawn_test.ts::spawnGh - redacts the stdin body of an --input - call (Issue #1254)`
  — the reproduction of the second half of the finding: the stdin body reaches
  the child masked, and the call is not refused.
- `worker/deno/tests/gh_spawn_test.ts::spawnGh - leaves the secret-scanning hardening body untouched (Issue #1254)`
  — the real `repo_settings_harden` body passes the new scan unchanged, so
  hardening is not broken by a false positive.
- `worker/deno/tests/gh_body_redaction_test.ts::redactGhBodyArgs #1254 - --input - passes through when the caller scans stdin`
- `worker/deno/tests/gh_body_redaction_test.ts::redactGhBodyArgs #1254 - --body-file - passes through when the caller scans stdin`
- `worker/deno/tests/gh_body_redaction_test.ts::redactGhBodyArgs #1254 - an unreadable path still refuses when the caller scans stdin`
  — scanning stdin does not soften any other fail-closed path.
- `worker/deno/tests/secret_redaction_test.ts::redactSecrets - leaves a JSON object value under a secret-ish key alone (Issue #1254)`
- `worker/deno/tests/secret_redaction_test.ts::redactSecrets - leaves a JSON array value under a secret-ish key alone (Issue #1254)`
- `worker/deno/tests/secret_redaction_test.ts::redactSecrets - still masks a scalar value under a secret-ish key (Issue #1254)`
- `worker/deno/tests/secret_redaction_test.ts::redactSecrets - still masks a secret nested inside a JSON object value (Issue #1254)`

No existing test was removed or weakened. One comment in
`gh_body_redaction_test.ts` was corrected: it claimed `spawnGh` supplies no
reader, which is exactly what this change fixes. Two pre-existing synthetic AWS
fixtures in `secret_redaction_test.ts` gained `// nosemgrep` markers — semgrep
only scans changed files, so they surfaced once this branch touched that file.

## Documentation

- `SECURITY.md` — §6 now records that both `gh` chokepoints scan the same body
  classes, and the redaction table gains a row for the worker's file/stdin
  bodies.
- `docs/THREAT-MODEL.md` — control **C24** now names `gh_spawn.ts` and covers
  file and stdin bodies.

## Security Self-Check

- **Input validation** — unchanged; the redactor's inputs are validated by shape
  (`-` versus a path) as before, and the new flag narrows nothing.
- **Secrets** — no credentials staged; the token-shaped test fixtures are
  synthetic and constructed in code.
- **Injection surface** — no new shell, SQL or HTTP construction; argv is still
  passed as an array and routing arguments are left byte-for-byte alone.
- **Fail loud** — `UnredactableBodyError` is caught nowhere on the `spawnGh`
  path; an unscannable body fails the call.
