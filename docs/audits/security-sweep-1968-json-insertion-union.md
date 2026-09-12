# Security sweep — structured JSON union (`json_insertion_union.ts`)

**Issue:** [#1968](https://github.com/stSoftwareAU/VibeCoder/issues/1968)
(chunk top-up-1968) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #1968:

- `worker/deno/lib/json_insertion_union.ts` — added by #1968.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record, as 12f's own record
documents. The module is claimed by **top-up-1968**, and this file is the
reading of it.

## `worker/deno/lib/json_insertion_union.ts`

The module merges three JSON documents — the merge base and the two sides of a
conflicted file — into one. Its caller is `both_inserted_conflict_rule.ts`,
which hands it the text of a conflicted `.json` path during the deterministic
conflict pass; the text comes from the repository under merge and from
`git show :1:<path>`, so it is **repository content**, influenced by whoever
authored the two branches. The relevant shapes are 12c's untrusted-ingestion
ones, not 12a's process ones — nothing here spawns, reads or writes anything.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | no `Deno.Command`, no import that reaches one; every function is pure over the strings it is given |
| no filesystem, no network, no `gh` | nothing is opened; the three texts arrive from the caller |
| no environment or secret sinks | no `Deno.env`; nothing is logged. The refusal reasons name JSON paths (`$.slices.parent`) and a `JSON.parse` message, never file content |
| nothing here can throw at the caller | every `JSON.parse` is inside a `try` and returns a refusal naming which of the three sides would not parse; the structural walk and the re-serialisation are wrapped too, so a document `JSON.parse` accepts but `JSON.stringify` cannot walk comes back as `the union could not be built — Maximum call stack size exceeded` rather than crashing the conflict pass, which calls `rule.resolve` without a `try` |
| untrusted content cannot reach an unbounded regex | the only regex is `/\n( +)\S/` against the merge base, anchored on a newline and matching a run of spaces followed by one non-space — linear, with no nested quantifier to backtrack over |
| recursion is bounded, and an overflow is contained | `mergeValue`, `jsonEquals` and `JSON.stringify` all recurse on the *parsed* structure. `JSON.parse` accepts documents deeper than they can walk — 60 000 nested arrays parse and then overflow — so depth is not a safety argument; the guard is the `try` around the whole merge, which turns the overflow into a refusal. Covered by `unionJsonInsertions - a document too deep to re-serialise is refused, not thrown` |
| the merge makes no judgements | a scalar both sides changed differently, a deleted key, a deleted or rewritten array item, and a type change are all refused with a reason. The caller turns a refusal into `unresolved`, which is the existing AI/human path |
| the result cannot be an invalid document | the output is `JSON.stringify` of a merged value, so a union is well-formed by construction — the failure mode that made the textual union unusable for this file cannot occur here |
| a one-sided change is taken, a two-sided one is not | `jsonEquals(ours, base)` yields `theirs` and vice versa, which is ordinary three-way merge behaviour; only where *both* sides moved away from the base does the merge insist on a structural union or refuse |
| formatting is the author's | the merge base must re-serialise to its own bytes before any union is attempted, so a file the union would reformat is refused instead. A `.jsonc`, a tab-indented file and a hand-compacted array all fail that gate |
| output order is deterministic | insertions are emitted base-branch-side first at each anchor point, and object keys keep base order then each side's additions; the same three inputs always produce the same bytes |

### Findings

None.

### Accepted residuals

- **A slice both branches wrote identically is kept once.** De-duplication is
  by structural equality against every insertion the other side made, wherever
  in the array it anchored it, so a cherry-picked entry — and an insertion one
  side merged cleanly while the other conflicted on it — does not land twice.
  An entry that differs in any field is not de-duplicated — the ledger's own
  uniqueness check (`duplicateSliceIds`) is what catches two slices that claim
  the same chunk id or issue, and it fails the PR rather than the merge.
- **Key order is ignored when comparing entries.** Two sides that wrote the
  same entry with its fields in a different order are treated as the same
  entry. That is the intended reading of "both sides added this"; the cost is
  that the base branch's field order wins, which no consumer of these ledgers
  depends on.
