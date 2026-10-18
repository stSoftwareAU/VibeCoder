# Skip repeat reviews for strict version-only re-bumps

## Summary

Closes #3713.

The own-diff gate now recognises a changed modified-file patch as equivalent
when both patches contain a complete one-line bare version increment. All
other files retain the existing exact comparison after hunk-position
normalisation. The exception requires findings from this PR's exact earlier
sent-back head, and a finding on the version file forces a fresh review.
A separate workflow bump commit and a bump in a merge resolution both qualify.

## Spec

### Intent and Rationale

- A repository workflow can advance only the version after a base merge while
  every earlier review finding remains unfixed. That should remain awaiting-fix.
- Fail toward a fresh review whenever the complete narrow exception cannot be
  confirmed, including missing earlier findings from another review host.

### Essential Design Decisions

- Accept one complete hunk, one removed and one added bare version line, with
  two to four numeric components and the same component count within each
  increment. Compare numeric components using BigInt; the first difference
  must increase. A suffix may accompany that increase, but suffix-only changes
  stay reviewable; no prerelease ordering is guessed.
- Added or renamed files, context lines, extra hunks, malformed/truncated
  patches, newline markers, equal/decreasing versions and any other changed
  own diff all retain fresh review.
- Bind local review-log findings to repository, PR number, sent-back head and
  changes-requested outcome. A matching version-file finding, including a
  qualified path, disables the exception. Existing exact-diff behaviour does
  not require local finding metadata.

### Undiscoverable Facts

- A temporary real Git repository reproduced the reported base-merge plus
  workflow-bump sequence. The two own diffs were `-1.32.4/+1.32.5` and
  `-1.32.5/+1.32.6`, each under the ordinary one-line hunk header.
- No remote PR or review was changed during local verification.

## Evidence

The two new own-diff regressions failed against the previous implementation
(19 passed, 2 failed). The gate and upkeep-failure suites now pass 26 tests,
including an integrated gate pass proving exact review-log binding and the
required version-file-finding exception. Seventeen isolated guard mutations
caused assertion failures. Restored production code passed the focused run.
The full review-fleet suite passed 243 tests; the manifest gate passed 687
tests with one existing ignored test. Changed TypeScript files passed lint, and Markdown lint reported no errors. Full hosted quality
validation remains pending.

Docs sweep — grep: `"own diff"`, `"awaiting-fix"`, `"base-branch merges"`;
updated `.claude/skills/review-fleet-prs/SKILL.md` and its edge-cases reference;
section: `.claude/skills/review-fleet-prs/references/edge-cases.md` — Version-only
re-bumps; siblings: none — the existing patch comparator gains a narrow
exception, with no new registry member. The rule-8 restatement and function
header agree with the exception, its earlier-finding guard and conservative
suffix handling. Existing exact-diff tests and added-binary blob rules remain
unchanged. The forwarding shim delegates to the changed script.

## Test Plan

- `worker/deno/tests/review_fleet_prs_gate_2675_test.ts`: merge-resolution and
  separate-commit bumps, all other own-diff changes, version-file findings,
  missing findings, version order/width/suffixes, malformed patches, file
  additions and renames. Existing tests and assertions remain unchanged.
- `worker/deno/tests/review_fleet_prs_upkeep_failure_2891_test.ts`: run the real
  gate using persisted review records; exclude records for another repository,
  PR, head or outcome and review a finding on the version file afresh.
- The new rule was applied to its own examples and docs; no contradictory
  restatement or out-of-scope implementation change was found.

<!-- vibe-branch-outcomes -->
