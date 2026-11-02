## Summary

The babysitter runner executes the target repository's `quality.sh` before
staging a repair. Its separate macOS sandbox permits Chromium Mach lookup and
scoped browser service registration while denying configured credentials,
Keychains, `securityd` and writes to `.git`. Failed validation gets one agent
repair pass and must pass revalidation before commit. The Codex agent profile
remains unchanged.

The runner protects the actual selected babysitter App key, including custom
paths and symlink targets. Its sandbox policy is created outside agent-writable
clone/scratch directories and removed after validation, preventing a planted
scratch symlink from overwriting a credential.

Part of #4674. Version bump: no `VERSION` change.

## Spec

### Intent and Rationale

- The Codex seatbelt profile prevents Chromium registering its Mach services.
  Runner-owned validation lets the repository gate decide readiness while
  retaining the agent's existing credential restrictions.
- Mach lookup alone does not authorise Chromium's `bootstrap_check_in`.
  Registration is restricted to Chromium/Chrome rendezvous and Crashpad
  prefixes; the runner still denies `securityd`.

### Essential Design Decisions

- Validation uses scratch `HOME`, `TMPDIR` and `DENO_DIR`, an allowlisted
  environment and the shared canonical credential-path resolver. The actual App
  key is forwarded from the runner's existing App configuration.
- One failed gate is returned as bounded, redacted, fenced diagnostics for
  repair, then revalidated. Missing sandbox capability prevents commit and
  clears the attempt record; absent `quality.sh` is reported as no local gate.
- The policy lives in a fresh runner-owned directory outside the agent's write
  grants. The gate cannot access that directory; cleanup runs on success and
  failure.
- Outbound network and reads of other host files remain permitted. Browser
  service names are visible in the login session's bootstrap namespace; these
  residuals are documented in the security model.

### Undiscoverable Facts

- This execution environment is Linux and has no macOS sandbox executor. The
  real macOS Chromium/Seatbelt test was not run; offline command doubles do not
  establish OS-level credential denial or successful browser startup.
- The independent Spec reviewer returned `partial` solely for that missing macOS
  execution evidence, after confirming the custom-key and policy-storage defects
  were fixed. The Standards reviewer returned `clean`.

## Evidence

Backend and runner workflow change; no visual surface changed.

Read the operator manual `docs/workflows/fleet-pr-babysitter.md` and updated it,
`SECURITY.md`, and control C37/residual R6 in `docs/THREAT-MODEL.md`. Searched
`BABYSITTER_READY`, validation helper names, and Mach lookup/registration
claims; no duplicated production validation rule was found. Existing credential
and symlink rules reuse `fleet_babysitter_sandbox.ts` rather than a second
resolver.

Issue provenance read:

- #4674 — “Babysitter repairs cannot run browser checks on macOS: Chromium
  cannot register its Mach ports inside the Codex seatbelt profile”.
- #4593 — “Fleet PR babysitter's Codex agent can read the GitHub App private
  key, so it can obtain a write credential despite its scoped token”.

The macOS integration test
`worker/deno/tests/fleet_babysitter_validation_test.ts::macOS runner sandbox launches Chromium without exposing credentials`
now exercises a failing target browser gate, HTML repair, browser DOM and
screenshot revalidation, credential probes and commit ordering. It also has a
bounded control launch without Mach registration and an outside-sandbox Keychain
baseline. It remains unexecuted on this Linux host.

The offline CLI tests exercise the real repair orchestration and filesystem,
with GitHub, Codex and sandbox command boundaries replaced. They cover
successful exact/multiline readiness, failed agents, lock loss before/after
spawn, missing/invalid responses, retry diagnostics, separate scratch and
credential context, response cleanup before staging, and attempt retention or
release. The body-proposal case observes the prepared description and retains
the existing PR-base guard's rejection of a plain-text `@file` body after push;
it does not bypass that guard or claim the description update succeeded.

### Mutation verification

