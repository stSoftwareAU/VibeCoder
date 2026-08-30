/**
 * Tests for gitleaks_drift_scanner.ts — native gitleaks-drift pre-filer for
 * the github-actions-audit template (Issue #598, part of #566).
 *
 * Every test exercises the real `scanGitleaksDrift` against in-memory
 * `WorkflowFile` fixtures — no filesystem, no network.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  _resetSuppressionCommitAuthors as _clearSuppressionCommitAuthors,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
  setSuppressionCommitAuthors as _setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { scanGitleaksDrift } from "../lib/gitleaks_drift_scanner.ts";
import { PINNED_ACTIONS } from "../lib/pinned_actions.ts";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

/** Build a parsed workflow `WorkflowFile` from YAML text. */
function wf(
  path: string,
  rawText: string,
  kind: WorkflowFile["kind"] = "workflow",
): WorkflowFile {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawText);
  } catch {
    parsed = null;
  }
  return { path, rawText, parsed, kind };
}

const CURRENT_SHA = PINNED_ACTIONS["gitleaks/gitleaks-action"]!.sha;

/** The canonical, current gitleaks workflow this repo emits. */
const CANONICAL_TEMPLATE = WORKFLOW_SPECS.find((s) => s.id === "gitleaks")!
  .template;

/** Ids the scanner emits for `.github/workflows/gitleaks.yml`. */
const BRANCH_ID = "BP-GITLEAKS-BRANCH-gitleaks";
const STALE_ID = "BP-GITLEAKS-ACTION-STALE-gitleaks";
const NO_FALLBACK_ID = "BP-GITLEAKS-NO-FALLBACK-gitleaks";
const NO_PR_ID = "BP-GITLEAKS-NO-PR-TRIGGER-gitleaks";

