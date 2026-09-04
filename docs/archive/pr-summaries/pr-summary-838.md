# PR Summary — Issue #838

## Summary

Applies the house vocabulary (`docs/PROMPT-HOUSE-VOCABULARY.md`) to the ten
interactive prompt templates. Six carried drift; four (`ci_fix`,
`merge_conflict`, `planning`, `pr_feedback`) were already at the house form and
needed no edit. Names and casing only — no instruction, gate, output contract or
worked-example body changed. Closes #838.

| Change | Files |
| --- | --- |
| Mode heading → `## <X> Mode` | `planning_critique`, `quorum`, `quorum_judge` |
| Repo-standards section → `## Project Guidelines` | `question` (was `## Guidelines`), `grill-me` (was `### Guidelines`) |
| Worked examples → `### Worked Examples` | `grill-me` (was `### Examples`), `spelling_fix` (was `### Worked examples`), `quorum` and `quorum_judge` (were `### Worked cases`) |
| Prose `markdown` → `Markdown` | `grill-me` |
| Bare `quality.sh` → `./quality.sh` | `spelling_fix` |

**The issue's mechanism no longer exists.** It asked for one new `vN.md` per
directory. Issue #844 (commit `c97783b`) removed prompt versioning: every
directory now holds a single `prompt.md`, and `loadPrompt()` reads only that
file (`worker/deno/lib/prompt_manager.ts:338,352`). The edits therefore land in
each directory's `prompt.md`, with git history as the record. The canon still
told the next sweeper to bump a version, so it is corrected here too.

Three pre-existing failures blocked `./quality.sh` on this branch before any of
this issue's edits, and are cleared here so the gate can be green: a doc test
importing an export #844 removed, a doc link the same merge dropped, and the
fourteen stranded `vN.md` files (**Closes #901**). Each is its own commit.

## Evidence

Backend/prompt-text change with no web interface, so no screenshot applies.
Evidence is the gate and the greps below.

Post-change sweep over the ten templates — every banned form is gone and every
house heading is present:

```text
$ grep -nE 'the executor|VibeCoder|idle task|an experienced software engineer' <the ten>
(no output)
$ grep -nE '(^|[^./`a-zA-Z])quality\.sh' <the ten> | grep -v '\./quality\.sh'
(no output)
$ grep -n 'markdown' <the ten>
prompts/grill-me/prompt.md:154:```markdown
prompts/question/prompt.md:101:```markdown          # fence infostrings — exempt
$ grep -nE '^#{1,4} ' <the ten> | grep -iE 'mode|guideline|example|worked'
prompts/ci_fix/prompt.md:2:## CI Fix Mode
prompts/ci_fix/prompt.md:19:### Worked Examples
prompts/ci_fix/prompt.md:114:## Project Guidelines
prompts/planning/prompt.md:2:## Planning Mode — Draft Stage
prompts/planning/prompt.md:137:### Planning Guidelines      # exempt, untouched
prompts/merge_conflict/prompt.md:2:## Merge Conflict Mode
prompts/merge_conflict/prompt.md:34:### Worked Examples
prompts/quorum/prompt.md:2:## Plan Drafting Mode — One Issue, One Plan
prompts/quorum/prompt.md:82:### Worked Examples
prompts/quorum_judge/prompt.md:2:## Plan Adjudication Mode — Two Candidate Plans, One Verdict
prompts/quorum_judge/prompt.md:103:### Worked Examples
prompts/pr_feedback/prompt.md:2:## PR Feedback Mode
prompts/pr_feedback/prompt.md:20:### Worked Examples
prompts/pr_feedback/prompt.md:83:## Project Guidelines
prompts/planning_critique/prompt.md:2:## Planning Mode — Adversarial Self-Critique and Publish
prompts/grill-me/prompt.md:2:## Grill-Me Mode
prompts/grill-me/prompt.md:145:### Worked Examples
prompts/grill-me/prompt.md:205:## Project Guidelines
prompts/spelling_fix/prompt.md:2:## Spelling Fix Mode
prompts/spelling_fix/prompt.md:25:### Worked Examples
prompts/question/prompt.md:6:## Question Answering Mode
prompts/question/prompt.md:176:## Project Guidelines
```

**No renamed heading is a code anchor.** Grepping `worker/deno/` for each
literal (`## Plan Drafting`, `## Plan Adjudication`, `## Planning — Adversarial`,
`### Worked cases`, `### Worked examples`, `### Examples`, `## Guidelines`,
`### Guidelines`) returns hits only in
`worker/deno/tests/prompt_house_vocabulary_doc_test.ts:225-234`, which are the
canon's banned-variant lists asserted against the document — not parsers over
template text. No parser reads these headings.

