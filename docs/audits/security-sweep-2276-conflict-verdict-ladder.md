# 🔎 Security sweep — the stale-verdict ladder reader (`conflict_verdict_ladder.ts`)

**Issue:** [#2276](https://github.com/stSoftwareAU/VibeCoder/issues/2276)
(chunk top-up-2276) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2276:

- `worker/deno/lib/conflict_verdict_ladder.ts` — added by #2276.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record. The module is
claimed by **top-up-2276**, and this file is the reading of it.

## `worker/deno/lib/conflict_verdict_ladder.ts`

Two exported pure functions over a PR's comment thread: `parseLadderState`
reads which stale-verdict rung already ran at which head sha, and
`decideLadderRung` returns the one rung to run now. Neither spawns, reads the
filesystem, nor touches the network.

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `trustedComments` | raw REST comment objects, **already filtered** by `partitionConflictComments` (`conflict_marker_trust.ts`) | each body is scanned for three fixed literal marker prefixes; attributes are read by three fixed patterns and must match `^[0-9a-f]{7,40}$` (sha) or the closed rung set before they reach the state |
| `currentHead` | GitHub's reported head sha | trimmed, lower-cased and pattern-checked; anything else waits instead of driving a rung |
| `mergeable` | GitHub's mergeability verdict | trimmed and upper-cased, then matched against exactly `CONFLICTING` / `MERGEABLE`; every other value waits |

| Property | Result |
| -------- | ------ |
| spawn chokepoints | none — the module constructs no `Deno.Command` and calls no spawn helper |
| filesystem | none |
| network | none |
| regex safety | four patterns, all linear and all literal: `/^[0-9a-f]{7,40}$/` and three `key="([^"]*)"` readers. No pattern is built from a variable, so there is no interpolated-`RegExp` or ReDoS surface |
| output bounds | the warn context truncates the offending marker segment to 200 characters, so hostile marker text cannot flood a log line |
| trust boundary | the module reads comment bodies, which any GitHub account can write. It is documented — and called — with the trusted partition only; an unfiltered thread would let an outsider skip a rung or exhaust the ladder (Issue #1247) |
| fail direction | a malformed attribute is discarded and logged at warn; the rest of the thread still counts. A discarded marker makes the ladder repeat a rung at that head, never skip to the destructive one, which is the safe direction |
| secret surface | holds no credential and emits none |

## The invariant this module exists to hold

Each rung of the stale-verdict ladder must run **at most once per head sha**:
the loop on NEAT-AI-Lamarck#239 was a rung's own output being read back as a
reason to run it again. Every decision here is keyed on the current head, and
a rung is offered only when no marker names that head with it — so two scans
between pushes produce one rung.

The second invariant is separation from the attempt budget: the three markers
share no literal with the frozen `vibe-coder:merge-conflict-*` vocabulary, so
`parseConflictAttempts` counts a thread identically with and without them.
`worker/deno/tests/conflict_verdict_ladder_test.ts` asserts that equality
directly.

## The caller contract this module cannot enforce

The module is pure: it neither fetches the thread nor filters it. A caller
that passed an **unfiltered** thread would hand an outsider the ability to
plant a rung marker — the same class of hole #1247 closed for the attempt
history. The doc comment states the contract; the enforcement is at the call
site, where `partitionConflictComments` already runs for the scan's own
markers.

## Verdict

**Swept, no findings.** Two pure functions with no spawn, filesystem, network
or secret surface, validated inputs, bounded log output, and linear patterns.
