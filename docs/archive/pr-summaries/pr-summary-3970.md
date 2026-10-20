## Summary

Closes #3970. Part of #3653.

This PR pins the Checkov image by digest. It also adds the shared scan
arguments and a report judge that CI and the local pre-push gate can both use.
The judge reads Checkov's JSON report and the scan's exit code, and returns
PASSED or FAILED. A small entry point exits 1 on FAILED and 0 on PASSED.
`container/tools.json` is unchanged.

## Spec

### Intent and Rationale

- Checkov 3.3.29 exits 0 when a template fails to parse, and when a skip has
  no reason. Its exit code alone is not enough, so the gate judges the JSON
  report.
- One pinned image and one argument list keep CI and the local gate
  identical, which is the parity #3653 asks for.

### Essential Design Decisions

- `CHECKOV_IMAGE` is `bridgecrew/checkov:3.3.29@sha256:3cc1…69f3` in
  `worker/deno/lib/pinned_actions.ts`, beside `SEMGREP_IMAGE`. The digest
  was resolved from the registry, not written from memory. The tag was
  published on 2026-10-13, so it is past the 24h quarantine.
- Exit codes 0 and 1 are accepted. Any other exit code is FAILED.
- The only skip accepted is an inline `# checkov:skip=<ID>:<reason>` inside
  the resource's line range of the template. A skip set in `Metadata` is
  FAILED, and so is a skip with Checkov's "No comment provided" placeholder.
- Template paths from the report are confined to the scan directory. An
  absolute path, a NUL or a `..` segment makes the run FAILED before any
  read.

### Undiscoverable Facts

- Checkov returns a summary-only object when it finds no templates, and an
  array when it scans more than one framework. The judge handles both
  shapes.
- During the run, some Deno cache artefacts (`worker/deno/gen/`, `remote/`
  and `*_cache_v2*`) were caught in a periodic WIP snapshot. Commit
  5fa2cdbd removed them. Where they came from is unknown, and no
  `.gitignore` rule covers them, so a later snapshot could pick them up
  again.

## Evidence

The fixtures under `worker/deno/tests/fixtures/checkov/` are real Checkov
3.3.29 output, produced by running the pinned image on the template beside
each `report.json`. What each case showed:

| Case | Checkov exit | What the report shows |
| ---- | ------------ | --------------------- |
| `clean` | 0 | Passed checks only |
| `failed` | 1 | `failed_checks` names the check, the file and the line range |
| `parse_error` | 0 | The file is listed in `parsing_errors` |
| `reasonless_skip` | 0 | The suppress comment reads "No comment provided" |
| `metadata_skip` | 0 | A skipped check with no inline comment in the template |
| `reasoned_skip` | 0 | A skipped check whose inline comment carries the reason |
| `no_templates` | 0 | An object holding only the summary |

The exit-2, malformed-JSON and empty-stdout cases are synthesised in the
tests, because Checkov does not produce them for a valid template.

`worker/deno/tests/checkov_report_test.ts` has 46 tests, and all pass.
`deno check` is clean. The full `./quality.sh` gate result is in the Test
Plan below.

**Docs sweep** — grep: `SEMGREP_IMAGE`, `CHECKOV_IMAGE|bridgecrew/checkov`, `container/tools.json`; section: none — no manual documents the Checkov image, its scan arguments or its judge yet, because nothing runs them until later #3653 sub-issues wire them into CI and the gate; siblings: `SEMGREP_IMAGE` — hits at `docs/CONTAINER-IMAGE.md:271`, `docs/CONTAINER.md:137`, `docs/INTERNALS.md:139,145` and `docs/SECURITY-TREE-SWEEP.md:72` describe the Semgrep pin only and are still true, and no doc lists the set of pinned images as complete; updated: none needed, because the Checkov image is not wired into CI or the gate yet (later #3653 sub-issues do that)

#3653: Add Checkov security scanning for AWS CloudFormation templates

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `CHECKOV_IMAGE` is `bridgecrew/checkov:<tag>@sha256:<64 hex>`, and a test in `pinned_actions_test.ts` asserts the format — evidence: `worker/deno/tests/pinned_actions_test.ts::pinned_actions - checkov image is digest-pinned` — reviewer: met
- **met** — `CHECKOV_SCAN_ARGS` equals `["-d", ".", "--framework", "cloudformation", "-o", "json", "--skip-download"]`, and a test asserts it — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report - scan arguments match the CI and local gate command` — reviewer: met
- **met** — The judge returns FAILED for a failed check — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report - FAILED names the failed check, file and lines (exit 1)` — reviewer: met
- **met** — The judge returns FAILED for a parse error — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report - FAILED for a parse error even though Checkov exits 0` — reviewer: met
- **met** — The judge returns FAILED for malformed or empty JSON — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report - FAILED for malformed JSON`, `worker/deno/tests/checkov_report_test.ts::checkov-report - FAILED for empty or whitespace-only stdout` — reviewer: met
- **met** — The judge returns FAILED for exit code 2 — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report - FAILED for exit code 2 even with a clean report` — reviewer: met
- **met** — The judge returns FAILED for a skip with no reason — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report - FAILED for a skip with no reason (Checkov's placeholder)` — reviewer: met
- **met** — The judge returns FAILED for a skip set in `Metadata` — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report - FAILED for a skip set only in Metadata` — reviewer: met
- **met** — The judge returns PASSED for a clean scan, a scan that finds no templates, and a scan whose only skips are inline skips with a reason — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report - PASSED for a clean scan (exit 0)`, `worker/deno/tests/checkov_report_test.ts::checkov-report - PASSED for no CloudFormation templates (exit 0)`, `worker/deno/tests/checkov_report_test.ts::checkov-report - PASSED for a skip with a reason in the template (exit 0)` — reviewer: met
- **met** — The entry point exits 1 on FAILED and 0 on PASSED — evidence: `worker/deno/tests/checkov_report_test.ts::checkov-report CLI - exit 0 for a clean report`, `worker/deno/tests/checkov_report_test.ts::checkov-report CLI - exit 1 for a failed report` — reviewer: met
- **met** — `container/tools.json` is unchanged — evidence: `git diff milestone/pre-push-gate-ci-parity -- container/tools.json` is empty — reviewer: met
- **met** — The tests and `./quality.sh` pass — evidence: `worker/deno/tests/checkov_report_test.ts` (46 passing) and the gate run recorded in the Test Plan — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The independent standards reviewer found no material departure from `CODING-STANDARDS.md` in the diff.

## Test Plan

- [x] `deno test` on `worker/deno/tests/checkov_report_test.ts`: 46 passed.
- [x] `worker/deno/tests/pinned_actions_test.ts` passes, including the new digest-pin test.
- [x] `deno check` is clean. Gate run 5 caught a TS2345 error at
      `checkov_report_test.ts:855`, which `--no-check` had hidden. Commit
      2b390491 fixed it.
- [x] `./quality.sh < /dev/null` passes. The config integration check was
      skipped by the gate itself.
- [x] Red checks: each outcome in the facts file was flipped on purpose,
      with 42 entries in all. Each flip turned at least one named test red.
      The confinement guard was also checked against a control: the same
      skip at its original path is PASSED.
- [x] `deno.lock` and `container/tools.json` are unchanged against the base.
- [x] Applied the rule changes to the PR's own diff. This PR adds no prompt
      or standards rule, so there was nothing to apply.

<!-- vibe-branch-outcomes -->
