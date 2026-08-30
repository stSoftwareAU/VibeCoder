/**
 * Tests for the required-status-check guidance carried by every gitleaks
 * recommendation the fleet files at a human (Issue #600, part of #566).
 *
 * Covers the three surfaces the guidance must reach:
 *   - the missing-workflow issue body (`issueBody`),
 *   - the partial-match issue body (`issueBodyPartial`),
 *   - every gitleaks drift finding's `suggestedFix`,
 *
 * plus the invariant that adding the prose did not disturb the dedup tags or
 * the drift finding ids — either would re-file every existing issue.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  checkNamesFromWorkflow,
  requiredStatusCheckSection,
} from "../lib/required_status_check_guidance.ts";
import {
  deduplicationTag,
  issueBody,
  issueBodyPartial,
  partialDeduplicationTag,
} from "../setup/workflow_sync.ts";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import { scanGitleaksDrift } from "../lib/gitleaks_drift_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

const gitleaksSpec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks")!;

/** Build a parsed workflow `WorkflowFile` from YAML text. */
function wf(path: string, rawText: string): WorkflowFile {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawText);
  } catch {
    parsed = null;
  }
  return { path, rawText, parsed, kind: "workflow" };
}

/** Assert one rendered body carries the whole human-action instruction. */
function assertCarriesGuidance(body: string, checkName: string): void {
  assert(
    body.includes("Require status checks to pass"),
    "body must name the ruleset setting to enable",
  );
  assert(
    body.includes(`\`${checkName}\``),
    `body must name the check \`${checkName}\``,
  );
  assert(
    body.includes("Settings → Rules → Rulesets"),
    "body must say where the ruleset lives",
  );
  assert(
    body.includes("default branch"),
    "body must name the default-branch ruleset target",
  );
  assert(
    body.includes("`milestone/**`"),
    "body must name the milestone ruleset target",
  );
  assert(
    body.includes(
      "A human must make this change — the worker cannot and " +
        "must not.",
    ),
    "body must state that the worker must not edit the ruleset",
  );
}

// ---------------------------------------------------------------------------
// Check-name derivation
// ---------------------------------------------------------------------------

Deno.test("checkNamesFromWorkflow - derives '<workflow> / <job>' from the canonical gitleaks template", () => {
  assertEquals(
    checkNamesFromWorkflow(
      gitleaksSpec.template,
      gitleaksSpec.suggestedFilename,
    ),
    ["Gitleaks / gitleaks"],
  );
});

Deno.test("checkNamesFromWorkflow - a job's own name: wins over its id", () => {
  const names = checkNamesFromWorkflow(
    `name: Secret Scan
on:
  pull_request:
jobs:
  scan:
    name: Leaks
    runs-on: ubuntu-latest
    steps:
      - name: not a job name
        run: echo hi
`,
    "fallback.yml",
  );
  assertEquals(names, ["Secret Scan / Leaks"]);
});

Deno.test("checkNamesFromWorkflow - one name per job, falling back to the file path when unnamed", () => {
  const names = checkNamesFromWorkflow(
    `on:
  pull_request:
jobs:
  gitleaks:
    runs-on: ubuntu-latest
  audit:
    runs-on: ubuntu-latest
`,
    ".github/workflows/gitleaks.yml",
  );
  assertEquals(names, [
    ".github/workflows/gitleaks.yml / gitleaks",
    ".github/workflows/gitleaks.yml / audit",
  ]);
});

Deno.test("checkNamesFromWorkflow - a workflow with no jobs still yields its own name", () => {
  assertEquals(
    checkNamesFromWorkflow("name: Gitleaks\non:\n  pull_request:\n", "x.yml"),
    ["Gitleaks"],
  );
});

Deno.test("requiredStatusCheckSection - fails loud when no check name is supplied", () => {
  assertThrows(
    () => requiredStatusCheckSection([]),
    Error,
    "at least one check name",
  );
  assertThrows(() => requiredStatusCheckSection(["  "]), Error);
});

Deno.test("requiredStatusCheckSection - lists every check name when a workflow reports several", () => {
  const section = requiredStatusCheckSection(["W / a", "W / b"]);
  assert(section.includes("`W / a`"));
  assert(section.includes("`W / b`"));
});

// ---------------------------------------------------------------------------
// Workflow-sync issue bodies
// ---------------------------------------------------------------------------

