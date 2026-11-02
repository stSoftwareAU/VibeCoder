## Summary

Merge conflict repair: retain the base branch's mirror-based clone API and its
clone tests, while creating the Linux validation fixture in the local repair
clone and preserving the platform-specific prompt tests.

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

- Permit named logging, notification, font, WindowServer and sysmond Mach lookups,
  plus lookup and registration of the browser rendezvous/Crashpad name
  prefixes (a child looks up the rendezvous server its parent registers); no
  unconditional Mach lookup grant or container/file-service grant is
  present. The list is reasoned from Chromium's behaviour and is not yet
  measured on macOS.
- Probe sandbox startup with fixed /usr/bin/true before any agent session
  (`checkBabysitterValidationCapability`, run once the clone exists and skipped
  when the clone has no quality.sh). An unavailable result skips the PR with no
  attempt record and no agent session, so a `--watch` pass cannot start a
  session every cycle. The same probe inside validation remains a backstop: a
  nonzero probe there is unavailable, gets no agent retry, and clears the
  attempt.
- Preserve explicit browser cache variables. An unset Playwright, Cypress or
  Puppeteer cache defaults to a fresh directory under scratch (inside the
  gate's write grant) holding links to the host's installed builds, so the gate
  reuses them and can still run an installer; installer state (dot entries)
  is not mirrored.
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

- Focused babysitter suites passed: 122 tests, no failures or ignored cases.
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
  — run as `deno task test:unit` with the same four files: 122 passed, zero
  failed or ignored. Includes ordering, planted hook,
  Linux script shapes, platform prompts, sandbox-apply failure and inherited-pipe
  timeout regressions. Timeout coverage injects spawn and signal functions: no
  real process-group signal runs in the unit suite. It asserts -pid/SIGKILL,
  destruction of both never-ending pipes, unref and exit 124.
- Targeted `deno lint`, frozen/locked `deno check` and repository-wide
  `deno fmt --check` passed. Manifest/completeness, source-target, Mermaid,
  Markdown, workflow and spawn-boundary checks passed through quality.sh.
- `./quality.sh --sequential < /dev/null` — full tests stopped at a Deno 2.9.5
  runtime panic (`pledge test permissions called before restoring previous
  pledge`). The serial pass therefore did not run. The unchanged release-tag
  ruleset check cannot read the sandbox-protected GitHub config. These are host
  differences: the current base commit 9afa408d5a30e545831964d2b7563eab2a1c2417
  came from PR #4718, whose Quality gate and all four test shards passed,
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

CI repair: the loop recovery integration fixture uses fabricated PIDs outside the
host PID range, preventing a real probe PID from being mistaken for a VM signal.
The existing client-signal and untouched-VM assertions remain in place; all
seven scenarios passed locally, as did targeted Deno formatting and lint.
The full integration command encountered sandbox-denied system temporary files
in unrelated fixtures and was stopped; the base PR's integration job passed
696 tests. The local quality gate passed formatting, lint, type checking,
Markdown and completeness, but Deno 2.9.0 panicked in its parallel test
runner, Semgrep and Checkov timed out, and the release-tag check could not read
the sandbox-protected GitHub configuration.

Review repair for PR #4716:

- The Mach grant is a fixed named allowlist with no unconditional lookup, plus
  lookup and registration for the four browser name prefixes. A unit test
  rejects any lookup rule that is not a named or browser-prefix rule and
  requires each prefix; SECURITY.md, C37 and the operator manual describe it.
  The integration task has a native bootstrap lookup probe for cfprefsd.agent
  with an unsandboxed positive control. None of this has run on macOS.
- The sandbox startup probe runs before any agent session. The probe-failure
  CLI test runs two passes over the same head and observes no agent event, no
  attempt record and no staging, commit or push. With the pre-agent check
  removed, the same test failed because each pass started `agent-1`.
- Default browser caches are scratch directories linking the host's installed
  builds. A unit test checks that each default is inside the scratch grant,
  resolves the host build (Puppeteer one level deeper), does not mirror
  installer state and tolerates the installer creating its own lock; another
  test shows an operator-set value is unchanged.
- The macOS repair prompt again says a check the Codex sandbox cannot run
  (CI-only, or covered by the runner's quality.sh) does not by itself withhold
  BABYSITTER_READY when the rest of the fix is complete. The test for all
  three repair kinds asserts it for the first prompt and a runner-failure retry
  prompt, next to the runner-ownership assertions; Linux keeps its own.
- Timeout coverage uses injected spawn/signal seams, with exact group target
  and destroyed-stream assertions.
- Remaining and unverified: `deno task test:browser` has not passed on macOS;
  this host refuses nested `sandbox-exec` with `sandbox_apply: Operation not
  permitted`, so neither Chromium, the Mach list nor OS-level credential and
  Mach denials are verified. The acceptance criterion stays partial and the
  description carries no closing reference, so merging leaves #4674 open.

Regression red checks: removing the pre-agent capability check failed the
two-pass probe CLI test; the earlier mutations (wildcard Mach lookup, browser
cache defaults, deleted in-validation probe, positive instead of negative group
PID) each failed their targeted test and were restored. Final formatting,
lint and type checking passed; `deno task test:unit` over the four babysitter
suites passed 122 tests.

The installed-browser-cache section of the operator manual now also describes
the writable scratch defaults, links to host builds and preserved explicit
values, consistent with the earlier overview.

Review repair for PR #4716 (signal permission and current-base fixtures):

- Added `(allow signal (target same-sandbox))`, allowing gate code to stop its
  own children without granting signals to other host processes. The unit
  regression fails when this grant is removed. Security documentation and C37
  describe the same grant; no second production profile builder was found.
- The live integration gate now terminates and reaps a background child and
  probes POSIX semaphores, shared memory and pseudo-terminals. No extra IPC or
  terminal grants were added without measurements. This host again refused
  sandbox startup with `sandbox_apply: Operation not permitted`; Chromium,
  resource probes, Mach allowlist and OS-level credential denials remain
  unverified. Acceptance remains partial and #4674 remains open.
- Followed the current base's mirror-cache behaviour: the offline command
  fixture accepts the exact synchronous maintenance argv, and attempt-record
  assertions count files rather than the new `mirrors` directory. Existing
  commit, retry, lock, attempt and no-agent assertions remain intact. This fixes
  the 11 failures in CI job 125325315544 rather than reverting base behaviour.
- Four focused babysitter suites passed: 122 tests, zero failures. Repository
  Deno formatting, targeted lint and frozen/locked type checking passed.

Additional host evidence: the native resource probe compiles with Apple clang;
its unsandboxed shared-memory creation is refused by this agent host too.
The explicit browser task remains blocked before its gate starts. Manifest
checks passed (847 tests, one existing ignored case). The archive freshness
check passes on the current committed history; the babysitter will commit
this updated summary with the repair.

Final local gate (`./quality.sh --sequential < /dev/null`): repository-wide
formatting, lint and type checking passed, as did Markdown, Mermaid,
completeness and structural checks. Full tests aborted inside Deno 2.9.5 with
`pledge test permissions called before restoring previous pledge`; the serial
pass did not run. The release-tag check cannot read the sandbox-protected gh
configuration. Semgrep and Checkov are unavailable locally, and operator config
integration is absent. Confirmed with gh that base PR #4718 passed its quality,
four test shards, Semgrep and Checkov jobs. These host limits do not change the
122-test focused pass or claim a full local gate pass.

Review repair for PR #4716 (process inspection and gate descendants):

- Replaced unrestricted process and sysctl rules with separate execution/fork
  grants, same-sandbox process inspection, and exact hardware/OS sysctl names.
  Existing same-sandbox signal and restricted Mach rules remain intact.
- The runner stops the gate process group after success, failure and timeout,
  before waiting for inherited pipes. Injected-signal tests cover successful
  and failed exits with open descendant pipes; existing timeout coverage stays.
- Allowed POSIX semaphore/shared-memory operations and pseudo-terminals,
  including the terminal device writes needed by the existing native resource
  probe. SECURITY.md, C37 and the operator manual describe the actual grants
  and the host-wide POSIX IPC namespace residual risk.
- Added a native process-environment probe with a same-user marker holder,
  an explicit readiness handshake and an unsandboxed positive control.
  The native helper compiled and its positive control returned zero on this
  host. Inside the runner, the gate requires a permission denial when reading
  that holder's environment; a missing marker alone does not pass.
- All three added unit regressions failed before the implementation change.
  The four focused babysitter suites pass 125 tests, with none ignored.
  Existing assertions remain intact; the bounded-output test injects its
  signal function so it never sends a real process-group signal.
- The live browser task was attempted again and fails at the initial fixed
  sandbox startup probe: sandbox_apply: Operation not permitted. Chromium,
  IPC/terminal grants and OS-level credential/Mach/process denials remain
  unverified. Acceptance stays partial and #4674 must remain open.
- Local quality gate: repository formatting, lint, Markdown, Mermaid and
  completeness passed. Deno 2.9.5 panicked restoring test permissions in the
  full parallel suite; the serial pass could not run. The release-tag ruleset
  check cannot read sandbox-protected gh configuration. Semgrep and pinned
  Checkov are unavailable, and operator configuration integration is absent.
  Base PR #4730 has passing quality, all four test shards, integration,
  Semgrep and Checkov checks, confirmed with gh.
- The gate exposed a type error in the new spawn double; its cast was fixed
  and the repository-wide frozen/locked type check passed on rerun.
  Final repository lint and formatting passed; Markdown checked 242 files.
  Manifest checks passed 847 tests with one existing ignored case.
- No second production profile builder was found. The current base's mirror
  clone API and its fixtures remain in use. A complete proposed PR description
  is supplied in .babysitter-pr-body for the babysitter to apply; it has no
  closing reference to the still-partial issue.

Review repair: the macOS profile permits the named hostname, architecture,
active CPU, product version and translation sysctls, and terminal-device ioctls.
The host integration gate now exercises uname and hostname alongside its existing
pseudo-terminal probe. The profile unit regression covers the added grants.
Live sandbox enforcement remains unverified when nested sandbox startup is refused;
the acceptance criterion remains partial.

Validation for this repair: 37 focused tests passed; repository formatting,
lint and frozen type checking passed. The full unit run hit Deno 2.9.0’s
permission-restoration panic; base PR #4730 passed all four CI test shards.
The live browser task was attempted and sandbox startup was refused with
`sandbox_apply: Operation not permitted`. The release-tag check could not read
the protected gh config; Semgrep and the pinned Checkov were unavailable.

Review repair for PR #4716: the macOS validation profile now permits the
exact CPU brand, model, argument-limit and semaphore-limit sysctls needed by
Node CPU detection, xargs and Python process pools. The integration gate
checks xargs and non-empty Node-compatible CPU detection; process inspection
remains scoped and kern.procargs2 remains excluded. The unit regression failed
before the four named grants were added. Live sandbox enforcement still requires
a host that permits sandbox-exec.

Repository Deno formatting, lint and frozen type checking passed, as did all
37 validation unit tests. The browser integration task was attempted with
installed Chrome but sandbox startup failed with `sandbox_apply: Operation not
permitted`; live grants and security denials remain unverified.

Review repair: permit the per-PID and process-group sysctl prefixes and the
sysmond Mach lookup so macOS gates can run `ps` and `pgrep`. Sysmond can reveal
other processes' arguments; SECURITY.md, C37 and the operator manual record the
residual risk and prohibit credentials in arguments. The integration gate checks
the parent PID and finds its own child. The unit regression requires exactly the
two prefixes and still rejects blanket sysctl reads and `kern.procargs2`.
The browser integration attempt remains blocked by this host's nested sandbox
refusal, so the new grants and earlier OS-level probes remain unverified.

Review repair (command-line reads): decided that `kern.procargs2` stays denied
because it also returns environments, so a gate that reads `ps -o command=`
(VibeCoder's `loop_supervisor_test.ts`) cannot pass in the runner and its repair
fails closed, discarded after the single retry. SECURITY.md, C37 and the
operator manual say so. The integration gate runs `ps -o command= -p` on a gate
child and logs the printed text; it has not run on macOS because sandbox
startup is still refused here.

Merge conflict repair for PR #4716: preserve absolute resolution of the selected
configuration path and use the base branch deployment-publishing loader for each
babysitter pass. Both deployment heartbeats and protected-path validation retain
the selected configuration.

Merge conflict repair: preserve both historical gitleaks fixture exemptions and
the base credential-logging instruction, while retaining the platform-specific
runner validation prompts and both prompt regression tests.
