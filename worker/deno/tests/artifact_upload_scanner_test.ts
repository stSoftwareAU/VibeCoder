/**
 * Tests for artifact_upload_scanner.ts — native broad-artefact-upload
 * pre-filer for the github-actions-audit template (Issue #2846, gap from
 * #2834).
 *
 * Every test exercises the real `scanArtifactUploads` /
 * `isBroadArtifactPath` / `extractTriggerEvents` / `secretsInScope` against
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
import {
  extractTriggerEvents,
  isBroadArtifactPath,
  isBroadPathEntry,
  scanArtifactUploads,
  secretsInScope,
  workflowHasPrivilegedTrigger,
} from "../lib/artifact_upload_scanner.ts";
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

// ---------------------------------------------------------------------------
// isBroadPathEntry / isBroadArtifactPath
// ---------------------------------------------------------------------------

Deno.test("isBroadPathEntry - whole-workspace tokens are broad", () => {
  for (const v of [".", "./", "*", "**", "${{ github.workspace }}"]) {
    assert(isBroadPathEntry(v), `${v} should be broad`);
  }
  assert(isBroadPathEntry("${{github.workspace}}/"));
});

Deno.test("isBroadPathEntry - scoped paths are NOT broad", () => {
  for (
    const v of ["dist/", "target/release/bin", "coverage", "build/out.txt"]
  ) {
    assertEquals(isBroadPathEntry(v), false, `${v} should not be broad`);
  }
});

Deno.test("isBroadArtifactPath - multi-line block flags any broad line", () => {
  assert(isBroadArtifactPath("dist/\n.\n"));
  assert(isBroadArtifactPath("logs/\n${{ github.workspace }}"));
  assertEquals(isBroadArtifactPath("dist/\ncoverage/\n"), false);
});

Deno.test("isBroadArtifactPath - non-string yields false", () => {
  assertEquals(isBroadArtifactPath(undefined), false);
  assertEquals(isBroadArtifactPath(42), false);
});

// ---------------------------------------------------------------------------
// extractTriggerEvents / workflowHasPrivilegedTrigger
// ---------------------------------------------------------------------------

Deno.test("extractTriggerEvents - scalar, array, and map forms", () => {
  assertEquals(extractTriggerEvents({ on: "push" }), ["push"]);
  assertEquals(extractTriggerEvents({ on: ["push", "pull_request"] }), [
    "push",
    "pull_request",
  ]);
  assertEquals(
    extractTriggerEvents({ on: { pull_request_target: null, push: null } }),
    ["pull_request_target", "push"],
  );
  assertEquals(extractTriggerEvents("nope"), []);
});

Deno.test("workflowHasPrivilegedTrigger - detects the privileged set", () => {
  assert(workflowHasPrivilegedTrigger({ on: "workflow_run" }));
  assert(workflowHasPrivilegedTrigger({ on: ["push", "pull_request_target"] }));
  // Review events added in Issue #2847 — they run with secrets + write token
  // and carry an attacker-influenced review body.
  assert(workflowHasPrivilegedTrigger({ on: "pull_request_review" }));
  assert(
    workflowHasPrivilegedTrigger({
      on: ["push", "pull_request_review_comment"],
    }),
  );
  assertEquals(workflowHasPrivilegedTrigger({ on: "pull_request" }), false);
  assertEquals(workflowHasPrivilegedTrigger({ on: "push" }), false);
});

// ---------------------------------------------------------------------------
// secretsInScope
// ---------------------------------------------------------------------------

Deno.test("secretsInScope - job env / step / workflow env references", () => {
  // Job-level env.
  assert(
    secretsInScope({}, {
      env: { TOKEN: "${{ secrets.MY_TOKEN }}" },
      steps: [],
    }),
  );
  // Step-level reference inside the job subtree.
  assert(
    secretsInScope({}, {
      steps: [{ run: "echo ${{ secrets.NPM_TOKEN }}" }],
    }),
  );
  // Workflow-level env.
  assert(
    secretsInScope({ env: { K: "${{ secrets.K }}" } }, { steps: [] }),
  );
  // No secrets anywhere.
  assertEquals(secretsInScope({}, { steps: [{ run: "deno test" }] }), false);
});

// ---------------------------------------------------------------------------
// scanArtifactUploads — positive cases
// ---------------------------------------------------------------------------

Deno.test("scan - `path: .` on a plain push workflow is low severity", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-artifact@v4
        with:
          name: everything
          path: .
`,
    ),
  ];
  const findings = scanArtifactUploads(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.severity, "low");
  assertEquals(f.job, "build");
  assertEquals(f.stepIndex, 1);
  assertEquals(f.findingId, "BP-ARTIFACT-UPLOAD-ci-build-1");
  assert(f.findingId.startsWith("BP-"));
  // Citation anchored to the upload-artifact uses line (line 8).
  assertEquals(f.lines, 8);
});

Deno.test("scan - broad upload escalates to medium under a privileged trigger", () => {
  const files = [
    wf(
      ".github/workflows/pr.yml",
      `name: PR
on: pull_request_target
jobs:
  build:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: ./
`,
    ),
  ];
  const findings = scanArtifactUploads(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.severity, "medium");
});

Deno.test("scan - broad upload escalates to medium when the job has secrets", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: push
jobs:
  build:
    env:
      TOKEN: \${{ secrets.DEPLOY_TOKEN }}
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: \${{ github.workspace }}
`,
    ),
  ];
  const findings = scanArtifactUploads(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.severity, "medium");
});

Deno.test("scan - multi-line path with a broad entry is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: push
jobs:
  build:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: |
            dist/
            .
`,
    ),
  ];
  const findings = scanArtifactUploads(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.severity, "low");
});

// ---------------------------------------------------------------------------
// scanArtifactUploads — negative cases
// ---------------------------------------------------------------------------

Deno.test("scan - a scoped path is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: push
jobs:
  build:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
`,
    ),
  ];
  assertEquals(scanArtifactUploads(files), []);
});

Deno.test("scan - upload-artifact with no path is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: push
jobs:
  build:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: dist
`,
    ),
  ];
  assertEquals(scanArtifactUploads(files), []);
});

Deno.test("scan - a different action with `path: .` is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: push
jobs:
  build:
    steps:
      - uses: actions/cache@v4
        with:
          path: .
          key: x
`,
    ),
  ];
  assertEquals(scanArtifactUploads(files), []);
});

Deno.test("scan - composite-action files are ignored", () => {
  const files = [
    wf(
      ".github/actions/x/action.yml",
      `runs:
  using: composite
  steps:
    - uses: actions/upload-artifact@v4
      with:
        path: .
`,
      "composite-action",
    ),
  ];
  assertEquals(scanArtifactUploads(files), []);
});

Deno.test("scan - unparseable / non-record workflow yields no finding", () => {
  const files = [
    {
      path: ".github/workflows/bad.yml",
      rawText: ":\n  bad",
      parsed: null,
      kind: "workflow" as const,
    },
  ];
  assertEquals(scanArtifactUploads(files), []);
});

// ---------------------------------------------------------------------------
// Dedup + suppression
// ---------------------------------------------------------------------------

Deno.test("scan - knownOpenFindingIds suppresses the finding", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: push
jobs:
  build:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: .
`,
    ),
  ];
  assertEquals(
    scanArtifactUploads(files, {
      knownOpenFindingIds: ["BP-ARTIFACT-UPLOAD-ci-build-0"],
    }),
    [],
  );
});

Deno.test("scan - in-source best-practice-ignore marker suppresses the finding", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const files = [
      wf(
        ".github/workflows/ci.yml",
        `name: CI
  on: push
  jobs:
    build:
      steps:
        # best-practice-ignore: BP-ARTIFACT-UPLOAD-ci-build-0 — author=nigel expires=2099-12-31 intentional full upload
        - uses: actions/upload-artifact@v4
          with:
            path: .
  `,
      ),
    ];
    assertEquals(scanArtifactUploads(files), []);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("scan - two flaggable jobs both produce findings, sorted by id", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `name: CI
on: push
jobs:
  test:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: .
  build:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: ./
`,
    ),
  ];
  const findings = scanArtifactUploads(files);
  assertEquals(findings.length, 2);
  // Sorted by stable id: "...-build-0" < "...-test-0".
  assertEquals(findings[0]!.findingId, "BP-ARTIFACT-UPLOAD-ci-build-0");
  assertEquals(findings[1]!.findingId, "BP-ARTIFACT-UPLOAD-ci-test-0");
});
