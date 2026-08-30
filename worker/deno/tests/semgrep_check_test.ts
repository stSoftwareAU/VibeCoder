/**
 * Tests for semgrep_check.ts (Issue #559).
 *
 * Covers:
 *   - changed-file selection: diff against the merge-base with the remote's
 *     default branch, plus untracked files, filtered to scannable extensions;
 *   - the `detect-non-literal-regexp` shape that blocked PRs #548 and #549 is
 *     reported as FAILED locally, with the standard remedy named;
 *   - loud SKIPPED when semgrep is unavailable, when the working directory is
 *     not a git repository, when the rule registry cannot be reached, and when
 *     the scan exceeds its deadline — each promoted to FAILED under --strict;
 *   - a tool error is never read as "no findings" (fail loud);
 *   - the container invocation carries the tag+digest image CI runs;
 *   - the real quality gate registers the check.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildContainerArgs,
  collectChangedFiles,
  type DetectSemgrepInvocation,
  type GitRunner,
  isRegistryUnavailable,
  isScannablePath,
  parseSemgrepJson,
  runSemgrepCheck,
  selectScannableFiles,
  SEMGREP_CONFIG,
  SEMGREP_DEADLINE_MS,
  type SemgrepFinding,
  type SemgrepRunResult,
} from "../lib/semgrep_check.ts";
import { SEMGREP_IMAGE, SEMGREP_IMAGE_TAG } from "../lib/pinned_actions.ts";
import { formatSummary, recordCheck } from "../lib/quality_helpers.ts";
import { runQualityGate } from "../lib/quality_gate.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A git runner backed by a fixed `args-joined-by-space -> stdout` map. */
function fakeGit(
  responses: Record<string, { exitCode?: number; stdout?: string }>,
): GitRunner {
  return (args: string[]) => {
    const key = args.join(" ");
    const hit = responses[key];
    if (!hit) return Promise.resolve({ exitCode: 1, stdout: "" });
    return Promise.resolve({
      exitCode: hit.exitCode ?? 0,
      stdout: hit.stdout ?? "",
    });
  };
}

/** A git runner reporting one changed TypeScript file on a branch. */
function gitWithChangedFile(path: string): GitRunner {
  return fakeGit({
    "rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "rev-parse --abbrev-ref refs/remotes/origin/HEAD": {
      stdout: "origin/main\n",
    },
    "merge-base origin/main HEAD": { stdout: "abc123def456\n" },
    "diff --name-only --diff-filter=ACMR abc123def456": { stdout: `${path}\n` },
    "ls-files --others --exclude-standard": { stdout: "" },
  });
}

/** A detector returning a runner with a fixed subprocess result. */
function fixedInvocation(
  result: SemgrepRunResult,
  seen?: { files: string[] },
): DetectSemgrepInvocation {
  return () =>
    Promise.resolve({
      description: "stub semgrep",
      pinnedToCi: true,
      run: (files: string[]) => {
        if (seen) seen.files = files;
        return Promise.resolve(result);
      },
    });
}

/** A semgrep JSON report carrying the given findings. */
function reportOf(findings: Array<Partial<SemgrepFinding>>): string {
  return JSON.stringify({
    errors: [],
    results: findings.map((f) => ({
      check_id: f.ruleId ?? "rule.id",
      path: f.file ?? "file.ts",
      start: { line: f.line ?? 1, col: 1 },
      end: { line: f.line ?? 1, col: 20 },
      extra: {
        message: f.message ?? "a finding",
        severity: f.severity ?? "WARNING",
      },
    })),
  });
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

Deno.test("isScannablePath - accepts source extensions, rejects prose and extensionless files", () => {
  assert(isScannablePath("worker/deno/lib/foo.ts"));
  assert(isScannablePath("scripts/deploy.sh"));
  assert(isScannablePath(".github/workflows/semgrep.yml"));
  assert(!isScannablePath("README.md"));
  assert(!isScannablePath("docs/evidence/shot.png"));
  assert(!isScannablePath("hooks/pre-commit"));
  assert(!isScannablePath(".gitignore"));
});

Deno.test("selectScannableFiles - de-duplicates, sorts and drops blank lines", () => {
  assertEquals(
    selectScannableFiles(["b.ts", "", "a.ts", "b.ts", "  ", "notes.md"]),
    ["a.ts", "b.ts"],
  );
});

Deno.test("collectChangedFiles - unions the merge-base diff with untracked files", async () => {
  const git = fakeGit({
    "rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "rev-parse --abbrev-ref refs/remotes/origin/HEAD": {
      stdout: "origin/main\n",
    },
    "merge-base origin/main HEAD": { stdout: "deadbeefcafe\n" },
    "diff --name-only --diff-filter=ACMR deadbeefcafe": {
      stdout: "worker/deno/lib/a.ts\ndocs/notes.md\n",
    },
    "ls-files --others --exclude-standard": {
      stdout: "worker/deno/lib/b.ts\n",
    },
  });

  const changed = await collectChangedFiles(git);
  assert(changed !== null);
  assertEquals(changed.base, "deadbeefcafe");
  assertEquals(changed.files, ["worker/deno/lib/a.ts", "worker/deno/lib/b.ts"]);
});

