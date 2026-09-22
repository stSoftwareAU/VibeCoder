# 🔎 Security sweep — chain-promotion wiring (`apply_chain_promotions.ts`)

**Issue:** [#2495](https://github.com/stSoftwareAU/VibeCoder/issues/2495)
(chunk top-up-2495) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2495:

- `worker/deno/lib/apply_chain_promotions.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2495**, and this file is the reading of it.

## `worker/deno/lib/apply_chain_promotions.ts`

One export with behaviour, `applyChainPromotions`, plus the types it takes. It
sits between the pure resolver swept under #2493 and `findOldestIssue`: it
builds the resolver's issue snapshot from the open-issue lists discovery has
already fetched, calls `resolveChainPromotions`, and moves each promoted
candidate out of its own tier list into the blocked issue's tier list. No I/O,
no subprocess, no environment read, no permission beyond what the caller
already holds; every value it touches is passed in.

| Input | Decision | Handling |
| ----- | -------- | -------- |
| no dependency-blocked candidate | fast path | the snapshot is never built and every tier is returned unchanged |
| issue body (attacker-controlled) | parsed for `Depends on` refs | `extractDependencyReferencesDetailed` — a bounded regex over the body, already used on the same bodies by the discovery collectors; the refs become data in a map, never a command, path or query |
| dependency absent from its repo's open list | dropped | it is closed, so it cannot block the root |
| dependency in a repo the scan holds no list for | kept as a blocker | a dependency nobody could read is never assumed closed, so the root stays unpromoted rather than promoted on a partial view |
| repo spelled with different casing | canonicalised to the monitored spelling | a casing mismatch would silently miss the snapshot it names and drop the subtree |
| promoted member with no candidate at any tier | left alone | promotion changes rank, never eligibility — an issue an earlier gate filtered out stays filtered out |
| promoted member already at the destination tier | left alone | the destination list is never searched as a source |
| resolver's `fleetWorking` / `unworkableRoots` | returned to the caller | reported, never acted on here |

Promotion is an **in-memory rank change for the length of one scan**: the
module writes nothing to GitHub, applies no label (the worker cannot apply
`top-priority` — label security strips it), and leaves each candidate's `repo`,
`labels`, `milestone` and `source` untouched, so `nice`, the eligibility gates
and the scan log still describe the issue as it actually is. The worst outcome
of a wrong verdict is that the scan claims a different issue it was already
entitled to claim — every per-issue gate has run before this module is reached,
and none of them is re-opened by it.

The candidate lists are copied before mutation, so a caller's arrays are never
mutated underneath it, and the promoted candidate is a copy carrying
`promotedBy` rather than an in-place edit of the collector's object.
