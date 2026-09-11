/**
 * Issue #1952: the pre-push workflow-scope check must not fail open silently.
 *
 * `git diff --name-only origin/<base>...HEAD` was treated as "no changed
 * paths" whenever it errored, so the check no-opped without a word and the
 * push carried the workflow file into GitHub's refusal. The probe now falls
 * back to the commit list, and says so both times it cannot answer.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { probeChangedWorkflowPaths } from "../lib/workflow_scope_precheck.ts";
import type { Result } from "../types.ts";

type GitResult = Result<{ code: number; stdout: string; stderr: string }>;

const ok = (stdout: string): GitResult => ({
  ok: true,
  value: { code: 0, stdout, stderr: "" },
});
const nonZero = (stderr: string): GitResult => ({
  ok: true,
  value: { code: 128, stdout: "", stderr },
});
const failed = (message: string): GitResult => ({
  ok: false,
  error: new Error(message),
});

interface Probe {
  args: string[][];
  warnings: string[];
}

function runProbe(
  responses: (args: string[]) => GitResult,
): { probe: Probe; run: () => ReturnType<typeof probeChangedWorkflowPaths> } {
  const probe: Probe = { args: [], warnings: [] };
  return {
    probe,
    run: () =>
      probeChangedWorkflowPaths({
        baseRef: "origin/main",
        cwd: "/tmp/repo",
        runGit: (args: string[]) => {
          probe.args.push(args);
          return Promise.resolve(responses(args));
        },
        warn: (message: string) => probe.warnings.push(message),
      }),
  };
}

Deno.test("probeChangedWorkflowPaths - the diff answers, and nothing is logged (Issue #1952)", async () => {
  const { probe, run } = runProbe(() =>
    ok(".github/workflows/ci.yml\nREADME.md\n")
  );
  const result = await run();
  assertEquals(result.source, "diff");
  assertEquals(result.paths, [".github/workflows/ci.yml", "README.md"]);
  assertEquals(probe.warnings, []);
  assertEquals(probe.args.length, 1);
  assertEquals(probe.args[0]?.[0], "diff");
});

Deno.test("probeChangedWorkflowPaths - a failed diff falls back to the commit list and says so (Issue #1952)", async () => {
  const { probe, run } = runProbe((args) =>
    args[0] === "diff"
      ? nonZero("fatal: ambiguous argument 'origin/main...HEAD'")
      : ok(
        "\n.github/workflows/ci.yml\n\ndocs/README.md\n.github/workflows/ci.yml\n",
      )
  );
  const result = await run();
  assertEquals(result.source, "commit-log");
  assertEquals(result.paths, [".github/workflows/ci.yml", "docs/README.md"]);
  assertEquals(probe.args[1]?.[0], "log");
  assertEquals(probe.warnings.length, 1);
  assertStringIncludes(probe.warnings[0] ?? "", "commit list");
  assertStringIncludes(probe.warnings[0] ?? "", "ambiguous argument");
});

Deno.test("probeChangedWorkflowPaths - a spawn failure also falls back (Issue #1952)", async () => {
  const { probe, run } = runProbe((args) =>
    args[0] === "diff"
      ? failed("git spawn timed out after 120s")
      : ok(".github/workflows/release.yml\n")
  );
  const result = await run();
  assertEquals(result.source, "commit-log");
  assertEquals(result.paths, [".github/workflows/release.yml"]);
  assertStringIncludes(probe.warnings[0] ?? "", "git spawn timed out");
});

Deno.test("probeChangedWorkflowPaths - when neither can answer it reports the skip loudly (Issue #1952)", async () => {
  const { probe, run } = runProbe(() => failed("fatal: not a git repository"));
  const result = await run();
  assertEquals(result.source, "unavailable");
  assertEquals(result.paths, []);
  assertEquals(probe.warnings.length, 2);
  const final = probe.warnings[1] ?? "";
  assertStringIncludes(final, "skipped");
  assertStringIncludes(final, "not a git repository");
  assertStringIncludes(final, ".github/workflows/");
  assertStringIncludes(result.detail, "not a git repository");
});
