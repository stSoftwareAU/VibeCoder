# PR Summary — Issue #3045

## Summary

Closes #3045.

Each idle-task prompt's Phase 4 "for each surviving finding" step used to
re-check dedup against a live `gh issue list ... --json number,body` call. It
skipped a finding whenever any open issue's body held its
`<!-- finding-id: … -->` marker. Anyone who can open an issue controls that
body, so a planted marker could suppress a real finding, including a security
finding. The step now dedups only on `{{KNOWN_OPEN_FINDING_IDS}}`. The worker
builds that list in code from open issues the fleet account authored.

```mermaid
flowchart LR
    A["Issue body by anyone<br/>(attacker-writable)"] -. no longer consulted .-> D
    K["KNOWN_OPEN_FINDING_IDS<br/>(fleet-authored issues only)"] --> D["Phase 4 dedup"]
    D --> F["File finding"]
```

- [x] Regression test that fails on base and passes after the fix
- [x] Removed the live re-check from all 14 idle-task prompts
- [x] Docs: `docs/SECURITY-SCAN.md` dedup section

## Spec

### Intent and Rationale

The author of an issue is trustworthy. Its body is not. Dedup must key on
what the fleet itself filed.

### Essential Design Decisions

- The live re-check was dropped instead of being given an author filter. The
  known-open list already holds that author filter in code, so a second,
  prompt-side copy would only duplicate it and could drift.
- `security_scan` no longer lists Phase 4 dedup among its permitted
  `gh issue list` uses.
- The new prompt wording names no issue number: cross-repo-filed prompt
  bodies must not carry a bare `#NNN`, because it would mislink in the target
  repo.

### Undiscoverable Facts

None.

## Evidence

- **Regression test:**
  `worker/deno/tests/idle_task_live_recheck_dedup_3045_test.ts::idle-task prompts dedup only on the fleet-filtered known-open list (Issue #3045)`.
  It loads each of the 14 idle-task prompts and asserts three things for
  each: there is no unfiltered `--json number,body` lookup, there is no
  "Re-check the live open-issue list" step, and the prompt states that the
  known-open list is "the only dedup source".
- **Fails before:** the regression test fails against the unfixed code. With
  `prompts/` restored from `main`, it reports:

  ```text
  error: AssertionError: best_practices must not look up issue bodies without filtering by author
  FAILED | 0 passed | 1 failed
  ```

- **Passes after:** after the fix, `deno task test:unit
  tests/idle_task_live_recheck_dedup_3045_test.ts` gives `ok | 1 passed |
  0 failed`.
- **Trigger closed, no trivial bypass:** the original attack plants
  `<!-- finding-id: X -->` in an issue someone else filed. The prompts no
  longer read any issue body for dedup. `grep -rn "number,body\|in:body"
  prompts/` finds no remaining unfiltered lookup. The only dedup source is
  `{{KNOWN_OPEN_FINDING_IDS}}`, which the worker builds in code from
  fleet-authored issues, so the prompt gives the agent no path that consults
  an issue body written by someone else.
- **Docs sweep:** I updated the "Dedup against open and recently-closed
  findings" section of `docs/SECURITY-SCAN.md`.

## Reproduction

- **Symptom:** an idle-task prompt told the agent to skip any finding whose
  `<!-- finding-id: … -->` marker appeared in any open issue body, whoever
  wrote it, so a planted marker suppressed a real finding.
- **Status:** verified. The regression test reproduces the unfiltered
  re-check on `main`'s prompts and passes on this branch.
- **Regression test:**
  `worker/deno/tests/idle_task_live_recheck_dedup_3045_test.ts::idle-task prompts dedup only on the fleet-filtered known-open list (Issue #3045)`.

## Test Plan

- [x] `deno task test:unit tests/idle_task_live_recheck_dedup_3045_test.ts`
      passes; it fails with `main`'s `prompts/`.
- [x] `./quality.sh` passes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
