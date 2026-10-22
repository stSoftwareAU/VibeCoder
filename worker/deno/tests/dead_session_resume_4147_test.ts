/**
 * A resumed session the CLI cannot load is retried fresh, never left to fail
 * every issue in its stream (Issue #4147).
 *
 * On 2026-10-22 the stream session record named a conversation whose
 * transcript was gone. The CLI answered every `--resume` with
 * `No conversation found with session ID: …` at zero turns, the #204
 * sessionless retry did not recognise that wording, and 29 issues in two
 * streams died without a model ever running. A resumed session that thrashed
 * the CLI's autocompaction did the same to 16 more.
 *
 * The stub agent (named by path, Issue #959) records whether each invocation
 * carried `--resume`, and refuses a resumed one with the CLI's real output.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import {
  detectInvalidSessionId,
  detectResumedSessionUnusable,
} from "../lib/claude_executor.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const ARG_LOG = "args.log";

/** The CLI's own result record for a `--resume` of a missing transcript. */
const NO_CONVERSATION_RESULT = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  duration_ms: 0,
  is_error: true,
  num_turns: 0,
  session_id: "e42c3312-11f8-478a-98fa-86458e5880b3",
  total_cost_usd: 0,
  modelUsage: {},
  errors: [
    "No conversation found with session ID: e42c3312-11f8-478a-98fa-86458e5880b3",
  ],
});

/** The CLI's autocompaction abort, as the run's final output line. */
const AUTOCOMPACT_THRASH =
  "Autocompact is thrashing: the context refilled to the limit within 3 " +
  "turns of the previous compact, 3 times in a row. A file being read or a " +
  "tool output is likely too large for the context window. Try reading in " +
  "smaller chunks, or use /clear to start fresh.";

/** Stub: log the session flag, refuse a resumed run with `refusal`. */
function stubBody(refusal: string, refuseFresh = false): string {
  return [
    `argLog="$(dirname "$0")/${ARG_LOG}"`,
    `resumed=0`,
    `for arg in "$@"; do`,
    `  [ "$arg" = "--resume" ] && resumed=1`,
    `done`,
    `printf 'resumed=%s\\n' "$resumed" >> "$argLog"`,
    `if [ "$resumed" = "1" ] || [ "${refuseFresh ? 1 : 0}" = "1" ]; then`,
    `  printf '%s\\n' '${refusal}'`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' '{"type":"result","is_error":false,"num_turns":4,"result":"Done.","session_id":"0b5c8e0e-1a6f-4c86-9d0e-6c3c3f1f9a11"}'`,
    `exit 0`,
  ].join("\n");
}

async function run(body: string, resumed: boolean) {
  return await withAgentStub(body, async (stub) => {
    const result = await runClaudeWithRetry(
      {
        clock: fakeClock(),
        prompt: "test",
        phase: "issue",
        agentBinaryPath: stub.path,
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        ...(resumed
          ? {
            sessionResumeState: {
              sessionId: "e42c3312-11f8-478a-98fa-86458e5880b3",
              phaseCount: 1,
            },
          }
          : {}),
      },
      { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
    );
    let invocations: string[] = [];
    try {
      invocations = (await Deno.readTextFile(`${stub.dir}/${ARG_LOG}`))
        .split("\n").filter(Boolean);
    } catch {
      // Never invoked.
    }
    return { result, invocations };
  }, { prefix: "claude_dead_session_stub_" });
}

Deno.test("detectInvalidSessionId - matches the CLI's missing-transcript refusal (Issue #4147)", () => {
  assert(detectInvalidSessionId(NO_CONVERSATION_RESULT));
  assert(
    detectInvalidSessionId(
      "No conversation found with session ID: e42c3312-11f8-478a-98fa-86458e5880b3",
    ),
  );
});

Deno.test("detectResumedSessionUnusable - names autocompact thrash, not ordinary failures (Issue #4147)", () => {
  assert(detectResumedSessionUnusable(AUTOCOMPACT_THRASH));
  assert(detectResumedSessionUnusable(NO_CONVERSATION_RESULT));
  assertEquals(detectResumedSessionUnusable("error: tests failed"), false);
});

Deno.test({
  name:
    "runClaudeWithRetry - a resume of a missing conversation retries fresh and succeeds (Issue #4147)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, invocations } = await run(
      stubBody(NO_CONVERSATION_RESULT),
      true,
    );
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(invocations, ["resumed=1", "resumed=0"]);
    assertEquals(result.value.exitCode, 0);
    // The fresh conversation's id is what the stream records next, never the
    // dead one.
    assertEquals(
      result.value.agentOutput?.sessionId,
      "0b5c8e0e-1a6f-4c86-9d0e-6c3c3f1f9a11",
    );
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - autocompact thrash on a resumed session retries fresh (Issue #4147)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, invocations } = await run(
      stubBody(AUTOCOMPACT_THRASH),
      true,
    );
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(invocations, ["resumed=1", "resumed=0"]);
    assertEquals(result.value.exitCode, 0);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - autocompact thrash on a fresh session is not retried (Issue #4147)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, invocations } = await run(
      stubBody(AUTOCOMPACT_THRASH, true),
      false,
    );
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(invocations, ["resumed=0"]);
    assertEquals(result.value.exitCode, 1);
  },
});