Deno.test("collectChangedFiles - falls back to HEAD when the remote default branch cannot be resolved", async () => {
  const git = fakeGit({
    "rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "rev-parse --abbrev-ref refs/remotes/origin/HEAD": { exitCode: 128 },
    "diff --name-only --diff-filter=ACMR HEAD": { stdout: "lib/x.py\n" },
    "ls-files --others --exclude-standard": { stdout: "" },
  });

  const changed = await collectChangedFiles(git);
  assert(changed !== null);
  assertEquals(changed.base, "HEAD");
  assertEquals(changed.files, ["lib/x.py"]);
});

Deno.test("collectChangedFiles - returns null outside a git work tree", async () => {
  const git = fakeGit({ "rev-parse --is-inside-work-tree": { exitCode: 128 } });
  assertEquals(await collectChangedFiles(git), null);
});

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

Deno.test("parseSemgrepJson - flattens results into findings", () => {
  const findings = parseSemgrepJson(reportOf([
    {
      ruleId: "javascript.lang.security.audit.detect-non-literal-regexp",
      file: "worker/deno/lib/a.ts",
      line: 42,
      severity: "WARNING",
      message: "RegExp() called with a non-literal variable",
    },
  ]));
  assertEquals(findings.length, 1);
  const finding = findings[0]!;
  assertEquals(finding.file, "worker/deno/lib/a.ts");
  assertEquals(finding.line, 42);
  assertEquals(
    finding.ruleId,
    "javascript.lang.security.audit.detect-non-literal-regexp",
  );
  assertStringIncludes(finding.message, "non-literal");
});

Deno.test("parseSemgrepJson - drops entries with no usable location", () => {
  const raw = JSON.stringify({
    results: [
      { check_id: "r", path: "", start: { line: 3 }, extra: {} },
      { check_id: "r", path: "a.ts", start: {}, extra: {} },
    ],
  });
  assertEquals(parseSemgrepJson(raw), []);
});

Deno.test("parseSemgrepJson - throws on an empty report rather than reporting clean", () => {
  let threw = false;
  try {
    parseSemgrepJson("   ");
  } catch {
    threw = true;
  }
  assert(threw, "an empty report must fail loud, not read as zero findings");
});

Deno.test("isRegistryUnavailable - recognises an offline rule fetch, not an ordinary failure", () => {
  assert(isRegistryUnavailable(
    "Failed to download config from https://semgrep.dev/c/p/default",
  ));
  assert(isRegistryUnavailable("Max retries exceeded with url: /c/p/default"));
  assert(!isRegistryUnavailable("invalid pattern in rule foo"));
});

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

Deno.test("runSemgrepCheck - FAILED naming the detect-non-literal-regexp remedy (Issue #559)", async () => {
  const seen = { files: [] as string[] };
  const result = await runSemgrepCheck("/repo", {
    git: gitWithChangedFile("worker/deno/lib/label_match.ts"),
    detectInvocation: fixedInvocation({
      exitCode: 1,
      stdout: reportOf([
        {
          ruleId: "javascript.lang.security.audit.detect-non-literal-regexp",
          file: "worker/deno/lib/label_match.ts",
          line: 17,
          severity: "WARNING",
          message: "RegExp() called with a non-literal variable",
        },
      ]),
      stderr: "",
    }, seen),
  });

  assertEquals(result.status, "FAILED");
  assertEquals(result.findings.length, 1);
  assertEquals(seen.files, ["worker/deno/lib/label_match.ts"]);
  assertStringIncludes(result.output, "worker/deno/lib/label_match.ts:17");
  assertStringIncludes(result.output, "detect-non-literal-regexp");
  assertStringIncludes(result.output, "escape the interpolated value");
});

Deno.test("runSemgrepCheck - a finding from another rule omits the regexp remedy", async () => {
  const result = await runSemgrepCheck("/repo", {
    git: gitWithChangedFile("worker/deno/lib/spawn.ts"),
    detectInvocation: fixedInvocation({
      exitCode: 1,
      stdout: reportOf([
        {
          ruleId: "javascript.lang.security.audit.detect-child-process",
          file: "worker/deno/lib/spawn.ts",
          line: 8,
        },
      ]),
      stderr: "",
    }),
  });

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "detect-child-process");
  assert(!result.output.includes("escape the interpolated value"));
});

Deno.test("runSemgrepCheck - PASSED when the scan reports no findings", async () => {
  const result = await runSemgrepCheck("/repo", {
    git: gitWithChangedFile("worker/deno/lib/a.ts"),
    detectInvocation: fixedInvocation({
      exitCode: 0,
      stdout: reportOf([]),
      stderr: "",
    }),
  });

  assertEquals(result.status, "PASSED");
  assertEquals(result.filesScanned, 1);
  assertStringIncludes(result.output, SEMGREP_CONFIG);
});

