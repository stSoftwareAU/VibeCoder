# Gate-skip drift audit — flag a gate that skips a tool its own CI enforces

## Summary

Adds a repeatable idle-task audit that compares each monitored repository's
local `quality.sh` with its own CI workflows and files one issue naming every
tool the gate **skips with a warning** while CI **installs and runs** it — the
drift that let NEAT-AI-core PR 597 pass its local gate and fail in CI. The
scanner is deterministic and network-free: it executes nothing, invokes no LLM,
and reads the gate script, the workflows and `container/tools.json` as text. A
tool the image already carries for that repository is suppressed, as is a tool
waived by a governed `best-practice-ignore: BP-GATE-SKIP-<TOOL>` marker. Closes
#1597.

- `worker/deno/lib/gate_skip_drift_scanner.ts` — the scanner (skip detection, CI
  enforcement detection, manifest suppression, correlation).
- `worker/deno/lib/idle_task_templates/gate_skip_drift_template.ts` — the
  idle-task template: issue-only, one finding per repository, weekly cooldown.
- `prompts/gate_skip_drift/prompt.md`, `docs/GATE-SKIP-DRIFT-SCAN.md` — wrapper
  body and operator manual.

```mermaid
flowchart LR
    W["Idle-task wrapper<br/>Run a gate-skip drift audit"] --> G["quality.sh<br/>command -v … skipping"]
    G --> C[".github/workflows/*<br/>install-and-run of the same tool"]
    C --> M["Drop tools container/tools.json<br/>pins for this repo"]
    M --> F["One gate-skip-drift issue<br/>each tool, both lines"]
    G -. no quality.sh .-> N["no findings"]
    C -. no workflow runs it .-> N
    G -. skip branch exits .-> N
    C -. workflow unreadable .-> E["ok: false — loud"]
```

## Evidence

Backend/CLI change with no web interface, so there is nothing to screenshot. The
evidence is the test suite and the gate:

- `deno test worker/deno/tests/gate_skip_drift_scanner_test.ts` — 28 passed.
- `deno test worker/deno/tests/gate_skip_drift_template_test.ts` — 14 passed.
- `./quality.sh` — `Result: PASSED (with skipped checks)`; the only SKIPPED
  check is `config integration`, which is skipped on every run in this
  environment (no `.config.json`).

The scanner was also run against the committed fixture snapshots of the two NEAT
gates: with the pre-#1595 manifest it reports NEAT-AI-core's `bats` and
`codespell` and NEAT-AI-scorer's `bats`; with the current manifest it reports
nothing and lists both tools as suppressed
(`scanGateSkipDrift - a baked toolchain suppresses the finding`).

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the scanner reports NEAT-AI-core's `bats`/`codespell` and
  NEAT-AI-scorer's `bats` against a pre-#1595 snapshot, and nothing once
  `tools.json` names them — evidence:
  `worker/deno/tests/gate_skip_drift_scanner_test.ts::scanGateSkipDrift - reports NEAT-AI-core's bats and codespell drift`,
  `::scanGateSkipDrift - reports NEAT-AI-scorer's bats drift`,
  `::scanGateSkipDrift - a baked toolchain suppresses the finding` — reviewer:
  met
- **met** — tests and `./quality.sh` pass — evidence: full gate run after the
  final edit, `Result: PASSED`; `deno task check:manifests` green — reviewer:
  missing — reason: departure recorded — the reviewer saw the diff before this
  run's fixes, when `deno fmt` and seven completeness tests were red; all seven
  registration surfaces (cross-repo prompt list, wrapper-dedup factories, lib
  sweep ledger, prompt house vocabulary, OWASP matrix, the prompt's
  `Rejected suppression` line) and the fixture's formatting are fixed in this
  diff.
- **unrequested** — in-source `best-practice-ignore: BP-GATE-SKIP-<TOOL>` waiver
  suppression beyond the `container/tools.json` suppression the issue names —
  reviewer: unrequested — reason: kept — every sibling scan honours the same
  governed grammar and the fleet's suppression-governance test requires any
  prompt that reads it to state all three fields, so omitting it would have made
  this the one scan with an ungoverned waiver path.