### Two pre-existing gate failures had to be cleared first

`./quality.sh` failed on this branch **before** any of this issue's edits, on
work merged from `main`:

```text
TS2305 [ERROR]: Module '.../lib/prompt_manager.ts' has no exported member 'getLatestVersion'.
  at worker/deno/tests/prompt_house_vocabulary_doc_test.ts:33:10
AssertionError: docs/PROMPT-BEST-PRACTICES-CHECKLIST.md does not link docs/PROMPT-HOUSE-VOCABULARY.md
  at worker/deno/tests/prompt_house_vocabulary_doc_test.ts:455
```

Merging #844 into the milestone branch removed `getLatestVersion` while #834's
doc test still imported it, and the merge dropped the house-vocabulary bullet
#834 had added to the checklist's Related list. Both are repaired in commit
`f59850d` — the test now resolves each template through
`loadPrompt(name, PROMPTS_DIR)`, and the bullet is restored. Without them no PR
for this issue could be raised, since the gate must be green first.

### A third pre-existing failure: the stranded batch A and B sweeps

`prompt_manager_test.ts:66` ("no versioned prompt files remain in the tree")
also failed on the branch before this issue's edits. Issues #835 and #836 landed
their sweeps as new `vN.md` files; #844 then removed versioning, so
`loadPrompt()` reads only `prompt.md`. Merging the two left **fourteen** swept
`vN.md` files beside an unswept `prompt.md`, and the worker was loading the
unswept one — eight still said `the executor`.

