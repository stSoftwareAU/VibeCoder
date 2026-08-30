/**
 * Tests for gitleaks_pr_coverage_scanner.ts — observed gitleaks coverage on
 * recent pull requests (Issue #601, part of #566).
 *
 * The workflow audit proves only that a file mentioning gitleaks is
 * committed. These tests exercise the real `scanGitleaksPrCoverage` against
 * in-memory `WorkflowFile` fixtures and a stubbed `GhCommandFn` — no
 * filesystem, no network — and assert the scanner reports what actually ran.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  GITLEAKS_PR_COVERAGE_FINDING_ID,
  scanGitleaksPrCoverage,
} from "../lib/gitleaks_pr_coverage_scanner.ts";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** The canonical gitleaks workflow this worker emits (Issue #594). */
const CANONICAL = wf(
  ".github/workflows/gitleaks.yml",
  WORKFLOW_SPECS.find((s) => s.id === "gitleaks")!.template,
);

/** A gitleaks scan living inside a multi-job `quality.yml`. */
const QUALITY_WORKFLOW = wf(
  ".github/workflows/quality.yml",
  `name: Quality
on:
  pull_request:
    branches: [main]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: deno lint
  secret-scan:
    name: Secrets
    runs-on: ubuntu-latest
    steps:
      - run: ./gitleaks git --redact --no-banner --exit-code 1 .
`,
);

/** A workflow that runs no gitleaks scan at all. */
const NON_GITLEAKS = wf(
  ".github/workflows/ci.yml",
  `name: CI
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: deno test
`,
);

interface CheckRun {
  name: string;
  status?: string;
  conclusion?: string | null;
}

interface GhScenario {
  /** Closed PRs, most recently updated first. */
  prs?: Array<{ number: number; sha: string }>;
  /** Check runs per head SHA; an `Error` value makes that lookup fail. */
  checkRuns?: Record<string, CheckRun[] | Error>;
  /** When set, the closed-PR listing itself fails. */
  listError?: Error;
}

/** A `GhCommandFn` stub answering the two endpoints the scanner calls. */
function makeGh(scenario: GhScenario): {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/pulls?")) {
      if (scenario.listError) return Promise.reject(scenario.listError);
      return Promise.resolve(
        JSON.stringify(
          (scenario.prs ?? []).map((pr) => ({
            number: pr.number,
            head: { sha: pr.sha },
          })),
        ),
      );
    }
    const match = /\/commits\/([0-9a-f]+)\/check-runs/.exec(endpoint);
    if (match) {
      const entry = (scenario.checkRuns ?? {})[match[1] as string];
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve(
        JSON.stringify({ check_runs: entry ?? [] }),
      );
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  return { gh, calls };
}

