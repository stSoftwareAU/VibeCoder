## Summary

The weekly GitHub Actions audit now files `BP-REPO-PVR-OFF` for a public
repository with private vulnerability reporting (PVR) off. Setup's audit
closer closes that finding once the #3267 harden step ran cleanly and a
re-read shows `"enabled": true`. Closes #3268.

- `worker/deno/lib/repo_settings_scanner.ts` — new check 5. A public
  repository is read at `repos/{repo}/private-vulnerability-reporting`
  through `readJson`. `enabled === false` adds `BP-REPO-PVR-OFF` (through
  the existing `add()`, so a known-open id is not filed again), with the
  `ADMIN` prose in `suggestedFix`. A private or internal repository
  (`needsPaidSecretProtection`, the gate harden uses) is not read. Its skip
  goes through `onCheckSkipped` with the new
  `PRIVATE_VULNERABILITY_REPORTING_SKIP_CHECK` / `_REASON` constants. Any
  read failure goes to `onLookupFailure`. When `repos/{repo}` was unreadable,
  PVR is not read; that failure is already reported.
- `worker/deno/setup/repo_settings_audit_close.ts` — `BP-REPO-PVR-OFF` maps to
  `private-vulnerability-reporting` in `FINDING_STEP_KIND`. `confirmFixed`
  requires the positive read-back `enabled === true`. The module doc has a
  new bullet.
- `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` — the `BP-REPO-*` list now includes the
  id. A paragraph covers the public-only check, and a sentence covers the
  closer.

**Docs sweep** — grep: `BP-REPO-PVR-OFF`, `BP-REPO-SECRET-SCANNING-OFF`, `BP-REPO-PUSH-PROTECTION-OFF`, `FINDING_STEP_KIND`, `repo_settings_scanner`, `repo_settings_audit_close`, `scanRepoSettings`, `private-vulnerability-reporting`, "private vulnerability reporting" (README.md, docs/ excluding docs/archive/, */README.md); section: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md#native-repository-settings-pre-filer`, `docs/GITHUB-ACTIONS-AUDIT-SCAN.md#closing-the-settings-findings-repo-settings-harden`, `docs/SETUP.md#repository-settings-hardening` (item 3, "Audit issues"); updated: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` (in the branch commit). The other hits are still true:
- `docs/SETUP.md:365` and `:1821` describe the #3267 harden step.
- `docs/SETUP.md:430` says audit issues "whose finding the run fixed" are closed.
- `docs/THREAT-MODEL.md:247` is about code-owner review.
- The `docs/audits/*` sweeps are dated snapshots.
- Open, from the standards review below: the "A check that could not run says so (Issue #1094)" paragraph (`docs/GITHUB-ACTIONS-AUDIT-SCAN.md:1123`) names the "Actions policies" permission for every 403 on these endpoints. That may be the wrong advice for the new PVR read.

## Test Plan

- `deno test --allow-all tests/repo_settings_scanner_test.ts tests/setup_repo_settings_audit_close_test.ts` (from `worker/deno`): 45 passed, 0 failed.
- Added to `worker/deno/tests/repo_settings_scanner_test.ts`: public PVR off, public PVR on (endpoint read), known-open not re-filed, private/internal not read with the skip recorded, 403/404/500 lookup failure, and unreadable `repos/{repo}` not followed by a PVR read.
- Added to `worker/deno/tests/setup_repo_settings_audit_close_test.ts`: closes on applied with `enabled:true`, and on no step of its kind with `enabled:true`. Stays open on `enabled:false`, on planned/failed/skipped, on a read-back without `enabled`, on a private repo, and on a rejected read-back (warns).
- Changed in existing tests:
  - the `HARDENED`/`OPEN` fixtures gain a PVR entry;
  - four private/internal tests filter `onCheckSkipped` to `SECRET_PROTECTION_SKIP_CHECK`;
  - all their secret-protection assertions are kept.