/** A gitleaks job whose only scanner is the licensed action. */
function actionJob(ref: string): string {
  return `jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: gitleaks/gitleaks-action@${ref}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}

/** A gitleaks job with both the licensed action and the CLI fallback. */
function actionAndCliJob(ref: string): string {
  return `jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: gitleaks/gitleaks-action@${ref}
      - name: Gitleaks (open-source CLI fallback)
        run: |
          curl -sSfL "$url" -o "$archive"
          tar -xzf "$archive" gitleaks
          ./gitleaks git --redact --no-banner --exit-code 1 .
`;
}

const MILESTONE_FILTER = `on:
  pull_request:
    branches: [Develop, main, milestone/*]
`;

const STAR_FILTER = `on:
  pull_request:
    branches: ["*"]
`;

// ---------------------------------------------------------------------------
// Branch-filter gap
// ---------------------------------------------------------------------------

Deno.test('scanGitleaksDrift - branches ["*"] misses milestone PRs', () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${STAR_FILTER}${actionAndCliJob(CURRENT_SHA)}`,
    ),
  ];
  const findings = scanGitleaksDrift(files);
  assertEquals(findings.map((f) => f.findingId), [BRANCH_ID]);
  const finding = findings[0]!;
  assertEquals(finding.kind, "branch");
  assertEquals(finding.severity, "medium");
  assertEquals(finding.workflowPath, ".github/workflows/gitleaks.yml");
  assert(finding.suggestedFix.includes("milestone/*"));
});

Deno.test("scanGitleaksDrift - branch gap deduped against an open milestone finding", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${STAR_FILTER}${actionAndCliJob(CURRENT_SHA)}`,
    ),
  ];
  // `scanMilestoneBranchFilters` already owns the same gap for this file.
  const findings = scanGitleaksDrift(files, {
    knownOpenFindingIds: ["BP-MILESTONE-FILTER-gitleaks"],
  });
  assertEquals(findings.length, 0);
});

Deno.test("scanGitleaksDrift - milestone finding for another workflow does not dedupe", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${STAR_FILTER}${actionAndCliJob(CURRENT_SHA)}`,
    ),
  ];
  const findings = scanGitleaksDrift(files, {
    knownOpenFindingIds: ["BP-MILESTONE-FILTER-validate"],
  });
  assertEquals(findings.map((f) => f.findingId), [BRANCH_ID]);
});

// ---------------------------------------------------------------------------
// Stale action pin
// ---------------------------------------------------------------------------

Deno.test("scanGitleaksDrift - tag-pinned gitleaks-action@v2 is stale", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${MILESTONE_FILTER}${actionAndCliJob("v2")}`,
    ),
  ];
  const findings = scanGitleaksDrift(files);
  assertEquals(findings.map((f) => f.findingId), [STALE_ID]);
  const finding = findings[0]!;
  assertEquals(finding.kind, "action-stale");
  assertEquals(finding.severity, "medium");
  assert(finding.suggestedFix.includes(CURRENT_SHA));
  assert(finding.evidence.includes("v2"));
});

Deno.test("scanGitleaksDrift - a SHA pin other than the current one is stale", () => {
  const otherSha = "0".repeat(40);
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${MILESTONE_FILTER}${actionAndCliJob(otherSha)}`,
    ),
  ];
  const findings = scanGitleaksDrift(files);
  assertEquals(findings.map((f) => f.findingId), [STALE_ID]);
  assert(findings[0]!.evidence.includes(otherSha));
});

Deno.test("scanGitleaksDrift - the current SHA pin is not stale", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${MILESTONE_FILTER}${actionAndCliJob(CURRENT_SHA)}`,
    ),
  ];
  assertEquals(scanGitleaksDrift(files).length, 0);
});

// ---------------------------------------------------------------------------
// Missing licence-less CLI fallback
// ---------------------------------------------------------------------------

Deno.test("scanGitleaksDrift - action with no CLI fallback is flagged", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${MILESTONE_FILTER}${actionJob(CURRENT_SHA)}`,
    ),
  ];
  const findings = scanGitleaksDrift(files);
  assertEquals(findings.map((f) => f.findingId), [NO_FALLBACK_ID]);
  assertEquals(findings[0]!.kind, "no-fallback");
  assert(findings[0]!.whyItMatters.includes("Dependabot"));
});

Deno.test("scanGitleaksDrift - a CLI-only workflow needs no fallback finding", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks
${MILESTONE_FILTER}jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - run: gitleaks git --redact --no-banner --exit-code 1 .
`,
    ),
  ];
  assertEquals(scanGitleaksDrift(files).length, 0);
});

// ---------------------------------------------------------------------------
// No pull_request trigger
// ---------------------------------------------------------------------------

Deno.test("scanGitleaksDrift - schedule-only gitleaks workflow leaves PRs unscanned", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks
on:
  schedule:
    - cron: "0 3 * * *"
${actionAndCliJob(CURRENT_SHA)}`,
    ),
  ];
  const findings = scanGitleaksDrift(files);
  assertEquals(findings.map((f) => f.findingId), [NO_PR_ID]);
  assertEquals(findings[0]!.kind, "no-pr-trigger");
});

Deno.test("scanGitleaksDrift - schedule-only copy is fine when another gitleaks workflow gates PRs", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks-nightly.yml",
      `name: Gitleaks nightly
on:
  schedule:
    - cron: "0 3 * * *"
${actionAndCliJob(CURRENT_SHA)}`,
    ),
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${MILESTONE_FILTER}${actionAndCliJob(CURRENT_SHA)}`,
    ),
  ];
  assertEquals(scanGitleaksDrift(files).length, 0);
});

// ---------------------------------------------------------------------------
// Current template, malformed YAML, non-gitleaks workflows
// ---------------------------------------------------------------------------

Deno.test("scanGitleaksDrift - the canonical current template yields no findings", () => {
  const files = [wf(".github/workflows/gitleaks.yml", CANONICAL_TEMPLATE)];
  assertEquals(scanGitleaksDrift(files), []);
});

Deno.test("scanGitleaksDrift - malformed YAML yields nothing and does not throw", () => {
  const raw = `name: Gitleaks
on:
  pull_request:
    branches: ["*"
jobs:
  gitleaks:
      - uses: gitleaks/gitleaks-action@v2
   bad indent: [
`;
  const file = wf(".github/workflows/gitleaks.yml", raw);
  assertEquals(file.parsed, null, "fixture must be unparseable YAML");
  assertEquals(scanGitleaksDrift([file]), []);
});

Deno.test("scanGitleaksDrift - workflows that never run gitleaks are ignored", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      # We should add gitleaks here one day.
      - run: deno test
`,
    ),
  ];
  assertEquals(scanGitleaksDrift(files).length, 0);
});

Deno.test("scanGitleaksDrift - composite actions are not scanned", () => {
  const files = [
    wf(
      ".github/actions/scan/action.yml",
      `name: Scan
runs:
  using: composite
  steps:
    - uses: gitleaks/gitleaks-action@v2
      shell: bash
`,
      "composite-action",
    ),
  ];
  assertEquals(scanGitleaksDrift(files).length, 0);
});

// ---------------------------------------------------------------------------
// Suppression and dedup
// ---------------------------------------------------------------------------

Deno.test("scanGitleaksDrift - suppressedIds and knownOpenFindingIds are honoured", () => {
  const files = [
    wf(
      ".github/workflows/gitleaks.yml",
      `name: Gitleaks\n${STAR_FILTER}${actionJob("v2")}`,
    ),
  ];
  assertEquals(scanGitleaksDrift(files).length, 3);
  assertEquals(
    scanGitleaksDrift(files, { suppressedIds: [BRANCH_ID, STALE_ID] })
      .map((f) => f.findingId),
    [NO_FALLBACK_ID],
  );
  assertEquals(
    scanGitleaksDrift(files, {
      knownOpenFindingIds: [BRANCH_ID, STALE_ID, NO_FALLBACK_ID],
    }),
    [],
  );
});

Deno.test("scanGitleaksDrift - in-source suppression marker drops the finding", () => {
  // Issue #3941: the suppression author allowlist fails closed, so
  // authorise the marker author this fixture uses.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const raw = `name: Gitleaks
on:
  pull_request:
    # best-practice-ignore: ${BRANCH_ID} — author=nigel expires=2099-12-31 milestone PRs use a separate gate
    branches: ["*"]
${actionAndCliJob(CURRENT_SHA)}`;
    const files = [wf(".github/workflows/gitleaks.yml", raw)];
    assertEquals(scanGitleaksDrift(files).length, 0);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("scanGitleaksDrift - findings are sorted by stable id", () => {
  const files = [
    wf(
      ".github/workflows/zeta-secrets.yml",
      `name: Zeta\n${STAR_FILTER}${actionJob("v2")}`,
    ),
    wf(
      ".github/workflows/alpha-secrets.yml",
      `name: Alpha\n${STAR_FILTER}${actionJob("v2")}`,
    ),
  ];
  const ids = scanGitleaksDrift(files).map((f) => f.findingId);
  assertEquals([...ids].sort(), ids);
  assertEquals(ids.length, 6);
});
