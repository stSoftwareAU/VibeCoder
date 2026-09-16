# Security sweep — the milestone-groups gate (`plan_milestone_groups.ts`, `markdown_table.ts`)

**Issue:** [#2172](https://github.com/stSoftwareAU/VibeCoder/issues/2172)
(chunk top-up-2172) · **Parent:** #1209

This is the written record for the two modules that entered
`worker/deno/lib/` under #2172:

- `worker/deno/lib/plan_milestone_groups.ts` — added by #2172.
- `worker/deno/lib/markdown_table.ts` — added by #2172.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. Both modules are claimed
by **top-up-2172**, and this file is the reading of them. They are swept
together because one is the other's only reason to exist: `markdown_table.ts`
holds the table primitives `plan_milestone_groups.ts` and the pre-existing
`plan_coverage_gate.ts` now share.

## `worker/deno/lib/markdown_table.ts`

A pure parser: a scan cap, a row splitter, and a locator that returns the first
table in a markdown blob whose headers satisfy a caller-supplied predicate. No
subprocess, no filesystem, no network, no environment read, no credential.

Untrusted inputs, and how each reaches the output:

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `markdown` | an issue body or a comment body on a public repository — writable by **any** account | rejected outright past `MAX_TABLE_SCAN_CHARS` (64 KiB), then split on newlines and matched line by line. Nothing in it is interpolated into an argv, a shell string, a URL or a query |
| `matches` | the calling gate's own header predicate, worker-controlled | invoked with the trimmed header cells only |

| Property | Result |
| -------- | ------ |
| no shell, no argv construction | the module spawns nothing |
| environment | reads none |
| filesystem | touches none |
| network | none |
| regex safety | the reason the module exists. `SEPARATOR_RE` is the hardened linear form carried across verbatim from `plan_coverage_gate.ts` with its full Issue #1245 rationale: no two quantifiers can consume the same character, so a failing match backtracks linearly. Two earlier shapes were quadratic on attacker-writable bodies (5.4 s on 40 000 dashes; 4.2 s on 64 000 spaces). `ROW_RE` is anchored with a bounded `\s{0,3}`; the split uses a fixed-width lookbehind. `plan_coverage_gate_bounds_1245_test.ts` times the same payloads through its caller and `markdown_table_test.ts` pins the cap behaviourally |
| secret surface | none read or emitted |
| resource bounds | `MAX_TABLE_SCAN_CHARS` rejects rather than truncates — half a table is not a table — and the row loop stops at the first non-row line, so a hostile blob costs one length check |
| fail direction | a blob that cannot be scanned yields `null`, which every caller treats as "no table of mine". Callers report the skip themselves, so an unscanned candidate is never silently equivalent to one that carried no table |

No finding. The single trust decision is that the cap **rejects**: a truncated
scan could parse the first half of a table and pass a gate on rows the author
never finished writing.

## `worker/deno/lib/plan_milestone_groups.ts`

The parser, validator, gate and escalation for the `## Milestones` table a
planning run publishes on its parent issue. Modelled on
`plan_coverage_gate.ts` (swept under chunk 12c) and sharing its two security
boundaries: the bounded scan above, and the fleet-author check on every
candidate comment.

Untrusted inputs, and how each reaches the output:

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| the parent's comment bodies | any GitHub account may post one | only comments that both carry a table **and** pass `selectFleetAuthoredComments` (Issue #1244) are candidates. An unresolved fleet identity discards every comment, and each discard is logged |
| the parent's issue body | the issue whose work is being planned | used as the final fallback candidate, exactly as the coverage gate does: it belongs to the planned issue, not to a third party commenting on it |
| the table cells | model output inside those bodies | parsed into `{ title, area, subIssueNumbers }`. Sub-issue numbers are extracted by regex and range-checked (`Number.isSafeInteger`, positive); the title and area are kept as text and only ever placed in a log field or an issue comment |
| `repo` / `parentIssueNumber` | the worker's own claim | passed to the injected `ghCommandFn` as **separate argv elements** (`["issue", "view", String(n), "--repo", repo, "--json", "body,comments"]`) — never concatenated into a command string |

| Property | Result |
| -------- | ------ |
| no shell, no argv construction | the module spawns nothing itself; the single `gh` read is an injected function called with a fixed argv shape, and no parsed cell reaches it |
| environment | reads none directly; `AlertDedupAuthorOptions` may resolve the fleet identity through the shared `alert_dedup_authors.ts` path (swept under 12d) |
| filesystem | touches none |
| network | only the injected `gh` read, whose failure is caught and reported as `readFailed` |
| regex safety | `ISSUE_REF_RE`, `NO_MILESTONE_RE` and the header patterns are all single bounded quantifiers with no adjacent overlapping classes; every one runs on a cell from an already length-capped blob. The line-level scanning belongs to `markdown_table.ts` above |
| secret surface | no credential is read. The escalation comment echoes offending cells — model-authored plan text, not process output — through the shared `escalateToHuman()` sink, which is the same surface the coverage gate's offending asks take |
| resource bounds | the shared 64 KiB scan cap per candidate; validation is O(groups × published sub-issues) over sets a plan-sized table bounds |
| fail direction | towards a human, never towards a silent pass: a `gh` read failure is logged and returned as `readFailed: true` rather than collapsed into "no table"; an oversized candidate is logged and skipped; a structurally broken table escalates through the single `escalateToHuman()` chokepoint, and a failed escalation logs `error` and returns `false` instead of reporting success |

No finding. Two deliberate trust decisions are recorded here so they are not
read later as oversights:

1. **A missing table is not a failure.** The gate landed before the prompts
   that teach the table (#2174), so a parent with no `## Milestones` table
   takes the legacy single-milestone path. The absence is logged at info; it is
   a documented transitional decision, not a swallowed fault.
2. **A structurally broken table escalates *and* falls back.** The plan is
   already published when the gate runs, so refusing the legacy milestone would
   strand real work. The `needs-human` label plus its paired comment is the
   record, and the single milestone keeps delivery moving until a human
   regroups.