- Removed from `worker/deno/tests/repo_settings_scanner_test.ts`: `assertEquals(ids, [ "BP-REPO-ACTIONS-ALLOW-ALL", "BP-REPO-ACTIONS-MAY-APPROVE-PRS", "BP-REPO-DEFAULT-TOKEN-WRITE", "BP-REPO-PUSH-PROTECTION-OFF", "BP-REPO-RULESET-NO-REVIEW", "BP-REPO-SECRET-SCANNING-OFF", "BP-REPO-SHA-PIN-NOT-ENFORCED", ]);` — #3268 makes a public repository with PVR off file `BP-REPO-PVR-OFF`, and the `OPEN` fixture now reads `enabled:false`, so the old list is untrue. It is now the same list with `"BP-REPO-PVR-OFF"` added, in the same test.
- Removed from `worker/deno/tests/setup_repo_settings_audit_close_test.ts`: `assertEquals( [...ids].sort(), [ "BP-REPO-ACTIONS-MAY-APPROVE-PRS", "BP-REPO-DEFAULT-TOKEN-WRITE", "BP-REPO-RULESET-NO-REVIEW", ], );` — #3268 maps `BP-REPO-PVR-OFF` to `private-vulnerability-reporting` in `FINDING_STEP_KIND`, and that kind is absent from the outcome, so it is eligible and the old list is untrue. It is now the same list with `"BP-REPO-PVR-OFF"` added, in the same test.

**Branch outcomes:**

Each test was flipped in a scratch copy of `worker/deno` with `--no-check` where the flip did not type-check:

