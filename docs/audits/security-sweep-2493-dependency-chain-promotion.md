# 🔎 Security sweep — dependency-chain promotion (`dependency_chain_promotion.ts`)

**Issue:** [#2493](https://github.com/stSoftwareAU/VibeCoder/issues/2493)
(chunk top-up-2493) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2493:

- `worker/deno/lib/dependency_chain_promotion.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2493**, and this file is the reading of it.

## `worker/deno/lib/dependency_chain_promotion.ts`

One pure export with behaviour, `resolveChainPromotions`, plus `chainIssueKey`
(the map-key helper callers share) and the types they take. It reads a snapshot
the caller has already fetched — the dependency-blocked candidates, the issues
behind them, the monitored-repo set, the discovery labels, the needs-human
label name and the fleet-author allowlist — walks each chain breadth-first and
returns which chain members to promote, which roots the fleet already holds and
which roots are unworkable. No I/O, no subprocess, no environment read, no
permission beyond what the caller already holds; the only data it touches is
what the caller passes in. Its two imports are `DependencyBlocker`
(`import type`, erased at runtime) and `isFleetAuthor` from
`worker/deno/lib/fleet_authors.ts`, which itself imports nothing.

| Input | Decision | Handling |
| ----- | -------- | -------- |
| blocker already visited on this chain | skipped | the visited set is seeded with the blocked candidate, so a cycle terminates and promotes nothing on the cycle |
| blocker in a repo outside `monitoredRepos` | `cross-repo-unmonitored` | the fleet cannot label or claim there, so it is reported, never walked past |
| blocker absent from the snapshot map | skipped | absent data is silence, not a verdict — no report on a partial view |
| chain member still carrying blockers | walked through | never promoted and never classified; only its own blockers are enqueued |
| `needsHumanLabel` present on the root | `needs-human` | checked before assignment so a human hand-off outranks who happens to hold it |
| assignee matching `fleetAuthors` | `fleetWorking` | the fleet already has it: no promotion, no unworkable entry, nothing to report |
| any other assignee | `assigned` | the login is the detail, so the caller reports the person actually holding it |
| no `discoveryLabels` on the root | `no-discovery-label` | the fleet's own discovery would never pick it up, so promoting it would bypass the label contract |
| open, unassigned, discoverable root | promoted | inherits the blocked candidate's tier; `configured-label` outranks `work-on` when two chains share a root |

Promotion is the caller's side effect — discovery wiring, logging and the
chain-root comment land in Issues #2494–#2496, which own every write. The
resolver itself cannot label, comment, or claim, so a wrong verdict here can
only change which candidate the scan reports, never mutate GitHub state
directly. Label, login and repository comparisons are normalised with
`trim().toLowerCase()` so padded or differently-cased GitHub data cannot slip
past the needs-human, fleet-author or monitored-repo checks — a casing mismatch
must not report a monitored repo as unreachable and silently drop its subtree. Every `detail` string is a repo
name, a label name, or an assignee login taken from GitHub data the caller
already fenced as untrusted; it is reported, never interpolated into a command
or a path.
