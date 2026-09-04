/**
 * Tests for claude_runner.ts — Claude execution with retry, timeout, health (Issue #913).
 *
 * Tests for pure functions and types. Integration tests that require the
 * actual Claude CLI are skipped when the CLI is not available.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildClaudeChildEnv,
  buildClaudeModelArgs,
  buildSummariseUserPrompt,
  captureTimeoutDiagnostics,
  checkClaudeHealth,
  CLAUDE_ENV_DENYLIST,
  extractStreamJsonText,
  getTokenEstimate,
  runClaudeWithRetry,
  runClaudeWithTimeout,
  stripEscapeCodes,
  SUMMARISE_SYSTEM_PROMPT,
  summariseLargeContent,
  TIMEOUT_EXIT_CODE,
} from "../lib/claude_runner.ts";
import { UNGUARDED_AGENT_GH_ENV } from "../lib/gh_guard_shim.ts";
import {
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import type { ClaudeExecutionResult } from "../lib/claude_executor.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import type { Result } from "../types.ts";
import { getDailySummary } from "../lib/credit_tracker.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

// ---------------------------------------------------------------------------
// Child-environment sanitisation (Issue #3203)
// ---------------------------------------------------------------------------

Deno.test("buildClaudeChildEnv - drops the GitHub App private-key path", () => {
  const env = buildClaudeChildEnv({
    PATH: "/usr/bin",
    GH_TOKEN: "ghs_token",
    GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/app.pem",
  });
  assertEquals(env.GITHUB_APP_PRIVATE_KEY_PATH, undefined);
  // Variables the child genuinely needs survive untouched.
  assertEquals(env.PATH, "/usr/bin");
  assertEquals(env.GH_TOKEN, "ghs_token");
});

Deno.test("buildClaudeChildEnv - drops the inline PEM body variable", () => {
  const env = buildClaudeChildEnv({
    HOME: "/home/worker",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----...",
  });
  assertEquals(env.GITHUB_APP_PRIVATE_KEY, undefined);
  assertEquals(env.HOME, "/home/worker");
});

Deno.test("buildClaudeChildEnv - removes every denylisted key", () => {
  const parent: Record<string, string> = { KEEP: "yes" };
  for (const key of CLAUDE_ENV_DENYLIST) parent[key] = "secret";
  const env = buildClaudeChildEnv(parent);
  for (const key of CLAUDE_ENV_DENYLIST) {
    assertEquals(env[key], undefined, `${key} must be stripped`);
  }
  assertEquals(env.KEEP, "yes");
});

Deno.test("buildClaudeChildEnv - returns a copy, never mutates the source", () => {
  const parent = { GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/app.pem" };
  buildClaudeChildEnv(parent);
  // Source is untouched — only the returned env is filtered.
  assertEquals(parent.GITHUB_APP_PRIVATE_KEY_PATH, "/secrets/app.pem");
});

// ---------------------------------------------------------------------------
// Re-exported utilities from claude_executor
// ---------------------------------------------------------------------------

Deno.test("claude runner - re-exports TIMEOUT_EXIT_CODE as 124", () => {
  assertEquals(TIMEOUT_EXIT_CODE, 124);
});

Deno.test("claude runner - re-exports getTokenEstimate", () => {
  assertEquals(getTokenEstimate("1234567890"), 2); // 10 chars / 4 = 2
});

Deno.test("claude runner - re-exports stripEscapeCodes", () => {
  assertEquals(stripEscapeCodes("hello\x1b[32mworld\x1b[0m"), "helloworld");
});

Deno.test("claude runner - re-exports extractStreamJsonText", () => {
  const input = '{"type":"result","result":"OK"}\n';
  assertEquals(extractStreamJsonText(input), "OK");
});

Deno.test("claude runner - re-exports buildClaudeModelArgs", () => {
  // The chain reads the injected lookup (Issue #957), so a `CLAUDE_MODEL` the
  // worker session exports is invisible here and nothing has to be deleted
  // from a process every other test in the run shares.
  assertEquals(buildClaudeModelArgs(undefined, emptyEnv).length, 0);
});

Deno.test("claude runner - re-exports captureTimeoutDiagnostics", () => {
  const diag = captureTimeoutDiagnostics("test output", "test");
  assertStringIncludes(diag.report, "Timeout Diagnostic Context");
});

// ---------------------------------------------------------------------------
// Type smoke tests — verify imports compile
// ---------------------------------------------------------------------------

Deno.test("claude runner - ClaudeRunResult type compiles", () => {
  // Verify the type exists and can be used
  const _result: import("../lib/claude_runner.ts").ClaudeRunResult = {
    exitCode: 0,
    output: "test",
    timedOut: false,
  };
  assertEquals(_result.exitCode, 0);
});

Deno.test("claude runner - HealthCheckResult type compiles", () => {
  const _result: import("../lib/claude_runner.ts").HealthCheckResult = {
    healthy: true,
    exitCode: 0,
    message: "OK",
  };
  assertEquals(_result.healthy, true);
});

Deno.test("claude runner - RunClaudeOptions type compiles", () => {
  const _options: import("../lib/claude_runner.ts").RunClaudeOptions = {
    prompt: "test",
    timeoutSeconds: 60,
  };
  assertEquals(_options.prompt, "test");
});

Deno.test("claude runner - RunClaudeOptions supports systemPrompt for caching (Issue #1262)", () => {
  const _options: import("../lib/claude_runner.ts").RunClaudeOptions = {
    prompt: "dynamic issue content",
    systemPrompt: "static coding guidelines for caching",
    timeoutSeconds: 60,
  };
  assertEquals(_options.systemPrompt, "static coding guidelines for caching");
});

Deno.test("claude runner - RunClaudeOptions supports sessionResumeState (Issue #1324)", () => {
  const _options: import("../lib/claude_runner.ts").RunClaudeOptions = {
    prompt: "test prompt",
    timeoutSeconds: 60,
    sessionResumeState: {
      sessionId: "owner-repo-42-1700000000000",
      phaseCount: 0,
    },
  };
  assertEquals(
    _options.sessionResumeState?.sessionId,
    "owner-repo-42-1700000000000",
  );
  assertEquals(_options.sessionResumeState?.phaseCount, 0);
});

Deno.test("claude runner - RunClaudeOptions sessionResumeState is optional (Issue #1324)", () => {
  const _options: import("../lib/claude_runner.ts").RunClaudeOptions = {
    prompt: "test prompt",
  };
  assertEquals(_options.sessionResumeState, undefined);
});

// ---------------------------------------------------------------------------
// runClaudeWithTimeout - no-output silence watchdog (Issue #1825)
//
// Verifies that a Claude stub which sleeps without writing to stdout is killed
// by the silence watchdog before the hard timeout expires, with a distinct
// timeoutReason of "no-output". Uses a stub `claude` script on PATH so the
// real CLI is not invoked.
// ---------------------------------------------------------------------------

/**
 * Create a temporary stub agent that ignores all arguments and runs the
 * supplied bash body, handing its path to `fn`.
 *
 * The runner is given that path as `agentBinaryPath` (Issue #959), so the
 * process-wide `PATH` is never touched.
 */
