/**
 * End-to-end tests for a model-scoped Claude usage limit (Issue #5086).
 *
 * A limit that names a model tier ("You've reached your Fable limit") is not
 * account-wide: the run must retry on the next model down on the same
 * provider, record a model-scoped cooldown, and write NO provider pause. An
 * account-wide limit keeps its terminal pause.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { Logger } from "../types.ts";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { rateLimitSignalPath } from "../lib/rate_limit_signal.ts";
import { modelUsageCooldownPath } from "../lib/model_usage_cooldown.ts";
import { posixSingleQuote } from "../lib/shell_quote.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` with a stub that refuses (stderr message, exit 1) whenever the
 * `--model` is one of `refusedModels`, and succeeds otherwise. Every `--model`
 * is logged.
 */
async function withModelStub<T>(
  refusedModels: string[],
  stderrMessage: string,
  fn: (stub: { path: string; modelLog: string }) => Promise<T>,
  refusalStream: "stderr" | "stdout" = "stderr",
): Promise<T> {
  const cases = refusedModels.length > 0
    ? refusedModels.map((m) => `"${m}"`).join("|")
    : '"__none__"';
  const redirect = refusalStream === "stderr" ? " >&2" : "";
  const body = `modelLog="$(dirname "$0")/models.log"\n` +
    `prev=""\nmodel=""\nfor arg in "$@"; do\n  if [ "$prev" = "--model" ]; then model="$arg"; printf '%s\\n' "$arg" >> "$modelLog"; fi\n  prev="$arg"\ndone\n` +
    `case "$model" in\n  ${cases})\n    printf '%s\\n' ${
      posixSingleQuote(stderrMessage)
    }${redirect}\n    exit 1\n    ;;\nesac\n` +
    `printf 'all done\\n'\nexit 0\n`;
  return await withAgentStub(
    body,
    (stub) => fn({ path: stub.path, modelLog: `${stub.dir}/models.log` }),
    { prefix: "claude_5086_stub_" },
  );
}

async function readModels(modelLog: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(modelLog)).trim().split("\n");
  } catch {
    return [];
  }
}

async function runOnce(
  workDir: string,
  stubPath: string,
  model: string,
  logger?: Logger,
) {
  await Deno.mkdir(`${workDir}/repo-clone`, { recursive: true });
  return await runClaudeWithRetry(
    {
      clock: fakeClock(),
      prompt: "test",
      model,
      enableModelFallback: true,
      timeoutSeconds: 30,
      killAfterSeconds: 2,
      cwd: `${workDir}/repo-clone`,
      agentBinaryPath: stubPath,
      workDir,
      ...(logger ? { logger } : {}),
    },
    { maxRetries: 2, maxWaitSeconds: 600, initialWaitInterval: 300 },
  );
}

const PERMS = { run: true, read: true, write: true, env: true } as const;
const SKIP = Deno.build.os === "windows";

for (
  const [label, message] of [
    [
      "observed form",
      "You've reached your Fable limit. Switch to another model to continue.",
    ],
    [
      "weekly form",
      "You've hit your Fable weekly limit · resets Nov 20, 1am (UTC)",
    ],
  ] as const
) {
  Deno.test({
    name:
      `runClaudeWithRetry - a Fable-scoped limit (${label}) steps down to opus with no provider pause (Issue #5086)`,
    permissions: PERMS,
    ignore: SKIP,
    async fn() {
      const workDir = await Deno.makeTempDir({ prefix: "ms_workdir_" });
      try {
        const first = await withModelStub(["fable"], message, async (stub) => {
          const result = await runOnce(workDir, stub.path, "fable");
          return { result, models: await readModels(stub.modelLog) };
        });
        assert(first.result.ok);
        assertEquals(first.result.value.exitCode, 0);
        assertEquals(first.models, ["fable", "opus"]);
        assertEquals(first.result.value.usageLimit, undefined);
        assertEquals(await exists(rateLimitSignalPath(workDir)), false);

        const cooldown = JSON.parse(
          await Deno.readTextFile(modelUsageCooldownPath(workDir)),
        );
        assert(cooldown.cooldowns["claude/fable"], JSON.stringify(cooldown));

        // A second call must start on opus rather than re-probe the cap.
        const second = await withModelStub(["fable"], message, async (stub) => {
          const result = await runOnce(workDir, stub.path, "fable");
          return { result, models: await readModels(stub.modelLog) };
        });
        assert(second.result.ok);
        assertEquals(second.result.value.exitCode, 0);
        assertEquals(second.models, ["opus"]);
        assertEquals(await exists(rateLimitSignalPath(workDir)), false);
      } finally {
        await Deno.remove(workDir, { recursive: true });
      }
    },
  });
}

