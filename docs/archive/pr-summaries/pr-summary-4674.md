## Summary

The babysitter runs a repaired repository's local gate in a credential-denying
macOS sandbox before staging or committing. Chromium can register its browser
services while configured credentials, Keychains, securityd and the clone's
`.git` remain protected. One failed gate gets one agent repair pass and must
pass revalidation before commit. Linux retains its existing agent validation
inside the Codex permissions profile.

Part of #4674. No VERSION change.

## Spec

### Intent and Rationale

Browser checks need Mach service registration that the agent's existing macOS
profile does not allow. A separate runner profile permits only the browser
registration prefixes while retaining the credential boundary from #4593.

### Essential Design Decisions

- Place the .git write and securityd lookup denials after every overlapping
  allow. Disable Git hooks during staging, commit and push as defence in depth.
- Select the platform before inspecting quality.sh. Linux retains agent
  validation even for symlinked, blank or oversized gate scripts; its repair
  prompt explicitly requires applicable local checks and promises no runner gate.
- Start the macOS gate in its own process group. On timeout terminate the group,
  send SIGKILL and destroy inherited output pipes so descendants cannot retain the PR lock indefinitely. Output remains bounded.

- Resolve default and relative CONFIG_PATH against the runner's working
  directory before constructing protected paths.
- Require quality.sh to be a regular, non-symlink file directly in the canonical
  repository root. Cap its metadata size and actual read at 64 KiB. Open with
  O_NOFOLLOW and O_NONBLOCK and verify device/inode identity, so a background
  process cannot substitute a symlink or block the privileged reader on a FIFO.
- Run the macOS gate with a token-free allowlisted environment and scratch HOME,
  TMPDIR and DENO_DIR. Protect the selected App key and its canonical target.
  Store the sandbox policy outside both agent and gate write grants.
- Recheck HEAD after a successful, ready retry before revalidation or commit.
  Lock loss, a changed HEAD, agent failure and an invalid response prevent
  staging, commit and push.
- Preserve Linux repairs through the existing agent validation path. Do not run
  repository code in the privileged Linux runner.
- Keep the live Chromium/Keychain case in the explicit `deno task test:browser`
  host integration task. Its macOS, Chromium and system-service prerequisites
  fail loudly; ordinary unit discovery requires no browser. This is a dedicated
  macOS host integration task rather than the Linux script-integration manifest:
  substituting a command double cannot prove Chromium and Keychain isolation.

### Undiscoverable Facts

- CI pins Deno 2.9.8. The host default was 2.9.5 and its full parallel gate
  panicked inside Deno's test-permission restoration. Verification uses a
  checksum-verified temporary Deno 2.9.8.
- The retry-body fixture expected an obsolete API update. Production uses
  `gh pr edit --body-file`; the fixture now models that supported command and
  asserts that the applied description preserves the closing reference.
- Gitleaks scans every commit in the PR range. Two historical findings were the
  counting-digits synthetic PAT in the redaction input and assertion. An exact
  value/context exception clears only those fixtures; the current test builds
  its token at runtime. The original config reproduces two findings and the
  updated config reports none.
- The sweep top-up now records the merge-base on main, rather than a feature
  commit that cannot survive squash-merge.

## Evidence

- Focused babysitter suites passed: 98 tests, no failures or ignored cases.
  The live browser test is in `worker/deno/integration/fleet_babysitter_browser.ts`,
  outside unit discovery. The body-proposal test observes `body-updated` and
  asserts the applied description, including its closing reference.
- The exact sweep-drift command from CI passed after reproducing its ancestry
  failure locally.
- Gitleaks 8.24.3 passed with CI's flags and exact historical commit range.
- Removing config resolution made both default/relative CLI tests fail.
  Reversing the retry HEAD comparison made the new real-CLI regression fail.
  Negating the unavailable-capability condition also made its CLI test fail;
  the two restored guards then passed together.
  Restoring the old validation implementation made the symlink, oversized-file
  and directory rejection cases fail. Every temporary mutation was restored.
- The new CLI HEAD case starts with a matching HEAD, completes a ready retry,
  changes HEAD only after that retry, and observes no second gate, staging,
  commit or push.
