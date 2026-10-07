# PR Summary — Issue #3368

## Summary

Wires the #3366 detector (`checkAwsEmulatorInCI`) into the best-practices
scan as a deterministic pre-filer that runs on every bucket. A repo that
uses AWS, has at least one loaded workflow, runs no `floci/floci` image in
CI and carries no valid `best-practice-ignore: BP-AWS-EMULATOR-MISSING`
waiver gets one `BP-AWS-EMULATOR-MISSING` issue at `severity:medium`. The
issue is filed through `fileFindingOnce` and added to the known-open list
passed to Claude. `fileMissingCIGateIssue` now takes a severity, and
`BP-LINTER-*` still files at `severity:high`. Part of #3346; depends on #3366.
Closes #3368.

**Docs sweep** — grep: `fileMissingCIGateIssue`, `BP-AWS-EMULATOR-MISSING`, `checkAwsEmulator`, `pre-fil`, `missing-linter`, `known-open`, `severity:high`, "one slot may be consumed", "all six slots" over `README.md`, `docs/` (excluding `docs/archive/`), `DESIGN-PRINCIPLES.md` and `*/README.md`; section: `docs/BEST-PRACTICES-SCAN.md#aws-emulator-in-ci-bp-aws-emulator-missing`, `docs/BEST-PRACTICES-SCAN.md#6-issue-cap-and-priority-order`, `DESIGN-PRINCIPLES.md` (best-practices "AWS emulator in CI" / "Cap and priority order"), `docs/IDLE-TASK-FRAMEWORK.md` (template table, `best-practices` row); updated: `docs/BEST-PRACTICES-SCAN.md`. The cap paragraph said a `general`/`design` run gives "the LLM all six slots", which a pre-filed `BP-AWS-EMULATOR-MISSING` finding now makes false, so it now says "less any pre-filed `BP-AWS-EMULATOR-MISSING` finding". Every other hit was read in its sentence and is still true. `markdownlint-cli2` reports `0 issues in 0 files` across 222 files.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — AWS repo, no Floci workflow → exactly one issue, with the `severity:medium` label and finding-id `BP-AWS-EMULATOR-MISSING`. — evidence: `worker/deno/tests/best_practices_template_test.ts::runTask - AWS repo with no Floci files BP-AWS-EMULATOR-MISSING at severity:medium` — reviewer: met
- **met** — An existing open issue with the same finding-id → no duplicate (`fileFindingOnce` dedup). — evidence: `worker/deno/tests/best_practices_template_test.ts::runTask - AWS finding already open under its finding-id is not re-filed` — reviewer: met
- **met** — AWS repo with Floci in CI, a non-AWS repo, or a repo with no workflows loaded → no issue. — evidence: `worker/deno/tests/best_practices_template_test.ts::runTask - AWS-emulator pre-check skips filing and logs why (floci configured / no AWS / no workflow)` — reviewer: met
- **met** — A valid unexpired waiver suppresses; an expired one does not. — evidence: `worker/deno/tests/best_practices_template_test.ts::runTask - a valid unexpired waiver marker in a workflow suppresses the AWS finding`, `::runTask - a valid waiver marker in an evidence file suppresses the AWS finding`, `::runTask - an expired waiver marker does not suppress: exactly one issue is filed`, `::runTask - a waiver marker missing author= does not suppress: one issue is filed` — reviewer: met
- **met** — `BP-LINTER-*` findings still file at `severity:high`. — evidence: `worker/deno/tests/best_practices_template_test.ts::runTask - BP-LINTER missing-linter finding remains severity:high, not severity:medium` — reviewer: met
- **met** — The issue body contains `CREATE_COMPLETE`, `::warning::`, `SKIPPED (needs Docker):` and a digest-pinned image reference. — evidence: `worker/deno/tests/best_practices_template_test.ts::runTask - AWS repo with no Floci files BP-AWS-EMULATOR-MISSING at severity:medium` — reviewer: met
- **met** — `docs/BEST-PRACTICES-SCAN.md` documents the check, and markdown-lint is green. — evidence: `docs/BEST-PRACTICES-SCAN.md#aws-emulator-in-ci-bp-aws-emulator-missing`; `markdownlint-cli2` run here: `Summary: 0 issues in 0 files` (222 files) — reviewer: partial — reason: the reviewer saw only the diff and could not run markdown-lint; it was run here and passed
- **unrequested** — "AWS emulator in CI" paragraph in `DESIGN-PRINCIPLES.md` — reviewer: unrequested — reason: keeps the design-principles summary of the best-practices scan in step with the manual
- **unrequested** — AWS pre-check added to the `best-practices` row in `docs/IDLE-TASK-FRAMEWORK.md` — reviewer: unrequested — reason: docs sync, so the template table describes the new pre-check
- **unrequested** — injectable `logger` dependency on `BestPracticesTemplateDeps` — reviewer: unrequested — reason: lets the tests observe the "log why" skip reasons the issue requires
- **unrequested** — evidence list capped at 50 entries with a `- … and N more` line, and backticks in paths replaced — reviewer: unrequested — reason: defensive hardening of the issue body against huge or hostile path lists
- **unrequested** — `assertRepoRelative` path guard and `NotFound` skip in `hasAwsEmulatorWaiver` — reviewer: unrequested — reason: path confinement under the Secure Coding standard, so the waiver scan never reads outside the checkout
- **unrequested** — `checkAwsEmulatorFn` no-AWS stub injected into the existing best-practices tests and into the `idle_task_scan_dedup_conformance_test.ts` harness — reviewer: unrequested — reason: supporting change that keeps existing tests isolated from the real detector

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Naming accuracy: a function's name must still describe what it does — evidence: `worker/deno/lib/idle_task_templates/best_practices_template.ts:575` — reason: not fixed in this diff. `fileMissingCIGateIssue` now also files `BP-AWS-EMULATOR-MISSING`, which is not a missing CI gate. This retry may change only the summary, so the rename (for example to `filePreFiledFinding`) is left as a follow-up.
- **violation** — Doc-comment accuracy — evidence: `worker/deno/tests/best_practices_template_test.ts:217` — reason: not fixed in this diff. The `spyLogger` comment says it collects `info()` messages "(and their context)", but it stores only the message string. This retry may change only the summary, so the fix is left as a follow-up.
- **clean** — Australian English; fail-loud (a detector throw returns `ok:false` through `runTask`'s catch; read errors in the waiver scan other than `NotFound` are re-thrown with context and `cause`); path safety on evidence paths (absolute and `..` rejected); INFO level for expected skips; Deno/TypeScript conventions (injected deps, strict types, `@std/assert`); DRY (`fileFindingOnce`, `findSuppressions`/`filterByFamily` and `loadWorkflows` reused); docs kept in sync; no existing test assertion removed.

## Test Plan

- Tests for the new behaviour were added to `worker/deno/tests/best_practices_template_test.ts` (eleven `runTask`/`hasAwsEmulatorWaiver` tests). A no-AWS `checkAwsEmulatorFn` stub was added to `worker/deno/tests/idle_task_scan_dedup_conformance_test.ts`.
- `deno test -A tests/best_practices_template_test.ts tests/idle_task_scan_dedup_conformance_test.ts` (from `worker/deno`): `ok | 133 passed | 0 failed`.
- No assertion was removed from an existing test. In `best_practices_template_test.ts` the only removed lines are two import statements: `import { assert, assertEquals, assertStringIncludes } from "@std/assert";` became a multi-line import that adds `assertRejects`, and `import type { Result } from "../types.ts";` became `import type { Logger, Result } from "../types.ts";`. `idle_task_scan_dedup_conformance_test.ts` has additions only.

**Branch outcomes:** (each was flipped on purpose against the two test files above; the named test went red, and the code was restored)

- `worker/deno/lib/idle_task_templates/best_practices_template.ts:1049` — absent (no AWS usage → skip and log) — `worker/deno/tests/best_practices_template_test.ts::runTask - AWS-emulator pre-check skips filing and logs why (floci configured / no AWS / no workflow)` — flipped the guard to `false`, that test and 7 linter `runTask` tests went red
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:1053` — fail-safe (no workflow loaded → skip and log) — `worker/deno/tests/best_practices_template_test.ts::runTask - AWS-emulator pre-check skips filing and logs why (floci configured / no AWS / no workflow)` — flipped to `false`, test went red
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:1057` — success (Floci configured → skip and log) — `worker/deno/tests/best_practices_template_test.ts::runTask - AWS-emulator pre-check skips filing and logs why (floci configured / no AWS / no workflow)` — flipped to `false`, test went red
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:1061` — waived (valid marker → skip and log) — `worker/deno/tests/best_practices_template_test.ts::runTask - a valid unexpired waiver marker in a workflow suppresses the AWS finding`, `worker/deno/tests/best_practices_template_test.ts::runTask - a valid waiver marker in an evidence file suppresses the AWS finding` — flipped to `false`, both went red
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:1081` — filed (id pushed to `preFiled`) / not filed — `worker/deno/tests/best_practices_template_test.ts::runTask - AWS repo with no Floci files BP-AWS-EMULATOR-MISSING at severity:medium` — flipped to never push, test went red
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:756` — valid marker counts / invalid (expired, no `author=`) does not — `worker/deno/tests/best_practices_template_test.ts::runTask - an expired waiver marker does not suppress: exactly one issue is filed`, `worker/deno/tests/best_practices_template_test.ts::runTask - a waiver marker missing author= does not suppress: one issue is filed` — inverted `s.valid`, those two and both valid-waiver tests went red
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:696` — error (evidence path with `..`) — `worker/deno/tests/best_practices_template_test.ts::hasAwsEmulatorWaiver - an evidence path escaping the repo root rejects` — flipped to `false`, test went red
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:737` — absent (evidence file not on disk → skipped) — `worker/deno/tests/best_practices_template_test.ts::hasAwsEmulatorWaiver - a non-existent evidence path is skipped, not thrown` — flipped `continue` to `throw err`, that test and 5 AWS `runTask` tests went red
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:738` — error (unreadable evidence file other than `NotFound` → throw with path) — not reached by a test: changing it to `continue` for every error stayed green
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:690` — error (absolute evidence path) — not reached by a test: flipping it to `false` stayed green
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:633` — truncated (more than 50 evidence paths → `- … and N more`) — not reached by a test: flipping it to `false` stayed green. The non-truncated outcome is reached by `worker/deno/tests/best_practices_template_test.ts::runTask - AWS repo with no Floci files BP-AWS-EMULATOR-MISSING at severity:medium`
- `worker/deno/lib/idle_task_templates/best_practices_template.ts:892` / `:894` — default `checkAwsEmulatorInCI` / `defaultLogger` when no dep is injected — not reached by a test: every test injects both, and replacing the default with a rejecting function stayed green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
