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
| the parser cannot be made to throw | every `JSON.parse` is inside a `try`, and a failure is returned as a refusal naming which of the three sides would not parse |
| untrusted content cannot reach an unbounded regex | the only regex is `/\n( +)\S/` against the merge base, anchored on a newline and matching a run of spaces followed by one non-space — linear, with no nested quantifier to backtrack over |
| recursion is bounded by the document | `mergeValue` recurses on the *parsed* structure, whose depth `JSON.parse` has already bounded: a document deep enough to exhaust the stack throws inside `JSON.parse` first, and that is a caught refusal |
| the merge makes no judgements | a scalar both sides changed differently, a deleted key, a deleted or rewritten array item, and a type change are all refused with a reason. The caller turns a refusal into `unresolved`, which is the existing AI/human path |
| the result cannot be an invalid document | the output is `JSON.stringify` of a merged value, so a union is well-formed by construction — the failure mode that made the textual union unusable for this file cannot occur here |
| a one-sided change is taken, a two-sided one is not | `jsonEquals(ours, base)` yields `theirs` and vice versa, which is ordinary three-way merge behaviour; only where *both* sides moved away from the base does the merge insist on a structural union or refuse |
| formatting is the author's | the merge base must re-serialise to its own bytes before any union is attempted, so a file the union would reformat is refused instead. A `.jsonc`, a tab-indented file and a hand-compacted array all fail that gate |
| output order is deterministic | insertions are emitted base-branch-side first at each anchor point, and object keys keep base order then each side's additions; the same three inputs always produce the same bytes |

### Findings

None.

### Accepted residuals

- **A slice both branches wrote identically is kept once.** De-duplication is
  by structural equality against the other side's insertions at the same
  anchor, so a cherry-picked entry does not land twice. An entry that differs
  in any field is not de-duplicated — the ledger's own uniqueness check
  (`duplicateSliceIds`) is what catches two slices that claim the same chunk id
  or issue, and it fails the PR rather than the merge.
- **Key order is ignored when comparing entries.** Two sides that wrote the
  same entry with its fields in a different order are treated as the same
  entry. That is the intended reading of "both sides added this"; the cost is
  that the base branch's field order wins, which no consumer of these ledgers
  depends on.