Deno.test({
  name:
    "runClaudeWithRetry - an account-wide session limit still pauses the provider and records no model cooldown (Issue #5086)",
  permissions: PERMS,
  ignore: SKIP,
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "ms_workdir_" });
    try {
      const { result, models } = await withModelStub(
        ["fable", "opus", "sonnet", "haiku"],
        "You've hit your session limit · resets 1:50pm (UTC)",
        async (stub) => {
          const result = await runOnce(workDir, stub.path, "fable");
          return { result, models: await readModels(stub.modelLog) };
        },
      );
      assert(result.ok);
      assertEquals(result.value.exitCode, 2);
      assertEquals(models, ["fable"]);
      assertEquals(await exists(rateLimitSignalPath(workDir)), true);
      assertEquals(await exists(modelUsageCooldownPath(workDir)), false);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a model-scoped limit on the cheapest rung writes no provider pause (Issue #5086)",
  permissions: PERMS,
  ignore: SKIP,
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "ms_workdir_" });
    try {
      const { result, models } = await withModelStub(
        ["haiku"],
        "You've reached your Haiku limit. Switch to another model to continue.",
        async (stub) => {
          const result = await runOnce(workDir, stub.path, "haiku");
          return { result, models: await readModels(stub.modelLog) };
        },
      );
      assert(result.ok);
      assert(result.value.exitCode !== 2, "must not look like a usage pause");
      assertEquals(result.value.usageLimit, undefined);
      assertEquals(models, ["haiku"]);
      assertEquals(await exists(rateLimitSignalPath(workDir)), false);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a stream-json synthetic Fable limit on stdout steps down to opus (Issue #5086)",
  permissions: PERMS,
  ignore: SKIP,
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "ms_workdir_" });
    try {
      const line =
        '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"You have reached your Fable limit"}]},"error":"rate_limit","is_api_error_message":true}';
      const { result, models } = await withModelStub(
        ["fable"],
        line,
        async (stub) => {
          const result = await runOnce(workDir, stub.path, "fable");
          return { result, models: await readModels(stub.modelLog) };
        },
        "stdout",
      );
      assert(result.ok);
      assertEquals(result.value.exitCode, 0);
      assertEquals(models, ["fable", "opus"]);
      assertEquals(result.value.usageLimit, undefined);
      assertEquals(await exists(rateLimitSignalPath(workDir)), false);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a corrupt cooldown file warns loudly and the requested model still runs (Issue #5086)",
  permissions: PERMS,
  ignore: SKIP,
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "ms_workdir_" });
    try {
      await Deno.writeTextFile(modelUsageCooldownPath(workDir), "{not json");
      const warnings: string[] = [];
      const logger = {
        info: () => {},
        warn: (m: string) => warnings.push(m),
        error: () => {},
        debug: () => {},
        security: () => {},
        skipReason: () => {},
        timing: () => {},
      } as unknown as Logger;
      const { result, models } = await withModelStub(
        [],
        "unused",
        async (stub) => {
          const result = await runOnce(workDir, stub.path, "fable", logger);
          return { result, models: await readModels(stub.modelLog) };
        },
      );
      assert(result.ok);
      assertEquals(models, ["fable"]);
      assert(
        warnings.some((w) => w.includes("[model-cooldown] could not read")),
        JSON.stringify(warnings),
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
});
