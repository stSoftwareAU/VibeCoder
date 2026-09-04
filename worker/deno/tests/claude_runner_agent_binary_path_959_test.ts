/**
 * The runner takes an explicit agent binary path (Issue #959, part of #944).
 *
 * Twenty-seven test files used to install a stub agent by prepending a temp
 * directory to the process-wide `PATH`, because binary resolution was the one
 * thing `runClaudeWithTimeout` still left to the process: the child
 * *environment* has been built explicitly since #3203 (`clearEnv: true`), but
 * `new Deno.Command(provider.binary)` handed a bare name to the OS. `PATH` is
 * shared, so each of those files raced the whole suite under
 * `deno test --parallel` — the debt `parallel_safety_cap_test.ts` caps.
 *
 * These tests pin the seam that replaces it, and they are written so that a
 * **silent fallback to `PATH` resolution fails rather than passes**:
 *
 * - the stub is named `vibe-agent-stub`, which no `PATH` resolves, and its
 *   directory is asserted to be absent from `PATH`, so the run can only have
 *   reached it through the injected path;
 * - the stub reports its own `$0`, so the assertion is on the binary that
 *   actually executed rather than on a side effect that some other agent
 *   might also produce;
 * - an injected path that does not exist must fail at spawn *naming that
 *   path* — a fallback would quietly run whatever `claude` the host has.
 *
 * The default is unchanged and is covered by the files that still install a
 * stub on `PATH` (`claude_runner_test.ts` and friends, migrated by #960/#961):
 * they pass no `agentBinaryPath` and still resolve the provider's binary name
 * on `PATH`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkClaudeHealth,
  checkDependencies,
  runClaudeWithRetry,
  runClaudeWithTimeout,
} from "../lib/claude_runner.ts";
import { createAgentStub, withAgentStub } from "./support/agent_stub.ts";

/** No rate-limit waiting — nothing here is a rate limit. */
const FAST_RETRY = {
  maxRetries: 0,
  maxWaitSeconds: 1,
  initialWaitInterval: 0,
} as const;

/** Basename of the file the stub writes its own `$0` to. */
const ARGV0_LOG = "argv0.log";

/**
 * A stub that records the binary path it was executed as — self-locating, so
 * it needs no path baked in — and reports the same value on its result line.
 */
const REPORTS_OWN_PATH = [
  `printf '%s\\n' "$0" > "$(dirname "$0")/${ARGV0_LOG}"`,
  `printf '{"type":"result","result":"ran %s"}\\n' "$0"`,
  "exit 0",
].join("\n");

/** The stub's directory must not be reachable through `PATH`. */
function assertNotOnPath(dir: string): void {
  const path = Deno.env.get("PATH") ?? "";
  assert(
    !path.split(":").includes(dir),
    `the stub directory must not be on PATH, or the test proves nothing: ${dir}`,
  );
}

Deno.test({
  name:
    "runClaudeWithTimeout - spawns the injected agent binary path, never a PATH lookup (Issue #959)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    await withAgentStub(REPORTS_OWN_PATH, async (stub) => {
      assertNotOnPath(stub.dir);

      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        agentBinaryPath: stub.path,
      });

      assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
      if (!result.ok) return;
      assertEquals(result.value.exitCode, 0);
      // The binary that actually executed, straight from the child.
      assertEquals(
        (await Deno.readTextFile(`${stub.dir}/${ARGV0_LOG}`)).trim(),
        stub.path,
      );
      assertStringIncludes(result.value.output, `ran ${stub.path}`);
    });
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - forwards the injected agent binary path to the spawn (Issue #959)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    await withAgentStub(REPORTS_OWN_PATH, async (stub) => {
      assertNotOnPath(stub.dir);

      const result = await runClaudeWithRetry(
        {
          prompt: "test",
          model: "sonnet",
          enableModelFallback: false,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          agentBinaryPath: stub.path,
        },
        FAST_RETRY,
      );

      assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
      assertEquals(
        (await Deno.readTextFile(`${stub.dir}/${ARGV0_LOG}`)).trim(),
        stub.path,
      );
    });
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - an injected path that does not exist fails at spawn rather than falling back to PATH (Issue #959)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await createAgentStub("exit 0");
    const absent = `${stub.dir}/not-installed-here`;
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 30,
        killAfterSeconds: 2,
        agentBinaryPath: absent,
      });

      // A runner that ignored the option would have resolved `claude` on the
      // host's PATH — and on a host that has one, would have *succeeded*.
      // Either way the failure must name the path that was asked for.
      //
      // Two shapes, because the agent is spawned under `nice` where `nice`
      // exists (Issue #324): `nice` reports the missing target itself and
      // exits 127, so the runner sees a clean non-zero child rather than a
      // spawn error. Unwrapped, `Deno.Command` throws at spawn.
      if (result.ok) {
        assertEquals(
          result.value.exitCode,
          127,
          `a missing agent must not produce a successful run: ${
            JSON.stringify(result.value)
          }`,
        );
        assertStringIncludes(result.value.stderr, absent);
      } else {
        assertStringIncludes(result.error.message, absent);
      }
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "checkClaudeHealth - probes the agent at the injected path (Issue #959)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // A marker no other agent on the host would ever print, so the assertion
    // is evidence that this stub ran and not merely that something failed.
    const marker = "959-stub-probe-marker";
    const result = await withAgentStub(
      `printf '%s\\n' '${marker}' 1>&2\nexit 7\n`,
      (stub) => {
        assertNotOnPath(stub.dir);
        return checkClaudeHealth(10, undefined, undefined, stub.path);
      },
    );

    assertEquals(result.healthy, false);
    assertStringIncludes(result.message, "exited 7");
    assertStringIncludes(result.message, marker);
  },
});

Deno.test({
  name:
    "checkDependencies - checks the agent at the injected path instead of on PATH (Issue #959)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const stub = await createAgentStub("exit 0");
    const absent = `${stub.dir}/not-installed-here`;
    try {
      const result = await checkDependencies({ agentBinaryPath: absent });
      assert(!result.ok, "an agent that is not at the given path is missing");
      if (result.ok) return;
      // The report names the path that was checked, not the provider's
      // binary name — proof the lookup did not fall back to `which claude`.
      assertStringIncludes(result.error.message, absent);
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "checkDependencies - an executable at the injected path is accepted without a PATH lookup (Issue #959)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    await withAgentStub("exit 0", async (stub) => {
      assertNotOnPath(stub.dir);
      const result = await checkDependencies({ agentBinaryPath: stub.path });
      // gh/git/jq may genuinely be absent on a bare host, so assert only on
      // the agent: whatever else is missing, the stub must not be.
      if (!result.ok) {
        assert(
          !result.error.message.includes(stub.path),
          `the stub is executable and must not be reported missing: ${result.error.message}`,
        );
      }
    });
  },
});
