# PR Summary — Issue #3298

## Summary

Adds `worker/deno/tests/claude_skill_frontmatter_test.ts`. It parses the YAML
frontmatter of every `.claude/skills/*/SKILL.md` and `.claude/agents/*.md`
with `@std/yaml/parse` and checks the skills guide's rules: `name` kebab-case
(and equal to the folder for a skill), `description` present, at most 1,024
characters, no `<` or `>`, and, for a skill only, containing "Use when". It
fails loudly when either directory is missing or matches no file. The
`review-fleet-prs` skill's `description` gains a "Use when…" clause so the new
test passes. Closes #3298.

## Spec

### Intent and Rationale

- Claude Code decides whether to load a skill from its `description`, so a description that never says when to use the skill rarely triggers. A test over every checked-in file stops a later skill or agent from drifting off the guide.
- The checks sit in one pure function, `frontmatterProblems`, which returns rule ids, so fixtures prove each rule refuses exactly its own case without touching the real files.

### Essential Design Decisions

- The "Use when" and name-equals-folder rules apply to skills only. Agents are held to the name and description rules, per the issue.
- Discovery throws on a missing directory or zero matches, so a moved `.claude/skills` cannot turn into a silent pass.
- Length counts code points (`[...description].length`), not UTF-16 units.
- Two extra rules, `no-frontmatter` and `yaml-invalid`, report a file the YAML step cannot read instead of passing it.

### Undiscoverable Facts

- Milestone parent direction ("Provider neutral but favouring Claude") does not conflict with this sub-issue: the test targets Claude Code's own `.claude/` layout, as the issue asks.
- `.claude/agents/fleet-pr-reviewer.md` passed unchanged, so it is not edited.

## Evidence

Backend/test-only change, with no UI file touched. Run from `worker/deno`:
`deno test --frozen --lock=deno.lock --allow-read --allow-write --allow-env tests/claude_skill_frontmatter_test.ts`
→ `ok | 23 passed | 0 failed`. With the base-branch `SKILL.md` restored, the
real-file test fails with exactly one problem:
`.claude/skills/review-fleet-prs/SKILL.md: description-no-use-when`.

New description: 546 characters, contains "Use when", no `<` or `>`.

#3298: Add a frontmatter test for Claude Code skills and agents, and give review-fleet-prs a "Use when" trigger

**Docs sweep** — grep: `review-fleet-prs`, `.claude/agents`, `.claude/skills`, `SKILL.md`, `frontmatter`, "Watches for new PRs every 5 minutes" over `README.md`, `CODING-STANDARDS.md` and `docs/` (excluding `docs/archive/` and `docs/audits/`); section: none — no manual documents skill frontmatter or quotes the skill's description; no doc updated. `docs/CONFIGURATION.md:174`, `docs/CONFIGURATION.md:381`, `docs/CONFIGURATION.md:406`, `docs/SETUP.md:366`, `docs/GITHUB-ACTIONS-AUDIT-SCAN.md:1189`, `docs/THREAT-MODEL.md:247` and `docs/workflows/pr-feedback.md:344` — still true because they name the skill's behaviour, files or labels, never its `description` text or frontmatter.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The new test passes against the real skill and subagent files. — evidence: `worker/deno/tests/claude_skill_frontmatter_test.ts::every checked-in skill and agent passes the frontmatter rules (Issue #3298)` — reviewer: partial — reason: the reviewer could not run commands; it found the logic correct statically, and the test was run here on the final head and passes
- **met** — In-test fixtures prove the test fails for each of these, without editing the real files: a skill description with no "Use when"; a description longer than 1,024 characters; a description containing `<`; a `name` that is not kebab-case; a skill `name` that differs from its folder; a missing `description`. — evidence: `worker/deno/tests/claude_skill_frontmatter_test.ts` tests "a skill description without 'Use when' is refused", "a 1025-character description is too long", "a description containing only < is refused", "a non-kebab-case name is refused", "a skill name that differs from its folder is refused", "a missing description is refused" — reviewer: met
- **met** — The test fails when no skill file is found. — evidence: `worker/deno/tests/claude_skill_frontmatter_test.ts::skillFiles rejects an empty skills directory loudly (Issue #3298)` and `::skillFiles rejects a missing skills directory loudly (Issue #3298)` — reviewer: met
- **met** — The skill's `description` contains "Use when", is under 1,024 characters and has no `<` or `>`. — evidence: `.claude/skills/review-fleet-prs/SKILL.md:3` (546 characters) — reviewer: met
- **met** — `./quality.sh` passes. — evidence: full gate run on the final head, `Result: PASSED (with skipped checks)`; only `config integration` was skipped (no `.config.json` in this checkout) — reviewer: missing — reason: the reviewer saw only the diff and could not run the gate; it was run here and passed
- **unrequested** — the `no-frontmatter` and `yaml-invalid` rules and their tests — reviewer: unrequested — reason: the parse step must report a file it cannot read rather than pass it (fail loud)
- **unrequested** — extra fixtures: 1,024-character boundary, valid skill and agent bases, `<`-and-`>` case, empty description, missing name, unclosed fence, non-mapping frontmatter, discovery positive case, folder without `SKILL.md`, empty and missing agents directory — reviewer: unrequested — reason: these prove each refusal is caused by its own rule (the valid base is accepted) and reach every outcome of the helpers

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — no violations and no removed assertions (no existing test is touched). Review-enforced rules checked: "Check where you insert" (the description edit appends to one line, and the test file is new) and "Avoid over-engineering" (no existing skill-frontmatter validator to reuse, no new dependency). Also checked: the tests call real functions rather than grepping source, every named test exists, no stub or workflow rules apply, and the spelling is Australian English. Optional: the local `fromFileUrl` helper repeats a pattern used in other tests.

