# Persisted data that changes shape bumps its key or reads the old shape

## Summary

Adds a **Changing the Shape of Persisted Data** rule to `CODING-STANDARDS.md`,
directly after "Never Fail Silently — Fail Loud". The same paragraph goes into
the code layer of `prompts/coding_guidelines/prompt.md`. When a change alters
the type or fields of a value cached or stored beyond one process, the rule
says to bump the key's version or read and convert the old shape. It also
requires a test that seeds an old-shape entry, an update to every doc that
names the key, and a PR summary that says which option was chosen. A
documentation-drift test keeps the two copies identical.
`docs/workflows/issue-processing.md` records the history. Closes #3328.

## Spec

### Intent and Rationale

- VibeCoder#3325 and GRQ-AutoTrader#2481 both changed a persisted payload's
  type under an unchanged `_v1_` or `-v1:` key. The tests saw only new-shape
  data, so CI passed while the first deployment would have broken. This rule
  makes the agent ask whether the value outlives a deployment before it
  changes the shape.

### Essential Design Decisions

- The prompt copy sits just inside `<!-- guidelines-layer: code -->`, right
  after Never Fail Silently. Only code-writing phases render it, so planning,
  question and grill-me prompts don't grow.
- The rule paragraph is identical on both surfaces and pinned word for word.
  Only `CODING-STANDARDS.md` has the carve-out: an interface a deployed
  extension reads follows **A Contract a Deployed Extension Reads Is
  Additive-Only**. Without the carve-out, the two rules would tell the agent
  to do opposite things about version bumps.

### Undiscoverable Facts

- The precedent already in the repository is Issue #2173. It bumped
  `issue_state_v1_` to `issue_state_v2_`, and its doc comment is at
  `worker/deno/lib/issue_cache.ts:45`.

## Evidence

This change is documentation and prompt only; no product code changed. The
drift test is the evidence.

**Docs sweep** — grep: `persisted`, `cache`, `versioned key`, `bump the key`,
"durable format (stored keys"; section: `CODING-STANDARDS.md#changing-the-shape-of-persisted-data`
(new); updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`,
`docs/workflows/issue-processing.md`; `CODING-STANDARDS.md:369` and
`prompts/coding_guidelines/prompt.md:1191` — still true because "do not change
… a durable format on an unverified diagnosis" governs *whether* to change a
format, and the new rule governs *how*; `CODING-STANDARDS.md:1279` — still
true because extension contracts are carved out of the new rule.

**Related existing rules checked:** the "No speculative fix … durable format"
rule (both surfaces), **A Contract a Deployed Extension Reads Is Additive-Only**
(`CODING-STANDARDS.md`), and the Never Fail Silently fallback bullets. None
conflicts. The additive-only rule is named as the exception.

**Applied the rule to this PR's own diff:** the diff changes no cached or
stored type and no persisted key, so the rule flags nothing.

## Test Plan

- Added `worker/deno/tests/persisted_shape_version_3328_test.ts`:
  - `both surfaces carry the persisted-shape rule (Issue #3328)` checks that
    the paragraph carries every key phrase and is identical on both surfaces.
  - `CODING-STANDARDS.md scopes the rule away from extension contracts (Issue #3328)`
    checks for the carve-out.
  - `the rule renders for code-writing phases only (Issue #3328)` checks that
    the heading renders in the issue prompt and not in the planning prompt.
- Red runs:
  - Changing "relaunch" to "restart" in the prompt copy turned the
    both-surfaces test red.
  - Moving the section above the code-layer marker turned the phase test red.
  - Both edits were then restored.
- Pinned phrases absent on base: `deno task drift-pins-on-base cbaacdbd …`
  reported "absent on base" for every pinned phrase in
  `CODING-STANDARDS.md` and in `prompts/coding_guidelines/prompt.md`.
- Modified `worker/deno/tests/coding_guidelines_layers_2574_test.ts`: added
  `"## Changing the Shape of Persisted Data"` to
  `CODE_PHASE_HEADINGS_BEFORE_2574`, because the code layer now renders that
  heading. No assertion was removed.
- `deno task test tests/coding_guidelines_layers_2574_test.ts tests/persisted_shape_version_3328_test.ts`
  passed: 15 passed, 0 failed.
- `./quality.sh < /dev/null` passed on the head. "config integration" was
  skipped; every other check passed.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
