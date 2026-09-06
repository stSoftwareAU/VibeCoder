/**
 * Regression tests for the three unbounded spawns over attacker-influenced
 * content (Issue #1228, parent #1214).
 *
 * Each of `deno doc` (coverage-gap scanner), the sweep scanners (semgrep and
 * friends) and the workflow auditor's non-`gh` fallback spawned a subprocess
 * with no `signal`/`AbortController` at the spawn and none anywhere in the
 * call chain. A spawn without a timeout is a hang, not a slowdown: the
 * worker's own watchdogs are starved and a human has to kill the host.
 *
 * The subprocess runner is injected in every test, so these assert the bound
 * itself — that a finite `timeoutMs` reaches the runner, and that a child
 * killed on timeout is surfaced rather than read as a clean result — without
 * spawning anything.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Result } from "../types.ts";
import type {
  runWithTimeout,
  SubprocessResult,
} from "../lib/subprocess_timeout.ts";
import {
  createDenoDocRunner,
  DENO_DOC_TIMEOUT_MS,
  findCoverageGaps,
} from "../lib/coverage_gap_scanner.ts";
import {
  createDefaultRunner,
  SWEEP_SCANNER_TIMEOUT_MS,
} from "../lib/security_tree_sweep.ts";
import {
  AUDITOR_COMMAND_TIMEOUT_MS,
  createDefaultRunCommand,
} from "../lib/workflow_auditor.ts";

/** One recorded call to the injected subprocess runner. */
interface RecordedCall {
  executable: string;
  args: string[];
  options?: Parameters<typeof runWithTimeout>[2];
}

/**
 * A fake `runWithTimeout` that records its calls and returns `value`.
 *
 * Nothing is spawned, so the tests are deterministic and take microseconds.
 */
function fakeRunner(
  value: Partial<SubprocessResult>,
): { calls: RecordedCall[]; run: typeof runWithTimeout } {
  const calls: RecordedCall[] = [];
  const run = (
    executable: string,
    args: string[],
    options?: Parameters<typeof runWithTimeout>[2],
  ): Promise<Result<SubprocessResult>> => {
    calls.push({ executable, args, options });
    return Promise.resolve({
      ok: true,
      value: {
        success: false,
        code: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...value,
      },
    });
  };
  return { calls, run };
}

/** Assert `timeoutMs` is present, finite and positive. */
function assertBounded(options: RecordedCall["options"]): void {
  const timeoutMs = options?.timeoutMs;
  assert(
    typeof timeoutMs === "number",
    "the spawn must carry a timeout — an unbounded spawn is a hang",
  );
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeout must be finite");
}

Deno.test("deno doc spawn is bounded and returns the document on success", async () => {
  const { calls, run } = fakeRunner({
    success: true,
    stdout: '{"nodes":[]}',
  });
  const doc = await createDenoDocRunner(run)("/tmp/cloned-repo");

  assertEquals(doc, '{"nodes":[]}');
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.executable, "deno");
  assertEquals(calls[0]!.args, ["doc", "--json", "/tmp/cloned-repo"]);
  assertBounded(calls[0]!.options);
  assertEquals(calls[0]!.options?.timeoutMs, DENO_DOC_TIMEOUT_MS);
});

Deno.test("a timed-out deno doc fails loud and never reads as a clean scan", async () => {
  const { run } = fakeRunner({ code: 124, timedOut: true });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...parts: unknown[]) => {
    warnings.push(parts.map(String).join(" "));
  };

  try {
    const denoDocFn = createDenoDocRunner(run);
    await assertRejects(
      () => denoDocFn("/tmp/cloned-repo"),
      Error,
      "timed out",
    );

    // The scanner's best-effort contract degrades to an empty gap list —
    // it must not hang, and the timeout is on the log either way.
    const gaps = await findCoverageGaps({
      workDir: "/tmp/cloned-repo",
      denoDocFn,
      collectTestSourcesFn: () => Promise.resolve(""),
    });
    assertEquals(gaps, []);
  } finally {
    console.warn = originalWarn;
  }

  // One warning per timed-out spawn: the direct call, then the one inside
  // `findCoverageGaps`. Neither timeout is swallowed.
  assertEquals(warnings.length, 2);
  assert(
    warnings.every((w) => w.includes("timed out")),
    `expected loud timeout warnings, got: ${warnings.join(" | ")}`,
  );
});

Deno.test("sweep scanner spawn is bounded, keeping cwd and the built environment", async () => {
  const { calls, run } = fakeRunner({
    success: true,
    code: 0,
    stdout: '{"results":[]}',
  });
  const outcome = await createDefaultRunner(run)(
    { bin: "semgrep", args: ["scan", "--json"] },
    "/tmp/swept-tree",
  );

  assertEquals(outcome.code, 0);
  assertEquals(outcome.stdout, '{"results":[]}');
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.executable, "semgrep");
  assertEquals(calls[0]!.args, ["scan", "--json"]);
  assertEquals(calls[0]!.options?.cwd, "/tmp/swept-tree");
  // Issue #1226's credential boundary must survive the timeout wrapping.
  assertEquals(calls[0]!.options?.clearEnv, true);
  assert(calls[0]!.options?.env !== undefined, "built environment is kept");
  assertBounded(calls[0]!.options);
  assertEquals(calls[0]!.options?.timeoutMs, SWEEP_SCANNER_TIMEOUT_MS);
});

Deno.test("a timed-out sweep scanner surfaces exit 124, not an empty clean result", async () => {
  const { run } = fakeRunner({
    code: 124,
    timedOut: true,
    stderr: "Timed out after 900000ms",
  });
  const outcome = await createDefaultRunner(run)(
    { bin: "semgrep", args: ["scan", "--json"] },
    "/tmp/swept-tree",
  );

  // Every collector treats a code outside {0, 1} as a fault, so 124 reaches
  // the operator as a failed scan rather than a clean tree.
  assertEquals(outcome.code, 124);
  assert(outcome.stderr.includes("Timed out"));
});

Deno.test("workflow auditor's non-gh spawn is bounded", async () => {
  const { calls, run } = fakeRunner({ success: true, stdout: "ok\n" });
  const output = await createDefaultRunCommand("/tmp/gh-config", run)([
    "curl",
    "https://example.invalid/workflows",
  ]);

  assertEquals(output.success, true);
  assertEquals(output.stdout, "ok");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.executable, "curl");
  assertEquals(calls[0]!.args, ["https://example.invalid/workflows"]);
  assertEquals(calls[0]!.options?.env, { GH_CONFIG_DIR: "/tmp/gh-config" });
  assertBounded(calls[0]!.options);
  assertEquals(calls[0]!.options?.timeoutMs, AUDITOR_COMMAND_TIMEOUT_MS);
});

Deno.test("workflow auditor reports a timed-out spawn as a failure", async () => {
  const { run } = fakeRunner({
    success: false,
    code: 124,
    timedOut: true,
    stderr: "Timed out after 60000ms",
  });
  const output = await createDefaultRunCommand(undefined, run)(["curl", "-s"]);

  assertEquals(output.success, false);
  assert(output.stderr.includes("Timed out"));
});
