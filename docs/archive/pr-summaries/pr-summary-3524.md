## Summary

Fleet tests treated the shared system temp directory as their own: one wrote
to a fixed file under `/tmp`, and another asserted on what `$TMPDIR` contained.
Both broke when another test, lane or OS user used the same directory. This PR
changes two pieces of guidance:

- `CODING-STANDARDS.md` → **Never let a unit test inherit the host's state**
  now names `/tmp` and `$TMPDIR` as shared host state and states the rule.
- `prompts/issue/prompt.md` → **PR Raising Requirements → Bugs/Enhancements**
  now tells the agent to check, before raising the PR, whether a new or edited
  test uses a fixed shared temp path or reads that directory's listing.

A new drift test pins both. Closes #3524.

## Spec

### Intent and Rationale

- The existing host-state rule gave environment variables, work directories
  and module caches as its examples, but said nothing about the temp directory.
  Neither cited PR applied the rule there, so the rule now names the temp
  directory as host state.
- The guidance is the proposed text from the issue. Its worked example is the
  seam that already exists: `computeWorkingTreeDigest(repoRoot, tempRoot?)` in
  `worker/deno/lib/quality_gate_cache.ts`.

### Essential Design Decisions

- The new paragraph goes before the OS-specific-branch paragraph, not at the
  end of the section. The **Shell code a test runs must behave the same on
  macOS** section points at "The last paragraph of **Never let a unit test
  inherit the host's state**", and that pointer must stay true.
- In the prompt, the sentence is inserted without rewrapping the rest of the
  bullet, so the diff touches only the one line it joins.
- The optional guardrail from the issue (a grep of new or edited test files
  for `/tmp/` and for `TMPDIR` used outside a temp-dir call) is written as a
  self-check step in `CODING-STANDARDS.md`. It is not a new automated gate.

### Undiscoverable Facts

- The test cited from VibeCoder#3522 has already been fixed at the head.
  `worker/deno/tests/quality_gate_cache_test.ts::computeWorkingTreeDigest -
  leaves nothing behind in the temp root it is given` lists a private
  `Deno.makeTempDir` root that it passes as `tempRoot`. No code change was
  needed here.

## Evidence

Documentation and prompt change only, with no runtime code. It is guarded by
`worker/deno/tests/shared_temp_dir_3524_test.ts`.

**Docs sweep** — grep: "inherit the host's state", "The same rule covers",
"temp-root", "shared temp"; section:
`CODING-STANDARDS.md#never-let-a-unit-test-inherit-the-hosts-state`; siblings:
"process-global caches", "OS-specific branch"; updated: `CODING-STANDARDS.md`,
`prompts/issue/prompt.md`; `CODING-STANDARDS.md:451` — still true because the
new paragraph sits before the OS-branch paragraph, so that paragraph is still
the section's last; `prompts/best_practices/buckets/general.md:389` — still
true because it already flags "a fixed shared temp path" and prescribes a
directory handed in by the caller, which agrees with the new rule;
`prompts/issue/prompt.md:1047` — still true because it is the existing
OS-branch cross-reference, which this change does not touch.

Related existing rules checked for agreement:

- `CODING-STANDARDS.md` **Never let a unit test inherit the host's state**:
  extended.
- **Shell code a test runs must behave the same on macOS**: its "last
  paragraph" pointer is kept true.
- `prompts/best_practices/buckets/general.md` item 16, **Unit tests are
  parallel-safe**: agrees.
- `prompts/test_audit/prompt.md`, "a value inside a temporary directory the
  test created" is silent: agrees.

None of them conflicts.

Applied the new rule to this PR's own diff. The only test it adds,
`shared_temp_dir_3524_test.ts`, reads repository docs through `readRepoDoc`.
It uses no `/tmp` path and never reads `TMPDIR`. Nothing found.

Provenance numbers the diff adds: #3524 — Fleet tests treat the shared system
temp directory as their own: fixed /tmp paths and assertions on TMPDIR's
contents go red when another test, lane or user touches it (VibeCoder#3522 and
a private fleet PR).

## Test Plan

- Added `worker/deno/tests/shared_temp_dir_3524_test.ts`, with two drift tests:
  - the `CODING-STANDARDS.md` host-state section;
  - the issue prompt's **PR Raising Requirements** section.
- Red check: with the edits to `CODING-STANDARDS.md` and
  `prompts/issue/prompt.md` reverted, both tests failed. Test 1 reported
  ``section is missing pin "`/tmp` and `$TMPDIR` are shared host state"``.
  Test 2 reported ``section is missing pin "uses a fixed path under `/tmp` or
  `$TMPDIR`, or reads that directory's listing"``.
- `deno task drift-pins-on-base origin/main …` reported every pinned phrase
  (5 in `CODING-STANDARDS.md`, 3 in `prompts/issue/prompt.md`) as
  "absent on base" for its section.
- `deno task test:unit tests/shared_temp_dir_3524_test.ts
  tests/os_branch_bypasses_stub_3475_test.ts tests/gnu_only_shell_3504_test.ts`:
  7 passed, 0 failed.
- The 129 test files that reference `CODING-STANDARDS.md` or
  `prompts/issue/prompt.md` passed. That run used an earlier rewrapped version
  of the prompt edit; the final prompt edit is a strict subset of the same
  words.
- `./quality.sh < /dev/null` on the guidance commit: `Result: PASSED (with
  skipped checks)`. Only `config integration` was skipped; every deno, lint,
  markdownlint and semgrep stage passed.
- No existing test was edited and no assertion was removed.

Branch outcomes: none added