/** A completed, successful check run. */
function ok(name: string): CheckRun {
  return { name, status: "completed", conclusion: "success" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "scanGitleaksPrCoverage - a gitleaks check on every sampled PR yields no finding",
  async () => {
    const { gh } = makeGh({
      prs: [
        { number: 12, sha: "a".repeat(40) },
        { number: 11, sha: "b".repeat(40) },
      ],
      checkRuns: {
        ["a".repeat(40)]: [ok("gitleaks"), ok("quality")],
        ["b".repeat(40)]: [ok("gitleaks")],
      },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
    });
    assertEquals(findings, []);
  },
);

Deno.test(
  "scanGitleaksPrCoverage - the canonical template's check name is the one matched",
  async () => {
    // The canonical template (Issue #594) declares `name: Gitleaks` with a
    // single `gitleaks:` job, so GitHub reports the check run as `gitleaks`.
    const { gh } = makeGh({
      prs: [{ number: 7, sha: "c".repeat(40) }],
      checkRuns: { ["c".repeat(40)]: [ok("gitleaks")] },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
    });
    assertEquals(findings, []);
  },
);

Deno.test(
  "scanGitleaksPrCoverage - a job-named check from a multi-job workflow counts as reported",
  async () => {
    // `quality.yml` runs the gitleaks CLI in a job named `Secrets`, so the
    // reported check run carries that name — not the string "gitleaks".
    const { gh } = makeGh({
      prs: [{ number: 4, sha: "d".repeat(40) }],
      checkRuns: { ["d".repeat(40)]: [ok("Secrets"), ok("lint")] },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [QUALITY_WORKFLOW],
      ghCommandFn: gh,
    });
    assertEquals(findings, []);
  },
);

Deno.test(
  "scanGitleaksPrCoverage - a sibling job reporting is not the gitleaks job reporting",
  async () => {
    // Only `lint` reported; the gitleaks-bearing `Secrets` job did not.
    const { gh } = makeGh({
      prs: [{ number: 4, sha: "d".repeat(40) }],
      checkRuns: { ["d".repeat(40)]: [ok("lint")] },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [QUALITY_WORKFLOW],
      ghCommandFn: gh,
    });
    assertEquals(findings.length, 1);
  },
);

Deno.test(
  "scanGitleaksPrCoverage - no gitleaks check on any sampled PR files one finding citing them",
  async () => {
    const { gh } = makeGh({
      prs: [
        { number: 12, sha: "a".repeat(40) },
        { number: 11, sha: "b".repeat(40) },
      ],
      checkRuns: {
        ["a".repeat(40)]: [ok("quality")],
        ["b".repeat(40)]: [ok("quality")],
      },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
    });
    assertEquals(findings.length, 1);
    const finding = findings[0]!;
    assertEquals(finding.findingId, GITLEAKS_PR_COVERAGE_FINDING_ID);
    assertEquals(finding.severity, "medium");
    assertEquals(finding.file, ".github/workflows/gitleaks.yml");
    assertStringIncludes(finding.evidence, "#12");
    assertStringIncludes(finding.evidence, "#11");
    // The usual causes are named so the gap is diagnosable, not a guess.
    assertStringIncludes(finding.suggestedFix, "Actions");
    assertStringIncludes(finding.suggestedFix, "branch filter");
  },
);

Deno.test(
  "scanGitleaksPrCoverage - a skipped conclusion counts as not reported",
  async () => {
    const { gh } = makeGh({
      prs: [{ number: 9, sha: "e".repeat(40) }],
      checkRuns: {
        ["e".repeat(40)]: [{
          name: "gitleaks",
          status: "completed",
          conclusion: "skipped",
        }],
      },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
    });
    assertEquals(findings.length, 1);
    assertStringIncludes(findings[0]!.evidence, "skipped");
    assertStringIncludes(findings[0]!.evidence, "#9");
  },
);

Deno.test(
  "scanGitleaksPrCoverage - a repo with no gitleaks workflow emits nothing and calls no gh",
  async () => {
    const { gh, calls } = makeGh({ prs: [{ number: 1, sha: "f".repeat(40) }] });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [NON_GITLEAKS],
      ghCommandFn: gh,
    });
    assertEquals(findings, []);
    assertEquals(calls, []);
  },
);

Deno.test(
  "scanGitleaksPrCoverage - a failed check-run lookup is logged and stated as a partial sample",
  async () => {
    const notes: string[] = [];
    const { gh } = makeGh({
      prs: [
        { number: 12, sha: "a".repeat(40) },
        { number: 11, sha: "b".repeat(40) },
      ],
      checkRuns: {
        ["a".repeat(40)]: [ok("quality")],
        ["b".repeat(40)]: new Error("HTTP 502: Bad Gateway"),
      },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
      onSamplingNote: (note) => notes.push(note),
    });
    assertEquals(findings.length, 1);
    const evidence = findings[0]!.evidence;
    // The verdict must never read as a clean, complete sample.
    assertStringIncludes(evidence, "partial");
    assertStringIncludes(evidence, "#11");
    assertStringIncludes(evidence, "HTTP 502");
    assert(
      notes.some((n) => n.includes("#11") && n.includes("HTTP 502")),
      JSON.stringify(notes),
    );
  },
);

