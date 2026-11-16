# PR Summary — Issue #5071

## Summary

The pre-PR temp-path self-check in `CODING-STANDARDS.md` (§ Never let a unit
test inherit the host's state) no longer lists "a config placeholder" as an
exempt `/tmp/...` string. The exemption now applies to a string that "never
touches the filesystem once your change is in". The rule also says to judge the
string against the code at the head, not the base: a fixture's
`workDir: "/tmp/work"` that the change starts reading or writing is a hit. The
self-check's scope (new or edited test files) and its test ("actually reads,
writes or lists") are unchanged. Closes #5071.

## Spec

### Intent and Rationale

- Two fleet PRs (#4535, #5059) kept a `/tmp/work` placeholder in a test file
  they edited. Their own change made production code write to that path, and the
  review sent each one back. The parenthetical example decided the case before
  the code could, so the fix rewords the exemption and adds no new check.

### Essential Design Decisions

- The pinned phrase "A `/tmp/...` string that never touches the filesystem" is
  kept, so the existing #3524 pin still holds. One sentence was added to name
  the edge case the issue reports. It gives the same answer as the reworded
  exemption.

### Undiscoverable Facts

- None.

## Evidence

Documentation-only change to a coding standard, with a drift test.

- `CODING-STANDARDS.md:708-712`: the exemption is reworded.
- Restatements checked: a grep for `never touches the filesystem`,
  `escaping payload` and `handed to an in-memory fake` across `prompts/`,
  `.claude/skills/`, `worker/deno/lib/`, `docs/` (excluding archive) and
  `CODING-STANDARDS.md` found the exemption only at this one place.
  `prompts/issue/prompt.md` PR Raising Requirements states the self-check but
  not the exemption, so it needed no change.
- Applying the rule to this PR's own diff: the diff adds no `/tmp/` path to any
  test file.
- Issue numbers this diff cites: #5071 (The temp-path self-check's 'a config
  placeholder' exemption lets fleet PRs keep a /tmp/work fixture their change
  now writes to).

## Test Plan

- `worker/deno/tests/shared_temp_dir_3524_test.ts`, new test
  "CODING-STANDARDS.md temp-path exemption is judged against the code at the
  head, not a config placeholder (Issue #5071)". It pins "never touches the
  filesystem once your change is in" and "Judge it against the code at the head,
  not the base". It also asserts that the section no longer contains "a config
  placeholder".
- Red before the change: with the base branch's `CODING-STANDARDS.md` restored,
  the new test failed with
  `section is missing pin "never touches the
  filesystem once your change is in"`.
  It passes on the head.
- No assertion was removed. The existing #3524 tests and pins are unchanged.
  `worker/deno/tests/os_branch_bypasses_stub_3475_test.ts`, which reads the same
  section, still passes.
- `./quality.sh < /dev/null` on the head: PASSED. The host skipped config
  integration and checkov.

Not done or not checked: no independent reviewers were dispatched, because the
issue has no acceptance-criteria heading. Nothing else was left out.
