/**
 * Tests for action_pin_scanner.ts — native SHA-pin pre-filer for the
 * github-actions-audit template (Issue #2501, part of #2497).
 *
 * Every test exercises the real `scanActionPins` against in-memory
 * `WorkflowFile` fixtures — no filesystem, no network.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import {
  classifyUses,
  extractUsesValue,
  scanActionPins,
} from "../lib/action_pin_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678"; // 40 hex

function wf(path: string, rawText: string): WorkflowFile {
  return { path, rawText, parsed: null, kind: "workflow" };
}

// ---------------------------------------------------------------------------
// extractUsesValue / classifyUses unit cases
// ---------------------------------------------------------------------------

Deno.test("extractUsesValue - handles list dash, quotes, and inline comments", () => {
  assertEquals(
    extractUsesValue("      - uses: actions/checkout@v4"),
    "actions/checkout@v4",
  );
  assertEquals(
    extractUsesValue("    uses: 'actions/checkout@v4'"),
    "actions/checkout@v4",
  );
  assertEquals(
    extractUsesValue('    uses: "actions/checkout@v4"'),
    "actions/checkout@v4",
  );
  assertEquals(
    extractUsesValue("      - uses: actions/checkout@v4 # pinned later"),
    "actions/checkout@v4",
  );
  assertEquals(extractUsesValue("      - run: echo hi"), null);
});

Deno.test("classifyUses - SHA pin, first-party, and local refs are exempt", () => {
  assertEquals(classifyUses(`actions/checkout@${SHA}`), null);
  assertEquals(classifyUses("stSoftwareAU/some-action@v1"), null);
  assertEquals(classifyUses("./.github/actions/setup"), null);
  assertEquals(classifyUses("docker://alpine:3.19"), null);
  // Tag pin on a third-party action is flagged.
  const parsed = classifyUses("actions/checkout@v4");
  assert(parsed !== null);
  assertEquals(parsed!.coordinate, "actions/checkout");
  assertEquals(parsed!.owner, "actions");
  assertEquals(parsed!.ref, "v4");
});

// ---------------------------------------------------------------------------
// scanActionPins — acceptance-criteria coverage
// ---------------------------------------------------------------------------

Deno.test("scanActionPins - SHA-pinned uses is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${SHA}\n`,
    ),
  ];
  assertEquals(scanActionPins(files), []);
});

Deno.test("scanActionPins - tag/branch pinned third-party action IS flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n",
    ),
  ];
  const findings = scanActionPins(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.coordinate, "actions/checkout");
  assertEquals(f.findingId, "BP-SHA-PIN-actions-checkout");
  assertEquals(f.severity, "high");
  assertEquals(f.file, ".github/workflows/ci.yml");
  assertEquals(f.lines, 4);
  assert(f.findingId.startsWith("BP-"));
});

Deno.test("scanActionPins - branch ref is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  b:\n    steps:\n      - uses: foo/bar@main\n",
    ),
  ];
  const findings = scanActionPins(files);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.callSites[0]!.ref, "main");
});

Deno.test("scanActionPins - stSoftwareAU/* carve-out is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  b:\n    steps:\n      - uses: stSoftwareAU/deploy-action@v2\n",
    ),
  ];
  assertEquals(scanActionPins(files), []);
});

Deno.test("scanActionPins - local ./ reference carve-out is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  b:\n    steps:\n      - uses: ./.github/actions/setup\n",
    ),
  ];
  assertEquals(scanActionPins(files), []);
});

Deno.test("scanActionPins - cross-repo reusable workflow is in scope", () => {
  const files = [
    wf(
      ".github/workflows/release.yml",
      "jobs:\n  call:\n    uses: org/repo/.github/workflows/build.yml@v1\n",
    ),
  ];
  const findings = scanActionPins(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.coordinate, "org/repo/.github/workflows/build.yml");
  assertEquals(f.findingId, "BP-SHA-PIN-org-repo-github-workflows-build-yml");
});

Deno.test("scanActionPins - consolidates multiple call-sites into one finding", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n  b:\n    steps:\n      - uses: actions/checkout@v3\n",
    ),
    wf(
      ".github/workflows/release.yml",
      "jobs:\n  c:\n    steps:\n      - uses: actions/checkout@v4\n",
    ),
  ];
  const findings = scanActionPins(files);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.coordinate, "actions/checkout");
  assertEquals(f.callSites.length, 3);
  // Evidence lists every call-site.
  assert(f.evidence.includes(".github/workflows/ci.yml`:4"));
  assert(f.evidence.includes(".github/workflows/ci.yml`:7"));
  assert(f.evidence.includes(".github/workflows/release.yml`:4"));
  assert(f.evidence.includes("3 call-sites"));
});

Deno.test("scanActionPins - in-source best-practice-ignore suppresses the finding", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  try {
    const findingId = "BP-SHA-PIN-actions-checkout";
    const files = [
      wf(
        ".github/workflows/ci.yml",
        `jobs:\n  b:\n    steps:\n      # best-practice-ignore: ${findingId} — author=nigel expires=2099-12-31 pinned by trusted mirror\n      - uses: actions/checkout@v4\n`,
      ),
    ];
    assertEquals(scanActionPins(files), []);
  } finally {
    _clearSuppressionAllowlist();
  }
});

Deno.test("scanActionPins - knownOpenFindingIds and suppressedIds are skipped", () => {
  const body = "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n";
  const known = scanActionPins([wf(".github/workflows/ci.yml", body)], {
    knownOpenFindingIds: ["BP-SHA-PIN-actions-checkout"],
  });
  assertEquals(known, []);

  const suppressed = scanActionPins([wf(".github/workflows/ci.yml", body)], {
    suppressedIds: ["BP-SHA-PIN-actions-checkout"],
  });
  assertEquals(suppressed, []);
});

Deno.test("scanActionPins - distinct coordinates yield distinct findings sorted by id", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  b:\n    steps:\n      - uses: zzz/last@v1\n      - uses: aaa/first@v1\n",
    ),
  ];
  const findings = scanActionPins(files);
  assertEquals(findings.length, 2);
  assertEquals(findings[0]!.findingId, "BP-SHA-PIN-aaa-first");
  assertEquals(findings[1]!.findingId, "BP-SHA-PIN-zzz-last");
});
