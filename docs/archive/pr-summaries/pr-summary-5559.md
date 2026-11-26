## Summary

Skip workflow files over 1 MiB before reading and parsing them, reporting the
filename and size-limit diagnostic through `onUnparseable`. AWS scans record
these workflows as unreadable, keeping unknown wiring from producing a
missing-wiring finding. Closes #5559.

## Spec

### Intent and Rationale

- Bound ordinary workflow inputs using the same 1 MiB scale as the AWS
  scanner's existing input limits, without changing YAML parsing.

### Essential Design Decisions

- `loadWorkflows` owns the private workflow limit. A stat size of exactly
  1,048,576 bytes remains eligible; larger files are skipped before reading.
- Reuse `onUnparseable` and `unreadableWorkflows` for oversized inputs, so the
  existing AWS consumer handles unknown wiring without another result shape.
- Preserve filename sorting, symlink-entry filtering and filesystem-error
  handling. The zero-load diagnostic now says none loaded rather than empty.

### Undiscoverable Facts

- The oversized regression failed against the unchanged base production code:
  `oversized.yml` appeared in the loaded filenames. The exact-limit control
  passed in that run (48 passed, 1 failed).

## Evidence

- #5559: linter_in_ci_check: `loadWorkflows` reads each workflow file whole,
  with no size limit.
- Backend scanner change; deterministic temporary-file tests cover the loader,
  AWS scanner and best-practices consumer. No browser evidence applies.
- Read and updated the workflow-loading and AWS-emulator sections of
  `docs/BEST-PRACTICES-SCAN.md`, the corresponding explanation in
  `DESIGN-PRINCIPLES.md`, and loader/scanner/template comments.

```mermaid
flowchart LR
    A[Regular workflow candidate] --> B{Stat size over 1 MiB?}
    B -- yes --> C[Report skipped filename]
    C --> D[Skipped workflow wiring unknown]
    B -- no --> E[Read and parse YAML]
    E -- parse failure --> C
    E -- parsed --> F[Assess readable workflow]
```

## Test Plan

- `worker/deno/tests/linter_in_ci_check_test.ts`: added
  `loadWorkflows — loads valid YAML at exactly 1 MiB` and
  `loadWorkflows — skips valid YAML over 1 MiB with a size diagnostic`.
  Assert loaded content/invocations, omitted filename, callback cause and
  zero-load wording, including omission without a callback.
- `worker/deno/tests/aws_emulator_in_ci_check_test.ts`: added
  `checkAwsEmulatorInCI - oversized workflows are unreadable while readable wiring is assessed`.
  Covers mixed workflows, only oversized workflows and an exact-limit control;
  readable wiring evidence identifies the readable file.
- `worker/deno/tests/best_practices_template_test.ts`: added
  `runTask - oversized workflows suppress missing AWS wiring through the real detector`.
  The production detector suppresses filing and logs unknown wiring with an
  oversized file; reducing that file to the limit permits the missing-wiring
  finding. The scan continues in both cases.
- The four-file targeted `deno task test:unit` run, including existing
  `worker/deno/tests/language_validity_gate_test.ts` regressions: **472 passed,
  0 failed** after the fix. The loader regression was observed red before it.
- Targeted `deno fmt --check`, `deno lint` and frozen `deno check`: passed.
- `timeout 1200 ./quality.sh < /dev/null`: **passed with skipped checks**.
  Deno unit tests (parallel and serial), lint, type checking, formatting,
  completeness, Mermaid, Markdown, Semgrep and gitleaks passed.
- Workflow-size corpus audit at base and head: 15 files on each, largest
  39,945 bytes; none exceeded the cap. No invocation matcher changed.
- `deno task pr-summary-check --base origin/main` with the fetched issue body
  and labels: passed, zero blocked and zero unchecked gates.
- No existing test assertions were removed or changed. No duplicate workflow
  loader or twinned workflow-size rule was found; existing callers retain the
  shared loader.

## Merge verification

CI and independent code review have not been observed in this run.

## Remaining limitations

The stat-before-read check does not bound a file that grows after the stat.
The full gate skipped configuration integration because local configuration
was unavailable, and Checkov because neither its pinned binary nor container
image was available. Its unit-test runner excludes integration suites.
No memory-exhaustion benchmark or concurrent-growth test was run. This executor
was not assigned a push and did not push.