function withStubClaude<T>(
  bashBody: string,
  fn: (agentBinaryPath: string) => Promise<T>,
): Promise<T> {
  return withAgentStub(bashBody, (stub) => fn(stub.path), {
    prefix: "claude_stub_",
  });
}

Deno.test({
  name:
    "runClaudeWithTimeout - kills silent process via no-output watchdog (Issue #1825)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Stub claude that sleeps for 60s without emitting any stdout. The hard
    // timeout is 30s, but the silence watchdog (2s) should fire first.
    const result = await withStubClaude("sleep 60", async (agentBinaryPath) => {
      return await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath,
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        noOutputTimeout: 2,
      });
    });

    assert(
      result.ok,
      `expected ok result, got ${!result.ok && result.error.message}`,
    );
    if (!result.ok) return;
    assertEquals(result.value.timedOut, true);
    // Issue #2434: the no-output watchdog firing (rather than the 30s hard
    // timeout) is proven by timeoutReason === "no-output" — the prior
    // `elapsed < 15s` wall-clock assertion added nothing but CI-load flakiness.
    assertEquals(result.value.timeoutReason, "no-output");
    assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - completes normally when stub emits output (Issue #1825)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Stub claude that emits stream-json and exits 0. The silence watchdog
    // is short (2s) but the stub finishes quickly so it must not fire.
    const stubBody = `printf '%s\\n' '{"type":"result","result":"hello"}'\n` +
      `exit 0\n`;
    const result = await withStubClaude(stubBody, async (agentBinaryPath) => {
      return await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath,
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        noOutputTimeout: 2,
      });
    });

    assert(
      result.ok,
      `expected ok result, got ${!result.ok && result.error.message}`,
    );
    if (!result.ok) return;
    assertEquals(result.value.timedOut, false);
    assertEquals(result.value.exitCode, 0);
    assertEquals(result.value.timeoutReason, undefined);
    assertStringIncludes(result.value.output, "hello");
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - silence watchdog disabled when noOutputTimeout=0 (Issue #1825)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Stub sleeps 5s then prints. With noOutputTimeout=0 (disabled), the run
    // should complete normally instead of being killed.
    const stubBody = `sleep 5\n` +
      `printf '%s\\n' '{"type":"result","result":"late"}'\n` +
      `exit 0\n`;
    const result = await withStubClaude(stubBody, async (agentBinaryPath) => {
      return await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath,
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        noOutputTimeout: 0,
      });
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.timedOut, false);
    assertEquals(result.value.exitCode, 0);
    assertStringIncludes(result.value.output, "late");
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - hard timeout still fires when silence watchdog disabled (Issue #1825)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Stub sleeps long. noOutputTimeout=0 disables silence watchdog, so the
    // hard timeout (2s) must fire with reason "hard-timeout".
    const result = await withStubClaude("sleep 60", async (agentBinaryPath) => {
      return await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath,
        timeoutSeconds: 2,
        killAfterSeconds: 2,
        noOutputTimeout: 0,
      });
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.timedOut, true);
    assertEquals(result.value.timeoutReason, "hard-timeout");
    assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
  },
});

