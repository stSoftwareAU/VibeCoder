## Summary

Added guidance requiring a test that stubs a tool, binary or measurement to
neutralise OS-specific branches in the script under test, so a macOS-only
branch cannot bypass the stub. The rule extends the host-state section of
`CODING-STANDARDS.md` and the Bugs/Enhancements stub bullet of
`prompts/issue/prompt.md`, and a documentation-drift test pins both. Closes
#3475.

## Spec

### Intent and Rationale

- Two private fleet PRs shipped tests whose stub was bypassed by a macOS-only
  branch — a `PATH` prepend running the host's real binary, a `df` figure
  replaced by the free space AppleScript reports — green on Linux CI and red
  in `./quality.sh` on macOS hosts. Linux CI can never exercise a branch only
  macOS takes, so the fix is guidance: the test author must read the script
  for OS branches and neutralise each one.

### Essential Design Decisions

- The rule lives in the existing "Never let a unit test inherit the host's
  state" section rather than a new one, because an OS-specific branch is host
  inheritance: the test reads the host's platform instead of the stub.
- `prompts/issue/prompt.md` states the requirement in the Bugs/Enhancements
  stub bullet and cross-references the CODING-STANDARDS section, so the rule
  is written once and the prompt points at it rather than duplicating it.

### Undiscoverable Facts

- The two triggering PRs live in private fleet repos and are not linked from
  this repo; the issue body's evidence table is the only record of them.
- The optional pre-PR self-review flag (flag a new/edited test whose stubbed
  script sources an OS marker with no override) was not implemented — the
  issue marks it "optionally".
- The branch carries a worker-written handover note
  (`docs/archive/handover/issue-3475.md`) from an interrupted run; it is a
  checkpoint record, not part of the guidance change.

## Evidence

The change is guidance plus a documentation-drift test; no UI or performance
surface.

**Docs sweep** — grep: `OSTYPE`, `uname`, `darwin`, `osascript`, `sw_vers`,
`diskutil`, `homebrew`, "inherit the host"; section:
`CODING-STANDARDS.md#never-let-a-unit-test-inherit-the-hosts-state`;
siblings: none — no existing set gained a member; updated:
`CODING-STANDARDS.md`, `prompts/issue/prompt.md`;
`docs/CONTAINER-IMAGE.md:154`, `docs/CONTAINER.md:1002,1023`,
`docs/DEPLOYMENT.md:569,620`, `docs/TROUBLESHOOTING.md:245,560` — still true
because they describe the container/deployment platform, not the test-stub
rule

## Test Plan

- `worker/deno/tests/os_branch_bypasses_stub_3475_test.ts` — two
  documentation-drift tests; `deno test` on the file passed (2 passed,
  0 failed).
- Drift pins verified against the base with
  `deno task drift-pins-on-base origin/main …` for both documents: all nine
  pinned phrases reported `absent on base`.
- `./quality.sh < /dev/null` — PASSED (with skipped checks: `config
  integration` SKIPPED).

**Branch outcomes:** none added — the diff adds no conditional branch.
