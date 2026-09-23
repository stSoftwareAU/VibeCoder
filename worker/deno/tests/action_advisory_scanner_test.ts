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
      - uses: stSoftwareAU/internal-action@v1
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

// --- Advisories already remediated at every call site (Issue #2523) --------

/** The SHA `aquasecurity/trivy-action@v0.36.0` actually points at. */
const TRIVY_SHA = "ed142fd0673e97e23eac54620cfb913e5ce36c25";

const TRIVY_ADVISORY = {
  ghsa_id: "GHSA-69fq-xp46-6x23",
  cve_id: "CVE-2026-33634",
  summary: "Trivy ecosystem supply chain was briefly compromised",
  severity: "critical",
  html_url: "https://github.com/advisories/GHSA-69fq-xp46-6x23",
  published_at: "2026-03-24T17:53:12Z",
  vulnerabilities: [
    {
      package: { ecosystem: "actions", name: "aquasecurity/trivy-action" },
      vulnerable_version_range: "< 0.35.0",
      first_patched_version: "0.35.0",
    },
  ],
};

/** A one-step workflow pinning trivy-action, optionally annotated. */
function trivyWorkflow(comment: string | null, sha = TRIVY_SHA): WorkflowFile {
  const lines = [
    "name: audit",
    "on: [push]",
    "jobs:",
    "  sbom:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...(comment === null ? [] : [`      ${comment}`]),
    `      - uses: aquasecurity/trivy-action@${sha}`,
    "",
  ];
  return wf(".github/workflows/dependency-audit.yml", lines.join("\n"));
}

/** Stub `gh`: the advisory query, plus tag→SHA resolution from `tags`. */
function trivyGh(
  tags: Record<string, string>,
  advisory: unknown = TRIVY_ADVISORY,
): { fn: (args: string[]) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: (args: string[]) => {
      const target = args[1] ?? "";
      calls.push(target);
      if (target.startsWith("repos/")) {
        const tag = target.split("/commits/")[1] ?? "";
        const sha = tags[tag];
        return sha === undefined
          ? Promise.reject(new Error("HTTP 404"))
          : Promise.resolve(`${sha}\n`);
      }
      return Promise.resolve(
        target.includes("trivy-action") ? JSON.stringify([advisory]) : "[]",
      );
    },
  };
}

Deno.test("scanActionAdvisories - an advisory already patched at every call site is not filed, and the tag is resolved once (Issue #2523)", async () => {
  const gh = trivyGh({ "v0.36.0": TRIVY_SHA });
  const findings = await scanActionAdvisories(
    [trivyWorkflow("# aquasecurity/trivy-action@v0.36.0")],
    { ghCommandFn: gh.fn },
  );
  assertEquals(findings, []);
  assertEquals(
    gh.calls.filter((c) => c.startsWith("repos/")),
    ["repos/aquasecurity/trivy-action/commits/v0.36.0"],
  );
});

Deno.test("scanActionAdvisories - a pin below the patched version is still filed (Issue #2523)", async () => {
  const gh = trivyGh({ "v0.34.0": TRIVY_SHA });
  const findings = await scanActionAdvisories(
    [trivyWorkflow("# aquasecurity/trivy-action@v0.34.0")],
    { ghCommandFn: gh.fn },
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.ghsaId, "GHSA-69fq-xp46-6x23");
});

Deno.test("scanActionAdvisories - a pin with no version comment is still filed: an unannotated SHA proves nothing (Issue #2523)", async () => {
  const gh = trivyGh({ "v0.36.0": TRIVY_SHA });
  const findings = await scanActionAdvisories([trivyWorkflow(null)], {
    ghCommandFn: gh.fn,
  });
  assertEquals(findings.length, 1);
});

Deno.test("scanActionAdvisories - a version comment that does not resolve to the pinned SHA is still filed (Issue #2523)", async () => {
  // The comment claims v0.36.0, but that tag points somewhere else — the
  // annotation is wrong, so the pin is not proven patched.
  const gh = trivyGh({ "v0.36.0": "a".repeat(40) });
  const findings = await scanActionAdvisories(
    [trivyWorkflow("# aquasecurity/trivy-action@v0.36.0")],
    { ghCommandFn: gh.fn },
  );
  assertEquals(findings.length, 1);

  // Same shape when the tag cannot be resolved at all (404, rate limit, …).
  const unresolved = await scanActionAdvisories(
    [trivyWorkflow("# aquasecurity/trivy-action@v0.36.0")],
    { ghCommandFn: trivyGh({}).fn },
  );
  assertEquals(unresolved.length, 1);
});

Deno.test("scanActionAdvisories - an advisory with no first patched version is always filed (Issue #2523)", async () => {
  const unpatched = {
    ...TRIVY_ADVISORY,
    vulnerabilities: [
      {
        package: { ecosystem: "actions", name: "aquasecurity/trivy-action" },
        vulnerable_version_range: ">= 0",
        first_patched_version: null,
      },
    ],
  };
  const gh = trivyGh({ "v0.36.0": TRIVY_SHA }, unpatched);
  const findings = await scanActionAdvisories(
    [trivyWorkflow("# aquasecurity/trivy-action@v0.36.0")],
    { ghCommandFn: gh.fn },
  );
  assertEquals(findings.length, 1);
});

