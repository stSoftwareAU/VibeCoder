## Summary

`worker/deno/tests/action_sha_pinning_policy_test.ts` used to flatten each
prompt with `.replace(/\s+/g, " ")` and pin every phrase against the whole
file, which breaks condition 1 of CODING-STANDARDS.md § Documentation-drift
tests. Each positive pin now reads only the section that states its rule, via
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
  come back in another section. The regex check uses `flatWholeFile` rather
  than a local whitespace regex.
- The issue offered an optional lint against `.replace(/\s+/g, " ")` in
  doc-reading tests. I skipped it to stay in scope. 33 test files under
  `worker/deno/tests` still contain that call, and each would need sorting
  into doc-reading or not before a lint could land. That is separate work.

### Undiscoverable Facts

- `loadPrompt` is a plain `Deno.readTextFile` of `prompts/<name>/prompt.md`, so
  switching to `readRepoDoc` does not change which text is read.

## Evidence

This is a test-only change. No production code or prompt changed.

**Docs sweep**: I grepped for `action_sha_pinning_policy` over `*.md`,
excluding `docs/archive/`, and got no hits. No symbol, flag or documented
behaviour changed, so no docs needed updating. The section is `none`.

## Test Plan

- `deno task test:unit tests/action_sha_pinning_policy_test.ts`: 6 passed, 0
  failed. `deno fmt --check`, `deno lint` and `deno check` on the file are
  clean.
- Red checks: I moved each pinned line out of its section in a scratch edit
  of the prompt, then restored the prompt afterwards.
  - Moving "**Container images** are the one carve-out" out of the audit's
    Definitions failed the image carve-out case. The base-branch version of
    the test stayed **green** under the same mutation, which shows the gap
    the issue describes.
  - Moving "this check is about *who wrote the code a privileged trigger
    runs*" out of Supply-chain hardening failed the check 10 case.
  - Moving "No owner is exempt" out of the setup prompt's CI Hardening
    Defaults failed the no-owner case.
  - Moving "Pin GitHub Actions to commit SHAs" out of the guidelines'
    Dependency Bumps and Supply Chain section failed the guidelines case.
- `deno task drift-pins-on-base origin/main` reported `ALREADY ON BASE` for the
  sampled pins in the audit's Definitions and the setup prompt's CI Hardening
  Defaults. That is expected. This PR adds no rule and no new pinned phrase:
  it narrows the scope of the #787 pins that already existed, so condition 4
  (a new pin must be absent from the base section) does not apply. The red
  checks above show what the narrowing guards.
- Assertions removed or changed (all scope changes; every pinned phrase is
  kept):
  - The `latest()` helper and its `loadPrompt` import were dropped, because
    they produced the whole-file `collapsed` text.
  - `assertStringIncludes(audit.collapsed, "no owner is exempt")` and the
    `for (const { collapsed } of [audit, setup])` loop now pin the same
    phrases against `auditDefinitions` and `setupHardening`.
  - `assertStringIncludes(setup.collapsed, "No owner is exempt")` now pins
    against `setupHardening`.
  - The three image carve-out, two check 13, one check 10 and one guidelines
    `assertStringIncludes(collapsed, …)` calls now pin against their
    sections.
  - `/first-party/i.test(collapsed)` in the guidelines case now tests the raw
    whole file. It is still an absence check.
- `./quality.sh`: see the result line below.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
