/**
 * Tests for the whole-tree security sweep (Issue #4193).
 *
 * Every scanner and every `gh` call is injected — no network, no real
 * semgrep, no Claude. The behavioural core is the fixture the issue asks
 * for: a planted injectable pattern that all three sources flag at the same
 * location must collapse to ONE deduplicated finding, be filed once with the
 * right labels, and file nothing on a second run against the baseline (or
 * against the already-open issue).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildCodeqlAlertsArgs,
  buildSemgrepCommand,
  classifyClusters,
  type CommandOutcome,
  computeSweepId,
  dedupeFindings,
  parseCodeqlAlerts,
  parseSarif,
  parseSemgrepJson,
  parseSweepBaseline,
  parseWorkerScanIssues,
  renderSweepReport,
  ruleFamily,
  runSecurityTreeSweep,
  type SweepCommand,
  type SweepDeps,
  type SweepFinding,
  type SweepRunResult,
} from "../lib/security_tree_sweep.ts";
import {
  createSecurityTreeSweepCommand,
  securityTreeSweepCommand,
} from "../commands/security_tree_sweep.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures — the planted pattern lives at src/app.ts:12 (child_process exec
// with request-controlled input). All three sources see it.
// ---------------------------------------------------------------------------

const PLANTED_PATH = "src/app.ts";
const PLANTED_LINE = 12;

const SEMGREP_JSON = JSON.stringify({
  version: "1.173.0",
  results: [
    {
      check_id: "javascript.lang.security.detect-child-process",
      path: PLANTED_PATH,
      start: { line: PLANTED_LINE, col: 3 },
      end: { line: PLANTED_LINE, col: 40 },
      extra: {
        severity: "ERROR",
        message: "Detected calls to child_process from a function argument.",
        metadata: { confidence: "HIGH", cwe: ["CWE-78"] },
      },
    },
    {
      check_id: "javascript.lang.security.audit.path-traversal.path-join",
      path: "worker/lib/files.ts",
      start: { line: 40 },
      end: { line: 41 },
      extra: {
        severity: "WARNING",
        message: "Possible path traversal through path.join.",
        metadata: { confidence: "MEDIUM" },
      },
    },
    {
      check_id: "yaml.github-actions.security.run-shell-injection",
      path: ".github/workflows/ci.yml",
      start: { line: 7 },
      end: { line: 9 },
      extra: { severity: "INFO", message: "Shell injection in run:" },
    },
  ],
  errors: [],
});

const CODEQL_ALERTS_JSON = JSON.stringify([
  {
    number: 41,
    state: "open",
    html_url: "https://github.com/o/r/security/code-scanning/41",
    rule: {
      id: "js/command-line-injection",
      severity: "error",
      security_severity_level: "high",
      description: "Uncontrolled command line",
    },
    tool: { name: "CodeQL" },
    most_recent_instance: {
      location: { path: PLANTED_PATH, start_line: PLANTED_LINE + 1 },
      message: { text: "This command depends on a user-provided value." },
    },
  },
  {
    number: 42,
    state: "open",
    html_url: "https://github.com/o/r/security/code-scanning/42",
    rule: {
      id: "js/insecure-randomness",
      severity: "warning",
      description: "Insecure randomness",
    },
    tool: { name: "CodeQL" },
    most_recent_instance: {
      location: { path: "worker/lib/token.ts", start_line: 3 },
      message: { text: "Math.random() used for a token." },
    },
  },
  {
    // The worker's own SARIF upload appears in the same feed; it must be
    // attributed to the worker source, never counted as CodeQL.
    number: 43,
    state: "open",
    html_url: "https://github.com/o/r/security/code-scanning/43",
    rule: {
      id: "SEC-aaaaaaaaaaaa",
      severity: "error",
      security_severity_level: "high",
      description: "command injection in src/app.ts:12",
    },
    tool: { name: "VibeCoder-security-scan" },
    most_recent_instance: {
      location: { path: PLANTED_PATH, start_line: PLANTED_LINE },
      message: { text: "command injection in src/app.ts:12" },
    },
  },
]);

const WORKER_ISSUES_JSON = JSON.stringify([
  {
    number: 901,
    title: `🟠 command injection in ${PLANTED_PATH}:${PLANTED_LINE}`,
    body: "<!-- finding-id: SEC-aaaaaaaaaaaa -->\n<!-- cwe: CWE-78 -->\n" +
      "Attacker-controlled input reaches exec().",
    labels: [{ name: "security" }, { name: "severity:high" }, {
      name: "confidence:high",
    }],
  },
  {
    number: 902,
    title: "Track the security backlog",
    body: "No finding marker here — an unrelated hand-filed issue.",
    labels: [{ name: "security" }],
  },
]);

const SARIF_JSON = JSON.stringify({
  version: "2.1.0",
  runs: [
    {
      tool: {
        driver: {
          name: "CodeQL",
          rules: [
            {
              id: "js/command-line-injection",
              properties: { "security-severity": "9.8" },
            },
          ],
        },
      },
      results: [
        {
          ruleId: "js/command-line-injection",
          ruleIndex: 0,
          level: "error",
          message: { text: "Command built from user input." },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: PLANTED_PATH },
                region: { startLine: PLANTED_LINE },
              },
            },
          ],
        },
        {
          ruleId: "js/log-injection",
          level: "warning",
          message: { text: "Log entry from user input." },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "worker/lib/log.ts" },
                region: { startLine: 88 },
              },
            },
          ],
        },
      ],
    },
  ],
});

/** Baseline that names nothing — every finding is new. */
const EMPTY_BASELINE = JSON.stringify({ falsePositives: [], accepted: [] });

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