Replayed the 24 mutations listed by the completion notice: 23 made a test fail;
one is an equivalent substitution documented below. Every mutation was restored.
Line numbers in this list are the notice's coordinates, before key forwarding
shifted the command lines.

- `worker/deno/tests/fleet_babysitter_repair_test.ts` kills 22 command
  mutations: validation logging at 468; each PR-body argument at 885–890;
  deletion of scratch/config/home at 919–921; stale retry prompt at 943; retry
  lock guard at 948; both false-return mutations at 953; all three status/lock
  condition mutations at 956; response cleanup at 968; both readiness operands
  at 975–976; unavailable-kind discrimination at 998; attempt cleanup at 1002.
- `worker/deno/tests/fleet_babysitter_validation_test.ts::runner does not retry an unrelated error with a failed kind`
  kills the `instanceof` operand deletion at
  `worker/deno/lib/fleet_babysitter_validation.ts:36`: an ordinary Error with
  `kind: "failed"` must be propagated once, with no repair callback.
- `worker/deno/commands/fleet_pr_babysitter.ts:919` exempt (untestable): the
  scratch shorthand mutation is behaviourally equivalent. `repairScratch` is
  assigned directly from `scratch`, and neither binding changes before or during
  validation. No supported execution can distinguish the two strings. Deleting
  the property on that same line is separately red-checked.
- The notice's other 60 candidate mutants were not replayed here and are not
  claimed as passed; this verification covers the 24 listed survivors.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — “Browser checks named by the target repository's gate run during
  a babysitter repair without weakening the credential boundary from #4593.” —
  evidence: `worker/deno/tests/fleet_babysitter_repair_test.ts` and
  `worker/deno/tests/fleet_babysitter_validation_test.ts::macOS runner sandbox launches Chromium without exposing credentials`
  — reviewer: partial — reason: implementation and regression coverage are
  complete, but real macOS Chromium launch and OS-level credential denial have
  not been verified on this Linux host.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Deno/TypeScript, credential and path boundaries, fail-loud
  handling, behavioural tests, test isolation, assertion preservation,
  dependency reuse and operator/security documentation.

## Test Plan

- `deno task test:unit tests/fleet_babysitter_repair_test.ts tests/fleet_babysitter_app_test.ts tests/fleet_babysitter_validation_test.ts tests/fleet_pr_babysitter_test.ts < /dev/null`
  — passed: 77 passed, 0 failed, 1 ignored. The Spec reviewer independently
  obtained the same result. The macOS browser test is the ignored case.
- `deno task check:manifests < /dev/null` — passed: 847 passed, 0 failed, 1
  ignored.
- Targeted `deno lint`, `deno fmt --check`, and
  `deno check --frozen --lock=deno.lock` — passed for the six changed TypeScript
  files, including the preload fixture.
- New Mach-registration profile assertion and planted scratch-policy symlink
  regression were observed failing before their production fixes, then passing.
  Custom App key and canonical target denials, caller forwarding and policy
  cleanup have regression coverage. No Node tooling or dependencies were added.
- The unchanged prompt assertion about naming unavailable checks was restored.
  The obsolete expectation that host failure alone cannot withhold readiness was
  replaced because #4674 makes runner validation decide whether to commit.
- `timeout 900 ./quality.sh < /dev/null` — failed the unit-test time budget.
  Both parallel and serial Deno test passes passed; the gate rejected unchanged
  `worker/deno/tests/launcher_harness_reclaim_stub_test.ts` because both tests
  exceeded the one-second budget (reported file time 3.19 seconds). That test
  file and its launcher harness are unchanged from `origin/main`. Lint, type
  checking, formatting, Semgrep, markdownlint and structural checks passed.
  Config integration was skipped because local configuration was absent; Checkov
  was skipped because PATH provided 3.3.30 instead of the CI pin 3.3.29 and no
  container runtime held the pinned image.
- Final summary markdownlint and `deno task pr-summary-check --base origin/main`
  with the issue body and `work-on` label — passed, no blocked gates.
