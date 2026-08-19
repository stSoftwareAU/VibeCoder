/**
 * Tests for the progress-extension check interval in the runner
 * (Issue #4295, part of #4290).
 *
 * With `checkSeconds` set the watchdog wakes on the check interval as well as
 * on the deadline. An interim wake only *samples* the working tree — it can
 * never kill, because the budget has not run out — so the deadline decision
 * reads a verdict describing the last check window instead of the whole grant.
 *
 * The agent is a stub script on PATH and the tree probe is injected, so no
 * test needs a git repository.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import type { TreeProgressState } from "../lib/progress_extension.ts";
import type { Logger } from "../types.ts";

/** One stream-json line carrying a tool call, so the activity signal moves. */
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"worker/deno/lib/x.ts"}}]}}`;

/** A stub agent on PATH plus the temp dir holding it. */
interface StubAgent {
  dir: string;
  restore: () => Promise<void>;
}

/**
 * Install a stub `claude` on PATH.
 *
 * The stub re-execs into its own session so the watchdog's process-group kill
 * lands on the stub alone rather than on the `deno test` process.
 *
 * @param body - Bash body of the stub, after the shebang.
 */
async function installStub(body: string): Promise<StubAgent> {
  const dir = await Deno.makeTempDir({ prefix: "claude_check_interval_" });
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(
    `${dir}/claude.impl`,
    `#!/usr/bin/env bash\n${body}`,
  );
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `impl="$(dirname "$0")/claude.impl"\n` +
      `if command -v setsid >/dev/null 2>&1; then exec setsid bash "$impl"; fi\n` +
      `exec bash "$impl"\n`,
  );
  await Deno.chmod(stubPath, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  return {
    dir,
    restore: async () => {
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    },
  };
}

/** A stub that emits a tool call every `gapSeconds` for `count` iterations. */
function chattyStub(count: number, gapSeconds: string): string {
  return `for i in $(seq 1 ${count}); do\n` +
    `  printf '%s\\n' '${TOOL_LINE}'\n` +
    `  sleep ${gapSeconds}\n` +
    `done\n` +
    `printf '%s\\n' '{"type":"result","result":"done"}'\n`;
}

/** Discard log lines — these tests assert on outcomes, not on the log. */
function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

/** A probe that records each call and always answers `verdict`. */
function countingProbe(verdict: TreeProgressState) {
  const calls: number[] = [];
  return {
    calls,
    probe: (): Promise<TreeProgressState> => {
      calls.push(Date.now());
      return Promise.resolve(verdict);
    },
  };
}

Deno.test({
  name:
    "runClaudeWithTimeout - the tree is sampled on the check interval, not only at the deadline (Issue #4295)",
  fn: async () => {
    // ~2 s of steady tool calls against a 1 s budget with 0.2 s checks: the
    // deadline alone would produce a single probe call (Issue #4296).
    const stub = await installStub(chattyStub(20, "0.1"));
    const { calls, probe } = countingProbe("advanced");
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger: silentLogger(),
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 10,
            activityStallSeconds: 60,
            checkSeconds: 0.2,
          },
          treeProbe: probe,
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a progressing run must not be killed",
      );
      assert(
        calls.length >= 3,
        `interim samples must run on the check interval (probe calls: ${calls.length})`,
      );
    } finally {
      await stub.restore();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - an interim check gathers evidence only and never kills (Issue #4295)",
  fn: async () => {
    // The tree never advances, but the run finishes well inside its budget:
    // the interim checks must not kill it, because the budget is what the
    // deadline guards — the checks only sample.
    const stub = await installStub(chattyStub(5, "0.1"));
    const { calls, probe } = countingProbe("unchanged");
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 5,
        killAfterSeconds: 1,
        logger: silentLogger(),
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 5,
            activityStallSeconds: 60,
            checkSeconds: 0.1,
          },
          treeProbe: probe,
        },
      });

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "an unchanged tree inside the budget is not a reason to kill",
      );
      assert(
        calls.length >= 2,
        `the interim checks must have run (probe calls: ${calls.length})`,
      );
    } finally {
      await stub.restore();
    }
  },
});
