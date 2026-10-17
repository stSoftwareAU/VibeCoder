## Summary

`worker/deno/tests/merge_conflict_prompt_v2_test.ts` pinned bare common words ("only", "before", "higher", "source code", "rule", "judgement", "carve-out", "duplicate") over the whole `prompts/merge_conflict/prompt.md`. Those words occur all through the template, so the sentence that bounds the never-side-pick carve-out to dependency-version hunks could be deleted with the suite still green. The nine prose-pin tests now read the template with `readRepoDoc()`, scope to the heading holding each rule with `section()`, and pin the rule's own sentence through `assertPins()`. This finishes the `merge_conflict_prompt_v2` conversion that #3309 left outstanding. Closes #3557.

## Spec

### Intent and Rationale

- A drift pin guards a rule only if deleting that rule's sentence turns it red. Bare words matched elsewhere in the template, so they guarded nothing.
- `section()` plus `assertPins()` is the repo's existing mechanism (CODING-STANDARDS.md § "Re-scoping an existing drift test"), so no new helper was written.

### Essential Design Decisions

- Each pin is scoped to the section holding the sentence it was written for. `git log -S` traces the carve-out pins to 67bae84c, whose `v2.md` carve-out subsection held the "before", "higher", "source code" and total-order sentences.
- Every string the old tests pinned is still inside some new pin. The bare "Never side-pick" in the contradiction test now pins the judgement section's "a side-pick is mechanical … still forbidden" sentence, the rule that test's comment describes. "Never side-pick" is still pinned in the contract test.
- Kept unchanged: the whole-file checks (the `{{CONFLICTED_FILES}}` count, the absent `{{QUALITY_INSTRUCTIONS}}` placeholder), the rendered-prompt tests, and the tests already sliced to the timeout example and the intent section.

### Undiscoverable Facts

- `section("The Contract — Both Sides Survive")` runs to the next `##` heading, so its body includes the `###` carve-out heading. The "names the carve-out in the contract section" test pins that heading.

## Evidence

Test-only change. No production code, prompt or doc changes.

**Docs sweep** — grep: `merge_conflict_prompt_v2`, "carve-out is bounded" in `README.md`, `docs/` (excluding `docs/archive/`) and `CODING-STANDARDS.md`; section: none — no manual documents this test file; siblings: none — no existing set gained a member; no hits outside `docs/archive/`

## Test Plan

- `deno test --frozen --lock=deno.lock --allow-read --allow-env tests/merge_conflict_prompt_v2_test.ts` (from `worker/deno`) on the final head: 24 passed, 0 failed. `deno fmt`, `deno lint` and `deno check` on the file: clean.
- Assertions removed from existing tests. Each removed string still appears inside a pin of the same test (or, for "Never side-pick", the contract test), now scoped to its section. No issue requirement made any of them untrue. The issue asked for the bare words to be replaced:
  - `assertStringIncludes(body, "only");`, `assertStringIncludes(body, manifest);`, `assertStringIncludes(body, "source code");` → pins p10–p13
  - `assertStringIncludes(body, "before");`, `assertStringIncludes(body, "higher");`, `assertStringIncludes(body, "semver");` → p14, p15
  - `assertStringIncludes(body, "regenerate");`, `assertStringIncludes(body, lock);` → p16, p17
  - `assertStringIncludes(body, "total order");`, `assertStringIncludes(body, "rule");`, `assertStringIncludes(body, "judgement");` → p19, p20
  - `assertStringIncludes(contract, "carve-out");`, `assertStringIncludes(contract, "dependency-version");` → p9
  - `assertStringIncludes(contract, "conflicted-file list");`, `assertStringIncludes(contract, "not listed");` → p18
  - `assertStringIncludes(body, "both intents are best served by");`, `assertStringIncludes(body, "Originating Issues");`, `assertStringIncludes(body, "Never side-pick");` → p3–p5, plus p6 in the contract test
  - `assertStringIncludes(body, "git merge -X ours");`, `assertStringIncludes(body, "git checkout --ours");`, `assertStringIncludes(body, "duplicate");` → p6–p8
  - `assertStringIncludes(body, ".pr_response_message");`, `assertStringIncludes(body, "one line per conflicted file");`, and the `Judgement: <path> — <kept …; dropped …; because …>` assertion → p1, p2
- Moved checks. Each pin was deleted from its own section only, the single test was run with `--filter`, and the template was restored. Every run failed with `section is missing pin "<pin>"`:
  - p1 "Write into `.pr_response_message`, one line per conflicted file, in exactly this shape:" — Where Both Sides Cannot Stand — red
  - p2 "`Judgement: <path> — <kept …; dropped …; because …>`" — Where Both Sides Cannot Stand — red
  - p3 "resolve to the outcome **both intents are best served by**" — Where Both Sides Cannot Stand — red
  - p4 "read the **Originating Issues** block below when one is present" — Where Both Sides Cannot Stand — red
  - p5 "a side-pick is mechanical (…), and it is still forbidden" — Where Both Sides Cannot Stand — red
  - p6 "**Perform a real merge. Never side-pick.**" — The Contract — Both Sides Survive — red
  - p7 "`git merge -X ours` / `-X theirs`, `git checkout --ours <file>` … side-pick" — The Contract — Both Sides Survive — red
  - p8 "The one exception is a genuine **duplicate**: …" — The Contract — Both Sides Survive — red
  - p9 "### The Dependency-Version Carve-Out — Settled Before You Ran" — The Contract — Both Sides Survive — red
  - p10 "**The carve-out is bounded to dependency-version hunks in those manifest files.** It is not licence to generalise." — The Dependency-Version Carve-Out — red
  - p11 "Do not settle a conflicting constant, config value, threshold or string anywhere else by taking the newer one" — The Dependency-Version Carve-Out — red
  - p12 "A dependency-version hunk in a known manifest — `deno.json`/`deno.jsonc`, `package.json`, `Cargo.toml`, `go.mod` —" — The Dependency-Version Carve-Out — red
  - p13 "A value in source code has no such order" — The Dependency-Version Carve-Out — red
  - p14 "settled deterministically by the worker **before** this prompt is built, so it never reaches you" — The Dependency-Version Carve-Out — red
  - p15 "is resolved per dependency key by taking the **higher** published semver, whichever branch carries it" — The Dependency-Version Carve-Out — red
  - p16 "**Lock files.** … are **never** text-merged." — The Dependency-Version Carve-Out — red
  - p17 "The worker regenerates them from the already-merged manifest with the ecosystem's own tool." — The Dependency-Version Carve-Out — red
  - p18 "Files the rules resolved are already staged and are **not listed** in the conflicted-file list at the end of this prompt" — The Dependency-Version Carve-Out — red
  - p19 "**Why this is a rule and not a judgement:** dependency versions have a total order" — The Dependency-Version Carve-Out — red
  - p20 "which is exactly why the timeout example below is a judgement you make by reading the code, not a rule you apply" — The Dependency-Version Carve-Out — red
- These are moved pins whose phrases are meant to be on base, so the base-absence check does not apply (CODING-STANDARDS.md § "Re-scoping an existing drift test"). No absence check was narrowed. `assertPins()` throws on a subsumed pin, so no pin in a list is a substring of another.

<!-- vibe-branch-outcomes -->