Deno.test("scanActionAdvisories - one lagging call site keeps the finding for all of them (Issue #2523)", async () => {
  const gh = trivyGh({ "v0.36.0": TRIVY_SHA, "v0.34.0": "b".repeat(40) });
  const findings = await scanActionAdvisories([
    trivyWorkflow("# aquasecurity/trivy-action@v0.36.0"),
    wf(
      ".github/workflows/scan.yml",
      `name: scan
on: [push]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      # aquasecurity/trivy-action@v0.34.0
      - uses: aquasecurity/trivy-action@${"b".repeat(40)}
`,
    ),
  ], { ghCommandFn: gh.fn });
  assertEquals(findings.length, 1);
  assert(
    findings[0]?.evidence?.includes(".github/workflows/scan.yml:8"),
    findings[0]?.evidence,
  );
});

// --- Sub-path actions and comments a bump left behind (Issue #2525) --------

/** The SHAs `github/codeql-action` v4.38.1 and v4.38.0 point at. */
const CODEQL_V4_38_1 = "1c5b675653bb5c22dbe9b12b556ec555138e09fd";
const CODEQL_V4_38_0 = "b96794f015dfd88f77b49b1c93e0fa7110f94c63";

const CODEQL_ADVISORY = {
  ghsa_id: "GHSA-vqf5-2xx6-9wfm",
  cve_id: "CVE-2025-24362",
  summary: "GitHub PAT written to debug artifacts",
  severity: "high",
  html_url: "https://github.com/advisories/GHSA-vqf5-2xx6-9wfm",
  published_at: "2025-01-24T18:44:55Z",
  vulnerabilities: [
    {
      package: { ecosystem: "actions", name: "github/codeql-action" },
      vulnerable_version_range: ">= 3.26.11, <= 3.28.2",
      first_patched_version: "3.28.3",
    },
  ],
};

/**
 * The CodeQL sweep's two sub-path call sites, both pinned to `sha` and each
 * annotated with `version` — the shape a group bump produces when it rewrites
 * the pin and leaves the comment above it alone.
 */
function codeqlWorkflow(version: string, sha: string): WorkflowFile {
  return wf(
    ".github/workflows/security-tree-sweep.yml",
    `name: security tree sweep
on: [push]
jobs:
  sweep:
    runs-on: ubuntu-latest
    steps:
      # github/codeql-action/init@${version}
      - uses: github/codeql-action/init@${sha}
      # github/codeql-action/analyze@${version}
      - uses: github/codeql-action/analyze@${sha}
`,
  );
}

/** Stub `gh`: the codeql advisory, plus tag→SHA resolution from `tags`. */
function codeqlGh(
  tags: Record<string, string>,
): { fn: (args: string[]) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fn: (args: string[]) => {
      const target = args[1] ?? "";
      calls.push(target);
      if (target.startsWith("repos/")) {
        const sha = tags[target.split("/commits/")[1] ?? ""];
        return sha === undefined
          ? Promise.reject(new Error("HTTP 404"))
          : Promise.resolve(`${sha}\n`);
      }
      return Promise.resolve(
        target.includes("codeql-action")
          ? JSON.stringify([CODEQL_ADVISORY])
          : "[]",
      );
    },
  };
}

Deno.test("scanActionAdvisories - sub-path call sites are proven patched against the parent repository's tags (Issue #2525)", async () => {
  const gh = codeqlGh({ "v4.38.1": CODEQL_V4_38_1 });
  const findings = await scanActionAdvisories(
    [codeqlWorkflow("v4.38.1", CODEQL_V4_38_1)],
    { ghCommandFn: gh.fn },
  );
  assertEquals(findings, []);
  // `github/codeql-action/init` is advised — and resolved — under the
  // repository, not under the sub-path, and once for both call sites.
  assertEquals(
    gh.calls.filter((c) => c.startsWith("repos/")),
    ["repos/github/codeql-action/commits/v4.38.1"],
  );
});

Deno.test("scanActionAdvisories - a comment a bump left behind is filed even though the pin itself is patched (Issue #2525)", async () => {
  // Both sites are pinned to v4.38.1, far beyond the patched 3.28.3, but the
  // comments still claim v4.38.0 — which resolves to a different SHA, so the
  // annotation proves nothing and the finding is filed loudly.
  const gh = codeqlGh({
    "v4.38.1": CODEQL_V4_38_1,
    "v4.38.0": CODEQL_V4_38_0,
  });
  const findings = await scanActionAdvisories(
    [codeqlWorkflow("v4.38.0", CODEQL_V4_38_1)],
    { ghCommandFn: gh.fn },
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.ghsaId, "GHSA-vqf5-2xx6-9wfm");
  assert(
    findings[0]?.evidence?.includes(
      ".github/workflows/security-tree-sweep.yml:8",
    ),
    findings[0]?.evidence,
  );
});

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
