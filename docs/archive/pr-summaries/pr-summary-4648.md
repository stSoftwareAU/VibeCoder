## Summary

`docs/INTERNALS.md` said a conflict that needs the agent on a cargo tree is
charged on the second over-budget cycle and so climbs the recovery ladder. The
code never does that: the withhold is returned as `not-charged`. The sentence
now says the conflict is not landed while the cargo root is over budget, and
that the cycle is not charged, does not climb the ladder and is not counted
toward `refusedCycles`. It cites Issues #4326 and #4588 and keeps the
HOST_DISK_BUDGET link. Closes #4648.

## Spec

### Intent and Rationale

- The passage predated #4588; commit 244a4d18da corrected the other two places
  (`docs/INTERNALS.md` near line 4560 and `docs/CONTAINER.md` near line 1412)
  but missed this one. An operator would otherwise wait for a roll-back that
  never comes.

### Essential Design Decisions

- Documentation only; the wording matches the two passages already corrected so
  all three agree.

### Undiscoverable Facts

- None.

## Evidence

Documentation only; no code or UI file changed. The claim was checked against
the head code: `worker/deno/lib/milestone_branch_sync.ts:623` returns the
`CARGO_BUDGET_AGENT_WITHHELD` verdict unchanged (no `failed` verdict), and
`milestone_branch_sync.ts:922` defines the reason string
`cargo budget withheld the agent`.

Issue numbers cited as provenance, each looked up with `gh issue view`:

- `#4326`: Milestone syncs are refused every cycle on disk budget, so milestone
  issues never run
- `#4588`: Cargo-budget withholds advance refusedCycles, so the first gate
  refusal after a disk shortage climbs straight to the roll-back

Docs sweep: grepped `docs/` (excluding `docs/archive/`) for `second
over-budget` and `charged on the second`; the only hit was the sentence fixed
here. The passages at `docs/INTERNALS.md` near line 4560 and
`docs/CONTAINER.md` near line 1412 already state the current behaviour.

## Test Plan

No test added: this is a prose correction with no behaviour change, and a test
that greps the manual for a sentence would be a source-text check.

- `markdownlint-cli2 docs/INTERNALS.md`: 0 issues.
- `deno fmt --check docs/INTERNALS.md` exits 1 on the base copy as well, so the
  failure is not from this change; the file was not reformatted.
- `./quality.sh` was not run: the change is one sentence in a Markdown file.

<!-- vibe-quality-gate-skipped: documentation-only one-sentence change; markdownlint passed; CI runs the full gate -->
