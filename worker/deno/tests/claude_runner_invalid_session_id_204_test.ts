/**
 * End-to-end tests for the invalid-session-id recovery inside
 * `runClaudeWithRetry()` (Issue #204).
 *
 * The Claude CLI validates `--session-id` as a UUID. When it refuses one the
 * process dies ~0.2 s after spawn having done no work at all, and the run used
 * to be reported as an ordinary non-zero failure — planning silently lost its
 * draft → publish structure and succeeded only via a legacy sessionless retry.
 *
 * The runner now recognises that refusal, drops the session flags, and retries
 * once at WARNING level. These tests drive a stub agent — named by path rather
 * than installed on `PATH` (Issue #959) — that refuses any invocation carrying
 * `--session-id`, so the recorded argument sequence proves the second
 * invocation carried no session flags and the run recovered.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { detectInvalidSessionId } from "../lib/claude_executor.ts";
import type { Logger } from "../types.ts";
import { withAgentStub } from "./support/agent_stub.ts";

// ---------------------------------------------------------------------------
// Pure detection
// ---------------------------------------------------------------------------

Deno.test("detectInvalidSessionId - matches the CLI's refusal (Issue #204)", () => {
  assert(
    detectInvalidSessionId("Error: Invalid session ID. Must be a valid UUID."),
  );
  assert(detectInvalidSessionId("invalid session id"));
  assert(
    detectInvalidSessionId("session ID must be a valid UUID"),
  );
});

Deno.test("detectInvalidSessionId - ignores unrelated failures (Issue #204)", () => {
  assertEquals(detectInvalidSessionId(""), false);
  assertEquals(detectInvalidSessionId("Error: invalid model"), false);
  assertEquals(
    detectInvalidSessionId("git: fatal: invalid reference: session"),
    false,
  );
  // A mention far from the tail must not resurrect the branch.
  const buried = "Invalid session ID. Must be a valid UUID.\n" +
    Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  assertEquals(detectInvalidSessionId(buried, 5), false);
});

// ---------------------------------------------------------------------------
// Stub harness — a fake agent, named by path (Issue #959), that records every
// invocation's args and refuses any invocation carrying `--session-id`,
// exactly as the real CLI does for a non-UUID id.
// ---------------------------------------------------------------------------

/** Basename of the file the stub records each invocation's flags in. */
const ARG_LOG = "args.log";

/** A stub agent plus the log it writes beside itself. */
interface SessionStub {
  /** Absolute path to the stub, passed to the runner as `agentBinaryPath`. */
  path: string;
  /** Where the stub records one line per invocation. */
  argLog: string;
}

function buildSessionRejectingStubBody(): string {
  return [
    `argLog="$(dirname "$0")/${ARG_LOG}"`,
    `has_session=0`,
    `line=""`,
    `for arg in "$@"; do`,
    `  case "$arg" in`,
    `    --session-id|--resume) has_session=1; line="$line $arg" ;;`,
    `  esac`,
    `done`,
    // The marker prefix keeps a flagless invocation from vanishing as a
    // blank line.
    `printf 'session-flags:%s\\n' "$line" >> "$argLog"`,
    `if [ "$has_session" = "1" ]; then`,
    `  printf '%s\\n' 'Error: Invalid session ID. Must be a valid UUID.' >&2`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' '{"type":"result","result":"Done."}'`,
    `exit 0`,
  ].join("\n");
}

function withStub<T>(
  body: () => string,
  fn: (stub: SessionStub) => Promise<T>,
): Promise<T> {
  return withAgentStub(
    body(),
    (stub) => fn({ path: stub.path, argLog: `${stub.dir}/${ARG_LOG}` }),
    { prefix: "claude_session_stub_" },
  );
}

async function readInvocations(argLog: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(argLog);
    return text.split("\n").filter((line) => line.length > 0).map((l) =>
      l.trim()
    );
  } catch {
    return [];
  }
}

/** No rate-limit waiting — the failure here is never a rate limit. */
const FAST_RETRY = {
  maxRetries: 0,
  maxWaitSeconds: 1,
  initialWaitInterval: 0,
} as const;

/** Collects the WARNING lines and security events the runner emits. */
function collectingLogger(): {
  warnings: string[];
  securityEvents: string[];
  logger: Logger;
} {
  const warnings: string[] = [];
  const securityEvents: string[] = [];
  const logger = {
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
    debug: () => {},
    security: (event: string) => {
      securityEvents.push(event);
    },
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } as unknown as Logger;
  return { warnings, securityEvents, logger };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - a rejected session id retries once without the session flags and succeeds (Issue #204)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { warnings, securityEvents, logger } = collectingLogger();
    const { result, invocations } = await withStub(
      buildSessionRejectingStubBody,
      async (stub) => {
        const result = await runClaudeWithRetry(
          {
            prompt: "test",
            phase: "issue",
            agentBinaryPath: stub.path,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            logger,
            sessionResumeState: {
              sessionId: "owner-repo-193-1755744446000",
              phaseCount: 1,
            },
          },
          FAST_RETRY,
        );
        return { result, invocations: await readInvocations(stub.argLog) };
      },
    );

    assert(result.ok, "runner returned an error result");
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 0);
    assertEquals(result.value.output.includes("Done."), true);

    // Two invocations: the first carried the session flags, the retry none.
    assertEquals(invocations.length, 2);
    assertEquals(invocations[0], "session-flags: --session-id --resume");
    assertEquals(invocations[1], "session-flags:");

    // The degradation is loud, never silent.
    assert(
      warnings.some((w) => w.includes("Invalid session ID")),
      `expected a WARNING naming the refusal, got: ${warnings.join(" | ")}`,
    );
    assertEquals(securityEvents.includes("INVALID_SESSION_ID"), true);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - the sessionless retry is not repeated when it also fails (Issue #204)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // This stub refuses *every* invocation with the same message, so a runner
    // that retried unconditionally would loop.
    const alwaysRefuses = () =>
      [
        `printf '%s\\n' "invoked" >> "$(dirname "$0")/${ARG_LOG}"`,
        `printf '%s\\n' 'Error: Invalid session ID. Must be a valid UUID.' >&2`,
        `exit 1`,
      ].join("\n");

    const { result, invocations } = await withStub(
      alwaysRefuses,
      async (stub) => {
        const result = await runClaudeWithRetry(
          {
            prompt: "test",
            phase: "issue",
            agentBinaryPath: stub.path,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            sessionResumeState: { sessionId: "bad-id", phaseCount: 0 },
          },
          FAST_RETRY,
        );
        return { result, invocations: await readInvocations(stub.argLog) };
      },
    );

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 1);
    assertEquals(invocations.length, 2);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a run with no session state is unaffected (Issue #204)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, invocations } = await withStub(
      buildSessionRejectingStubBody,
      async (stub) => {
        const result = await runClaudeWithRetry(
          {
            prompt: "test",
            phase: "issue",
            agentBinaryPath: stub.path,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          FAST_RETRY,
        );
        return { result, invocations: await readInvocations(stub.argLog) };
      },
    );

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 0);
    assertEquals(invocations.length, 1);
  },
});
