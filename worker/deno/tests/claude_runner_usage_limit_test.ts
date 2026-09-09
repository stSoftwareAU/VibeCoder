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
import type { Logger } from "../types.ts";
import {
  isRateLimitActive,
  rateLimitSignalPath,
} from "../lib/rate_limit_signal.ts";
import { posixSingleQuote } from "../lib/shell_quote.ts";
import { type AgentStub, withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import { createClaudeSpawnGate } from "../lib/claude_spawn_gate.ts";
import type { ClaudeTokenBudget } from "../lib/claude_token_budget.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

/** The Claude provider descriptor the pool fixtures are built against. */
const CLAUDE = resolveAgentProvider(CLAUDE_PROVIDER_ID);

/** A discovered pool token file whose value the child environment carries. */
function tokenFile(label: string): ProviderTokenFile {
  const name = "CLAUDE_CODE_OAUTH_TOKEN";
  const value = `token-${label}`;
  return {
    label,
    path: `/creds/claude/${label}.env`,
    name,
    value,
    primary: label === "provider",
    poolMember: true,
    entries: [{ name, value }],
  };
}

/** Measured figures for one token, as a probe would have reported them. */
function budget(
  label: string,
  fiveHourRemaining: number,
  now: number,
): ClaudeTokenBudget {
  return {
    known: true,
    label,
    remainingFraction: fiveHourRemaining,
    resetAt: now + 2 * HOUR,
    window: "five_hour",
    windows: [
      {
        window: "five_hour",
        remainingFraction: fiveHourRemaining,
        resetAt: now + 2 * HOUR,
      },
      {
        window: "seven_day",
        remainingFraction: 0.7,
        resetAt: now + 100 * HOUR,
      },
    ],
  };
}

/**
 * A pool of two tokens with figures already recorded, and the gate over it.
 *
 * `fetchFn` throws: every figure these tests need is recorded, so a probe
 * would mean the gate measured something it had already been told.
 */
function pooledGate(
  record: (pool: ReturnType<typeof createClaudeCredentialPool>) => void,
  setEnv: (name: string, value: string) => void,
) {
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: () => {
      throw new Error("the gate must not probe figures it already holds");
    },
    log: (line) => lines.push(line),
  });
  record(pool);
  return {
    gate: createClaudeSpawnGate(pool, { setEnv, log: (l) => lines.push(l) }),
    lines,
  };
}

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
    `printf '%s\\n' ${posixSingleQuote(stderrMessage)} >&2\n` +
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
      // Issue #1669 changed this assertion deliberately: the usage branch
      // used to write the durable `usage` signal here, which drained
      // `run_core`'s slot pool and idled the whole host on one
      // subscription's window. No signal is written now — not to WORK_DIR,
      // not to the per-issue cwd — so the loop keeps running.
      for (const dir of [workDir, `${workDir}/some-repo-clone`]) {
        let present = false;
        try {
          await Deno.stat(rateLimitSignalPath(dir));
          present = true;
        } catch { /* expected: absent */ }
        assertEquals(present, false, `a usage limit wrote a signal in ${dir}`);
      }
      const active = await isRateLimitActive(workDir);
      assert(active.ok);
      assertEquals(active.value.active, false);
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

Deno.test({
  name:
    "runClaudeWithRetry - the CLI's 'session limit' refusal is terminal with its reset carried (Issue #1665)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "ul_workdir_" });
    try {
      const { result, models, securityTags, errors } = await withUsageLimitStub(
        "You've hit your session limit \u00b7 resets 1:50pm (UTC)",
        async (stub) => {
          const securityTags: string[] = [];
          const errors: string[] = [];
          const result = await runClaudeWithRetry(
            {
              clock: fakeClock(),
              prompt: "test",
              model: "fable",
              enableModelFallback: true,
              timeoutSeconds: 30,
              killAfterSeconds: 2,
              agentBinaryPath: stub.path,
              workDir,
              logger: {
                info: () => {},
                warn: () => {},
                error: (message: string) => {
                  errors.push(message);
                },
                debug: () => {},
                security: (event: string) => {
                  securityTags.push(event);
                },
                skipReason: () => {},
                timing: () => {},
                scanSummary: () => {},
                workerSummary: () => {},
              } as unknown as Logger,
            },
            { maxRetries: 2, maxWaitSeconds: 600, initialWaitInterval: 300 },
          );
          let models: string[] = [];
          try {
            models = (await Deno.readTextFile(stub.modelLog)).trim().split(
              "\n",
            );
          } catch { /* none */ }
          return { result, models, securityTags, errors };
        },
      );

      assert(result.ok);
      assertEquals(result.value.exitCode, 2);
      // One invocation — the ladder must not run for a subscription window.
      assertEquals(models, ["fable"]);
      const reset = result.value.usageLimit?.resetEpochMs;
      assert(reset, "the reset time must be parsed from the refusal");
      assertEquals(new Date(reset).toISOString().slice(11, 16), "13:50");
      // The short-backoff ladder was not the branch taken.
      assertEquals(securityTags.includes("RATE_LIMIT"), false);
      assert(securityTags.includes("USAGE_LIMIT"), securityTags.join(","));
      assertStringIncludes(
        errors.join("\n"),
        "Claude usage limit reached (subscription window)",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
    }
  },
});

