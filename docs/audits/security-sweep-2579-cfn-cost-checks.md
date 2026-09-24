# 🔎 Security sweep — CloudFormation cost pre-scan (`cfn_cost_checks.ts`)

**Issue:** [#2579](https://github.com/stSoftwareAU/VibeCoder/issues/2579)
(chunk top-up-2579) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2579:

- `worker/deno/lib/cfn_cost_checks.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2579**, and this file is the reading of it.

## `worker/deno/lib/cfn_cost_checks.ts`

Two pure exports and one with read-only I/O. `findCfnCostCandidates` parses one
template's text and reports Lambda functions without `Architectures: [arm64]`
or without a retained log group; `renderCfnCostCandidates` formats them as
evidence lines. `scanCfnCostCandidates` walks the scanned checkout and reads
candidate template files. Nothing is written, spawned or sent over the network.

| Input | Source | Handling |
| ----- | ------ | -------- |
| template text | untrusted — the scanned repository | parsed with `JSON.parse` or `@std/yaml` (data only, no custom types, so no code runs); short-form tags are stripped by a fixed regex first; a parse failure yields no candidates |
| logical ids | untrusted — template keys | regex-escaped before they are used in a pattern, so a crafted id cannot inject a regex; rendered into the scan prompt as backticked text |
| file paths | untrusted — checkout layout | built from `Deno.readDir` entry names under the checkout root; dot-directories (so `.git`), `node_modules`, `cdk.out`, `target` and `vendor` are skipped, and symbolic links are neither followed as directories nor read as files (`isFile`/`isDirectory` are false for a link) |
| file count and size | untrusted | bounded at 500 candidate files and 1 MB per file, so a hostile checkout cannot stall or exhaust the run |

The rendered lines reach the best-practices prompt under
`## Deterministic pre-scan candidates` as evidence for Claude to confirm, the
same trust the scan already extends to every file it reads in that checkout;
they do not file issues or change labels themselves. An unreadable directory or
file is skipped, so a failure degrades to "no candidates" and the scan runs as
it did before.