- `worker/deno/lib/repo_settings_scanner.ts:370` — absent (`repos/{repo}` unreadable → no PVR read) — `worker/deno/tests/repo_settings_scanner_test.ts::scanRepoSettings - an unreadable repos/{owner}/{repo} is not followed by a PVR read (Issue #3268)` — flipped to `if (true)`, test went red
- `worker/deno/lib/repo_settings_scanner.ts:371` — skipped (private/internal → `onCheckSkipped`, no read) — `worker/deno/tests/repo_settings_scanner_test.ts::scanRepoSettings - a private or internal repository is not read for PVR and the skip is recorded (Issue #3268)` — flipped to never skip, test went red (also `BP-REPO-PVR-OFF stays open when the repo is private (PVR not read at all)`)
- `worker/deno/lib/repo_settings_scanner.ts:371` — read (public → endpoint read) — `worker/deno/tests/repo_settings_scanner_test.ts::scanRepoSettings - a public repository with PVR on files nothing but still reads the endpoint (Issue #3268)` — flipped to always skip, test went red (9 tests red)
- `worker/deno/lib/repo_settings_scanner.ts:383` — finding (`enabled:false`) — `worker/deno/tests/repo_settings_scanner_test.ts::scanRepoSettings - a public repository with PVR off files BP-REPO-PVR-OFF (Issue #3268)` — inverted to `=== true`, test went red
- `worker/deno/lib/repo_settings_scanner.ts:383` — no finding (`enabled:true`) — `worker/deno/tests/repo_settings_scanner_test.ts::scanRepoSettings - a hardened repository yields no findings (Issues #4397 #4398 #4401)` — inverted to `=== true`, test went red
- `worker/deno/lib/repo_settings_scanner.ts:383` — error (read failure → no finding) — `worker/deno/tests/repo_settings_scanner_test.ts::scanRepoSettings - a PVR read failure is a lookup failure, not a finding or a skip (Issue #3268)` — flipped to `!== true`, test went red (through a `TypeError` on the undefined read)
- `worker/deno/lib/repo_settings_scanner.ts:383` — absent (`{}` response, no `enabled` field → no finding) — no scanner test reaches it. Flipped to `!== true`, no test failed because of this outcome; the two that went red failed on the read-failure path. Open, per the standards review.
- `worker/deno/setup/repo_settings_audit_close.ts:102` — eligible (mapping present) — `worker/deno/tests/setup_repo_settings_audit_close_test.ts::FINDING_STEP_KIND covers every BP-REPO id the scanner files` — mapping removed, test went red (also the two close tests and `eligibleFindingIds - applied or absent kinds are eligible; failed, planned or skipped are not`)
- `worker/deno/setup/repo_settings_audit_close.ts:277` — success (`enabled:true` → close) — `worker/deno/tests/setup_repo_settings_audit_close_test.ts::BP-REPO-PVR-OFF closes once hardening applied and the re-read shows enabled: true` — flipped to `false`, test went red
- `worker/deno/setup/repo_settings_audit_close.ts:277` — fail-closed (missing `enabled`, or private repo not read → stays open) — `worker/deno/tests/setup_repo_settings_audit_close_test.ts::BP-REPO-PVR-OFF stays open when the read-back has no enabled field (scanner silent)` — flipped to `true` and to `!== false`, test went red each time (also `BP-REPO-PVR-OFF stays open when the repo is private (PVR not read at all)`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Public repo with enabled:false → one BP-REPO-PVR-OFF finding with the admin prose. — evidence: `worker/deno/tests/repo settings scanner test.ts::scanRepoSettings - a public repository with PVR off files BP-REPO-PVR-OFF (Issue #3268)` — reviewer: met
- **met** — Public repo with enabled:true → no finding. — evidence: `worker/deno/tests/repo settings scanner test.ts::scanRepoSettings - a public repository with PVR on files nothing but still reads the endpoint (Issue #3268)` — reviewer: met
- **met** — Already-open BP-REPO-PVR-OFF → no duplicate. — evidence: `worker/deno/tests/repo settings scanner test.ts::scanRepoSettings - a known-open BP-REPO-PVR-OFF is not re-filed (Issue #3268)` — reviewer: met
- **met** — Private repo → no PVR read, check recorded as skipped. — evidence: `worker/deno/tests/repo settings scanner test.ts::scanRepoSettings - a private or internal repository is not read for PVR and the skip is recorded (Issue #3268)` — reviewer: met
- **met** — 403 / other read error → onLookupFailure called, no finding. — evidence: `worker/deno/tests/repo settings scanner test.ts::scanRepoSettings - a PVR read failure is a lookup failure, not a finding or a skip (Issue #3268)` — reviewer: met
- **met** — Closer closes an open BP-REPO-PVR-OFF only when the PVR step ran cleanly and the re-read shows enabled:true . — evidence: `worker/deno/tests/setup repo settings audit close test.ts::BP-REPO-PVR-OFF closes once hardening applied and the re-read shows enabled: true; ::BP-REPO-PVR-OFF closes when already compliant (no step of its kind) and the re-read shows enabled: true` — reviewer: met
- **met** — Closer leaves it open on a re-read of false , a dry run, a failed step, or a missing read-back. — evidence: `worker/deno/tests/setup repo settings audit close test.ts::BP-REPO-PVR-OFF stays open when the re-read shows enabled: false; ::BP-REPO-PVR-OFF never closes on a dry run (planned/failed/skipped this run); ::BP-REPO-PVR-OFF stays open when the read-back has no enabled field (scanner silent); ::BP-REPO` — reviewer: met
- **met** — Docs list the new id. — evidence: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md (finding-id list and the 'Private vulnerability reporting is checked on a public repository only (Issue #3268)' paragraph)` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Log Levels Are a Promise About What the Reader Must Do: the PVR skip this diff adds fires for every private or internal repository on every audit run. The audit template's onCheckSkipped logs it at WARNING, but it is an expected absence nobody can act on, so it belongs at INFO. — evidence: `worker/deno/lib/repo settings scanner.ts:372` — reason: NOT fixed and NOT filed. This turn is barred from changing code, so I cannot honestly write 'fixed in this diff'. The new skip call is a line this diff adds, so this needs a fix turn (onCheckSkipped → logger.info, plus the docs line that says WARNING) before the PR is raised.
- **violation** — Every outcome of a branch you add needs a test that reaches it: no scanner test sends a PVR response without an enabled field. Flipping pvr?.enabled === false to pvr && pvr.enabled !== true would leave the suite green. — evidence: `worker/deno/lib/repo settings scanner.ts:383` — reason: NOT fixed. The branch is a line this diff adds and this turn is barred from changing code. It needs a fix turn that adds a scanner test feeding {} for private-vulnerability-reporting and asserting no BP-REPO-PVR-OFF.
- **violation** — A new behaviour reaches every caller / A Code Change Owes a Docs Change: a 403 on the new private-vulnerability-reporting read goes down the 'not permitted' path, which tells the operator to grant ACTIONS POLICY PERMISSION ('Actions policies'). GitHub documents the Administration read permission for — evidence: `worker/deno/lib/repo settings scanner.ts:376` — reason: NOT fixed. The new read is a line this diff adds and this turn is barred from changing code. It needs a fix turn that names the right permission per endpoint (or a PVR-specific message) and says in docs/GITHUB-ACTIONS-AUDIT-SCAN.md which permission the PVR read needs.
- **violation** — Comment/doc accuracy: this diff narrowed the test's onCheckSkipped to count only the secret-protection skip, so the title 'records no skip' is now false, because the scanner does record a PVR skip for that private repository. — evidence: `worker/deno/tests/repo settings scanner test.ts:246` — reason: NOT fixed. The narrowed callback is a line this diff changes and this turn is barred from changing code. It needs a fix turn that retitles the test to 'records no secret-protection skip'.
- **clean** — Checked and compliant: Australian English in new prose and identifiers; KISS/DRY (the scanner reuses needsPaidSecretProtection and readJson, and the closer reuses the FINDING STEP KIND/positive read-back table); fail-loud handling (a read failure is a lookup failure, never a pass, and an unreadable