Deno.test(
  "scanGitleaksPrCoverage - fewer PRs than requested is stated in the evidence",
  async () => {
    const { gh } = makeGh({
      prs: [{ number: 3, sha: "a".repeat(40) }],
      checkRuns: { ["a".repeat(40)]: [ok("quality")] },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
      sampleSize: 10,
    });
    assertEquals(findings.length, 1);
    const evidence = findings[0]!.evidence;
    assertStringIncludes(evidence, "1");
    assertStringIncludes(evidence, "10");
  },
);

Deno.test(
  "scanGitleaksPrCoverage - a failed PR listing files nothing and is logged loud",
  async () => {
    const notes: string[] = [];
    const { gh } = makeGh({ listError: new Error("HTTP 403: Forbidden") });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
      onSamplingNote: (note) => notes.push(note),
    });
    // Undecidable is not clean: nothing is filed, but the failure is loud.
    assertEquals(findings, []);
    assert(
      notes.some((n) => n.includes("HTTP 403")),
      JSON.stringify(notes),
    );
  },
);

Deno.test(
  "scanGitleaksPrCoverage - every check-run lookup failing files nothing and is logged",
  async () => {
    const notes: string[] = [];
    const { gh } = makeGh({
      prs: [{ number: 12, sha: "a".repeat(40) }],
      checkRuns: { ["a".repeat(40)]: new Error("HTTP 500: Server Error") },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
      onSamplingNote: (note) => notes.push(note),
    });
    assertEquals(findings, []);
    assert(
      notes.some((n) => n.includes("no pull request")),
      JSON.stringify(notes),
    );
  },
);

Deno.test(
  "scanGitleaksPrCoverage - a repo with no closed PRs emits nothing and says so",
  async () => {
    const notes: string[] = [];
    const { gh } = makeGh({ prs: [] });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
      onSamplingNote: (note) => notes.push(note),
    });
    assertEquals(findings, []);
    assert(
      notes.some((n) => n.includes("no closed pull request")),
      JSON.stringify(notes),
    );
  },
);

Deno.test(
  "scanGitleaksPrCoverage - a known-open finding id is not re-filed",
  async () => {
    const { gh, calls } = makeGh({
      prs: [{ number: 12, sha: "a".repeat(40) }],
      checkRuns: { ["a".repeat(40)]: [ok("quality")] },
    });
    const findings = await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
      knownOpenFindingIds: [GITLEAKS_PR_COVERAGE_FINDING_ID],
    });
    assertEquals(findings, []);
    // Dedup happens before sampling — no API budget is spent re-deciding.
    assertEquals(calls, []);
  },
);

Deno.test(
  "scanGitleaksPrCoverage - an invalid repo slug is refused before any gh call",
  async () => {
    const notes: string[] = [];
    const { gh, calls } = makeGh({ prs: [] });
    const findings = await scanGitleaksPrCoverage("org/repo;rm -rf /", {
      files: [CANONICAL],
      ghCommandFn: gh,
      onSamplingNote: (note) => notes.push(note),
    });
    assertEquals(findings, []);
    assertEquals(calls, []);
    assert(notes.length > 0, "an unusable repo slug must be logged");
  },
);

Deno.test(
  "scanGitleaksPrCoverage - the sample size caps the PRs inspected",
  async () => {
    const { gh, calls } = makeGh({
      prs: [
        { number: 12, sha: "a".repeat(40) },
        { number: 11, sha: "b".repeat(40) },
      ],
      checkRuns: {
        ["a".repeat(40)]: [ok("quality")],
        ["b".repeat(40)]: [ok("quality")],
      },
    });
    await scanGitleaksPrCoverage("org/repo", {
      files: [CANONICAL],
      ghCommandFn: gh,
      sampleSize: 1,
    });
    const checkRunCalls = calls.filter((c) =>
      (c[1] ?? "").includes("/check-runs")
    );
    assertEquals(checkRunCalls.length, 1);
    assertStringIncludes(calls[0]![1] ?? "", "per_page=1");
  },
);
