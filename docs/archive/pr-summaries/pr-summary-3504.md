## Summary

Fleet PRs kept shipping shell code that assumes GNU/Linux. It passed Linux CI
and then failed `./quality.sh` on macOS fleet hosts: a raw `mktemp -d` path
compared with a `pwd -P` path, and GNU `date +%N` arithmetic. This PR adds the
guidance the issue asks for, on three surfaces:

- `CODING-STANDARDS.md` has a new subsection, **Shell code a test runs must
  behave the same on macOS**, directly after **Never let a unit test inherit
  the host's state**. It explains why Linux CI is not proof, then gives the
  rules:
  - avoid each GNU-only form or give it a portable fallback (the issue's full
    list);
  - resolve both sides of a path comparison the same way;
  - grep the shell files a new or edited test runs for those forms before
    raising the PR.
- The `prompts/issue/prompt.md` **PR Raising Requirements → Bugs/Enhancements**
  bullet gains a one-sentence pre-PR portability check that links to the new
  subsection.
- The `prompts/coding_guidelines/prompt.md` **GNU vs BSD tools** bullet now says
  shell code a test runs needs a portable fallback. Before, it only said to
  "Document the dependency", which would still break macOS hosts.

Closes #3504.

## Spec

### Intent and Rationale

- The #3475 rule tells authors to grep for OS branches (`OSTYPE`, `darwin`).
  The cases in this issue have no OS branch, so that grep misses them. This
  change adds a separate, listable check for GNU-only forms.
- Optional guardrails 2 and 3 from the issue are not in this PR: a lint in the
  quality gate, and a `macos-latest` CI runner. Guardrail 1, the pre-PR grep, is
  in this PR as the subsection's **Check before you raise the PR** bullet.

### Essential Design Decisions

- The new rule sits in its own `###` subsection. A drift test can then scope
  its pins to that subsection, and the issue prompt can link to it by name.
- The coding-guidelines bullet keeps "Document the dependency" for GNU flags in
  general, and adds the fallback requirement only for shell code a test runs.
  That is the scope the issue covers.

### Undiscoverable Facts

- The first wording, "fleet hosts run the quality gate on macOS too", tripped
  the Issue #1138 check in `worker/deno/lib/prompt_gate_instruction_check.ts`
  (`RUN_GATE_RE`), which forbids a prompt from ordering the gate. It was
  reworded to "macOS fleet hosts run the same tests too".

## Evidence

This change touches docs and prompts only, plus one drift test. No UI.

- `worker/deno/tests/gnu_only_shell_3504_test.ts` pins the new text in each of
  the three surfaces.
- Issue numbers in the diff:
  - #3504: Fleet shell code assumes GNU/Linux userland and paths: green on
    Linux CI, red in quality.sh on macOS hosts (two private fleet PRs).
  - #3475: Fleet shell tests stub a tool, but a macOS-only branch in the script
    under test bypasses the stub: green on Linux CI, red in quality.sh on macOS
    hosts (two private fleet PRs). Named only as the sibling rule; it was
    already cited at the base.
- Related existing rules checked:
  - `CODING-STANDARDS.md` **Never let a unit test inherit the host's state**
    (the #3475 OS-branch paragraph). The two agree, and the new subsection
    names it as the case it does not cover.
  - The `prompts/coding_guidelines/prompt.md` **Cross-Platform Bash
    Compatibility** bullets on `timeout` and "GNU vs BSD tools". The second
    one is changed in this diff so the two rules do not disagree.
  - The **Bugs/Enhancements** OS-branch sentence in `prompts/issue/prompt.md`.
    It is kept, and the new sentence follows it.
  - The Issue #1138 rule against ordering the gate. The wording was changed to
    comply.
- I applied the new rule to this PR's own diff. The diff adds no shell code,
  and its only test is a Deno drift test that runs no shell, so nothing was
  flagged.

**Docs sweep** — grep: "GNU vs BSD", "Document the dependency", "Never let a
unit test inherit the host", "bash 3.2", "BSD"; section:
`CODING-STANDARDS.md#never-let-a-unit-test-inherit-the-hosts-state`; siblings:
none — no existing set gained a member; updated: `CODING-STANDARDS.md`,
`prompts/issue/prompt.md`, `prompts/coding_guidelines/prompt.md`;
`prompts/coding_guidelines/prompt.md:1192` — still true because it only states
that the project must run on macOS (bash 3.2), Ubuntu and AWS Linux.

## Test Plan

- Added `worker/deno/tests/gnu_only_shell_3504_test.ts`, a documentation-drift
  test with three cases. I ran
  `deno task drift-pins-on-base origin/main <doc> <section> <pins>`:
  - `CODING-STANDARDS.md` § "Shell code a test runs must behave the same on
    macOS": the section does not exist on base, and the tool reported
    `absent on base`.
  - `prompts/issue/prompt.md` § "PR Raising Requirements": all three pins
    reported `absent on base`.
  - `prompts/coding_guidelines/prompt.md` § "Cross-Platform Bash
    Compatibility": "give any GNU-only form in shell code a test runs a
    portable fallback" reported `absent on base`. I checked the reworded pin
    "macOS fleet hosts run the same tests too" with a red-check instead:
    restoring the base bullet turned case c red.
- Red-check: for each of the three docs, I restored the base version on its own
  and ran the new test. Only that doc's case went red each time, and all three
  passed again once the edits were restored.
- `deno test -A tests/gnu_only_shell_3504_test.ts
  tests/prompt_gate_instruction_check_test.ts` from `worker/deno` gave
  `ok | 18 passed | 0 failed`.
- `tests/os_branch_bypasses_stub_3475_test.ts`,
  `tests/observe_real_tool_3082_test.ts`,
  `tests/coding_guidelines_layers_2574_test.ts` and
  `tests/coding_guidelines_twin_drift_test.ts` also pass on the reflowed text.
- No existing test was edited, and no assertion was removed.
- `./quality.sh < /dev/null` on the head before this summary was added:
  `Result: PASSED (with skipped checks)`. Every stage passed except `config
  integration`, which the gate reports as SKIPPED.

**Branch outcomes:** none added
