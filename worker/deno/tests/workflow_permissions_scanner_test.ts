/**
 * Tests for workflow_permissions_scanner.ts — native least-privilege
 * `permissions:` pre-filer for the github-actions-audit template
 * (Issue #2502, part of #2497).
 *
 * Every test exercises the real `scanWorkflowPermissions` against
 * in-memory `WorkflowFile` fixtures — no filesystem, no network.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  _resetSuppressionCommitAuthors as _clearSuppressionCommitAuthors,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
  setSuppressionCommitAuthors as _setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { scanWorkflowPermissions } from "../lib/workflow_permissions_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

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

// ---------------------------------------------------------------------------
// (a) Missing-block detection
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowPermissions - no permissions anywhere is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    ),
  ];
  const findings = scanWorkflowPermissions(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.kind, "missing-block");
  assertEquals(f.scope, "job");
  assertEquals(f.job, "build");
  assertEquals(f.severity, "medium");
  assertEquals(f.findingId, "BP-PERMISSIONS-ci-build");
  assert(f.findingId.startsWith("BP-"));
});

Deno.test("scanWorkflowPermissions - scoped top-level block is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    ),
  ];
  assertEquals(scanWorkflowPermissions(files), []);
});

Deno.test("scanWorkflowPermissions - scoped job-level block is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - run: echo hi\n",
    ),
  ];
  assertEquals(scanWorkflowPermissions(files), []);
});

Deno.test("scanWorkflowPermissions - empty top-level block ({}) is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\npermissions: {}\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
    ),
  ];
  assertEquals(scanWorkflowPermissions(files), []);
});

Deno.test("scanWorkflowPermissions - one finding per uncovered job", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\njobs:\n  build:\n    steps:\n      - run: echo a\n  test:\n    permissions:\n      contents: read\n    steps:\n      - run: echo b\n  deploy:\n    steps:\n      - run: echo c\n",
    ),
  ];
  const findings = scanWorkflowPermissions(files);
  const jobs = findings.map((f) => f.job).sort();
  // `test` has its own scoped block → not flagged; `build` and `deploy` are.
  assertEquals(jobs, ["build", "deploy"]);
});

// ---------------------------------------------------------------------------
// (b) write-all detection
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowPermissions - top-level write-all is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\npermissions: write-all\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
    ),
  ];
  const findings = scanWorkflowPermissions(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.kind, "write-all");
  assertEquals(f.scope, "top");
  assertEquals(f.findingId, "BP-PERMISSIONS-ci");
});

Deno.test("scanWorkflowPermissions - job-level write-all is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\npermissions:\n  contents: read\njobs:\n  build:\n    permissions: write-all\n    steps:\n      - run: echo hi\n",
    ),
  ];
  const findings = scanWorkflowPermissions(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.kind, "write-all");
  assertEquals(f.scope, "job");
  assertEquals(f.job, "build");
  assertEquals(f.findingId, "BP-PERMISSIONS-ci-build");
});

Deno.test("scanWorkflowPermissions - write-all takes precedence over missing-block for a job", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\njobs:\n  build:\n    permissions: write-all\n    steps:\n      - run: echo hi\n",
    ),
  ];
  const findings = scanWorkflowPermissions(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.kind, "write-all");
});

// ---------------------------------------------------------------------------
// Suppression and dedup
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowPermissions - in-source suppression marker is honoured", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const files = [
      wf(
        ".github/workflows/ci.yml",
        "name: CI\npermissions: write-all # best-practice-ignore: BP-PERMISSIONS-ci — author=nigel expires=2099-12-31 root token by design\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
      ),
    ];
    assertEquals(scanWorkflowPermissions(files), []);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("scanWorkflowPermissions - knownOpenFindingIds are skipped", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\npermissions: write-all\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
    ),
  ];
  assertEquals(
    scanWorkflowPermissions(files, {
      knownOpenFindingIds: ["BP-PERMISSIONS-ci"],
    }),
    [],
  );
});

Deno.test("scanWorkflowPermissions - suppressedIds are skipped", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "name: CI\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
    ),
  ];
  assertEquals(
    scanWorkflowPermissions(files, {
      suppressedIds: ["BP-PERMISSIONS-ci-build"],
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Scope and robustness
// ---------------------------------------------------------------------------

Deno.test("scanWorkflowPermissions - composite actions are ignored", () => {
  const files: WorkflowFile[] = [
    {
      path: ".github/actions/setup/action.yml",
      rawText:
        "name: setup\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n",
      parsed: { name: "setup" },
      kind: "composite-action",
    },
  ];
  assertEquals(scanWorkflowPermissions(files), []);
});

Deno.test("scanWorkflowPermissions - unparseable workflow yields no finding", () => {
  const files: WorkflowFile[] = [
    {
      path: ".github/workflows/broken.yml",
      rawText: ":::not yaml:::",
      parsed: null,
      kind: "workflow",
    },
  ];
  assertEquals(scanWorkflowPermissions(files), []);
});

Deno.test("scanWorkflowPermissions - findings are sorted by stable id", () => {
  const files = [
    wf(
      ".github/workflows/zeta.yml",
      "name: Z\njobs:\n  build:\n    steps:\n      - run: echo z\n",
    ),
    wf(
      ".github/workflows/alpha.yml",
      "name: A\njobs:\n  build:\n    steps:\n      - run: echo a\n",
    ),
  ];
  const ids = scanWorkflowPermissions(files).map((f) => f.findingId);
  assertEquals(ids, [
    "BP-PERMISSIONS-alpha-build",
    "BP-PERMISSIONS-zeta-build",
  ]);
});
