# PR Summary — Issue #3371

## Summary

The PR summary's **Docs sweep** line now needs a `siblings:` part: the existing
sibling members grepped for each set the change adds a member to, backticked or
double-quoted, or `siblings: none — <why no existing set gained a member>`. The
docs-sweep gate refuses a code-changing summary whose line has no `siblings:`,
a bare placeholder, or a non-`none` value that quotes no term. The worker
re-runs the quoted sibling terms beside the `grep:` terms, so a stale list of
the set becomes the same advisory PR comment. Before this, the #3137
sibling-grep rule was prose only, and GRQ-AutoTrader#2460, #2481, #2682 and
#2792 each left a list one short. Closes #3371.

## Spec

### Intent and Rationale

- The new member's name is in no doc yet, so grepping only that name finds nothing. A required, machine-read `siblings:` part makes the agent name the siblings it grepped, and lets the worker re-run them.
- The design copies `section:`: same field parse, same bare-placeholder set, and the same honest `none — <why>` negative. The re-run reuses the existing `checkDocsSweepTerms` path, so sibling hits are cleared and reported exactly like grep-term hits.

### Essential Design Decisions

- A non-`none` `siblings:` must quote at least one term. Otherwise the line passes while the worker has nothing to re-run. Unquoted names are not re-run.
- The section and siblings problems are reported together, section first, so the one recovery turn can fix both.
- `isSiblingsNegative` (in `docs_sweep_hits.ts`) is the single test of the `none` negative, used by both the gate and `extractSiblingTerms`. That keeps a quoted `"none" — why` from being accepted by one and refused by the other.
- Grep and sibling terms are capped at `MAX_TERMS` each, so a long `grep:` list cannot crowd out the siblings.

### Undiscoverable Facts

- `isBarePlaceholder` is shared with `section:`, so a quote-wrapped bare `section: "none"` is now also refused as a placeholder (before, it read as a section name).
- Corpus run over `docs/archive/pr-summaries/`: 945 summaries, 147 with a Docs sweep line, and none with a `siblings:` part. Under the new rule all 147 would be refused for the missing part, as expected for a new field. None was misparsed: no prose was read as a `siblings:` value.
- The pr_feedback drift check (`pr_feedback_drift_check.ts`) calls the same `validateDocsSweep`, so a feedback push on an older PR whose summary lacks `siblings:` is asked to add it.

## Evidence

Backend and prompt-only change; no UI file touched. Behaviour is pinned by `worker/deno/tests/docs_sweep_gate_test.ts`, `worker/deno/tests/docs_sweep_hits_test.ts` and `worker/deno/tests/prompt_docs_sweep_siblings_3371_test.ts`.

```mermaid
flowchart LR
    S[PR summary Docs sweep line] --․> P[parseDocsSweepLine: section, siblings]
    P --․> G{validateDocsSweep}
    G -- no siblings / placeholder / no quoted term --․> B[block + one recovery turn]
    G -- valid --․> T[extractSweepTerms: grep + sibling terms]
    T --․> R[checkDocsSweepTerms: git grep at HEAD]
    R -- unnamed hit outside diff --․> C[advisory PR comment]
```

Issue numbers the diff cites: #3371: Sibling-member grep for an added set member is prose only: fleet PRs still leave the list one short after #3137 (GRQ-AutoTrader#2460, #2481, #2682, #2792). GRQ-AutoTrader#2460: Evaluation run reads the whole decision-log partition for purchase ratings on every run (Issue #2377). GRQ-AutoTrader#2481: Report the loan, interest charged and margin settings; performance nets interest (#2129). GRQ-AutoTrader#2682: Policy: minimum hold days, so a name bought today isn't sold tomorrow (Issue #2589). GRQ-AutoTrader#2792: Live policy: switch on rebalancing trims (position and industry tolerances) (Issue #2749). I looked each one up with `gh` in this run.

Related existing rules checked for agreement: CODING-STANDARDS.md *Adding a member owes a docs change too* (extended, word-for-word with `prompts/coding_guidelines/prompt.md`). The PR-summary Evidence item (extended). The issue prompt's Instructions step 3 and PR Summary File bullet, and the pr_feedback *A fix owes its docs change too* paragraph (each extended). `docs/workflows/issue-processing.md` *Docs sweep on a code change* and `docs/workflows/pr-feedback.md` *Docs sweep re-check* (updated). I found no rule that conflicts. I applied the new rule to this PR's own diff: this summary's Docs sweep line carries a `siblings:` part, and every Docs sweep example in the diff passes the gate. The prompt examples are checked by `prompt_docs_sweep_siblings_3371_test.ts`, and the gate comment's examples by `buildDocsSweepGateComment - each example Docs sweep line it shows passes the gate`.