Filed as **stSoftwareAU/VibeCoder#901** and fixed here, because it fails the
gate branch-wide and every sibling sweep (#837, #839, #840) is behind the same
wall. Each `prompt.md` is a three-way merge — base = the pre-#844 version,
theirs = the swept `vN.md` — so batch A and B's content lands verbatim. The only
conflict in all fourteen was the H1 version suffix #844 removed, resolved to the
unsuffixed heading; every folded file now differs from its `vN.md` by that line
alone, which the per-file diff confirms. `the executor` now survives only in
`security_scan` and `workflow_annotation_scan`, owned by #837 and #839. Kept as
its own commit (`cf9996c`) so it reads independently of the rename.

### One fact recorded rather than changed

**`prompts/quorum/prompt.md:112` names its repo-standards section
`### Standards`.** The canon bans `## Coding Guidelines`, `## Guidelines` and
`### Guidelines` (`docs/PROMPT-HOUSE-VOCABULARY.md:96`); `### Standards` is not a
recorded variant and the issue did not list it, so it is left alone. Renaming it
is a canon change, and the canon says a row is changed on the page first.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — ten new `vN.md` files exist, one per directory; no existing `vN.md` modified or deleted — evidence: `prompts/{planning_critique,quorum,quorum_judge,question,grill-me,spelling_fix}/prompt.md` — reviewer: met — reason: the `vN.md` mechanism was removed by #844, so no version file was created or could be; the equivalent holds — the ten directories' `prompt.md` is at the house form, six by edit and four already compliant, and no template file was deleted.
- **partial** — each new file's H1 states its own new version number — reviewer: met — reason: void after #844 — none of the ten templates carries an H1 at all (each opens with `{{VERBOSITY_INSTRUCTIONS}}` then its mode H2), so there is no version H1 to state and none was invented.
- **met** — all ten open with an H2 mode heading in the `## <X> Mode` form — evidence: `prompts/planning_critique/prompt.md:2`, `prompts/quorum/prompt.md:2`, `prompts/quorum_judge/prompt.md:2`, plus the seven already conforming (grep above) — reviewer: met
- **met** — the repo-standards section is `## Project Guidelines` in every file that has one; `### Planning Guidelines` untouched — evidence: `prompts/question/prompt.md:176`, `prompts/grill-me/prompt.md:205`, `prompts/ci_fix/prompt.md:114`, `prompts/pr_feedback/prompt.md:83`; `prompts/planning/prompt.md:137` unchanged — reviewer: met
- **met** — every worked-examples section is `### Worked Examples` — evidence: `prompts/grill-me/prompt.md:145`, `prompts/quorum/prompt.md:82`, `prompts/quorum_judge/prompt.md:103`, `prompts/spelling_fix/prompt.md:25` — reviewer: met
- **met** — no `the executor`, no `VibeCoder` in prose, no bare `quality.sh`, no `idle task`, no lowercase `markdown` in prose across the ten — evidence: the four greps under Evidence; `prompts/spelling_fix/prompt.md:70` and `prompts/grill-me/prompt.md:43` were the only two hits — reviewer: met
- **partial** — a grep of `worker/deno/` confirms no renamed heading was a code anchor; no worker source file is modified — evidence: the anchor grep under Evidence — reviewer: met — reason: the anchor half is met, but one worker file *is* modified — `worker/deno/tests/prompt_house_vocabulary_doc_test.ts` — for the pre-existing #844 import break, not for any renamed heading; the reviewer saw only the template commit and so did not see it.
- **met** — `./quality.sh` passes — evidence: full gate run after the final edit, every stage PASSED, exit 0 (see the note in Test Plan on the seven run-environment variables that must not leak into the test process — the same suites fail identically at base commit `27bdbbb`) — reviewer: partial — reason: the reviewer judged the template commit alone, where the pre-existing failures still stood; all three are fixed in `f59850d` and `cf9996c`.
- **unrequested** — `prompts/grill-me/prompt.md:211`: `#### Grill-me guidelines` demoted to `### Grill-me guidelines` — reviewer: unrequested — reason: its parent was promoted from `### Guidelines` to `## Project Guidelines` by the mandated rename, and leaving the child at H4 would skip a level; this keeps the increment at one.
- **unrequested** — `worker/deno/tests/prompt_house_vocabulary_doc_test.ts` and `docs/PROMPT-BEST-PRACTICES-CHECKLIST.md` repaired — reviewer: unrequested — reason: both failures pre-date this issue and blocked `./quality.sh`, which the last acceptance criterion requires to pass.
- **unrequested** — `docs/PROMPT-HOUSE-VOCABULARY.md` mechanism prose updated for #844 — reviewer: unrequested — reason: the canon told this sweep to land a new `vN.md`, which #844 made impossible; both independent reviews flagged the page as the document that misdirected the sweep, and the standards rule is to correct the doc surface in the same change.
- **unrequested** — fourteen scan templates folded and their `vN.md` files removed (#901) — reviewer: unrequested — reason: `prompt_manager_test.ts:66` fails on the leftovers, so no PR on this branch could reach a green gate without it; both reviewers independently surfaced the stray files, and the fold is a mechanical three-way merge kept in its own commit.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — the branch tip could not pass the quality gate: the committed doc test imported `getLatestVersion`, removed by #844 — evidence: `worker/deno/tests/prompt_house_vocabulary_doc_test.ts:33` — reason: fixed in this diff (commit `f59850d`); the test now resolves templates through `loadPrompt(name, PROMPTS_DIR)` and the restored checklist link clears the second, related failure.
- **violation** — docs not kept in step: the canon still stated "committed `vN.md` files are immutable, so a fix is always a version bump" while this sweep landed in `prompt.md` — evidence: `docs/PROMPT-HOUSE-VOCABULARY.md:29` — reason: fixed in this diff (commit `0b09510`); Scope, "Changing the canon", the flowchart node and the dangling `EXTENDING.md#prompt-versioning-and-templates` anchor all updated.
- **violation** — leftover `prompts/*/v*.md` files contradicted the post-#844 single-template layout, and the templates the worker loads were the unswept ones — evidence: `prompts/supply_chain_detection/v7.md` and thirteen siblings — reason: fixed in this diff (commit `cf9996c`, #901); both reviewers surfaced it independently.
- **violation** — no `docs/archive/pr-summaries/pr-summary-838.md` at the reviewed commit — evidence: `docs/archive/pr-summaries/` — reason: fixed — this file, committed as the last step of the run, as the sibling sweeps did.
- **clean** — Australian English throughout; scope discipline (rename and casing only, no instruction, gate or output contract changed, `### Planning Guidelines` untouched, no worker *source* modified); no renamed heading is a code anchor; heading hierarchy stays MD001-safe; commit safety — only tracked files staged, no hidden path, key material or credential file; every commit references `(Issue #838)` and carries the `Vibe-Coder-Run-Id` trailer; no test added for a Markdown rename, since asserting heading strings would be the grep-the-source anti-pattern `CODING-STANDARDS.md` forbids and the drift gate is owned by #840.

## Test Plan

No new test: this issue is a Markdown rename, and the drift gate that will pin
these house forms against every template is Issue #840's deliverable — the same
split the canon records at `docs/PROMPT-HOUSE-VOCABULARY.md:25-27`.

Tests run:

- `deno test -A tests/prompt_house_vocabulary_doc_test.ts tests/prompt_best_practices_checklist_test.ts` — 30 passed, 0 failed. These are the two suites the repaired import and restored link affect; both failed before the repair (`SyntaxError: ... does not provide an export named 'getLatestVersion'`, then `AssertionError: docs/PROMPT-BEST-PRACTICES-CHECKLIST.md does not link docs/PROMPT-HOUSE-VOCABULARY.md`).
- `deno test -A tests/prompt_manager_test.ts tests/prompt_h1_version_suffix_test.ts tests/prompt_house_vocabulary_doc_test.ts tests/prompt_placeholder_substitution_test.ts tests/scan_prompt_open_issue_titles_test.ts tests/test_audit_prompt_v12_test.ts tests/documentation_audit_prompt_v9_test.ts` — 140 passed, 0 failed, after the fold. `prompt_manager_test.ts:66` ("no versioned prompt files remain in the tree") failed before it.
- `./quality.sh --sequential` — **every stage PASSED**, exit 0.

**One note on how that gate was run.** Run plainly inside this container the
gate reports 35 test failures, all in `service_account_env_test.ts`,
`setup_credential_provisioning_test.ts`, `setup_lockfile_test.ts`,
`setup_prerequisites_test.ts`, `setup_provider_credential_flow_test.ts` and
`setup_workdir_reminder_test.ts` — none prompt-related. They are the worker's own
run environment leaking into the test process: the suites assert on paths they
create, and `CONFIG_PATH`, `GH_CONFIG_DIR`, `VIBE_STATE_DIR`, `VIBE_BASE_DIR`,
`VIBE_IMAGE_AGENT_PROVIDERS`, `VIBE_DENO_SEED_DIR` and `VIBE_SCRATCH_DIR` point
them at the live run's instead (`ERROR: CONFIG_FILE and CONFIG_PATH are both set
and name different files`). Two proofs they are not this branch's doing:

- a clean worktree at the **base commit `27bdbbb`** fails the same way — 19 of 40
  in the two files sampled;
- with those seven variables unset, the same six suites pass 111 / 111 on this
  branch, and the full gate is green.

The prompt-consuming suites (`grill_me_*`, `question_*`, `quorum_*`,
`planning_*`, `merge_conflict_prompt_v2`, `ci_fix_prompt_v4`,
`phase_prompt_output_contract`, `fable5_remaining_prompts`, `prompt_hash`) run
inside the gate and pass, which is what proves no renamed heading broke a
consumer.
