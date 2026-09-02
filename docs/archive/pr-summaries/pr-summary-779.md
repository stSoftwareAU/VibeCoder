# Five output contracts say they override the injected trailing summary

## Summary

`{{VERBOSITY_INSTRUCTIONS}}` renders into every phase prompt carrying the
placeholder, and the text it substitutes says:

> Summarise what you changed once the work is done … **Write that summary at
> the end**.

Five prompts state an output shape with no room for it:

| Prompt | The shape |
| --- | --- |
| `quorum_judge` | a machine-parsed verdict block, "nothing else after it" |
| `quorum` | exactly four sections |
| `question` | answer content only, posted verbatim |
| `spelling_fix` | exactly three sections, "never drop a heading" |
| `ci_fix` | a fixed `.pr_response_message` skeleton |

`quorum_judge` is the sharpest case: a program parses the verdict block, and
the verbosity text instructs the model to write prose after the last thing in
the reply. That is a correctness failure, not a style one. In `quorum`,
`quorum_judge` and `question` the phase also forbids changing anything, so
"summarise what you changed" has no referent at all.

Each latest version now states that its own shape overrides the injected
block, following the `grill-me/v15` pattern:
`prompts/quorum_judge/v2.md`, `prompts/quorum/v2.md`,
`prompts/question/v10.md`, `prompts/spelling_fix/v8.md`,
`prompts/ci_fix/v16.md`. Committed versions are immutable, so each is a new
version; the fix is prompt-side only, exactly as the issue's accepted scope
says, and the builder's substitution is untouched.

`ci_fix/v16` bases on v15, which #778 minted earlier today — the sequencing
both issues agreed for whichever landed second.

Closes #779.

## Evidence

Prompt-content change with no runtime surface to screenshot. The evidence is
the rendered prompt.

Each new version differs from its predecessor by one sentence, placed beside
the contract it defends:

```diff
-- The content between the tags must be valid JSON — … Put any narration *before* the block.
+- The content between the tags must be valid JSON — … Put any narration *before* the block. This shape overrides the Response Verbosity block above: a program parses this reply, so the summary that block asks for goes before the verdict block or not at all — prose after the closing tag breaks the consumer.
```

```
ok | 5 passed | 0 failed     # tests/phase_prompt_output_contract_test.ts
ok | 162 passed | 0 failed   # + the narration, ci_fix, prompt-manager,
                             #   quorum, question and spelling suites
```

`deno fmt --check` (2020 files), `deno lint` (2014 files), `deno check` over
every file in `worker/deno/tests` (0 errors) and the `docs prompt versions`
quality check all pass.

## Reproduction

- **symptom** — a `quorum_judge` run is told to end its reply with the verdict
  block and *nothing else*, and in the same rendered prompt to write a summary
  at the end; the four other phases are told to use an exact section list and
  to append a section that is not in it
- **status** — `verified` — the contradiction and its resolution are asserted
  on the rendered surface: each latest template is rendered with the block
  `buildVerbosityBlock("standard")` really produces, and the result carries
  both the shape and the sentence that subordinates the block to it
- **regression test** —
  `worker/deno/tests/phase_prompt_output_contract_test.ts::output contracts - every verbosity level still asks for the summary the shapes override (Issue #779)`

## Acceptance Criteria

The issue states its scope in the grill-me understanding block rather than an
`## Acceptance Criteria` heading; each accepted item is closed out here. Judged
in an operator review of the whole diff, not by reviewer sub-agents.

- **met** — each of the five prompts' latest version gains an explicit sentence
  that its stated output skeleton overrides the injected verbosity block —
  evidence: the five new versions above;
  `::output contracts - the latest version of each states the override (Issue #779)`
  asserts both the shared marker and the distinctive sentence per prompt
- **met** — new immutable `vN.md` per file, version = latest+1 at
  implementation time — evidence: `quorum_judge` v1 → v2, `quorum` v1 → v2,
  `question` v9 → v10, `spelling_fix` v7 → v8, `ci_fix` **v15 → v16** (v15 is
  #778's, merged earlier today);
  `::output contracts - the retired versions stay immutable (Issue #779)`
- **met** — a regression test per prompt asserting the sentence is present in
  the latest version, mirroring `grill_me_narration_test.ts` — evidence: the
  five cases in `phase_prompt_output_contract_test.ts`, each iterating all five
  prompts through `getLatestVersion` / `loadPrompt`
- **met** — coverage is the five named prompts, from the Round 2 sweep of all
  12 placeholder-bearing prompts — evidence: the `SUBJECTS` table is exactly
  those five; the sweep's finding is restated in the test's header comment so
  the next reader knows why the other seven are absent
- **met** — the fix is prompt-side only; the builder's substitution is
  untouched — evidence: the diff contains no change under `worker/deno/lib`
- **met** — the conflict holds at all four verbosity levels, so the override is
  stated unconditionally — evidence:
  `::output contracts - every verbosity level still asks for the summary the shapes override (Issue #779)`
  checks every level's block for a summary instruction and fails if none asks,
  which would mean five prompts overriding nothing

- **unrequested** — the test asserts each prompt still *states* the contract
  the sentence defends — reason: an override sentence outliving the shape it
  protects is worse than no sentence; the assertion costs one line per prompt
  and keeps the pair together
- **unrequested** — a case asserting `quorum` and `question` say the summary
  has no referent — reason: the issue makes that point specifically ("has no
  referent in those three"), and the wording is what a reader of the prompt
  needs to know why the override is not merely about placement

## Standards Review

- **clean** — prompt immutability honoured: no committed version edited, each
  change is a new version, and a test asserts the retired versions do not carry
  the new sentence; Australian English throughout; the wording follows the
  `grill-me/v15` pattern already established, so the fleet reads one idiom for
  this rule
- **clean** — the immutability assertion is pinned to *this* change's sentence
  rather than the shared "Response Verbosity block above" marker, because
  `ci_fix/v15` already carries that marker from #778 — a detail that would
  otherwise have made the test pass for the wrong reason, or fail for one
- **violation** — the test asserts on prose fragments, which a rewording would
  break — evidence: `SUBJECTS.addition` and `SUBJECTS.contract` — reason:
  stands, as in #778. A prompt is prose; asserting nothing about the wording
  would let a later version delete the override and leave the contradiction
- **clean** — no shell or runtime logic changed, so nothing here can alter
  behaviour beyond what the model reads

## Test Plan

Added `worker/deno/tests/phase_prompt_output_contract_test.ts` (5 tests, each
over all five prompts):

- `output contracts - the latest version of each states the override (Issue #779)`
- `output contracts - the shape the override defends is still stated (Issue #779)`
- `output contracts - the retired versions stay immutable (Issue #779)`
- `output contracts - every verbosity level still asks for the summary the shapes override (Issue #779)`
- `output contracts - the two phases that change nothing say the summary has no referent (Issue #779)`

No existing test was modified.
