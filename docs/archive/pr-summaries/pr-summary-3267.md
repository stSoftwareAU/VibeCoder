## Summary

Closes #3267.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Public repo reading enabled:false → exactly one bare gh api --method PUT repos/<repo>/private-vulnerability-reporting , result applied . — evidence: `worker/deno/tests/repo settings harden test.ts::hardenRepo - a public repo with private vulnerability reporting off gets a bare PUT (Issue #3267)` — reviewer: met
- **met** — Public repo reading enabled:true → no step and no write. — evidence: `worker/deno/tests/repo settings harden test.ts::hardenRepo - private vulnerability reporting already on makes no write (Issue #3267)` — reviewer: met
- **met** — Dry run → step reported planned , no write. — evidence: `worker/deno/tests/repo settings harden test.ts::hardenRepo - a dry run plans private vulnerability reporting without writing (Issue #3267)` — reviewer: met
- **partial** — Private or internal repo → no PVR read or write; the skip note appears on the repo's line. — evidence: `worker/deno/lib/repo settings harden.ts:1937` — reviewer: partial — reason: the read is skipped, but the field is left absent, so enabled !== true still plans a PUT, and pvrSkipNote is never read by the sync step or the CLI; both private/internal tests fail
- **partial** — Unreadable visibility is never treated as exempt (the PVR read still runs or the repo fails, never a silent skip). — evidence: `worker/deno/tests/repo settings harden test.ts::hardenRepo - an unreadable visibility still reads and writes private vulnerability reporting, never a silent skip (Issue #3267)` — reviewer: partial — reason: when the repos/{repo} read fails, PVR is never read but a blind PUT is still planned from the absent field; the 'a failed repos/{repo} read fails rather than silently skipping' test fails
- **partial** — Refused PUT → failed on the repo's line and the sync step returns false. — evidence: `worker/deno/tests/repo settings harden test.ts::hardenRepo - a refused private-vulnerability-reporting PUT is a failed result, never a throw (Issue #3267)` — reviewer: partial — reason: the failed result is checked at the hardenRepo level only; no test shows it on the sync line or that the sync step returns false
- **partial** — Non-404 read error → failed , nothing planned for PVR. — evidence: `worker/deno/lib/repo settings harden.ts:1942` — reviewer: partial — reason: the failed read is recorded, but the absent field still plans a PUT; the 'a non-404 private-vulnerability-reporting read failure plans nothing about it' test fails
- **met** — docs/SETUP.md lists the new step. — evidence: `docs/SETUP.md:365` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Quality gate broken: deno test tests/repo settings harden test.ts gives 80 passed, 24 failed, because the absent-field plan ( enabled !== true ) adds a PUT to every snapshot without the field — evidence: `worker/deno/lib/repo settings harden.ts:686` — reason: not fixed — on a line this diff adds; the code has to change (plan only on enabled === false ) before the PR can be raised
- **violation** — Fail-loud / no dead code: pvrSkipNote is set but never read, so the skip note never reaches the sync line or the CLI, and private-vulnerability-reporting is missing from CHECKED KINDS — evidence: `worker/deno/lib/repo settings harden.ts:1788` — reason: not fixed — on a line this diff adds; worker/deno/setup/repo settings harden sync.ts:143 and worker/deno/commands/repo settings harden.ts:121 must use it before the PR can be raised
- **violation** — Docs do not match behaviour: SETUP.md and the module doc say a 404 on the read plans nothing, but read() treats a 404 as a failed result and the absent field then plans a PUT — evidence: `docs/SETUP.md:370` — reason: not fixed — on a line this diff adds; the read needs a 404 special case like readCodeScanning before the PR can be raised
- **clean** — Australian English in new identifiers, comments and docs; tests added alongside the change (TDD); the refused PUT is reported as a failed result, not thrown