Deno.test("runClaudeWithTimeout - RunClaudeOptions accepts noOutputTimeout (Issue #1825)", () => {
  // Type smoke test: the option must be optional and a number.
  const _options: import("../lib/claude_runner.ts").RunClaudeOptions = {
    prompt: "test",
    noOutputTimeout: 600,
  };
  assertEquals(_options.noOutputTimeout, 600);
});

// ---------------------------------------------------------------------------
// stderr capture + checkClaudeHealth real-error reporting (Issue #1980)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithTimeout - captures stderr in ClaudeExecutionResult (Issue #1980)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Stub claude that writes to stderr and exits non-zero. The previous
    // runner discarded stderr — it must now be returned to the caller.
    const stubBody = `printf '%s\\n' 'boom: configuration error' 1>&2\n` +
      `exit 7\n`;
    const result = await withStubClaude(stubBody, async (agentBinaryPath) => {
      return await runClaudeWithTimeout({
        prompt: "test",
        agentBinaryPath,
        timeoutSeconds: 30,
        killAfterSeconds: 2,
      });
    });

    assert(
      result.ok,
      `expected ok result, got ${!result.ok && result.error.message}`,
    );
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 7);
    assertEquals(result.value.timedOut, false);
    assertStringIncludes(result.value.stderr, "boom: configuration error");
  },
});

Deno.test({
  name:
    "checkClaudeHealth - surfaces real exit code + stderr instead of misleading 'rate-limited' (Issue #1980)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Stub claude that fails with a clear non-rate-limit stderr message.
    const stubBody =
      `printf '%s\\n' 'Error: model claude-bogus not found' 1>&2\n` +
      `exit 7\n`;
    const result = await withStubClaude(stubBody, async (agentBinaryPath) => {
      return await checkClaudeHealth(10, undefined, undefined, agentBinaryPath);
    });

    assertEquals(result.healthy, false);
    // Must include the real exit code, not just exit 1.
    assertStringIncludes(result.message, "exited 7");
    // Must include the real stderr.
    assertStringIncludes(result.message, "model claude-bogus not found");
    // Must NOT claim rate-limited when stderr has no rate-limit evidence.
    assert(
      !result.message.toLowerCase().includes("rate-limited"),
      `unexpected rate-limited claim: ${result.message}`,
    );
  },
});

Deno.test({
  name:
    "checkClaudeHealth - identifies rate-limit only when stderr contains evidence (Issue #1980)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stubBody =
      `printf '%s\\n' 'HTTP 429 rate limit exceeded, please retry' 1>&2\n` +
      `exit 1\n`;
    const result = await withStubClaude(stubBody, async (agentBinaryPath) => {
      return await checkClaudeHealth(10, undefined, undefined, agentBinaryPath);
    });

    assertEquals(result.healthy, false);
    assertStringIncludes(result.message, "rate-limited");
    assertStringIncludes(result.message, "429");
  },
});

