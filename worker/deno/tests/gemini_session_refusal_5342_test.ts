/**
 * Gemini's start-up refusals of the session flags are retried without them
 * (Issue #5342).
 *
 * The Gemini CLI (0.68.0) refuses `--session-id` naming a session that
 * already exists (a retried first phase) and `--resume` naming a session
 * missing from its home (a re-claim on a new container), exiting non-zero
 * before any model call. The runner drops the flags and retries once, as it
 * does for Claude's refusals.
 *
 * The stub agent (named by path) logs which session flag each invocation
 * carried and refuses with the CLI's real wording.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import {
  detectInvalidSessionId,
  detectResumedSessionUnusable,
} from "../lib/claude_executor.ts";
import { IMAGE_AGENT_PROVIDERS_ENV } from "../lib/agent_provider.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const ARG_LOG = "args.log";

const ALREADY_EXISTS =
  `Error starting session: Session ID "${ID}" already exists. Use --resume to resume it, or provide a different ID.`;

const INVALID_IDENTIFIER = [
  `Error resuming session: Invalid session identifier "${ID}".`,
  "  Searched for sessions in /home/vibe/.gemini/tmp/abc/chats.",
  "  Use --list-sessions to see available sessions, then use --resume {number}, --resume {uuid}, or --resume latest.",
].join("\n");

Deno.test("detectInvalidSessionId - matches Gemini's already-exists refusal", () => {
  assert(detectInvalidSessionId(ALREADY_EXISTS));
  assert(detectResumedSessionUnusable(ALREADY_EXISTS));
});

Deno.test("detectInvalidSessionId - matches Gemini's multi-line invalid-identifier refusal", () => {
  assert(detectInvalidSessionId(INVALID_IDENTIFIER));
  assert(detectResumedSessionUnusable(INVALID_IDENTIFIER));
});

Deno.test("detectInvalidSessionId - look-alikes do not fire", () => {
  for (
    const text of [
      "Error: Path already exists: /tmp/x",
      `Session started: ${ID}`,
      "Error: tests failed",
    ]
  ) {
    assertEquals(detectInvalidSessionId(text), false, text);
    assertEquals(detectResumedSessionUnusable(text), false, text);
  }
});

Deno.test("detectInvalidSessionId - hostile input returns false without backtracking", () => {
  assertEquals(
    detectInvalidSessionId(
      'session id "' + "a".repeat(50000) + " already exists",
    ),
    false,
  );
  assertEquals(
    detectInvalidSessionId(
      'session id "' + "x".repeat(81) + '" already exists',
    ),
    false,
  );
});

/** Stub: log the session flag; refuse a flagged run with `refusal`. */
function stubBody(flag: "--session-id" | "--resume", refusal: string): string {
  return [
    `argLog="$(dirname "$0")/${ARG_LOG}"`,
    `seen=none`,
    `for arg in "$@"; do`,
    `  [ "$arg" = "${flag}" ] && seen=${flag}`,
    `done`,
    `printf '%s\\n' "$seen" >> "$argLog"`,
    `if [ "$seen" != "none" ]; then`,
    `  cat >&2 <<'REFUSAL'`,
    refusal,
    `REFUSAL`,
    `  exit 52`,
    `fi`,
    `printf '%s\\n' '{"type":"init","session_id":"${ID}","model":"gemini-2.5-pro"}'`,
    `printf '%s\\n' '{"type":"result","status":"success","stats":{"total_tokens":10,"input_tokens":8,"output_tokens":2,"duration_ms":100,"tool_calls":0}}'`,
    `exit 0`,
  ].join("\n");
}

async function run(
  flag: "--session-id" | "--resume",
  refusal: string,
  phaseCount: number,
) {
  return await withAgentStub(stubBody(flag, refusal), async (stub) => {
    const result = await runClaudeWithRetry(
      {
        clock: fakeClock(),
        prompt: "test",
        phase: "issue",
        agentProvider: "gemini",
        // The image stamp names the providers the container installed.
        env: (name: string) =>
          name === IMAGE_AGENT_PROVIDERS_ENV ? "claude,gemini" : undefined,
        agentBinaryPath: stub.path,
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        sessionResumeState: {
          sessionId: ID,
          phaseCount,
          ...(phaseCount > 0 ? { providerId: "gemini" } : {}),
        },
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
  }, { prefix: "gemini_session_refusal_stub_" });
}

Deno.test({
  name:
    "runClaudeWithRetry - gemini --session-id already-exists retries without flags (Issue #5342)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, invocations } = await run(
      "--session-id",
      ALREADY_EXISTS,
      0,
    );
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(invocations, ["--session-id", "none"]);
    assertEquals(result.value.exitCode, 0);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - gemini --resume of a missing session retries without flags (Issue #5342)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, invocations } = await run(
      "--resume",
      INVALID_IDENTIFIER,
      1,
    );
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(invocations, ["--resume", "none"]);
    assertEquals(result.value.exitCode, 0);
  },
});
