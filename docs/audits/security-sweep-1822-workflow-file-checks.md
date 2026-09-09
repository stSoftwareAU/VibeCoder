# Security sweep — file-scoped audit check table (`workflow_file_checks.ts`)

**Issue:** [#1822](https://github.com/stSoftwareAU/VibeCoder/issues/1822)
(chunk 12n) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12m) recorded their coverage:

- `worker/deno/lib/workflow_file_checks.ts` — added by #1822.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12n**, and this file is
the reading of it.

## `worker/deno/lib/workflow_file_checks.ts`

The module is a data table: eleven `{ id, label, run }` entries, each a thin
adapter over a pure scanner that already lives in `worker/deno/lib/` and is
already swept (nine native pre-filers under 12e, the two hygiene rules in
`workflow_hygiene_check.ts` under 12b). It adds two private normalising
functions — `fromScanner` and `fromHygiene` — that copy four fields off a
finding and return a new object. No scanner logic is reimplemented here.

Shapes checked (12e's remainder slice, because the module neither spawns nor
touches the filesystem):

| Property | Result |
| -------- | ------ |
| no spawn, no argv | no `Deno.Command`; the module imports no spawn helper |
| no filesystem, no temp files | no `Deno.readTextFile`/`writeTextFile`/`makeTempDir`; callers supply the already-read `WorkflowFile[]` |
| no network, no `gh` | the five audit scans that read run logs, pull requests, the GHSA database or repository settings are deliberately **excluded** from the table and documented as such |
| no environment or secret sinks | no `Deno.env`; the only context field is `defaultBranch`, a plain string |
| no clock, no randomness | `run()` is a pure function of `(files, ctx)`; the table order is a literal |
| untrusted input is data, never a sink | `rawText`/`path` are passed to the scanners unchanged and only ever read; findings are copied field-by-field into a fixed shape, so a crafted workflow file cannot widen the result |
| no silent failure | an adapter neither catches nor swallows: a scanner that throws propagates to the caller |

No findings. The accepted residual: the table is a list, so a check omitted
from it is a check the conformance test stops running. That is why
`worker/deno/tests/workflow_template_audit_conformance_test.ts` asserts the
exact eleven ids — a dropped check fails the gate rather than passing quietly.