- **unrequested** — `prompts/gate_skip_drift/prompt.md` and its
  `GATE_INSTRUCTION_ALLOWLIST` entry for a template that invokes no LLM —
  reviewer: unrequested — reason: kept — the idle-task framework files the
  prompt body verbatim as the wrapper issue (#2077), so a registered template
  without one cannot file its wrapper.
- **unrequested** — `docs/GATE-SKIP-DRIFT-SCAN.md` and its README index row —
  reviewer: unrequested — reason: kept — every registered scan owns an operator
  manual reachable from the README, and `readme_docs_reachability_test.ts`
  enforces it.
- **unrequested** — the canonical `gate-skip-drift` label in
  `content_label_definitions.ts` and `worker_label_guard.ts` — reviewer:
  unrequested — reason: kept — the template files findings under that label, and
  a label the worker cannot apply would strip it at filing time.
- **unrequested** — a fourth fixture pair (`skip_only`: skipped but not
  enforced) beyond the three cases the issue lists — reviewer: unrequested —
  reason: kept — it pins the false-positive direction, which is the failure mode
  that would file noise into every fleet repository.
- **unrequested** — composite actions under `.github/actions/` are scanned as
  well as `.github/workflows/` — reviewer: unrequested — reason: kept — it is
  inherited from the shared `readWorkflowFiles` reader; a tool enforced from a
  composite action is the same drift, and narrowing the shared reader is out of
  scope here.
- **unrequested** — "eighteen → nineteen" count updates across
  `DESIGN-PRINCIPLES.md`, `SECURITY.md` and nine docs — reviewer: unrequested —
  reason: kept — `idle_task_count_docs_test.ts` fails when a registered template
  is not counted, so registering the nineteenth template forces them.
- **unrequested** — the scanner now fails loud on an unreadable/unparseable
  workflow, an `exit` disqualifies only its own branch, a nested guard no longer
  hides the outer skip, and a scanner error replaces (rather than sits beside)
  the "no findings" count — reviewer: unrequested — reason: added this run after
  the Spec reviewer found each as a false negative or an overstated fail-loud
  claim; each is covered by a test that was red before the fix.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — `deno fmt --check` red, so the quality gate could not pass —
  evidence:
  `worker/deno/tests/fixtures/gate_skip_drift/neat_ai_scorer/ci.yml:18` —
  reason: fixed here; the gate now reports `deno fmt PASSED`.
- **violation** — the template registers but is not enrolled in the six guards
  derived from the tree, so seven completeness tests fail — evidence:
  `worker/deno/lib/idle_task_templates/gate_skip_drift_template.ts:414`
  (`registerTemplate`), with
  `worker/deno/tests/idle_task_cross_repo_body_refs_test.ts:92`,
  `worker/deno/tests/idle_task_wrapper_dedup_author_test.ts:238`,
  `docs/audits/lib-sweep-coverage.json`, `docs/PROMPT-HOUSE-VOCABULARY.md`,
  `docs/OWASP-TOP-10-2025-COVERAGE-MATRIX.md` — reason: fixed here; all six are
  updated and a new `12i` sweep slice with its written record
  (`docs/audits/security-sweep-1597-gate-skip-drift.md`) claims both new
  modules.
- **violation** — the suppression prompt omits the `Rejected suppression`
  reporting line every other marker-reading prompt carries — evidence:
  `prompts/gate_skip_drift/prompt.md:61` — reason: fixed here, and made true
  rather than merely written: the template now renders
  `renderSuppressionSummary()` into its wrapper summary, so an active or
  rejected waiver is visible in the report.
- **violation** — no PR summary file — evidence:
  `docs/archive/pr-summaries/pr-summary-1597.md` — reason: fixed here (this
  file).
- **violation** — two exported functions had no direct tests — evidence:
  `worker/deno/lib/gate_skip_drift_scanner.ts` (`gateSkipFindingId`,
  `correlateGateSkipDrift`) — reason: fixed here; four direct tests added
  covering the id rewrite (`pip3`, `shell-check`, `shell..check`, empty), the
  happy pairing, both suppression paths and empty input.
- **clean** — Australian English throughout; fail-loud contract (scanner
  `ok: false`, template never throws out of `runTask`); Deno-native tooling
  only; module↔test pairing and `@std/assert`; tests call real functions against
  fixtures with no source-grepping, sleeps or wall-clock budgets; no hidden or
  key-shaped path staged; every commit references Issue #1597 and carries
  `Vibe-Coder-Run-Id`; `deno lint`, `deno check`, markdownlint and semgrep
  clean.

## Test Plan

Added in `worker/deno/tests/gate_skip_drift_scanner_test.ts` (28 tests):

- fixture-driven scans of the NEAT-AI-core and NEAT-AI-scorer gate snapshots
  against the pre-#1595 and current manifests (finding, then suppressed);
- the negative cases: enforced-and-hard-failing, skipped-but-not-enforced, no
  `quality.sh`, an attributed waiver, an unattributed waiver;
- guard shapes: an `exit` in the success branch is still a skip, a nested guard
  does not hide the outer skip, an `exit` in the skip branch is enforcement;
- fail-loud: unreadable `quality.sh`, unparseable manifest, unparseable
  workflow, unreadable workflow;
- the pure correlation layer: `gateSkipFindingId` and `correlateGateSkipDrift`.

Added in `worker/deno/tests/gate_skip_drift_template_test.ts` (14 tests):
title/body rendering, summary wording (including that a scanner error replaces
the count and that a waiver is reported), `runTask` filing one issue for one or
two drifting tools, no-drift filing nothing, scanner error and scanner throw
both failing loud, the checkout-path fix, `shouldFile` vetoing while a wrapper
is open, and claim-handler dispatch.

Registration guards updated so the nineteenth template is covered rather than
exempted: `idle_task_cross_repo_body_refs_test.ts`,
`idle_task_wrapper_dedup_author_test.ts` (a real `gate-skip-drift` factory whose
scanner throws if `shouldFile` ever reaches it), `lib_sweep_coverage_test.ts`,
both prompt-house-vocabulary suites, `readme_docs_reachability_test.ts` and
`suppression_governance_drift_test.ts`.