**Docs sweep** — grep: `extractGrepTerms`, `MAX_TERMS`, "grep terms", "re-runs the line's quoted terms", "must name the manual"; siblings: `section:` (the Docs sweep line's parts), `rawBody` (`DocsSweepLine` fields); section: `docs/workflows/issue-processing.md#-docs-sweep-on-a-code-change`; updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`, `prompts/coding_guidelines/prompt.md`, `prompts/pr_feedback/prompt.md`, `docs/workflows/issue-processing.md`, `docs/workflows/pr-feedback.md`, and the doc comments in `worker/deno/lib/docs_sweep_hits.ts:117-120` and `worker/deno/lib/phases/completion_phase.ts:2845-2850`; `docs/workflows/issue-processing.md:1591` — still true because it shows the `section:` example the next two lines (1592-1593) extend with `siblings:`; `docs/workflows/issue-processing.md:1627-1631` — still true because it is the history of the grep-term re-run; `worker/deno/lib/docs_sweep_gate.ts:16`, `worker/deno/lib/docs_sweep_gate.ts:40`, `worker/deno/lib/docs_sweep_gate.ts:73-75`, `worker/deno/lib/docs_sweep_gate.ts:108`, `worker/deno/lib/docs_sweep_gate.ts:141`, `worker/deno/lib/docs_sweep_gate.ts:174`, `worker/deno/lib/docs_sweep_gate.ts:213`, `worker/deno/lib/docs_sweep_gate.ts:263-264` — still true because each describes the `section:` field alone; `worker/deno/lib/docs_sweep_hits.ts:175-180` — still true because `extractGrepTerms` still reads only `grep:`; `worker/deno/lib/parallel_unsafe_test_manifest.ts:179` — still true because that entry is the `section:` placeholder scan

## Acceptance Criteria

<․!-- vibe-spec-review inputs="diff+issue-body" --․>

- **met** — Add a required `siblings:` part to the **Docs sweep** line, modelled on `section:` … A bare placeholder is refused, as `section:` refuses one — evidence: `worker/deno/tests/docs_sweep_gate_test.ts::validateDocsSweep - a line with no siblings: is refused, and accepted once an explained none is added` — reviewer: met
- **met** — In `docs_sweep_gate.ts`, parse and validate `siblings:` alongside `section:`, and include the sibling terms in the term re-run — evidence: `worker/deno/tests/docs_sweep_hits_test.ts::checkDocsSweepTerms - a sibling term's untouched, unnamed hit is reported with the sibling term` — reviewer: met
- **met** — Update the Docs sweep wording in `prompts/issue/prompt.md` (the PR Summary File section), `prompts/coding_guidelines/prompt.md` and `CODING-STANDARDS.md` to describe the new part, and point at the four examples above — evidence: `worker/deno/tests/prompt_docs_sweep_siblings_3371_test.ts` — reviewer: partial — reason: the reviewer found the issue prompt did not cite the four GRQ-AutoTrader PRs; commit e0f30ffe added them to Instructions step 3 of `prompts/issue/prompt.md`
- **met** — Add tests in the docs-sweep gate's test file: the line is refused without `siblings:`, refused with a bare placeholder, and accepted with real terms or a reasoned `none` — evidence: `worker/deno/tests/docs_sweep_gate_test.ts::validateDocsSweep - a bare siblings: placeholder is refused, with only the placeholder problem` — reviewer: met
- **unrequested** — a third refusal: a non-`none` `siblings:` that quotes no term — reviewer: unrequested — reason: without a quoted term the line would pass while the worker has nothing to re-run, which defeats item 2
- **unrequested** — `prompts/pr_feedback/prompt.md`, `docs/workflows/issue-processing.md` and `docs/workflows/pr-feedback.md` updated — reviewer: unrequested — reason: the pr_feedback drift check runs the same gate, and these are the manuals for it (the docs-change rule)
- **unrequested** — `siblings: none — …` appended to Docs sweep fixtures in about 25 other test files — reviewer: unrequested — reason: these fixtures must keep passing the stricter gate; no assertion changed
- **unrequested** — `parallel_unsafe_test_manifest.ts` lists `tests/docs_sweep_hits_test.ts` as a wall-clock test — reviewer: unrequested — reason: its new hostile regex cases use `assertLinearGrowth`, and the manifest test requires the entry

## Standards Review

<․!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" --․>

- **violation** — Writing a gate over text: the gate and `extractSiblingTerms` normalised a quoted `none` differently, so `siblings: "none" — why` was refused — evidence: `worker/deno/lib/docs_sweep_gate.ts:340` — reason: fixed in this diff (shared `isSiblingsNegative`, plus tests for the backticked, straight- and curly-quoted variants)
- **violation** — Check where you insert: "The same terms are also re-run over source files" now followed the new siblings paragraph — evidence: `worker/deno/lib/docs_sweep_hits.ts:28` — reason: fixed in this diff (reworded to "The grep and sibling terms")
- **violation** — Vet every regex on untrusted text, one hostile case per pattern: `SIBLINGS_LABEL_RE`, `SIBLINGS_NONE_RE`/`LEADING_QUOTE_RE` and the placeholder quote strips had no hostile case — evidence: `worker/deno/lib/docs_sweep_hits.ts:188` — reason: fixed in this diff (`assertLinearGrowth` cases in both test files)
- **clean** — no `new RegExp` from input, fail-closed refusals, refusal tests name their rule and show the legal input accepted, Australian English, doc comments, no removed assertions; review-enforced rules checked: Check where you insert, Australian English, Prose about the PR's own change, A refusal test must be refused by the rule it names, Every outcome of a branch you add needs a test

## Test Plan

- `worker/deno/tests/docs_sweep_gate_test.ts`: new siblings tests (refused when missing, a bare placeholder, or quoting no term; a quoted `none` negative accepted; both problems reported, section first; wrapped continuation; the gate comment's examples pass; hostile linear-growth cases). `siblings:` appended to existing fixtures.
- `worker/deno/tests/docs_sweep_hits_test.ts`: `extractSiblingTerms`, `isSiblingsNegative`, `extractSweepTerms`, sibling re-run through `checkDocsSweepTerms` (reported, cleared when named, sibling-only line checked), hostile linear-growth cases.
- `worker/deno/tests/prompt_docs_sweep_siblings_3371_test.ts` (new): pins `siblings:` in each section, and also `siblings: none —` in the issue prompt's Instructions and PR Summary File sections; the CODING-STANDARDS.md and coding_guidelines *A Code Change Owes a Docs Change* sections and the pr_feedback *Making Changes* section are pinned on `siblings:` alone. `deno task drift-pins-on-base origin/milestone/fleet-guidance-issue-and-feedback-prompts …` reported every pinned phrase absent from its base section: issue Instructions, issue PR Summary File, both *A Code Change Owes a Docs Change* sections, pr_feedback *Making Changes*. It also runs every Docs sweep example in the issue prompt through `validateDocsSweep`. Removing `siblings:` from the skeleton example turned it red.
- About 25 other test files gained `; siblings: none — no existing set gained a member` on their Docs sweep fixtures. No assertion was removed from any existing test.
- Red checks: removing the siblings checks from `evaluateApplicable` turned the refusal tests red. Using `extractGrepTerms` alone in `checkDocsSweepTerms` turned the sibling re-run tests red. Dropping the `none` negative from `extractSiblingTerms` turned its test red. A local `/^none\b/i` in the gate turned the quoted-negative test red. Inverting `isSiblingsNegative` or `isBarePlaceholder` turned the hostile cases red.
- `deno task test:unit tests/docs_sweep_gate_test.ts tests/docs_sweep_hits_test.ts tests/completion_phase_docs_sweep_test.ts tests/prompt_docs_sweep_siblings_3371_test.ts tests/coding_guidelines_additive_member_3137_test.ts`: passed on the final head.
- `./quality.sh < /dev/null` on `b3ba9f8b`: passed (with skipped checks: config integration, which needs `.config.json`); Deno tests, lint, type check, fmt, markdownlint, semgrep and completeness checks all passed. The final commit after it changes two doc comments only; `deno fmt --check` and `deno lint` on both files passed on the final head

**Branch outcomes:**

- `worker/deno/lib/docs_sweep_gate.ts:331` — no `siblings:` refused — `worker/deno/tests/docs_sweep_gate_test.ts::validateDocsSweep - a line with no siblings: is refused, and accepted once an explained none is added` — removing the check turned it red
- `worker/deno/lib/docs_sweep_gate.ts:335` — bare placeholder refused — `worker/deno/tests/docs_sweep_gate_test.ts::validateDocsSweep - a bare siblings: placeholder is refused, with only the placeholder problem` — removing the check turned it red
- `worker/deno/lib/docs_sweep_gate.ts:340` — non-`none` value quoting no term refused — `worker/deno/tests/docs_sweep_gate_test.ts::validateDocsSweep - a siblings: value that quotes no term is refused, and accepted once terms are quoted` — removing the check turned it red
- `worker/deno/lib/docs_sweep_gate.ts:340` — the `none — why` negative accepted (plain, backticked, quoted) — `worker/deno/tests/docs_sweep_gate_test.ts::validateDocsSweep - a none negative for siblings: is accepted with backticks, straight or curly quotes` — a local `/^none\b/i` turned it red
- `worker/deno/lib/docs_sweep_hits.ts:253` — `none` negative re-runs nothing — `worker/deno/tests/docs_sweep_hits_test.ts::extractSiblingTerms - the none — negative returns no terms, even with a quoted span in the reason` — dropping the check turned it red
- `worker/deno/lib/docs_sweep_hits.ts:274` — a sibling term that duplicates a grep term is dropped — `worker/deno/tests/docs_sweep_hits_test.ts::extractSweepTerms - merges grep then sibling terms, deduplicated case-insensitively` — removing the `continue` turned it red
- `worker/deno/lib/docs_sweep_hits.ts:494` — sibling terms re-run — `worker/deno/tests/docs_sweep_hits_test.ts::checkDocsSweepTerms - a sibling term's untouched, unnamed hit is reported with the sibling term` — using `extractGrepTerms` alone turned it red

🤖 Generated with [Claude Code](https://claude.com/claude-code)