// ---------------------------------------------------------------------------
// The quota gate in front of every spawn (Issue #1669, parent #1653).
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - every candidate spent: no child is spawned and the result says so (Issue #1669)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const now = Date.now();
    const soonest = now + 90 * 60_000;
    const { gate } = pooledGate((pool) => {
      // Both windows are spent, so there is nothing to switch to. The
      // soonest of the two resets is what the pool as a whole is waiting on.
      pool.recordExhaustion("provider", [
        { window: "five_hour", resetAt: soonest },
      ]);
      pool.recordExhaustion("provider-2", [
        { window: "five_hour", resetAt: now + 4 * HOUR },
      ]);
    }, () => {
      throw new Error("no credential should be applied when none is eligible");
    });

    // The stub records that it ran. It must never run.
    const body = 'printf ran > "$(dirname "$0")/ran.log"\nprintf OK\n';
    await withAgentStub(body, async (stub) => {
      const result = await runClaudeWithRetry({
        clock: fakeClock(),
        prompt: "test",
        model: "opus",
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        agentBinaryPath: stub.path,
        credentialGate: gate,
      });

      assert(result.ok);
      assertEquals(result.value.noEligibleCredential, true);
      assertEquals(result.value.exitCode, 2);
      assertEquals(result.value.usageLimit?.resetEpochMs, soonest);
      // No invocation is billed against a closed window.
      let ran = false;
      try {
        await Deno.stat(`${stub.dir}/ran.log`);
        ran = true;
      } catch { /* expected: the stub never ran */ }
      assertEquals(
        ran,
        false,
        "a child was spawned with no eligible credential",
      );
    }, { prefix: "claude_gate_none_" });
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - the spawn is preceded by a selection and the child carries that token only (Issue #1669)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const now = Date.now();
    // The run started on the token that is now down to 10% of its five-hour
    // window; the pool's other subscription still holds 60%.
    const parentEnv: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "token-provider",
    };
    const { gate, lines } = pooledGate((pool) => {
      pool.recordBudget("provider", budget("provider", 0.1, now), now);
      pool.recordBudget("provider-2", budget("provider-2", 0.6, now), now);
    }, (name, value) => {
      parentEnv[name] = value;
    });

    const body = 'env | grep "^CLAUDE_CODE_OAUTH" > "$(dirname "$0")/env.log"' +
      " || true\nprintf OK\n";
    await withAgentStub(body, async (stub) => {
      const result = await runClaudeWithRetry({
        clock: fakeClock(),
        prompt: "test",
        model: "opus",
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        agentBinaryPath: stub.path,
        parentEnv,
        credentialGate: gate,
      });

      assert(result.ok);
      assertEquals(result.value.noEligibleCredential, undefined);
      const childEnv = (await Deno.readTextFile(`${stub.dir}/env.log`))
        .trim().split("\n");
      // Exactly one Claude token variable, carrying the 60% subscription.
      assertEquals(childEnv, ["CLAUDE_CODE_OAUTH_TOKEN=token-provider-2"]);
      // Both shares are on the record, so an operator can see the choice.
      const log = lines.join("\n");
      assertStringIncludes(log, "provider-2");
      assertStringIncludes(log, "provider ");
    }, { prefix: "claude_gate_switch_" });
  },
});
