## Summary

`worker/deno/tests/action_sha_pinning_policy_test.ts` used to flatten each
prompt with `.replace(/\s+/g, " ")` and pin every phrase against the whole file,
which breaks condition 1 of CODING-STANDARDS.md § Documentation-drift tests.
Each positive pin now reads only the section that states its rule, via
`flat(section(await readRepoDoc(doc), title))`. The absence checks still read
the whole file. Closes #3262.

## Spec

### Intent and Rationale

- With a whole-file `includes`, a pinned rule could move to an unrelated
  heading, or survive only in an example, and the test stayed green. Scoping
  each pin to its heading makes a moved rule fail the test.

### Essential Design Decisions

- There are four sections:
  - `github_actions_audit` § Definitions, which holds the owner set, "no owner
    is exempt" and the image carve-out.
  - `github_actions_audit` § Supply-chain hardening, which holds checks 10 and
    13.
  - `workflow_setup` § CI Hardening Defaults.
  - `coding_guidelines` § Dependency Bumps and Supply Chain.
- The `first-party` checks and the tag carve-out regex are absence checks, so
  they still read the whole file. Narrowing them would let the forbidden text
  come back in another section. The regex check uses `flatWholeFile` rather than
  a local whitespace regex.
- The issue offered an optional lint against `.replace(/\s+/g, " ")` in
  doc-reading tests. I skipped it to stay in scope. 33 test files under
  `worker/deno/tests` still contain that call, and each would need sorting into
  doc-reading or not before a lint could land. That is separate work.

### Undiscoverable Facts

- `loadPrompt` is a plain `Deno.readTextFile` of `prompts/<name>/prompt.md`, so
  switching to `readRepoDoc` does not change which text is read.

## Evidence

This is a test-only change. No production code or prompt changed.

**Docs sweep**: I grepped for `action_sha_pinning_policy` over `*.md`, excluding
`docs/archive/`, and got no hits. No symbol, flag or documented behaviour
changed, so no docs needed updating. The section is `none`.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- Each positive pin reads `readRepoDoc` + `section()` + `flat()` scoped to the
  heading that states its rule — reviewer: met
- The `first-party` and tag carve-out absence checks stay whole-file —
  reviewer: met
- Each pin maps to its own section (audit Definitions, audit Supply-chain
  hardening, setup CI Hardening Defaults, guidelines Dependency Bumps and
  Supply Chain) — reviewer: met
- Reuse the shared `worker/deno/tests/support/markdown_docs.ts` helpers, as in
  #3242 — reviewer: met
- Optional lint for `.replace(/\s+/g, " ")` in doc-reading tests — reviewer:
  met — reason: the issue marks it optional; skipped as out of scope (33 test
  files still use the call)
- Unrequested changes: none — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- § Documentation-drift tests, condition 1 (section-scoped positive pins;
  absence checks whole-file) — reviewer: met
- Every re-scoped phrase sits inside its named heading's bounds in the prompt
  — reviewer: met
- Condition 4 (new pin absent from base) — reviewer: met — reason: no new pin
  is added; existing #787 pins are narrowed
- Removed assertions each keep an equivalent or stricter check — reviewer: met
- A named test must exist (`worker/deno/tests/action_sha_pinning_policy_test.ts`,
  `worker/deno/tests/support/markdown_docs.ts`) — reviewer: met

## Test Plan

- Removed from `worker/deno/tests/action_sha_pinning_policy_test.ts`:
  ``assertEquals(loaded.ok, true, `${family} failed to load`);`` — the
  `latest()` helper that returned `loaded` is gone; `readRepoDoc` throws on a
  missing prompt, so a failed load still fails the test.
- Removed from `worker/deno/tests/action_sha_pinning_policy_test.ts`:
  ``assertEquals( /`stSoftwareAU\/\*` actions and\s+`ghcr\.io\/stsoftwareau\/\*` images may pin to a tag/ .test(audit.text.replace(/\s+/g, " ")), false, "the audit still carries the tag carve-out for stSoftwareAU/* actions", );``
  — same regex and verdict, now `.test(flatWholeFile(audit.text))`; still
  whole-file.
- Removed from `worker/deno/tests/action_sha_pinning_policy_test.ts`:
  `assertEquals( /first-party/i.test(collapsed), false, "the guidelines never used the term and must not gain it", );`
  — `collapsed` is now section-scoped, so the absence check reads the whole
  file as `/first-party/i.test(text)`.
- Every other assertion line is unchanged; only the bindings it reads
  (`collapsed`, `audit.collapsed`, `setup.collapsed`) are now section-scoped.
- `deno task test:unit tests/action_sha_pinning_policy_test.ts`: 6 passed, 0
  failed.
- Red checks (scratch prompt edits, restored afterwards): moving "**Container
  images** are the one carve-out" out of the audit's Definitions, "this check
  is about _who wrote the code a privileged trigger runs_" out of Supply-chain
  hardening, "No owner is exempt" out of the setup prompt's CI Hardening
  Defaults, and "Pin GitHub Actions to commit SHAs" out of the guidelines'
  Dependency Bumps and Supply Chain section each failed its case. The base
  version of the test stayed green under the first mutation.
- Drift pins: `deno task drift-pins-on-base origin/main` reported
  `ALREADY ON BASE` for the sampled pins — expected green on base, because this
  refactor adds no new pinned phrase; it narrows the existing #787 pins.
- `./quality.sh < /dev/null`: exit 0, `Result: PASSED (with skipped checks)` —
  only `config integration` skipped (`deno or .config.json not available`);
  deno tests, lint, type check, fmt, markdownlint and semgrep passed.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
