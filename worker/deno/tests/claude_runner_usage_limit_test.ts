/**
 * End-to-end tests for the subscription usage-limit path in
 * `runClaudeWithRetry()` (Issue #4315).
 *
 * A stub agent, named by path (Issue #959), prints the CLI's usage-limit
 * message to STDERR (with empty stdout — the shape a real refusal has) and
 * exits non-zero. The runner must: detect it from stderr, NOT walk the
 * model-fallback ladder, return exit code 2 with the usage-limit evidence,
 * and write the durable signal to the work volume — not the per-issue cwd.
 *
 * Neither the stub nor the work volume is installed in the process
 * environment any more (Issue #960): the binary path and `workDir` are
 * both invocation options, so this suite races nothing under
 * `deno test --parallel`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  runClaudeWithRetry,
  USAGE_LIMIT_MAX_WAIT_SECONDS,
} from "../lib/claude_runner.ts";
import { rateLimitSignalPath } from "../lib/rate_limit_signal.ts";
import { type AgentStub, withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

/**
 * Run `fn` with a stub agent that refuses with `stderrMessage` and logs
 * every `--model` it was asked for.
 *
 * The log lives beside the stub, so disposing the stub takes it too.
 */
function withUsageLimitStub<T>(
  stderrMessage: string,
  fn: (stub: AgentStub & { modelLog: string }) => Promise<T>,
): Promise<T> {
  const body = `modelLog="$(dirname "$0")/models.log"\n` +
    `prev=""\nfor arg in "$@"; do\n  if [ "$prev" = "--model" ]; then printf '%s\\n' "$arg" >> "$modelLog"; fi\n  prev="$arg"\ndone\n` +
    `printf '%s\\n' '${stderrMessage}' >&2\n` +
    "exit 1\n";
  return withAgentStub(
    body,
    (stub) => fn({ ...stub, modelLog: `${stub.dir}/models.log` }),
    { prefix: "claude_ul_stub_" },
  );
}

Deno.test({
  name:
    "runClaudeWithRetry - a stderr-only usage limit is terminal: no fallback ladder, exit 2, evidence carried (Issue #4315)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "ul_workdir_" });
    try {
      const resetEpoch = Math.floor(Date.now() / 1000) + 2 * 3600;
      await Deno.mkdir(`${workDir}/some-repo-clone`, { recursive: true });
      const { result, models } = await withUsageLimitStub(
        `Claude AI usage limit reached|${resetEpoch}`,
        async (stub) => {
          const result = await runClaudeWithRetry(
            {
              clock: fakeClock(),
              prompt: "test",
              model: "fable",
              enableModelFallback: true,
              timeoutSeconds: 30,
              killAfterSeconds: 2,
              cwd: `${workDir}/some-repo-clone`,
              agentBinaryPath: stub.path,
              workDir,
            },
            { maxRetries: 2, maxWaitSeconds: 600, initialWaitInterval: 300 },
          );
          let models: string[] = [];
          try {
            models = (await Deno.readTextFile(stub.modelLog)).trim().split(
              "\n",
            );
          } catch { /* none */ }
          return { result, models };
        },
      );

      assert(result.ok);
      assertEquals(result.value.exitCode, 2);
      // ONE invocation — no retry, no fable→opus→sonnet→haiku ladder.
      assertEquals(models, ["fable"]);
      assert(result.value.usageLimit, "usageLimit evidence must be carried");
      assertEquals(result.value.usageLimit!.resetEpochMs, resetEpoch * 1000);
      // Issue #333: the reset and the retry cadence are separate. The true
      // reset is still carried in full — that is what an operator reads — but
      // the pause is capped so an *extended* quota is picked up within the
      // hour rather than the worker sleeping to a reset that may have moved.
      // This previously asserted `> 3600`, i.e. sleep until the reset.
      assertEquals(
        result.value.usageLimit!.waitSeconds,
        USAGE_LIMIT_MAX_WAIT_SECONDS,
      );
      assert(
        (result.value.usageLimit!.resetEpochMs ?? 0) >
          Date.now() + USAGE_LIMIT_MAX_WAIT_SECONDS * 1000,
        "the fixture's reset must be beyond the cap for this to mean anything",
      );
      // The signal lands in WORK_DIR, not in the per-issue cwd.
      const signal = JSON.parse(
        await Deno.readTextFile(rateLimitSignalPath(workDir)),
      );
      assertEquals(
        signal.waitSeconds,
        USAGE_LIMIT_MAX_WAIT_SECONDS,
        JSON.stringify(signal),
      );
      let cwdSignal = false;
      try {
        await Deno.stat(rateLimitSignalPath(`${workDir}/some-repo-clone`));
        cwdSignal = true;
      } catch { /* expected: absent */ }
      assertEquals(cwdSignal, false, "signal must not be written to cwd");
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a usage limit with no reset time waits the default hour (Issue #4315)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "ul_workdir_" });
    try {
      const { result } = await withUsageLimitStub(
        "You have hit your usage limit for this 5-hour window",
        async (stub) => ({
          result: await runClaudeWithRetry(
            {
              clock: fakeClock(),
              prompt: "t",
              model: "opus",
              timeoutSeconds: 30,
              killAfterSeconds: 2,
              agentBinaryPath: stub.path,
              workDir,
            },
            { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
          ),
        }),
      );
      assert(result.ok);
      assertEquals(result.value.exitCode, 2);
      assertEquals(result.value.usageLimit?.waitSeconds, 3600);
      assertEquals(result.value.usageLimit?.resetEpochMs, undefined);
      assertStringIncludes(result.value.stderr ?? "", "usage limit");
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
    }
  },
});
