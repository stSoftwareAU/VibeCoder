## Summary

The babysitter runs a repaired repository's local gate in a credential-denying
macOS sandbox before staging or committing. Chromium can register its browser
services while configured credentials, Keychains, securityd and the clone's
`.git` remain protected. One failed gate gets one agent repair pass and must
pass revalidation before commit. Linux retains its existing agent validation
inside the Codex permissions profile.

Closes #4674. No VERSION change.

## Spec

### Intent and Rationale

Browser checks need Mach service registration that the agent's existing macOS
profile does not allow. A separate runner profile permits only the browser
registration prefixes while retaining the credential boundary from #4593.

### Essential Design Decisions

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

- Focused babysitter suites passed: 89 tests, no failures or ignored cases.
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
- Browser integration cannot run on this host because CHROMIUM_PATH is unset.
  Its explicit task reports that prerequisite as a failure.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — “Browser checks named by the target repository's gate run during
  a babysitter repair without weakening the credential boundary from #4593.” —
  The macOS runner owns validation, preserves credential denials and retries
  once before commit. Self-contained unit/CLI coverage passes. The retained
  live integration task requires a provisioned macOS Chromium host.

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

- Run `deno task test tests/fleet_babysitter_repair_test.ts tests/fleet_babysitter_validation_test.ts tests/fleet_pr_babysitter_test.ts tests/fleet_babysitter_app_test.ts`.
- Run `deno task test:browser < /dev/null` on a provisioned macOS Chromium host.
- Run `./quality.sh --sequential < /dev/null` with pinned Deno 2.9.8.
- CI's exact shard command, `.github/scripts/deno-test-shard.sh 3 4`, cannot
  start on this host because setsid is missing. CI runs that command on Linux.

- Pinned-Deno full gate: repository checks, completeness, source targets,
  Mermaid, markdownlint, lint, type-check and formatting passed. The full unit
  parallel pass exceeded the 30-minute host deadline with one worker, so its
  serial pass did not run. A four-worker retry stalled at 3,638 completion
  markers and was stopped through the managed session. No full-suite pass is
  claimed; the 89 focused tests and two restored-guard checks passed.
- The base commit, 81c25ff92d6781d1ae8ac9fc5f4c2f7c0a6e63a4, came from
  [PR #4711](https://github.com/stSoftwareAU/VibeCoder/pull/4711).
  Confirmed with gh that its Quality gate and all four test shards passed.
- Other host limits: release-tag ruleset reconciliation cannot read the
  sandbox-protected GitHub config; config integration has no operator config;
  Semgrep and pinned Checkov are unavailable. Browser integration requires
  CHROMIUM_PATH, and the exact CI shard command requires setsid.
- PR-summary checks with the issue body and work-on label passed with zero
  blocked or unchecked gates. Temporary mutations were restored, and
  git diff --check passed.
