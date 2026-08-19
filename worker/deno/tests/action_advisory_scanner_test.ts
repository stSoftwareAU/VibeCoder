/**
 * Tests for the GHSA cross-check of pinned GitHub Actions (Issue #4405,
 * GHA-SUPPLY-018).
 *
 * The audit verified pin SHAPE and staleness but never asked the advisory
 * database whether a pinned action has a disclosed, unpatched
 * vulnerability. This scanner enumerates every third-party `uses:`
 * coordinate and queries `gh api /advisories?ecosystem=actions&affects=…`
 * once per coordinate; a match becomes a `github-actions-audit` finding.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  buildAdvisoryArgs,
  scanActionAdvisories,
} from "../lib/action_advisory_scanner.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

function wf(path: string, rawText: string): WorkflowFile {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawText);
  } catch {
    parsed = null;
  }
  return { path, rawText, parsed, kind: "workflow" };
}

const CI = wf(
  ".github/workflows/ci.yml",
  `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # actions/checkout@v7.0.1
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - uses: tj-actions/changed-files@0123456789012345678901234567890123456789
      - uses: ./.github/actions/local
      - uses: example-org/private-repo-25@v1
      - uses: docker://alpine:3.20
`,
);

const ADVISORY = {
  ghsa_id: "GHSA-mrrh-fwg8-r2c3",
  cve_id: "CVE-2025-30066",
  summary: "tj-actions/changed-files leaks secrets via malicious commit",
  severity: "high",
  html_url: "https://github.com/advisories/GHSA-mrrh-fwg8-r2c3",
  published_at: "2025-03-15T00:00:00Z",
  vulnerabilities: [
    {
      package: { ecosystem: "actions", name: "tj-actions/changed-files" },
      vulnerable_version_range: "<= 45.0.7",
      first_patched_version: "46.0.1",
    },
  ],
};

Deno.test("buildAdvisoryArgs - one paginated GHSA query per coordinate, ecosystem actions (Issue #4405)", () => {
  assertEquals(buildAdvisoryArgs("actions/checkout"), [
    "api",
    "/advisories?ecosystem=actions&affects=actions%2Fcheckout&per_page=100",
    "--paginate",
  ]);
});

Deno.test("scanActionAdvisories - a coordinate with a disclosed advisory becomes one finding, queried once per coordinate (Issue #4405)", async () => {
  const queried: string[] = [];
  const findings = await scanActionAdvisories([CI], {
    ghCommandFn: (args) => {
      queried.push(args[1] ?? "");
      if (args[1]?.includes("tj-actions%2Fchanged-files")) {
        return Promise.resolve(JSON.stringify([ADVISORY]));
      }
      return Promise.resolve("[]");
    },
  });
  // Third-party coordinates only: local (`./`), first-party (stSoftwareAU/*)
  // and docker:// references are not queried; checkout is queried once
  // despite two call sites.
  assertEquals(queried.length, 2, JSON.stringify(queried));
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.coordinate, "tj-actions/changed-files");
  assertEquals(
    f.findingId,
    "BP-GHSA-tj-actions-changed-files-GHSA-mrrh-fwg8-r2c3",
  );
  assertEquals(f.severity, "high");
  assert(f.title.includes("GHSA-mrrh-fwg8-r2c3"), f.title);
  assertEquals(f.file, ".github/workflows/ci.yml");
  assertEquals(f.lines, 10);
  assert(f.whyItMatters.includes("46.0.1"), f.whyItMatters);
  assert(f.evidence?.includes("CVE-2025-30066"), f.evidence);
});

Deno.test("scanActionAdvisories - clean coordinates produce no findings; a known-open id is skipped (Issue #4405)", async () => {
  const none = await scanActionAdvisories([CI], {
    ghCommandFn: () => Promise.resolve("[]"),
  });
  assertEquals(none, []);
  const skipped = await scanActionAdvisories([CI], {
    ghCommandFn: (args) =>
      Promise.resolve(
        args[1]?.includes("tj-actions") ? JSON.stringify([ADVISORY]) : "[]",
      ),
    knownOpenFindingIds: [
      "BP-GHSA-tj-actions-changed-files-GHSA-mrrh-fwg8-r2c3",
    ],
  });
  assertEquals(skipped, []);
});

Deno.test("scanActionAdvisories - a failed or malformed lookup is reported, never a false clean (Issue #4405)", async () => {
  const result = await scanActionAdvisories([CI], {
    ghCommandFn: (args) => {
      if (args[1]?.includes("checkout")) {
        return Promise.reject(new Error("HTTP 403"));
      }
      return Promise.resolve("not json");
    },
    onLookupFailure: (coordinate, reason) => {
      failures.push(`${coordinate}: ${reason}`);
    },
  });
  assertEquals(result, []);
  assertEquals(failures.length, 2, JSON.stringify(failures));
  assert(failures.some((f) => f.startsWith("actions/checkout: HTTP 403")));
});
const failures: string[] = [];

Deno.test("scanActionAdvisories - severity maps GHSA bands onto the audit's three (Issue #4405)", async () => {
  const low = { ...ADVISORY, ghsa_id: "GHSA-low0-0000-0000", severity: "low" };
  const critical = {
    ...ADVISORY,
    ghsa_id: "GHSA-crit-0000-0000",
    severity: "critical",
  };
  const findings = await scanActionAdvisories([CI], {
    ghCommandFn: (args) =>
      Promise.resolve(
        args[1]?.includes("tj-actions")
          ? JSON.stringify([low, critical])
          : "[]",
      ),
  });
  assertEquals(findings.map((f) => f.severity).sort(), ["high", "low"]);
});