Deno.test("runSemgrepCheck - PASSED without invoking semgrep when nothing scannable changed", async () => {
  let detected = false;
  const git = fakeGit({
    "rev-parse --is-inside-work-tree": { stdout: "true\n" },
    "rev-parse --abbrev-ref refs/remotes/origin/HEAD": {
      stdout: "origin/main\n",
    },
    "merge-base origin/main HEAD": { stdout: "abc123def456\n" },
    "diff --name-only --diff-filter=ACMR abc123def456": {
      stdout: "README.md\ndocs/EXTENDING.md\n",
    },
    "ls-files --others --exclude-standard": { stdout: "" },
  });

  const result = await runSemgrepCheck("/repo", {
    git,
    detectInvocation: () => {
      detected = true;
      return Promise.resolve(null);
    },
  });

  assertEquals(result.status, "PASSED");
  assertEquals(result.filesScanned, 0);
  assert(!detected, "a docs-only change must not pay for tool detection");
});

Deno.test("runSemgrepCheck - SKIPPED loudly when semgrep cannot be run", async () => {
  const result = await runSemgrepCheck("/repo", {
    git: gitWithChangedFile("worker/deno/lib/a.ts"),
    detectInvocation: () => Promise.resolve(null),
  });

  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(result.output, "semgrep: SKIPPED");
  assertStringIncludes(result.skipReason ?? "", "install semgrep");
  assertStringIncludes(result.skipReason ?? "", SEMGREP_IMAGE);
});

Deno.test("runSemgrepCheck - SKIPPED outside a git repository", async () => {
  const result = await runSemgrepCheck("/tmp/not-a-repo", {
    git: fakeGit({ "rev-parse --is-inside-work-tree": { exitCode: 128 } }),
    detectInvocation: () => Promise.resolve(null),
  });

  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(result.skipReason ?? "", "not a git repository");
});

Deno.test("runSemgrepCheck - SKIPPED when the rule registry is unreachable", async () => {
  const result = await runSemgrepCheck("/repo", {
    git: gitWithChangedFile("worker/deno/lib/a.ts"),
    detectInvocation: fixedInvocation({
      exitCode: 7,
      stdout: "",
      stderr: "Failed to download config from https://semgrep.dev/c/p/default",
    }),
  });

  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(result.skipReason ?? "", "could not be fetched");
});

Deno.test("runSemgrepCheck - SKIPPED naming the deadline when the scan runs long", async () => {
  const result = await runSemgrepCheck("/repo", {
    git: gitWithChangedFile("worker/deno/lib/a.ts"),
    detectInvocation: fixedInvocation({
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: true,
    }),
  });

  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(
    result.skipReason ?? "",
    `${SEMGREP_DEADLINE_MS / 1000}s`,
  );
});

Deno.test("runSemgrepCheck - FAILED when semgrep errors without a report (never a silent pass)", async () => {
  const result = await runSemgrepCheck("/repo", {
    git: gitWithChangedFile("worker/deno/lib/a.ts"),
    detectInvocation: fixedInvocation({
      exitCode: 2,
      stdout: "",
      stderr: "invalid rule schema in p/default",
    }),
  });

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "invalid rule schema");
});

Deno.test("runSemgrepCheck - FAILED when semgrep exits non-zero with an empty report", async () => {
  const result = await runSemgrepCheck("/repo", {
    git: gitWithChangedFile("worker/deno/lib/a.ts"),
    detectInvocation: fixedInvocation({
      exitCode: 3,
      stdout: reportOf([]),
      stderr: "config error",
    }),
  });

  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "no findings reported");
});

Deno.test("runSemgrepCheck - a SKIPPED semgrep fails the gate under --strict", () => {
  const checks: Array<{ name: string; status: "PASSED" | "SKIPPED" }> = [];
  recordCheck(checks, "semgrep", "SKIPPED");
  assertEquals(formatSummary(checks, false).passed, true);
  assertEquals(formatSummary(checks, true).passed, false);
});

// ---------------------------------------------------------------------------
// Invocation shape
// ---------------------------------------------------------------------------

Deno.test("buildContainerArgs - runs the tag+digest image CI runs, read-only", () => {
  const args = buildContainerArgs("/work/repo", ["lib/a.ts"]);
  assertEquals(args[0], "run");
  assert(args.includes(SEMGREP_IMAGE), `image pin missing: ${args.join(" ")}`);
  assertStringIncludes(SEMGREP_IMAGE, SEMGREP_IMAGE_TAG);
  assert(args.includes("/work/repo:/src:ro"));
  assertEquals(args[args.length - 1], "lib/a.ts");
  // `--` guards a changed file whose name starts with a dash (CWE-88).
  assertEquals(args[args.length - 2], "--");
  assert(args.includes(SEMGREP_CONFIG));
});

// ---------------------------------------------------------------------------
// Gate wiring
// ---------------------------------------------------------------------------

Deno.test("quality gate - registers the semgrep check (Issue #559)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await runQualityGate({
      scriptDir: tmpDir,
      options: { strict: false, sequential: true, validatePrompts: false },
    });
    assert(result.ok, "quality gate should return a result");
    const names = result.value.checks.map((check) => check.name);
    assert(
      names.includes("semgrep"),
      `Gate must run semgrep locally (Issue #559); recorded: ${
        names.join(", ")
      }`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