Deno.test({
  name: "checkClaudeHealth - identifies auth error in stderr (Issue #1980)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stubBody =
      `printf '%s\\n' 'Error: not logged in. Run claude login.' 1>&2\n` +
      `exit 1\n`;
    const result = await withStubClaude(stubBody, async (agentBinaryPath) => {
      return await checkClaudeHealth(10, undefined, undefined, agentBinaryPath);
    });

    assertEquals(result.healthy, false);
    assertEquals(result.exitCode, 2);
    assertStringIncludes(result.message, "claude login");
  },
});

// ---------------------------------------------------------------------------
// Summarise-phase prompt structure (Issue #2395)
// ---------------------------------------------------------------------------

Deno.test("summarise prompt - system prompt carries the static instructions (Issue #2395)", () => {
  // The static summarisation instructions must live in the system prompt so
  // they form a byte-identical, cacheable prefix across invocations. The
  // dynamic content must NOT leak into the system prompt — otherwise every
  // call mints a unique prefix and the cache prefix is busted.
  assertStringIncludes(SUMMARISE_SYSTEM_PROMPT, "summarising a large GitHub");
  assertStringIncludes(
    SUMMARISE_SYSTEM_PROMPT,
    "Preserves ALL technical requirements",
  );
  assertStringIncludes(
    SUMMARISE_SYSTEM_PROMPT,
    "Output ONLY the summarised content",
  );
  // No template hole for content — must be byte-identical across calls.
  assert(!SUMMARISE_SYSTEM_PROMPT.includes("${"));
  assert(!SUMMARISE_SYSTEM_PROMPT.includes("Content to summarise"));
});

Deno.test("summarise prompt - user prompt carries only the dynamic content (Issue #2395)", () => {
  const userPrompt = buildSummariseUserPrompt("PAYLOAD_TOKEN");
  // Dynamic content must appear in the user prompt …
  assertStringIncludes(userPrompt, "PAYLOAD_TOKEN");
  assertStringIncludes(userPrompt, "Content to summarise:");
  // … but the static instructions must NOT — otherwise the cacheable prefix
  // would be duplicated and the system prompt becomes redundant overhead.
  assert(!userPrompt.includes("Preserves ALL technical requirements"));
  assert(!userPrompt.includes("Output ONLY the summarised content"));
});

Deno.test("summarise prompt - user prompt is deterministic for a given input (Issue #2395)", () => {
  // Stability is a precondition for cache hits: same content => same bytes.
  const a = buildSummariseUserPrompt("hello world");
  const b = buildSummariseUserPrompt("hello world");
  assertEquals(a, b);
  // Different content produces different bytes (sanity check — not a hash).
  const c = buildSummariseUserPrompt("hello vibe");
  assert(a !== c);
});

// ---------------------------------------------------------------------------
// summariseLargeContent — observable Result mapping (Issue #3037)
//
// These WHAT-tests inject the Claude runner so the summarisation path is
// exercised without spawning the CLI. They assert on what a caller observes —
// the returned Result and its payload — not on how the summary is produced.
// ---------------------------------------------------------------------------

/** Build a stub runner returning a fixed success result. */
function stubRunnerOk(
  output: string,
  capture?: (opts: RunClaudeOptions) => void,
): (opts: RunClaudeOptions) => Promise<Result<ClaudeExecutionResult>> {
  return (opts: RunClaudeOptions) => {
    capture?.(opts);
    return Promise.resolve({
      ok: true,
      value: { exitCode: 0, output, stderr: "", timedOut: false },
    });
  };
}

Deno.test("summariseLargeContent - happy path propagates the summary into the Result (Issue #3037)", async () => {
  const result = await summariseLargeContent({
    content: "a very large issue body ".repeat(20),
    context: "issue body",
    runner: stubRunnerOk("Concise summary of the issue."),
  });
  assert(result.ok);
  // The caller observes the cleaned summary text in the value …
  assertStringIncludes(result.value, "Concise summary of the issue.");
  // … prefixed by the automatic-summarisation note.
  assertStringIncludes(result.value, "automatically summarised");
});

