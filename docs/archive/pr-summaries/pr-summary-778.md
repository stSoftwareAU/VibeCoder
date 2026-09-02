# Three prompts stop asking for the narration their own verbosity block forbids

## Summary

Every phase prompt carries `{{VERBOSITY_INSTRUCTIONS}}` on line 1, and the
block substituted there says *"no running commentary while you work"*. Three
prompts then asked for exactly that commentary:

- `prompts/ci_fix/v14.md:72` — "narrating briefly as you go"
- `prompts/pr_feedback/v13.md:8` — "Narrate briefly as you go (a short line …)"
- `prompts/planning/v23.md:10` — "Narrate briefly as you go."

So one rendered prompt both asked for and forbade narration. This is the
defect #759 fixed for `grill-me` (v15), surviving in three other prompts, found
by the cross-prompt contradiction audit for #762.

All three render the **`standard`** block whatever `PHASE_VERBOSITY_DEFAULTS`
declares, because `resolveVerbosity` has one non-test call site — the dead
plumbing is #798's, split out of this issue.

`prompts/ci_fix/v15.md`, `prompts/pr_feedback/v14.md` and
`prompts/planning/v24.md` drop the clause, worded after the `grill-me/v15`
pattern: each defers to the block that actually governs the output rather than
deleting the sentence. Committed versions are immutable, so each is a new
version and the retired one keeps the clause.

Closes #778.

## Evidence

Prompt-content change with no runtime surface to screenshot. The evidence is
the rendered prompt.

Each new version differs from its predecessor by exactly one sentence:

```diff
-You run unattended with no operator to consult. Make the reasonable call and proceed, narrating briefly as you go.
+You run unattended with no operator to consult. Make the reasonable call and proceed. Nobody watches the run in real time, so the Response Verbosity block above governs what you write: the reply is the output, not a commentary on producing it.
```

```
ok | 5 passed | 0 failed    # tests/phase_prompt_narration_test.ts
ok | 56 passed | 0 failed   # + ci_fix_reproduction_loop_v14, grill_me_narration,
                            #   prompt_manager and the prompt-version suites
```

`deno fmt --check` (2019 files), `deno lint` (2013 files), `deno check` over
every file in `worker/deno/tests` (0 errors) and the `docs prompt versions`
quality check all pass.

## Reproduction

- **symptom** — a `ci_fix`, `pr_feedback` or `planning` run receives one prompt
  that both bans running commentary (the substituted verbosity block) and asks
  the agent to narrate as it goes (the template)
- **status** — `verified` — the contradiction is asserted on the rendered
  surface, not on the file: the latest template is rendered with the block
  `buildVerbosityBlock("standard")` really produces, and the result carries the
  ban and none of the narration wording
- **regression test** —
  `worker/deno/tests/phase_prompt_narration_test.ts::phase prompts - every verbosity level bans commentary and none asks for it (Issue #778)`

## Acceptance Criteria

The issue states its scope in the grill-me understanding block rather than an
`## Acceptance Criteria` heading; each accepted item is closed out here. Judged
in an operator review of the whole diff, not by reviewer sub-agents.

- **met** — mint `ci_fix`, `pr_feedback` and `planning` versions with the
  narration clause removed, worded after the `grill-me/v15` pattern — evidence:
  `prompts/ci_fix/v15.md`, `prompts/pr_feedback/v14.md`,
  `prompts/planning/v24.md`; each is its predecessor plus one rewritten
  sentence, verified by `diff`
- **met** — one regression test per prompt, built through the real
  prompt-building path as `grill_me_narration_test.ts` does — evidence:
  `worker/deno/tests/phase_prompt_narration_test.ts`, whose five cases run over
  all three prompts: the latest version is the one that dropped the clause,
  no latest version asks for narration, the unattended framing survives, the
  retired versions stay immutable, and the rendered surface (template +
  `buildVerbosityBlock`) carries the ban alone
- **met** — the affected set is exactly these three prompts — evidence: the
  suite iterates a `SUBJECTS` table of the three; the audit's own table
  (`docs/audits/prompt-audit-cross-prompt-contradictions-762.md:49-65`) names
  no other prompt for #778
- **met** — use latest+1 at implementation time — evidence: `ci_fix` v14 → v15,
  `pr_feedback` v13 → v14, `planning` v23 → v24, each confirmed against the
  tree at the time of writing. #779 mints a further `ci_fix` version and will
  base on v15
- **met** — the new versions change only the narration clause — evidence: the
  one-line diffs above; #779, #783, #792 and #794 stay with their own issues

- **unrequested** — `ci_fix_reproduction_loop_v14_test.ts`'s exact version pin
  was relaxed — evidence: that file asserted `latest.value === "v14"`, which
  v15 makes false — reason: required by the change, and its intent is
  preserved. The assertion becomes "v14 or newer" and the resolution check
  still compares `loadPrompt(undefined)` against the resolved latest, so the
  test still proves the worker loads what it resolves. Every contract
  assertion in that file is untouched
- **unrequested** — a `<!-- pinned: … -->` marker on
  `docs/audits/prompt-audit-cross-prompt-contradictions-762.md:139` — reason:
  required by the `docs prompt versions` quality check, which v15 turned red.
  That line cites `ci_fix/v14.md:15` as the evidence for a finding *recorded at
  that version*, which is exactly what the marker is for; the audit is a
  historical record, not guidance to keep current

## Standards Review

- **clean** — prompt immutability honoured: no committed version was edited,
  each change is a new version, and a test asserts the retired versions still
  carry the clause; Australian English throughout; the replacement wording is
  the one `grill-me/v15` already established, so the fleet reads one sentence
  for this rule rather than four
- **clean** — the regression test builds through `getLatestVersion` /
  `loadPrompt` and the real `buildVerbosityBlock`, so it exercises the path
  the worker renders rather than reading files for keywords. It is a content
  assertion about a *prompt*, which is the artefact under test, not a grep
  over source
- **violation** — the test asserts on prose fragments ("Response Verbosity
  block above governs"), which a future rewording would break — evidence:
  `phase_prompt_narration_test.ts` `SUBJECTS.keeps` — reason: stands. A prompt
  *is* prose; the alternative is asserting nothing about what replaced the
  clause, which would let a later version delete the deferral and reintroduce
  the ambiguity the wording exists to remove
- **clean** — the dead `PHASE_VERBOSITY_DEFAULTS` plumbing is left to #798 as
  the issue's accepted scope says, and the new suite's last case covers the
  risk of that follow-up: *no* verbosity level's block asks for narration, so
  threading a configured level through later cannot reintroduce this

## Test Plan

Added `worker/deno/tests/phase_prompt_narration_test.ts` (5 tests, each over
all three prompts):

- `phase prompts - the latest version of each is the one that dropped the clause (Issue #778)`
- `phase prompts - no latest version asks the run to narrate (Issue #778)`
- `phase prompts - the unattended framing survives the clause (Issue #778)`
- `phase prompts - the retired versions stay immutable (Issue #778)`
- `phase prompts - every verbosity level bans commentary and none asks for it (Issue #778)`

Modified: `ci_fix_reproduction_loop_v14_test.ts`'s version-resolution
assertion, documented above. No assertion was weakened or removed.