- Ran `deno task test:browser` with CHROMIUM_PATH pointing to the installed
  Google Chrome binary. Nested Seatbelt execution is refused by this host:
  `sandbox-exec: sandbox_apply: Operation not permitted`. No successful browser
  or OS-level credential denial is claimed.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — “Browser checks named by the target repository's gate run during
  a babysitter repair without weakening the credential boundary from #4593.” —
  The macOS runner owns validation, preserves credential denials and retries
  once before commit. Self-contained unit/CLI coverage passes. The retained
  live integration task cannot start its nested sandbox in this agent host;
  OS-level Chromium and credential isolation evidence remains outstanding.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — capsec-file-bounds: canonical root, regular file, symlink refusal,
  bounded size/read, nonblocking no-follow open and file identity checks.
- **clean** — No dependencies, single-implementation abstractions, copied
  scanners or hand-written replacements for available filesystem/path APIs.
  Runtime standard-library filesystem flags close the privileged-read race.
- **clean** — Updated the operator manual, SECURITY.md and threat model together.
  No second implementation of the changed validation rule was found.
- `worker/deno/commands/fleet_pr_babysitter.ts:928` exempt (untestable):
  replacing `scratch: repairScratch` with shorthand `scratch` is equivalent:
  repairScratch is assigned directly from scratch and neither changes during
  validation. This is the notice's original line 921. Deleting the property is
  separately covered by the isolated scratch/context assertions.
- The body-proposal test's old PR_BASE_CHANGE_REFUSED assertion described an
  obsolete command that production no longer issues. Its replacement asserts
  successful application and the exact closing reference. Existing base-change
  guard tests remain intact. The live browser assertions moved intact to the
  explicit integration task.

## Test Plan

- `deno task test tests/fleet_babysitter_repair_test.ts tests/fleet_babysitter_validation_test.ts tests/fleet_pr_babysitter_test.ts tests/fleet_babysitter_app_test.ts < /dev/null`
  — 98 passed, zero failed or ignored. The gate-style `deno task test:unit`
  invocation also passed all 98 tests and its time-budget check. Includes ordering, planted hook,
  Linux script shapes, platform prompts and inherited-pipe timeout regressions.
- Targeted `deno lint`, frozen/locked `deno check` and repository-wide
  `deno fmt --check` passed. Manifest/completeness, source-target, Mermaid,
  Markdown, workflow and spawn-boundary checks passed through quality.sh.
- `./quality.sh --sequential < /dev/null` — full tests stopped at a Deno 2.9.5
  runtime panic (`pledge test permissions called before restoring previous
  pledge`). The serial pass therefore did not run. The unchanged release-tag
  ruleset check cannot read the sandbox-protected GitHub config. These are host
  differences: the current base commit 6de3b9345aadfb1cb9fee49d82e8ab9e8146782a
  came from PR #4714, whose Quality gate and all four test shards passed,
  confirmed with gh. No full local suite pass is claimed.
- Semgrep skipped because its local route could not run; pinned Checkov was
  unavailable and operator config integration was absent. CI remains
  authoritative for those checks.
- `CHROMIUM_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome deno task test:browser`
  — attempted, refused by nested sandbox policy with `sandbox_apply: Operation
  not permitted`. Browser and Keychain evidence remains partial.
- Existing assertions remain intact. The macOS prompt cases explicitly select
  Darwin on every host; Linux cases require agent local validation for CI,
  review and conflict repairs. The body-proposal test asserts the applied body
  and its preserved closing reference.
- Searched for twinned validation/prompt rules: no second production validation
  implementation was found. Updated the operator manual alongside this summary.
- `worker/deno/commands/fleet_pr_babysitter.ts:928` equivalent scratch shorthand
  exemption remains as recorded above; scratch is the same immutable value.

PR-summary checks with the issue body and work-on label passed: zero blocked
or unchecked gates. The output-bound test now exercises the actual isolated
subprocess collector, retaining its exact 20,000-character assertions.

Merge-conflict repair: combined the base CI-repair scope and applicable local-gate
instructions with the platform-aware runner/browser guidance. Linux continues
to validate locally, and macOS retains runner validation.