Deno.test("summariseLargeContent - assembles the payload from the dynamic content (Issue #3037)", async () => {
  let seen: RunClaudeOptions | undefined;
  const result = await summariseLargeContent({
    content: "PAYLOAD_MARKER",
    timeoutSeconds: 42,
    killAfterSeconds: 7,
    runner: stubRunnerOk("ok", (opts) => {
      seen = opts;
    }),
  });
  assert(result.ok);
  assert(seen);
  // The dynamic content is carried in the user prompt; the static
  // instructions stay in the cacheable system prompt.
  assertStringIncludes(seen.prompt, "PAYLOAD_MARKER");
  assertEquals(seen.systemPrompt, SUMMARISE_SYSTEM_PROMPT);
  assertEquals(seen.phase, "summarise");
  // The configured timeout / kill-after budget is wired through.
  assertEquals(seen.timeoutSeconds, 42);
  assertEquals(seen.killAfterSeconds, 7);
});

Deno.test("summariseLargeContent - runner failure maps to a failure Result (Issue #3037)", async () => {
  const result = await summariseLargeContent({
    content: "content",
    runner: () =>
      Promise.resolve({ ok: false, error: new Error("runner exploded") }),
  });
  assert(!result.ok);
  assertEquals(result.error.message, "runner exploded");
});

Deno.test("summariseLargeContent - non-zero exit code maps to a failure Result (Issue #3037)", async () => {
  const result = await summariseLargeContent({
    content: "content",
    runner: (_opts) =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 1, output: "partial", stderr: "", timedOut: false },
      }),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "exit code 1");
});