Deno.test("issueBody - the gitleaks missing-workflow issue tells the human how to make the check block merges", () => {
  assertCarriesGuidance(issueBody(gitleaksSpec), "Gitleaks / gitleaks");
});

Deno.test("issueBodyPartial - the gitleaks partial-match issue carries the same instructions", () => {
  const body = issueBodyPartial(gitleaksSpec, "gitleaks.yml", []);
  assertCarriesGuidance(body, "Gitleaks / gitleaks");
});

Deno.test("issueBody/issueBodyPartial - every security spec carries the guidance with its own check name", () => {
  const security = WORKFLOW_SPECS.filter((s) => s.category === "security");
  assert(security.length > 0, "expected at least one security spec");
  for (const spec of security) {
    const checkName = checkNamesFromWorkflow(
      spec.template,
      spec.suggestedFilename,
    )[0]!;
    assertCarriesGuidance(issueBody(spec), checkName);
    assertCarriesGuidance(
      issueBodyPartial(spec, spec.suggestedFilename, []),
      checkName,
    );
  }
});

Deno.test("issueBody - non-security specs are unaffected by the guidance", () => {
  const other = WORKFLOW_SPECS.find((s) => s.category !== "security")!;
  const body = issueBody(other);
  assert(!body.includes("Require status checks to pass"));
  assert(!body.includes("Make this scan block merges"));
  assert(
    !issueBodyPartial(other, other.suggestedFilename, []).includes(
      "Make this scan block merges",
    ),
  );
});

Deno.test("issueBody - dedup tags are unchanged and still appear exactly once", () => {
  assertEquals(
    deduplicationTag("gitleaks"),
    "<!-- vibe-coder:workflow-sync:gitleaks -->",
  );
  assertEquals(
    partialDeduplicationTag("gitleaks"),
    "<!-- vibe-coder:workflow-sync:partial:gitleaks -->",
  );

  const body = issueBody(gitleaksSpec);
  assertEquals(body.split(deduplicationTag("gitleaks")).length - 1, 1);
  assert(body.trimEnd().endsWith(deduplicationTag("gitleaks")));

  const partial = issueBodyPartial(gitleaksSpec, "gitleaks.yml", []);
  assertEquals(
    partial.split(partialDeduplicationTag("gitleaks")).length - 1,
    1,
  );
  assert(partial.trimEnd().endsWith(partialDeduplicationTag("gitleaks")));
});

// ---------------------------------------------------------------------------
// Drift findings
// ---------------------------------------------------------------------------

/** A stale gitleaks copy that trips every drift class the scanner has. */
const STALE_COPY = `name: Gitleaks
on:
  pull_request:
    branches: ["*"]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

Deno.test("scanGitleaksDrift - every finding's suggested fix carries the required-status-check guidance", () => {
  const findings = scanGitleaksDrift([
    wf(".github/workflows/gitleaks.yml", STALE_COPY),
  ]);
  assert(findings.length > 0, "expected drift findings for a stale copy");
  for (const finding of findings) {
    assertCarriesGuidance(finding.suggestedFix, "Gitleaks / gitleaks");
    // The class-specific fix must survive alongside the new section.
    assert(
      finding.suggestedFix.split("### Make this scan block merges").length ===
        2,
      "the guidance must appear exactly once per finding",
    );
  }
});

Deno.test("scanGitleaksDrift - the guidance names the check the scanned file actually reports", () => {
  const renamed = STALE_COPY
    .replace("name: Gitleaks", "name: Secret Scan")
    .replace("  gitleaks:\n", "  leaks:\n");
  const findings = scanGitleaksDrift([
    wf(".github/workflows/secret-scan.yml", renamed),
  ]);
  assert(findings.length > 0);
  for (const finding of findings) {
    assert(finding.suggestedFix.includes("`Secret Scan / leaks`"));
  }
});

Deno.test("scanGitleaksDrift - finding ids are unchanged by the added prose", () => {
  const ids = scanGitleaksDrift([
    wf(".github/workflows/gitleaks.yml", STALE_COPY),
  ]).map((f) => f.findingId).sort();
  assertEquals(ids, [
    "BP-GITLEAKS-ACTION-STALE-gitleaks",
    "BP-GITLEAKS-BRANCH-gitleaks",
    "BP-GITLEAKS-NO-FALLBACK-gitleaks",
  ]);
});
