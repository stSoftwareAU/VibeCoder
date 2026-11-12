/**
 * Tests that external orchestration role calls stay on the provider that
 * passed the role, billing and read-only checks (Issue #4986).
 *
 * A model refusal with no cheaper model used to move the invocation to the next
 * provider in `agent_provider_fallback` (Issue #4034). For a role call that
 * provider never passed the gate's checks, so the pin must hold. The stub agent
 * is named by path, records its full argv, refuses the model under test when
 * run as Claude, and succeeds when run as Codex (`exec`). The real retry
 * ladder runs, so an `exec` line in the log proves the switch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import type {
  ClaudeRunResult,
  RunClaudeOptions,
} from "../lib/claude_runner.ts";
import type { ExternalIssueRunInput } from "../lib/execute_claude_phase.ts";
import {
  type IssueRunGateDeps,
  runOrchestratedIssueRun,
} from "../lib/orchestration/issue_run_gate.ts";
import {
  resolveProviderFallbackPolicy,
  setConfiguredProviderFallbackPolicy,
} from "../lib/provider_fallback_policy.ts";
import type { Logger, Result } from "../types.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv } from "./support/env_lookup.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** Basename of the file the stub appends each invocation's argv to. */
const CALL_LOG = "calls.log";

const SUBSCRIPTION_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "test-token" };
const REPO = "stSoftwareAU/VibeCoder";

const FAST_RETRY = {
  maxRetries: 0,
  maxWaitSeconds: 1,
  initialWaitInterval: 0,
} as const;

/** Stub: Codex succeeds; Claude refuses a `--model` containing `refused`. */
function stubBody(refused: string): string {
  return [
    `printf '%s\\n' "$*" >> "$(dirname "$0")/${CALL_LOG}"`,
    `if [ "$1" = "exec" ]; then`,
    `  printf '%s\\n' '{"type":"result","result":"step output"}'`,
    `  exit 0`,
    `fi`,
    `prev=""`,
    `for a in "$@"; do`,
    `  case "$prev" in`,
    `    --model)`,
    `      case "$a" in`,
    `        *${refused}*)`,
    `          printf '%s\\n' "API Error: 404 model: $a not found"`,
    `          exit 1`,
    `          ;;`,
    `      esac`,
    `      ;;`,
    `  esac`,
    `  prev="$a"`,
    `done`,
    `printf '%s\\n' '{"type":"result","result":"step output"}'`,
    `exit 0`,
  ].join("\n");
}

async function readCalls(log: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(log)).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function recordingLogger(lines: string[]): Logger {
  const push = (message: string) => lines.push(message);
  return {
    info: push,
    warn: push,
    error: push,
    debug: () => {},
  } as unknown as Logger;
}

async function withWorkDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/codex`);
    await Deno.writeTextFile(
      `${dir}/codex/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt" }),
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function withPolicy<T>(fn: () => Promise<T>): Promise<T> {
  setConfiguredProviderFallbackPolicy(
    resolveProviderFallbackPolicy({
      preferred: "claude",
      enabled: ["claude", "codex"],
      fallback: ["codex"],
    }),
  );
  return fn().finally(() => setConfiguredProviderFallbackPolicy(undefined));
}

/** Runs the gate with the real retry ladder over a stub refusing `refused`. */
async function runRole(
  refused: string,
): Promise<{ ok: boolean; calls: string[]; log: string[] }> {
  const log: string[] = [];
  return await withPolicy(async () => {
    let result = { ok: true, calls: [] as string[], log };
    await withWorkDir(async (dir) => {
      result = await withAgentStub(stubBody(refused), async (stub) => {
        const input: ExternalIssueRunInput = {
          claudeOptions: {
            prompt: "unused",
            cwd: dir,
            agentBinaryPath: stub.path,
            clock: fakeClock(),
            env: emptyEnv,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            logger: recordingLogger(log),
          },
          retryOptions: FAST_RETRY,
          workDir: dir,
          repo: REPO,
          issueNumber: 4986,
          branch: "issue-4986-pin",
          workspaceDir: dir,
          brief: "Keep role calls on their provider",
          settings: {},
        };
        const deps: IssueRunGateDeps = {
          runClaudeWithRetry,
          preflight: async () => {},
          stateDir: `${dir}/state`,
          env: { ...SUBSCRIPTION_ENV, CODEX_HOME: `${dir}/codex` },
          now: () => 1_000,
        };
        const outcome = await runOrchestratedIssueRun(input, deps);
        return {
          ok: outcome.ok,
          calls: await readCalls(`${stub.dir}/${CALL_LOG}`),
          log,
        };
      }, { prefix: "pin_4986_" });
    });
    return result;
  });
}

function assertPinned(
  r: { ok: boolean; calls: string[]; log: string[] },
  refused: string,
): void {
  assertEquals(r.ok, false, "a refused role model must fail the run");
  assert(
    !r.calls.some((c) => c.split(" ")[0] === "exec"),
    `no Codex invocation may run: ${r.calls.join(" | ")}`,
  );
  assert(
    r.calls.some((c) => c.includes("--model") && c.includes(refused)),
    `the refused model was requested: ${r.calls.join(" | ")}`,
  );
  assert(
    r.log.some((l) => l.includes("pinned") && l.includes("#4986")),
    `the pin is logged: ${r.log.join(" | ")}`,
  );
}

const PERMS = { run: true, read: true, write: true, env: true };

Deno.test({
  name:
    "orchestration - a refused manager model does not switch provider (Issue #4986)",
  permissions: PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    assertPinned(await runRole("opus"), "opus");
  },
});

Deno.test({
  name:
    "orchestration - a refused executor model does not switch provider (Issue #4986)",
  permissions: PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const r = await runRole("sonnet");
    assertPinned(r, "sonnet");
    assert(
      r.calls.some((c) => c.includes("opus")),
      `the manager ran first: ${r.calls.join(" | ")}`,
    );
  },
});

Deno.test({
  name:
    "orchestration - a refused reviewer model does not switch provider (Issue #4986)",
  permissions: PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const r = await runRole("fable");
    assertPinned(r, "fable");
    assert(
      r.calls.some((c) => c.includes("sonnet")),
      `the executor ran first: ${r.calls.join(" | ")}`,
    );
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a non-role call still uses agent_provider_fallback (Issue #4986)",
  permissions: PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const calls = await withPolicy(() =>
      withAgentStub(stubBody(""), async (stub) => {
        const options: RunClaudeOptions = {
          clock: fakeClock(),
          prompt: "test",
          phase: "issue",
          agentProvider: "claude",
          model: "opus",
          agentBinaryPath: stub.path,
          env: emptyEnv,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          logger: recordingLogger([]),
        };
        const result: Result<ClaudeRunResult> = await runClaudeWithRetry(
          options,
          FAST_RETRY,
        );
        assert(result.ok);
        return await readCalls(`${stub.dir}/${CALL_LOG}`);
      }, { prefix: "pin_4986_control_" })
    );
    assert(
      calls.some((c) => c.split(" ")[0] === "exec"),
      `the configured fallback applies: ${calls.join(" | ")}`,
    );
  },
});