interface StubOptions {
  /** semgrep JSON returned by the stub runner. */
  semgrepJson?: string;
  /** Exit code the stub semgrep returns. */
  semgrepCode?: number;
  /** Which binaries the stub `which` finds. */
  onPath?: string[];
  /** CodeQL alerts payload. */
  codeqlJson?: string;
  /** gh failure message for the code-scanning call (throws when set). */
  codeqlError?: string;
  /** Worker-scan issue payload. */
  workerIssuesJson?: string;
  /** Finding ids already open (returned for the SWEEP- lookup). */
  knownOpenIds?: string[];
}

interface Stub {
  deps: SweepDeps;
  ghCalls: string[][];
  runnerCalls: SweepCommand[];
  filed: Array<{ title: string; body: string; labels: string[] }>;
}

function makeStub(options: StubOptions = {}): Stub {
  const ghCalls: string[][] = [];
  const runnerCalls: SweepCommand[] = [];
  const filed: Array<{ title: string; body: string; labels: string[] }> = [];
  const onPath = new Set(options.onPath ?? ["semgrep", "git"]);
  let nextIssue = 5000;

  const runner = (cmd: SweepCommand): Promise<CommandOutcome> => {
    runnerCalls.push(cmd);
    if (cmd.bin === "git" && cmd.args[0] === "ls-files") {
      return Promise.resolve({
        code: 0,
        stdout: [
          "README.md",
          ".github/workflows/ci.yml",
          "container/Dockerfile",
          "hooks/pre-commit.sh",
          "prompts/security_scan/v9.md",
          "worker/deno/mod.ts",
          "src/app.ts",
        ].join("\n"),
        stderr: "",
      });
    }
    if (cmd.bin === "semgrep" || cmd.args.includes("scan")) {
      return Promise.resolve({
        code: options.semgrepCode ?? 0,
        stdout: options.semgrepJson ?? SEMGREP_JSON,
        stderr: "",
      });
    }
    return Promise.resolve({ code: 127, stdout: "", stderr: "unknown stub" });
  };

  const ghCommandFn = (args: string[]): Promise<string> => {
    ghCalls.push(args);
    const joined = args.join(" ");
    if (args[0] === "api" && joined.includes("code-scanning/alerts")) {
      if (options.codeqlError) {
        return Promise.reject(new Error(options.codeqlError));
      }
      return Promise.resolve(options.codeqlJson ?? CODEQL_ALERTS_JSON);
    }
    if (args[0] === "issue" && args[1] === "list") {
      const wantsBodyOnly = joined.includes("number,body");
      if (wantsBodyOnly) {
        // The SWEEP- known-open lookup.
        const ids = options.knownOpenIds ?? [];
        return Promise.resolve(JSON.stringify(
          ids.map((id, i) => ({
            number: 7000 + i,
            body: `<!-- finding-id: ${id} -->`,
          })),
        ));
      }
      return Promise.resolve(options.workerIssuesJson ?? WORKER_ISSUES_JSON);
    }
    if (args[0] === "issue" && args[1] === "create") {
      const title = args[args.indexOf("--title") + 1] ?? "";
      const body = args[args.indexOf("--body") + 1] ?? "";
      const labels: string[] = [];
      args.forEach((a, i) => {
        if (a === "--label") labels.push(args[i + 1] ?? "");
      });
      filed.push({ title, body, labels });
      nextIssue += 1;
      return Promise.resolve(`https://github.com/o/r/issues/${nextIssue}`);
    }
    if (args[0] === "repo" && args[1] === "view") {
      return Promise.resolve("o/r");
    }
    return Promise.reject(new Error(`unexpected gh call: ${joined}`));
  };

  const deps: SweepDeps = {
    runner,
    ghCommandFn,
    whichFn: (bin) =>
      Promise.resolve(onPath.has(bin) ? `/usr/bin/${bin}` : null),
    ensureLabelFn: () => Promise.resolve(),
  };
  return { deps, ghCalls, runnerCalls, filed };
}