## Test Plan

- Added `worker/deno/tests/claude_skill_frontmatter_test.ts` (23 tests). On the final head, from `worker/deno`: `deno test --frozen --lock=deno.lock --allow-read --allow-write --allow-env tests/claude_skill_frontmatter_test.ts` → `ok | 23 passed | 0 failed`.
- Red check: with `.claude/skills/review-fleet-prs/SKILL.md` restored to the base branch, the real-file test fails (`19 passed | 1 failed` at that point) on `description-no-use-when` only.
- `./quality.sh < /dev/null` → `Result: PASSED (with skipped checks)` (config integration skipped: no `.config.json`).
- No existing test edited, so no assertion is removed.

**Branch outcomes:** (all in the test file's helpers; each tested outcome was flipped on purpose and the suite went red)

- `worker/deno/tests/claude_skill_frontmatter_test.ts:45` — no opening fence → `no-frontmatter` — "no frontmatter at all is refused" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:58` — no closing fence → `no-frontmatter` — "an unclosed frontmatter fence is refused" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:69` — YAML parse throws → `yaml-invalid` — "invalid YAML in the frontmatter is refused" — flip (rethrowing instead) went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:78` — non-mapping frontmatter → `yaml-invalid` — "frontmatter that is not a mapping is refused" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:92` — name missing or not kebab-case — "a non-kebab-case name is refused", "a missing name is refused" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:97` — skill name differs from folder — "a skill name that differs from its folder is refused" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:107` — description missing or empty — "a missing description is refused", "an empty description is refused" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:116` — over 1,024 characters — "a 1025-character description is too long"; accepted side "a 1024-character description is accepted at the boundary" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:123` — `<` or `>` — "a description containing only < is refused" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:131` — skill without "Use when"; agent exempt — "a skill description without 'Use when' is refused", "a valid agent fixture has no problems…" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:153` — skills directory missing — "skillFiles rejects a missing skills directory loudly" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:169` — folder without `SKILL.md` skipped — "skillFiles rejects a skills directory whose only folder lacks SKILL.md" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:177` — no skill matched — "skillFiles rejects an empty skills directory loudly" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:190` — agents directory missing — "agentFiles rejects a missing agents directory loudly" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:205` — no agent matched — "agentFiles rejects an empty agents directory loudly" — flip went red
- `worker/deno/tests/claude_skill_frontmatter_test.ts:158`, `:170` and `:195` — rethrow of a non-`NotFound` filesystem error — exempt (untestable): needs a permission or I/O fault the unit suite cannot stage portably
