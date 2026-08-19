/**
 * Tests for workflow_trigger_scanner.ts — native push-to-default trigger
 * pre-filer for the github-actions-audit template (Issue #2587, part of
 * #2561).
 *
 * Every test exercises the real `scanWorkflowTriggers` against in-memory
 * `WorkflowFile` fixtures — no filesystem, no network.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { scanWorkflowTriggers } from "../lib/workflow_trigger_scanner.ts";
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

const TEST_JOB =
  "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: deno test\n";
const DEPLOY_JOB =
  "jobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n";

// ---------------------------------------------------------------------------
// Positive: test/lint workflow with push to default
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowTriggers - test workflow with bare push to default is flagged", () => {
  const files = [
    wf(".github/workflows/ci.yml", `name: CI\non: push\n${TEST_JOB}`),
  ];
  const findings = scanWorkflowTriggers(files, { defaultBranch: "main" });
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.findingId, "BP-TRIGGER-ci");
  assert(f.findingId.startsWith("BP-"));
  assertEquals(f.severity, "low");
  assertEquals(f.workflowPath, ".github/workflows/ci.yml");
});

Deno.test("scanWorkflowTriggers - push branches list matching default is flagged", () => {
  const files = [
    wf(
      ".github/workflows/lint.yml",
      `name: Lint\non:\n  push:\n    branches: [main]\n  pull_request:\n${TEST_JOB}`,
    ),
  ];
  const findings = scanWorkflowTriggers(files, { defaultBranch: "main" });
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.findingId, "BP-TRIGGER-lint");
});

Deno.test("scanWorkflowTriggers - push array form including push is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non: [push, pull_request]\n${TEST_JOB}`,
    ),
  ];
  assertEquals(
    scanWorkflowTriggers(files, { defaultBranch: "main" }).length,
    1,
  );
});

Deno.test("scanWorkflowTriggers - branches glob matching default is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches: ['*']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(
    scanWorkflowTriggers(files, { defaultBranch: "main" }).length,
    1,
  );
});

Deno.test("scanWorkflowTriggers - branches-ignore not excluding default is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches-ignore: [dependabot/**]\n${TEST_JOB}`,
    ),
  ];
  assertEquals(
    scanWorkflowTriggers(files, { defaultBranch: "main" }).length,
    1,
  );
});

Deno.test("scanWorkflowTriggers - single-char '?' glob matching default is flagged", () => {
  // Exercises the `any` GlobToken branch of the branch-matcher switch:
  // `mai?` matches `main` via three `lit` tokens plus one `?` (`any`).
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches: ['mai?']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(
    scanWorkflowTriggers(files, { defaultBranch: "main" }).length,
    1,
  );
});

Deno.test("scanWorkflowTriggers - single-char '?' glob NOT matching default is NOT flagged", () => {
  // `mai?` is exactly four characters, so it cannot match the five-character
  // `maint` default branch — the `any` token consumes a single character only.
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches: ['mai?']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "maint" }), []);
});

// ---------------------------------------------------------------------------
// Negative: deploy / ambiguous workflows
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowTriggers - deploy workflow with push to default is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/publish.yml",
      `name: Publish\non: push\n${DEPLOY_JOB}`,
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

Deno.test("scanWorkflowTriggers - ambiguous workflow (test + deploy) is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\non: push\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: deno test\n      - run: npm publish\n",
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

Deno.test("scanWorkflowTriggers - unrecognised workflow (no signatures) is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/misc.yml",
      "name: Misc\non: push\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hello\n",
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

// ---------------------------------------------------------------------------
// Negative: push does not reach the default branch
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowTriggers - PR-only test workflow is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  pull_request:\n  workflow_dispatch:\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

Deno.test("scanWorkflowTriggers - push branches NOT matching default is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches: [release/**]\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

Deno.test("scanWorkflowTriggers - push tags-only is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    tags: ['v*']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

Deno.test("scanWorkflowTriggers - branches-ignore excluding default is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches-ignore: [main]\n${TEST_JOB}`,
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

// ---------------------------------------------------------------------------
// Default-branch awareness (non-`main` default)
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowTriggers - honours a non-main default branch", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches: [master]\n${TEST_JOB}`,
    ),
  ];
  // Default is `main`, the filter targets `master` → not flagged.
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
  // Default is `master` → flagged.
  assertEquals(
    scanWorkflowTriggers(files, { defaultBranch: "master" }).length,
    1,
  );
});

Deno.test("scanWorkflowTriggers - no default branch yields no findings", () => {
  const files = [
    wf(".github/workflows/ci.yml", `name: CI\non: push\n${TEST_JOB}`),
  ];
  assertEquals(scanWorkflowTriggers(files, {}), []);
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "  " }), []);
});

// ---------------------------------------------------------------------------
// Dedup / suppression
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowTriggers - knownOpenFindingIds dedup drops the finding", () => {
  const files = [
    wf(".github/workflows/ci.yml", `name: CI\non: push\n${TEST_JOB}`),
  ];
  assertEquals(
    scanWorkflowTriggers(files, {
      defaultBranch: "main",
      knownOpenFindingIds: ["BP-TRIGGER-ci"],
    }),
    [],
  );
});

Deno.test("scanWorkflowTriggers - suppressedIds drops the finding", () => {
  const files = [
    wf(".github/workflows/ci.yml", `name: CI\non: push\n${TEST_JOB}`),
  ];
  assertEquals(
    scanWorkflowTriggers(files, {
      defaultBranch: "main",
      suppressedIds: ["BP-TRIGGER-ci"],
    }),
    [],
  );
});

Deno.test("scanWorkflowTriggers - in-source best-practice-ignore marker drops the finding", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  try {
    const files = [
      wf(
        ".github/workflows/ci.yml",
        `name: CI\non:\n  # best-practice-ignore: BP-TRIGGER-ci — author=nigel expires=2099-12-31 push kept deliberately\n  push:\n    branches: [main]\n${TEST_JOB}`,
      ),
    ];
    assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
  } finally {
    _clearSuppressionAllowlist();
  }
});

// ---------------------------------------------------------------------------
// Misc robustness
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowTriggers - composite actions are ignored", () => {
  const files = [
    wf(
      ".github/actions/foo/action.yml",
      `name: Foo\non: push\n${TEST_JOB}`,
      "composite-action",
    ),
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

Deno.test("scanWorkflowTriggers - unparseable workflow yields no finding", () => {
  const files: WorkflowFile[] = [
    {
      path: ".github/workflows/ci.yml",
      rawText: "name: CI\n  on: ][",
      parsed: null,
      kind: "workflow",
    },
  ];
  assertEquals(scanWorkflowTriggers(files, { defaultBranch: "main" }), []);
});

// ---------------------------------------------------------------------------
// Branch-glob token kinds: exercise every GlobToken variant through the
// public API so the exhaustiveness-guarded switch (Issue #2895) keeps
// matching `lit`, `any`, `star`, and `globstar` correctly.
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowTriggers - branch glob exercises every GlobToken kind", () => {
  // Each pattern matches the default branch "main" via a different token
  // kind: literal, `?` (any), `*` (star), and `**` (globstar).
  for (const pattern of ["main", "mai?", "m*n", "m**"]) {
    const files = [
      wf(
        ".github/workflows/ci.yml",
        `name: CI\non:\n  push:\n    branches: ['${pattern}']\n${TEST_JOB}`,
      ),
    ];
    assertEquals(
      scanWorkflowTriggers(files, { defaultBranch: "main" }).length,
      1,
      `pattern '${pattern}' should match default branch main`,
    );
  }
});

Deno.test("scanWorkflowTriggers - star does not match across a slash", () => {
  // `*` matches any run except `/`, so it must not match a slashed branch.
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches: ['feat*']\n${TEST_JOB}`,
    ),
  ];
  assertEquals(
    scanWorkflowTriggers(files, { defaultBranch: "feat/x" }).length,
    0,
    "star must not match across a slash",
  );
});

Deno.test("scanWorkflowTriggers - findings sorted by stable id", () => {
  const files = [
    wf(".github/workflows/zeta.yml", `name: Z\non: push\n${TEST_JOB}`),
    wf(".github/workflows/alpha.yml", `name: A\non: push\n${TEST_JOB}`),
  ];
  const ids = scanWorkflowTriggers(files, { defaultBranch: "main" }).map((f) =>
    f.findingId
  );
  assertEquals(ids, ["BP-TRIGGER-alpha", "BP-TRIGGER-zeta"]);
});

// ---------------------------------------------------------------------------
// Line anchor: inline `on: push` is anchored to the `on:` line, block form to
// the nested `push:` line (Issue #3481 — inline branch made genuinely live).
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowTriggers - inline on: push anchors to the on: line", () => {
  const files = [
    wf(".github/workflows/ci.yml", `name: CI\non: push\n${TEST_JOB}`),
  ];
  const findings = scanWorkflowTriggers(files, { defaultBranch: "main" });
  assertEquals(findings.length, 1);
  // `on:` is the second source line.
  assertEquals(findings[0]!.lines, 2);
});

Deno.test("scanWorkflowTriggers - inline on: [push] anchors to the on: line", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\n# comment\non: [push, pull_request]\n${TEST_JOB}`,
    ),
  ];
  const findings = scanWorkflowTriggers(files, { defaultBranch: "main" });
  assertEquals(findings.length, 1);
  // `on:` is the third source line (after name + comment).
  assertEquals(findings[0]!.lines, 3);
});

Deno.test("scanWorkflowTriggers - block push: anchors to the nested push line", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI\non:\n  push:\n    branches: [main]\n${TEST_JOB}`,
    ),
  ];
  const findings = scanWorkflowTriggers(files, { defaultBranch: "main" });
  assertEquals(findings.length, 1);
  // Nested `push:` is the third source line.
  assertEquals(findings[0]!.lines, 3);
});