/** Write a temp repo dir with a baseline file, returning both paths. */
async function tempRepo(baselineJson: string): Promise<{
  repoDir: string;
  baselinePath: string;
  reportPath: string;
}> {
  const repoDir = await Deno.makeTempDir({ prefix: "sweep-" });
  await Deno.mkdir(`${repoDir}/docs/audits`, { recursive: true });
  await Deno.mkdir(`${repoDir}/.github`, { recursive: true });
  const baselinePath = `${repoDir}/.github/security-tree-sweep-baseline.json`;
  await Deno.writeTextFile(baselinePath, baselineJson);
  return {
    repoDir,
    baselinePath,
    reportPath: `${repoDir}/docs/audits/security-tree-sweep.md`,
  };
}

async function runWith(
  stub: Stub,
  baselineJson = EMPTY_BASELINE,
  extra: Partial<Parameters<typeof runSecurityTreeSweep>[0]> = {},
): Promise<SweepRunResult> {
  const { repoDir, baselinePath, reportPath } = await tempRepo(baselineJson);
  return await runSecurityTreeSweep({
    repoDir,
    slug: "o/r",
    baselinePath,
    reportPath,
    writeReport: false,
    ...extra,
  }, stub.deps);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

Deno.test("parseSemgrepJson normalises severity, location and confidence", () => {
  const findings = parseSemgrepJson(SEMGREP_JSON);
  assertEquals(findings.length, 3);
  const [planted, traversal, workflow] = findings as [
    SweepFinding,
    SweepFinding,
    SweepFinding,
  ];
  assertEquals(planted.source, "semgrep");
  assertEquals(planted.ruleId, "javascript.lang.security.detect-child-process");
  assertEquals(planted.path, PLANTED_PATH);
  assertEquals(planted.line, PLANTED_LINE);
  assertEquals(planted.severity, "high");
  assertEquals(planted.confidence, "high");
  assertEquals(traversal.severity, "medium");
  assertEquals(traversal.confidence, "medium");
  assertEquals(workflow.severity, "low");
  assertEquals(workflow.path, ".github/workflows/ci.yml");
});

Deno.test("parseSemgrepJson rejects a payload that is not semgrep output", () => {
  let threw = false;
  try {
    parseSemgrepJson("[]");
  } catch (error) {
    threw = true;
    assertStringIncludes((error as Error).message, "semgrep");
  }
  assert(threw, "a non-object payload must be an error, not zero findings");
});

Deno.test("parseCodeqlAlerts keeps every severity and attributes the worker's own upload to worker-scan", () => {
  const findings = parseCodeqlAlerts(CODEQL_ALERTS_JSON);
  assertEquals(findings.length, 3);
  const codeql = findings.filter((f) => f.source === "codeql");
  assertEquals(codeql.length, 2);
  const [cmd, rand] = codeql as [SweepFinding, SweepFinding];
  assertEquals(cmd.ruleId, "js/command-line-injection");
  assertEquals(cmd.severity, "high");
  assertEquals(cmd.path, PLANTED_PATH);
  assertEquals(cmd.line, PLANTED_LINE + 1);
  assertEquals(cmd.ref, "https://github.com/o/r/security/code-scanning/41");
  // No security_severity_level → fall back to the rule severity (warning).
  assertEquals(rand.severity, "medium");
  const worker = findings.filter((f) => f.source === "worker-scan");
  assertEquals(worker.length, 1);
  assertEquals(worker[0]?.ruleId, "SEC-aaaaaaaaaaaa");
});

Deno.test("parseCodeqlAlerts fails loud on a non-array payload", () => {
  let threw = false;
  try {
    parseCodeqlAlerts('{"message":"Not Found"}');
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("parseWorkerScanIssues lifts SEC- findings and skips unmarked issues", () => {
  const findings = parseWorkerScanIssues(WORKER_ISSUES_JSON);
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.source, "worker-scan");
  assertEquals(f.ruleId, "SEC-aaaaaaaaaaaa");
  assertEquals(f.path, PLANTED_PATH);
  assertEquals(f.line, PLANTED_LINE);
  assertEquals(f.severity, "high");
  assertEquals(f.confidence, "high");
  assertEquals(f.ref, "#901");
  assertStringIncludes(f.message, "command injection");
});

Deno.test("parseSarif reads rule ids, levels, security-severity and locations", () => {
  const findings = parseSarif(SARIF_JSON, "codeql");
  assertEquals(findings.length, 2);
  const [cmd, log] = findings as [SweepFinding, SweepFinding];
  assertEquals(cmd.severity, "critical"); // 9.8 → critical
  assertEquals(cmd.path, PLANTED_PATH);
  assertEquals(cmd.line, PLANTED_LINE);
  assertEquals(log.severity, "medium"); // warning, no score
  assertEquals(log.ruleId, "js/log-injection");
});

Deno.test("ruleFamily maps semgrep, CodeQL and worker rule names onto one family", () => {
  assertEquals(
    ruleFamily("semgrep", "javascript.lang.security.detect-child-process"),
    "command-injection",
  );
  assertEquals(
    ruleFamily("codeql", "js/command-line-injection"),
    "command-injection",
  );
  assertEquals(
    ruleFamily("worker-scan", "command injection"),
    "command-injection",
  );
  assertEquals(ruleFamily("codeql", "js/path-injection"), "path-traversal");
  assertEquals(
    ruleFamily(
      "semgrep",
      "javascript.lang.security.audit.path-traversal.path-join",
    ),
    "path-traversal",
  );
  assertEquals(ruleFamily("codeql", "js/polynomial-redos"), "unsafe-regex");
  assertEquals(
    ruleFamily(
      "semgrep",
      "javascript.lang.security.audit.detect-non-literal-regexp",
    ),
    "unsafe-regex",
  );
  // Unknown rules fall back to their normalised last segment.
  assertEquals(ruleFamily("codeql", "js/some-new-rule"), "some-new-rule");
});

Deno.test("computeSweepId is stable and independent of source", async () => {
  const a = await computeSweepId("command-injection", PLANTED_PATH, 12);
  const b = await computeSweepId("command-injection", PLANTED_PATH, 13);
  const c = await computeSweepId("command-injection", PLANTED_PATH, 400);
  assert(a.startsWith("SWEEP-"));
  assertEquals(a.length, "SWEEP-".length + 12);
  assertEquals(a, b, "lines in the same window share an id");
  assert(a !== c, "a distant line is a different finding");
});

// ---------------------------------------------------------------------------
// Dedup + baseline
// ---------------------------------------------------------------------------

Deno.test("dedupeFindings collapses the planted pattern from three sources into one cluster", async () => {
  const findings = [
    ...parseSemgrepJson(SEMGREP_JSON),
    ...parseCodeqlAlerts(CODEQL_ALERTS_JSON),
    ...parseWorkerScanIssues(WORKER_ISSUES_JSON),
  ];
  const clusters = await dedupeFindings(findings);
  const planted = clusters.filter((c) => c.path === PLANTED_PATH);
  assertEquals(planted.length, 1, "three sources, one deduplicated finding");
  const cluster = planted[0]!;
  assertEquals(cluster.family, "command-injection");
  assertEquals(cluster.sources, ["codeql", "semgrep", "worker-scan"]);
  assertEquals(cluster.severity, "high");
  assertEquals(cluster.confidence, "high");
  assertEquals(cluster.lineStart, PLANTED_LINE);
  assertEquals(cluster.lineEnd, PLANTED_LINE + 1);
  // The other findings stay distinct.
  assertEquals(clusters.length, 1 + 3);
  // Sorted most important first.
  assertEquals(clusters[0]!.path, PLANTED_PATH);
});

Deno.test("parseSweepBaseline enforces reasons and rejects malformed entries", () => {
  const good = parseSweepBaseline(JSON.stringify({
    note: "x",
    falsePositives: [{
      path: "a.ts",
      rule: "xss",
      line: 4,
      reason: "Test fixture — output is never rendered to a browser.",
    }],
    accepted: [{
      path: "b.ts",
      rule: "unsafe-regex",
      reason: "Input is bounded to 64 chars by the caller.",
      issue: 12,
    }],
  }));
  assertEquals(good.errors, []);
  assertEquals(good.baseline.falsePositives.length, 1);
  assertEquals(good.baseline.accepted[0]?.issue, 12);

  const bad = parseSweepBaseline(JSON.stringify({
    falsePositives: [{ path: "a.ts", rule: "xss", reason: "ok" }],
    accepted: [{ rule: "xss", reason: "long enough reason here" }],
  }));
  assert(bad.errors.some((e) => e.includes("reason")));
  assert(bad.errors.some((e) => e.includes("path")));

  const notJson = parseSweepBaseline("{nope");
  assertEquals(notJson.errors.length, 1);
});

Deno.test("classifyClusters marks baselined, new and stale entries", async () => {
  const findings = [
    ...parseSemgrepJson(SEMGREP_JSON),
    ...parseCodeqlAlerts(CODEQL_ALERTS_JSON),
  ];
  const clusters = await dedupeFindings(findings);
  const { baseline } = parseSweepBaseline(JSON.stringify({
    falsePositives: [
      {
        path: "worker/lib/files.ts",
        rule: "path-traversal",
        line: 41,
        reason: "Path is validated by resolveInside() two lines earlier.",
      },
      {
        path: "gone/away.ts",
        rule: "xss",
        reason: "This file was deleted — the entry is now stale.",
      },
    ],
    accepted: [
      {
        path: "worker/lib/token.ts",
        rule: "js/insecure-randomness",
        reason: "Token is a display nonce, not a credential (accepted).",
        issue: 77,
      },
    ],
  }));
  const classified = classifyClusters(clusters, baseline);
  const byPath = new Map(classified.rows.map((r) => [r.path, r]));
  assertEquals(byPath.get("worker/lib/files.ts")?.status, "false-positive");
  assertEquals(byPath.get("worker/lib/token.ts")?.status, "accepted");
  assertEquals(byPath.get("worker/lib/token.ts")?.issue, 77);
  assertEquals(byPath.get(PLANTED_PATH)?.status, "new");
  assertEquals(classified.newRows.length, 2); // planted + workflow rule
  assertEquals(classified.staleEntries.length, 1);
  assertStringIncludes(classified.staleEntries[0]!, "gone/away.ts");
});

// ---------------------------------------------------------------------------
// End-to-end with stubs
// ---------------------------------------------------------------------------

Deno.test("sweep: three sources → one deduplicated new finding, exit non-zero, report rendered", async () => {
  const stub = makeStub();
  const result = await runWith(stub);
  assertEquals(result.ok, false, "unbaselined findings fail the run");
  const planted = result.rows.filter((r) => r.path === PLANTED_PATH);
  assertEquals(planted.length, 1);
  assertEquals(planted[0]!.sources, ["codeql", "semgrep", "worker-scan"]);
  assertEquals(result.filed.length, 0, "report-only by default");
  // Coverage statement names the tree roots the sweep saw.
  assertStringIncludes(result.report, "worker/");
  assertStringIncludes(result.report, "container/");
  assertStringIncludes(result.report, "hooks/");
  assertStringIncludes(result.report, "prompts/");
  assertStringIncludes(result.report, "7 tracked files");
  // Per-source counts and the triage table.
  assertStringIncludes(result.report, "| semgrep |");
  assertStringIncludes(result.report, "| codeql |");
  assertStringIncludes(result.report, "| worker-scan |");
  assertStringIncludes(result.report, `\`${PLANTED_PATH}:${PLANTED_LINE}`);
  assertStringIncludes(result.report, "**NEW**");
  // The semgrep invocation is the local binary with JSON output.
  const semgrep = stub.runnerCalls.find((c) => c.bin === "semgrep");
  assert(semgrep, "semgrep was invoked");
  assert(semgrep.args.includes("--json"));
  assert(semgrep.args.includes("--metrics=off"));
});

Deno.test("sweep: report is deterministic (no timestamp unless injected)", async () => {
  const { repoDir, baselinePath, reportPath } = await tempRepo(EMPTY_BASELINE);
  const opts = {
    repoDir,
    slug: "o/r",
    baselinePath,
    reportPath,
    writeReport: false,
  };
  const first = await runSecurityTreeSweep(opts, makeStub().deps);
  const second = await runSecurityTreeSweep(opts, makeStub().deps);
  assertEquals(first.report, second.report);
  assert(!/\d{4}-\d{2}-\d{2}T/.test(first.report), "no timestamp by default");
  const stamped = await runSecurityTreeSweep(
    { ...opts, now: new Date("2026-08-19T00:00:00Z") },
    makeStub().deps,
  );
  assertStringIncludes(stamped.report, "2026-08-19");
});

Deno.test("sweep: a fully baselined tree is clean and files nothing", async () => {
  const stub = makeStub();
  const baseline = JSON.stringify({
    falsePositives: [
      {
        path: PLANTED_PATH,
        rule: "command-injection",
        line: PLANTED_LINE,
        reason: "Planted fixture for the sweep tests — not shipped code.",
      },
      {
        path: "worker/lib/files.ts",
        rule: "path-traversal",
        reason: "Path is validated by resolveInside() before use.",
      },
      {
        path: ".github/workflows/ci.yml",
        rule: "yaml.github-actions.security.run-shell-injection",
        reason: "Interpolated value is a workflow constant, not an input.",
      },
    ],
    accepted: [
      {
        path: "worker/lib/token.ts",
        rule: "js/insecure-randomness",
        reason: "Display nonce only; tracked for replacement.",
        issue: 77,
      },
    ],
  });
  const result = await runWith(stub, baseline, { fileIssues: true });
  assertEquals(result.ok, true);
  assertEquals(result.newRows.length, 0);
  assertEquals(stub.filed.length, 0);
  assertStringIncludes(result.report, "✅");
});

Deno.test("sweep: --file-issues files one issue per new cluster with id, labels and citations", async () => {
  const stub = makeStub();
  const result = await runWith(stub, EMPTY_BASELINE, { fileIssues: true });
  assertEquals(result.filed.length, result.newRows.length);
  assertEquals(result.filed.length, 4);
  const planted = stub.filed.find((f) => f.title.includes(PLANTED_PATH));
  assert(planted, "the planted finding was filed");
  const id = result.rows.find((r) => r.path === PLANTED_PATH)!.id;
  assertStringIncludes(planted.title, id);
  assertStringIncludes(planted.title, "🟠");
  assertStringIncludes(planted.body, `<!-- finding-id: ${id} -->`);
  assertStringIncludes(planted.body, "semgrep");
  assertStringIncludes(planted.body, "codeql");
  assertStringIncludes(planted.body, "worker-scan");
  assertStringIncludes(planted.body, `${PLANTED_PATH}:${PLANTED_LINE}`);
  assertStringIncludes(planted.body, "js/command-line-injection");
  assert(planted.labels.includes("security"));
  assert(planted.labels.includes("security-tree-sweep"));
  assert(planted.labels.includes("severity:high"));
  assert(planted.labels.includes("confidence:high"));
  // Most important first: the planted high finding is filed before the lows.
  assertEquals(stub.filed[0]!.title, planted.title);
});

Deno.test("sweep: re-run files nothing when the ids are already open", async () => {
  const first = makeStub();
  const firstRun = await runWith(first, EMPTY_BASELINE, { fileIssues: true });
  const openIds = firstRun.filed.map((f) => f.id);
  const second = makeStub({ knownOpenIds: openIds });
  const secondRun = await runWith(second, EMPTY_BASELINE, { fileIssues: true });
  assertEquals(second.filed.length, 0, "unchanged tree files zero new issues");
  assertEquals(secondRun.alreadyOpen.length, 4);
  assertStringIncludes(secondRun.report, "already open");
});

Deno.test("sweep: --max-issues caps filing and reports the remainder", async () => {
  const stub = makeStub();
  const result = await runWith(stub, EMPTY_BASELINE, {
    fileIssues: true,
    maxIssues: 2,
  });
  assertEquals(stub.filed.length, 2);
  assertEquals(result.deferred.length, 2);
  assertStringIncludes(result.report, "deferred");
});

Deno.test("sweep: missing semgrep is an error, never a clean sweep", async () => {
  const stub = makeStub({ onPath: ["git"] }); // no semgrep, no runtime
  await assertRejects(
    () => runWith(stub),
    Error,
    "semgrep",
  );
});

Deno.test("sweep: semgrep falls back to the pinned container image when only a runtime is present", async () => {
  const stub = makeStub({ onPath: ["git", "container"] });
  await runWith(stub);
  const call = stub.runnerCalls.find((c) => c.bin === "container");
  assert(call, "container runtime was used");
  assert(
    call.args.some((a) => a.startsWith("semgrep/semgrep:1.173.0@sha256:")),
  );
  assert(call.args.includes("--json"));
});

Deno.test("sweep: unexpected semgrep exit code is an error", async () => {
  const stub = makeStub({ semgrepCode: 2 });
  await assertRejects(() => runWith(stub), Error, "exit 2");
});

Deno.test("sweep: CodeQL feed unavailable is an error, not zero findings", async () => {
  const stub = makeStub({
    codeqlError:
      "gh command failed (exit 1): Code Security must be enabled (HTTP 403)",
  });
  await assertRejects(() => runWith(stub), Error, "code-scanning");
});

Deno.test("sweep: --sources narrows the run and the report states the narrowed coverage", async () => {
  const stub = makeStub({ codeqlError: "boom (HTTP 403)" });
  const result = await runWith(stub, EMPTY_BASELINE, {
    sources: ["semgrep", "worker-scan"],
  });
  assert(!stub.ghCalls.some((c) => c.join(" ").includes("code-scanning")));
  assertStringIncludes(result.report, "codeql | not run");
});

Deno.test("sweep: pre-produced semgrep JSON and CodeQL SARIF inputs are consumed instead of running tools", async () => {
  const stub = makeStub({ onPath: ["git"] });
  const dir = await Deno.makeTempDir();
  const semgrepPath = `${dir}/semgrep.json`;
  const sarifPath = `${dir}/codeql.sarif`;
  await Deno.writeTextFile(semgrepPath, SEMGREP_JSON);
  await Deno.writeTextFile(sarifPath, SARIF_JSON);
  const result = await runWith(stub, EMPTY_BASELINE, {
    semgrepJsonPath: semgrepPath,
    codeqlSarifPath: sarifPath,
  });
  assert(!stub.runnerCalls.some((c) => c.bin === "semgrep"));
  assert(!stub.ghCalls.some((c) => c.join(" ").includes("code-scanning")));
  const planted = result.rows.filter((r) => r.path === PLANTED_PATH);
  assertEquals(planted.length, 1);
  assertEquals(planted[0]!.sources, ["codeql", "semgrep", "worker-scan"]);
  assertEquals(planted[0]!.severity, "critical"); // SARIF score 9.8 wins
});

Deno.test("sweep: malformed baseline fails the run and is reported", async () => {
  const stub = makeStub();
  const result = await runWith(
    stub,
    JSON.stringify({ falsePositives: [{ path: "x", rule: "y", reason: "?" }] }),
  );
  assertEquals(result.ok, false);
  assert(result.baselineErrors.length > 0);
  assertStringIncludes(result.report, "Baseline errors");
});

Deno.test("sweep: missing baseline file is an error", async () => {
  const stub = makeStub();
  const dir = await Deno.makeTempDir();
  await assertRejects(
    () =>
      runSecurityTreeSweep({
        repoDir: dir,
        slug: "o/r",
        baselinePath: `${dir}/nope.json`,
        reportPath: `${dir}/r.md`,
        writeReport: false,
      }, stub.deps),
    Error,
    "baseline",
  );
});

Deno.test("sweep: writes the report to disk when asked", async () => {
  const stub = makeStub();
  const { repoDir, baselinePath, reportPath } = await tempRepo(EMPTY_BASELINE);
  const result = await runSecurityTreeSweep({
    repoDir,
    slug: "o/r",
    baselinePath,
    reportPath,
  }, stub.deps);
  const onDisk = await Deno.readTextFile(reportPath);
  assertEquals(onDisk, result.report);
});

Deno.test("sweep: --run-worker-scan invokes the injected worker scan before harvesting", async () => {
  const stub = makeStub();
  let invoked = 0;
  stub.deps.runWorkerScanFn = () => {
    invoked += 1;
    return Promise.resolve({ ok: true });
  };
  await runWith(stub, EMPTY_BASELINE, { runWorkerScan: true });
  assertEquals(invoked, 1);
});

Deno.test("sweep: a failed worker scan is an error", async () => {
  const stub = makeStub();
  stub.deps.runWorkerScanFn = () =>
    Promise.resolve({ ok: false, error: "Claude exited with code 1" });
  await assertRejects(
    () => runWith(stub, EMPTY_BASELINE, { runWorkerScan: true }),
    Error,
    "worker scan",
  );
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("buildSemgrepCommand and buildCodeqlAlertsArgs are the documented invocations", () => {
  const local = buildSemgrepCommand("/repo", "p/default", null);
  assertEquals(local.bin, "semgrep");
  assertEquals(local.args.slice(0, 2), ["scan", "--config"]);
  const contained = buildSemgrepCommand("/repo", "p/default", "docker");
  assertEquals(contained.bin, "docker");
  assertEquals(contained.args[0], "run");
  assert(contained.args.includes("/repo:/src"));
  const args = buildCodeqlAlertsArgs("o/r");
  assertEquals(args[0], "api");
  assertStringIncludes(
    args[1] ?? "",
    "repos/o/r/code-scanning/alerts?state=open",
  );
  assert(args.includes("--paginate"));
});

Deno.test("renderSweepReport snapshot for an empty, clean sweep", () => {
  const report = renderSweepReport({
    repoDir: "/tmp/VibeCoder",
    slug: "o/r",
    coverage: { trackedFiles: 3, roots: ["docs/", "worker/"] },
    sourceStatus: [
      {
        source: "worker-scan",
        status: "ran",
        rawCount: 0,
        detail: "open security issues",
      },
      { source: "semgrep", status: "ran", rawCount: 0, detail: "p/default" },
      {
        source: "codeql",
        status: "ran",
        rawCount: 0,
        detail: "code-scanning alerts",
      },
    ],
    rows: [],
    newRows: [],
    alreadyOpen: [],
    filed: [],
    deferred: [],
    staleEntries: [],
    baselineErrors: [],
    baselinePath: "/tmp/VibeCoder/.github/security-tree-sweep-baseline.json",
  });
  const expected = [
    "# 🧹 Whole-tree security sweep",
    "",
    "Generated by `mod.ts security-tree-sweep` (Issue #4193) — do not edit by",
    "hand; edit the baseline instead.",
    "",
    "- **Repository**: `o/r`",
    "- **Coverage**: 3 tracked files under `docs/`, `worker/`",
    "- **Baseline**: `.github/security-tree-sweep-baseline.json`",
    "",
    "## Sources",
    "",
    "| Source | Status | Raw findings | Detail |",
    "| ------ | ------ | -----------: | ------ |",
    "| worker-scan | ran | 0 | open security issues |",
    "| semgrep | ran | 0 | p/default |",
    "| codeql | ran | 0 | code-scanning alerts |",
    "",
    "## Summary",
    "",
    "| Severity | Deduplicated | New | Baselined |",
    "| -------- | -----------: | --: | --------: |",
    "| critical | 0 | 0 | 0 |",
    "| high | 0 | 0 | 0 |",
    "| medium | 0 | 0 | 0 |",
    "| low | 0 | 0 | 0 |",
    "| **total** | **0** | **0** | **0** |",
    "",
    "## Triage table",
    "",
    "No findings from any source.",
    "",
    "## Verdict",
    "",
    "✅ No unbaselined findings.",
    "",
  ].join("\n");
  assertEquals(report, expected);
});

// ---------------------------------------------------------------------------
// Command wrapper
// ---------------------------------------------------------------------------

Deno.test("command: report-only default, exit non-zero on new findings, human summary", async () => {
  const stub = makeStub();
  const { repoDir } = await tempRepo(EMPTY_BASELINE);
  const result = await createSecurityTreeSweepCommand(stub.deps).execute(
    { repo: repoDir, slug: "o/r" },
    {} as WorkerConfig,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "unbaselined");
  assertStringIncludes(result.message, "security-tree-sweep.md");
  assertEquals(stub.filed.length, 0);
});

Deno.test("command: parses --sources, --file-issues and --max-issues", async () => {
  const stub = makeStub();
  const { repoDir } = await tempRepo(EMPTY_BASELINE);
  const result = await createSecurityTreeSweepCommand(stub.deps).execute(
    {
      repo: repoDir,
      slug: "o/r",
      sources: "semgrep,worker-scan",
      "file-issues": true,
      "max-issues": 1,
    },
    {} as WorkerConfig,
  );
  assertEquals(result.success, false);
  assertEquals(stub.filed.length, 1);
});

Deno.test("command: a scanner failure surfaces as a could-not-run failure", async () => {
  const stub = makeStub({ onPath: ["git"] });
  const { repoDir } = await tempRepo(EMPTY_BASELINE);
  const result = await createSecurityTreeSweepCommand(stub.deps).execute(
    { repo: repoDir, slug: "o/r" },
    {} as WorkerConfig,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "could not run");
  assertStringIncludes(result.message, "semgrep");
});

Deno.test("command: unknown --sources value is rejected", async () => {
  const stub = makeStub();
  const { repoDir } = await tempRepo(EMPTY_BASELINE);
  const result = await createSecurityTreeSweepCommand(stub.deps).execute(
    { repo: repoDir, slug: "o/r", sources: "semgrep,bogus" },
    {} as WorkerConfig,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "bogus");
});

Deno.test("command: default export is registered under the documented name", () => {
  assertEquals(securityTreeSweepCommand.name, "security-tree-sweep");
  assertStringIncludes(securityTreeSweepCommand.description, "4193");
});
