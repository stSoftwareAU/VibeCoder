/**
 * Rate-limit detection reads the provider's refusal, never the agent's own
 * words (Issue #4114).
 *
 * The runner used to scan the last 30 lines of the combined stream for
 * `try again|retry|limit`. The agent's transcript is in those lines, so an
 * ordinary exit-1 run on an issue about retries or rate limiters walked the
 * opus → sonnet → haiku ladder, then failed as `usage-limit` — a class that is
 * never filed, so the real failure was never seen.
 *
 * These tests run `runClaudeWithRetry()` against a stub agent (named by path,
 * Issue #959) that records each `--model` it is given, so a ladder walk shows
 * up as more than one recorded model.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const MODEL_LOG = "models.log";

/** Stub body: record `--model`, print `lines` (one JSON event each), exit 1. */
function stubBody(lines: readonly string[]): string {
  return [
    `log="$(dirname "$0")/${MODEL_LOG}"`,
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    printf '%s\\n' "$arg" >> "$log"`,
    `  fi`,
    `  prev="$arg"`,
    `done`,
    ...lines.map((line) => `printf '%s\\n' '${line}'`),
    `exit 1`,
  ].join("\n");
}

/** Run the retry loop once against a stub; return the result and models. */
async function runAgainst(lines: readonly string[]) {
  return await withAgentStub(stubBody(lines), async (stub) => {
    const result = await runClaudeWithRetry(
      {
        clock: fakeClock(),
        prompt: "test",
        agentBinaryPath: stub.path,
        model: "opus",
        enableModelFallback: true,
        timeoutSeconds: 30,
        killAfterSeconds: 2,
      },
      { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
    );
    let models: string[] = [];
    try {
      models = (await Deno.readTextFile(`${stub.dir}/${MODEL_LOG}`))
        .split("\n").filter(Boolean);
    } catch {
      // Never invoked.
    }
    return { result, models };
  }, { prefix: "claude_rl_prose_stub_" });
}

/** An assistant turn whose text is `text`. */
function assistant(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

Deno.test({
  name:
    "runClaudeWithRetry - an exit-1 run whose last turns discuss limits and retries is not a rate limit (Issue #4114)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await runAgainst([
      assistant(
        "The rate limit handler should retry with backoff; I will add a test " +
          "for the 429 path and the quota exceeded case. Try again later.",
      ),
      assistant("Running the limit tests now."),
    ]);

    assert(result.ok, `expected ok result, got ${!result.ok && result.error}`);
    if (!result.ok) return;
    // One invocation on the requested model — no ladder.
    assertEquals(models, ["opus"]);
    assertEquals(result.value.fallbackModel, undefined);
    // The real exit code survives, so the failure is classified by its cause.
    assertEquals(result.value.exitCode, 1);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a failed run whose answer quotes a 429 is not a rate limit (Issue #4114)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { models } = await runAgainst([
      assistant("Added a retry for HTTP 429 Too Many Requests."),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Added a retry for HTTP 429 Too Many Requests.",
      }),
    ]);
    assertEquals(models, ["opus"]);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - the CLI's own 429 refusal still walks the ladder (Issue #4114)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await runAgainst([
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result:
          'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
      }),
    ]);
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(models, ["opus", "sonnet", "haiku"]);
    assertEquals(result.value.fallbackModel, "haiku");
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - an overloaded (529) refusal still takes the short-backoff ladder (Issue #4114)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { models } = await runAgainst([
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result:
          'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
    ]);
    assertEquals(models, ["opus", "sonnet", "haiku"]);
  },
});