Deno.test("summariseLargeContent - empty output maps to a failure Result (Issue #3037)", async () => {
  const result = await summariseLargeContent({
    content: "content",
    // Exit code 0 but only whitespace output — nothing usable to return.
    runner: stubRunnerOk("   \n  "),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "exit code 0");
});

Deno.test("ClaudeRunResult - exposes timeoutReason for diagnostics (Issue #1825)", () => {
  const _hard: import("../lib/claude_runner.ts").ClaudeRunResult = {
    exitCode: TIMEOUT_EXIT_CODE,
    output: "",
    timedOut: true,
    timeoutReason: "hard-timeout",
  };
  const _silence: import("../lib/claude_runner.ts").ClaudeRunResult = {
    exitCode: TIMEOUT_EXIT_CODE,
    output: "",
    timedOut: true,
    timeoutReason: "no-output",
  };
  assertEquals(_hard.timeoutReason, "hard-timeout");
  assertEquals(_silence.timeoutReason, "no-output");
});

// ---------------------------------------------------------------------------
// Rate-limit fallback populates the credit-log fallbackFrom (Issue #2707)
// ---------------------------------------------------------------------------
//
// End-to-end: a stub `claude` returns a rate-limit error while invoked on the
// original model ("opus") and succeeds once the runner downgrades to the
// cheaper tier ("sonnet"). The post-fallback credit-log entry must carry
// fallbackFrom="opus", and the daily summary must reflect the opus→sonnet
// transition — the behaviour the documented byFallback aggregation relies on.

Deno.test({
  name:
    "runClaudeWithRetry - rate-limit fallback records fallbackFrom in credit log (Issue #2707)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const logDir = await Deno.makeTempDir({ prefix: "credit_fallback_" });

    // Branch on the --model argument: the original tier is rate-limited, the
    // cheaper tier succeeds. This drives one real fallback transition.
    const stubBody = [
      `case "$*" in`,
      `  *opus*)`,
      `    printf '%s\\n' '{"type":"result","result":"rate limit exceeded"}'`,
      `    exit 1`,
      `    ;;`,
      `  *)`,
      `    printf '%s\\n' '{"type":"result","result":"done"}'`,
      `    exit 0`,
      `    ;;`,
      `esac`,
    ].join("\n");

    try {
      const result = await withStubClaude(stubBody, async (agentBinaryPath) => {
        return await runClaudeWithRetry(
          {
            prompt: "test",
            model: "opus",
            phase: "implementation",
            agentBinaryPath,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            enableModelFallback: true,
            creditLogDir: logDir,
            workerName: "worker-test",
            repo: "owner/repo",
          },
          // maxRetries=0 → the first rate-limit detection exhausts retries and
          // triggers an immediate, wait-free fallback to the cheaper tier.
          { maxRetries: 0, maxWaitSeconds: 0, initialWaitInterval: 0 },
        );
      });

      assert(result.ok, `expected ok result`);
      if (!result.ok) return;
      assertEquals(result.value.exitCode, 0);
      assertEquals(result.value.fallbackModel, "sonnet");

      // The credit log must contain an entry for the served cheaper tier with
      // fallbackFrom set to the original model. The credit-log write is
      // fire-and-forget (Issue #1074 — logging must never block the main flow),
      // so the append can still be in flight when runClaudeWithRetry returns.
      // Poll until the opus→sonnet transition lands rather than racing it
      // (Issue #3111: CI saw byFallback["opus→sonnet"] undefined when the read
      // beat the un-awaited write). Mirrors the async-reaping poll above.
      let byFallbackCount: number | undefined;
      for (let i = 0; i < 50; i++) {
        const summaryResult = await getDailySummary({ logDir });
        if (summaryResult.ok) {
          byFallbackCount = summaryResult.value.byFallback["opus→sonnet"];
          if (byFallbackCount === 1) break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assertEquals(byFallbackCount, 1);
    } finally {
      await Deno.remove(logDir, { recursive: true }).catch(() => {});
    }
  },
});

// ---------------------------------------------------------------------------
// gh guard shim — fail closed before the spawn (Issue #3869)
//
// An uninstallable shim used to degrade silently: the agent was spawned with
// the raw environment and its own `gh` calls bypassed the write-repo allowlist
// and the reserved-label guard entirely. While the allowlist is active the
// spawn must now be refused unless an operator has explicitly opted in.
// ---------------------------------------------------------------------------

/** Where the gh-less stub records that it ran, beside the stub itself. */
const SPAWN_MARKER = "spawned";

/**
 * Run `fn` with a stub agent whose child `PATH` holds only the stub's own
 * directory, so `gh` is unresolvable and the shim cannot install.
 *
 * Nothing is exported into the process (Issue #961): the stub is named by
 * path (`agentBinaryPath`, Issue #959), the `PATH` the shim searches is the
 * one `parentEnv` supplies, and the journal is held off by an environment
 * lookup that carries no `WORK_DIR` — the shim's own audit sink is asserted
 * directly in `gh_guard_shim_test.ts`.
 */
function withGhLessStubClaude<T>(
  fn: (
    run: { agentBinaryPath: string; parentEnv: Record<string, string> },
  ) => Promise<T>,
  marker: (path: string) => void,
): Promise<T> {
  return withAgentStub(
    // `${0%/*}` rather than `dirname`: the child's PATH is deliberately
    // gh-less, so the stub must reach for no external command at all.
    `printf 'ran\\n' > "\${0%/*}/${SPAWN_MARKER}"\n` +
      `printf 'stub-claude-ok\\n'`,
    (stub) => {
      marker(`${stub.dir}/${SPAWN_MARKER}`);
      return fn({
        agentBinaryPath: stub.path,
        // `/bin` alone: enough for the stub's own `#!/usr/bin/env bash`,
        // and no host puts `gh` there — so the shim finds none. The stub
        // itself is named by path, so it needs no `PATH` entry.
        parentEnv: { PATH: "/bin" },
      });
    },
    { prefix: "claude_no_gh_" },
  );
}

Deno.test({
  name:
    "runClaudeWithTimeout - refuses to spawn when the gh guard shim cannot be installed (Issue #3869)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    try {
      let marker = "";
      const { result, spawned } = await withGhLessStubClaude(
        async (run) => {
          const result = await runClaudeWithTimeout({
            prompt: "test",
            ...run,
            // No operator opt-in in this environment, and no `WORK_DIR`, so
            // the journal stays inert.
            env: emptyEnv,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          });
          const spawned = await Deno.stat(marker).then(() => true, () => false);
          return { result, spawned };
        },
        (path) => {
          marker = path;
        },
      );

      assert(!result.ok, "an unguarded agent run must not be started");
      assertStringIncludes(result.error.message, "gh guard shim");
      assertStringIncludes(result.error.message, UNGUARDED_AGENT_GH_ENV);
      assertEquals(spawned, false, "claude must not have been spawned");
    } finally {
      resetWriteRepoAllowlist();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - spawns unguarded only with the operator opt-in (Issue #3869)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    try {
      let marker = "";
      const { result, spawned } = await withGhLessStubClaude(
        async (run) => {
          const result = await runClaudeWithTimeout({
            prompt: "test",
            ...run,
            // The operator opt-in, stated for this invocation only.
            env: envFrom({ [UNGUARDED_AGENT_GH_ENV]: "1" }),
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          });
          const spawned = await Deno.stat(marker).then(() => true, () => false);
          return { result, spawned };
        },
        (path) => {
          marker = path;
        },
      );

      assert(result.ok, "the opt-in permits a degraded, unguarded run");
      assertEquals(spawned, true, "claude must have been spawned");
    } finally {
      resetWriteRepoAllowlist();
    }
  },
});
