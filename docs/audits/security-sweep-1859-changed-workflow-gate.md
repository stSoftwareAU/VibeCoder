# Security sweep — pre-PR changed-workflow gate (`changed_workflow_gate.ts`)

**Issue:** [#1859](https://github.com/stSoftwareAU/VibeCoder/issues/1859)
(chunk 12p) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after chunk 12o:

- `worker/deno/lib/changed_workflow_gate.ts` — added by #1859.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12p**, and this file is the reading of it.

## `worker/deno/lib/changed_workflow_gate.ts`

The module runs `WORKFLOW_FILE_CHECKS` (swept as 12n) over the workflow files a
branch added or changed, before `gh pr create`. It holds no scanner logic: it
selects paths, reads them through an injected reader, parses the YAML, iterates
the check table and renders the verdict.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | no `Deno.Command`; the diff is collected by the caller's `runGitOrThrow` and handed in as a dep |
| no filesystem of its own | the module never touches `Deno.readTextFile`; `readFile` is injected, so the whole path is unit-tested without a clone |
| path handling | only `*.yml`/`*.yaml` **directly** under `.github/workflows/` are accepted; a `..` segment is refused before the path can reach the caller's filesystem read, and a nested path is out of scope because GitHub runs nothing there |
| no network, no `gh` | the five audit scans that read run logs, pull requests, the GHSA database or repository settings are excluded from the check table by construction |
| no environment or secret sinks | no `Deno.env`; the rendered message is passed through `redactSecrets()` before it leaves, because an error line can carry a tail of `git` stderr |
| no clock, no randomness | the verdict is a pure function of the injected reads |
| untrusted input is data, never a sink | workflow text is read and passed to the scanners unchanged; findings are copied field-by-field into a fixed shape and only ever rendered into Markdown |
| bounded output | the message names at most 20 findings and then states how many more there are, so a pathological file cannot render an unbounded comment |
| no silent failure | a failed diff, an unreadable file, an unparseable file and a check that throws each produce `ok: false` with a named error — never "no findings" |

No findings. Two accepted residuals, both documented in the module header:

1. A check that reasons across the whole workflow set (`scanGitleaksDrift`'s
   "no gitleaks workflow has a `pull_request` trigger", `findVersionCommentDrift`'s
   repo-wide pin comparison) sees only the changed subset here, so it can
   over- or under-report against the idle-task audit, which reads every file.
   Reading the whole tree would put untouched files back in scope, which the
   gate's own rule forbids; the audit remains the authority on repository-wide
   questions.
2. When the base ref is unresolvable in the clone the gate stands down at ERROR
   rather than blocking, matching the ahead-of-base guard beside it — blocking
   would fail every run on such a clone, including ones that touch no workflow.
