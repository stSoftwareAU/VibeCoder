/**
 * Integration tests for the post-run callback contract (Issue #806, parent
 * #796) — real executables, real spawns, real timeouts.
 *
 * The unit tests inject the subprocess seam; these do not. They prove the
 * properties an external extension actually depends on: `always` runs exactly
 * once, the original VibeCoder result survives a hook that fails or hangs, the
 * versioned context file is readable from the hook, and no worker credential
 * crosses into the child environment.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CALLBACK_SCHEMA_VERSION,
  invokeRunCallbacks,
  type IssueRunCallbackContext,
} from "../lib/run_callbacks.ts";
import type { CallbacksConfig } from "../lib/run_callbacks_config.ts";

/** A scratch directory holding the hook scripts and their evidence files. */
async function withHookDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-callbacks-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Write an executable POSIX shell hook and return its absolute path. */
async function writeHook(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await Deno.chmod(path, 0o700);
  return path;
}

/** Lines a hook appended to the evidence file, in order. */
async function evidence(dir: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(`${dir}/evidence.txt`);
    return text.split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

function context(
  overrides: Partial<IssueRunCallbackContext> = {},
): IssueRunCallbackContext {
  return {
    runId: "vibe-integration-1",
    result: "success",
    repository: "stSoftwareAU/VibeCoder",
    issueNumber: 806,
    host: "integration-host",
    startedAt: "2026-09-02T01:00:00.000Z",
    finishedAt: "2026-09-02T01:00:30.000Z",
    durationSeconds: 30,
    exitCode: 0,
    ...overrides,
  };
}

async function run(
  callbacks: CallbacksConfig,
  ctx: IssueRunCallbackContext,
) {
  const logs: string[] = [];
  const errors: string[] = [];
  const invocations = await invokeRunCallbacks({
    callbacks,
    context: ctx,
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
  });
  return { invocations, logs, errors };
}

Deno.test({
  name:
    "run_callbacks integration - a successful run runs success then always, exactly once",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const record = (event: string) =>
        `echo "${event}" >> "${dir}/evidence.txt"`;
      const callbacks: CallbacksConfig = {
        success: await writeHook(dir, "success.sh", record("success")),
        failure: await writeHook(dir, "failure.sh", record("failure")),
        always: await writeHook(dir, "always.sh", record("always")),
        timeoutSeconds: 30,
      };

      const { invocations } = await run(callbacks, context());

      assertEquals(await evidence(dir), ["success", "always"]);
      assertEquals(invocations.map((i) => i.status), ["ok", "ok"]);
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - a failed run runs failure then always, exactly once",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const record = (event: string) =>
        `echo "${event}" >> "${dir}/evidence.txt"`;
      const callbacks: CallbacksConfig = {
        success: await writeHook(dir, "success.sh", record("success")),
        failure: await writeHook(dir, "failure.sh", record("failure")),
        always: await writeHook(dir, "always.sh", record("always")),
        timeoutSeconds: 30,
      };

      const ctx = context({ result: "failure", exitCode: 1 });
      const { invocations } = await run(callbacks, ctx);

      assertEquals(await evidence(dir), ["failure", "always"]);
      assertEquals(invocations.map((i) => i.status), ["ok", "ok"]);
      // The hooks observed the original result and never altered it.
      assertEquals(ctx.result, "failure");
      assertEquals(ctx.exitCode, 1);
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - always runs exactly once after a failing outcome hook",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const callbacks: CallbacksConfig = {
        success: await writeHook(
          dir,
          "success.sh",
          `echo "success" >> "${dir}/evidence.txt"\necho "hook exploded" >&2\nexit 7`,
        ),
        always: await writeHook(
          dir,
          "always.sh",
          `echo "always" >> "${dir}/evidence.txt"`,
        ),
        timeoutSeconds: 30,
      };

      const ctx = context();
      const { invocations, errors } = await run(callbacks, ctx);

      assertEquals(await evidence(dir), ["success", "always"]);
      assertEquals(invocations[0]?.status, "failed");
      assertEquals(invocations[0]?.exitCode, 7);
      assert(invocations[0]?.stderr.includes("hook exploded"));
      assertEquals(invocations[1]?.status, "ok");
      // The original result is preserved, and said so, loudly.
      assertEquals(ctx.result, "success");
      assert(
        errors.some((e) => e.includes("unchanged")),
        errors.join("\n"),
      );
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - a hanging outcome hook is terminated and always still runs",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const callbacks: CallbacksConfig = {
        success: await writeHook(
          dir,
          "success.sh",
          // `exec` so the timeout's SIGTERM lands on the sleeping process
          // itself; a forked child would outlive the shell holding the pipes.
          `echo "success" >> "${dir}/evidence.txt"\n` +
            `printf "still working"\nexec sleep 30`,
        ),
        always: await writeHook(
          dir,
          "always.sh",
          `echo "always" >> "${dir}/evidence.txt"`,
        ),
        timeoutSeconds: 1,
      };

      const { invocations } = await run(callbacks, context());

      assertEquals(await evidence(dir), ["success", "always"]);
      assertEquals(invocations[0]?.status, "timed_out");
      assertEquals(invocations[0]?.exitCode, 124);
      // What the hook printed before the kill survives, alongside the
      // timeout marker — the hung hook is the one whose output matters.
      assert(invocations[0]!.stderr.includes("Timed out after"));
      assertEquals(invocations[0]?.stdout, "still working");
      assertEquals(invocations[1]?.status, "ok");
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - a missing executable is reported and always still runs",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const callbacks: CallbacksConfig = {
        success: `${dir}/does-not-exist.sh`,
        always: await writeHook(
          dir,
          "always.sh",
          `echo "always" >> "${dir}/evidence.txt"`,
        ),
        timeoutSeconds: 30,
      };

      const { invocations } = await run(callbacks, context());

      assertEquals(await evidence(dir), ["always"]);
      assertEquals(invocations[0]?.status, "spawn_failed");
      assertEquals(invocations[1]?.status, "ok");
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - a non-executable path is reported, never run through a shell",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const notExecutable = `${dir}/plain.sh`;
      await Deno.writeTextFile(
        notExecutable,
        `#!/bin/sh\necho "ran" >> "${dir}/evidence.txt"\n`,
        { mode: 0o600 },
      );
      await Deno.chmod(notExecutable, 0o600);

      const callbacks: CallbacksConfig = {
        success: notExecutable,
        timeoutSeconds: 30,
      };
      const { invocations } = await run(callbacks, context());

      assertEquals(invocations[0]?.status, "spawn_failed");
      assertEquals(await evidence(dir), []);
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - the hook reads the versioned context file and environment",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const callbacks: CallbacksConfig = {
        success: await writeHook(
          dir,
          "success.sh",
          [
            `cp "$VIBECODER_CALLBACK_CONTEXT" "${dir}/context.json"`,
            `echo "$VIBECODER_CALLBACK_EVENT $VIBECODER_RESULT ` +
            `$VIBECODER_REPOSITORY $VIBECODER_ISSUE_NUMBER $VIBECODER_RUN_ID" ` +
            `> "${dir}/env.txt"`,
          ].join("\n"),
        ),
        timeoutSeconds: 30,
      };

      await run(
        callbacks,
        context({
          provider: "claude",
          sessionId: "sess-integration",
          sessionLogPath: `${dir}/transcript.log`,
          telemetry: {
            inputTokens: 100,
            outputTokens: 20,
            estimatedCostUsd: 3,
          },
        }),
      );

      const document = JSON.parse(
        await Deno.readTextFile(`${dir}/context.json`),
      );
      assertEquals(document.schemaVersion, CALLBACK_SCHEMA_VERSION);
      assertEquals(document.event, "success");
      assertEquals(document.result, "success");
      assertEquals(document.repository, "stSoftwareAU/VibeCoder");
      assertEquals(document.issueNumber, 806);
      assertEquals(document.provider, "claude");
      assertEquals(document.sessionId, "sess-integration");
      assertEquals(document.sessionLogPath, `${dir}/transcript.log`);
      assertEquals(document.telemetry.inputTokens, 100);
      assertEquals(document.exitCode, 0);

      assertEquals(
        (await Deno.readTextFile(`${dir}/env.txt`)).trim(),
        "success success stSoftwareAU/VibeCoder 806 vibe-integration-1",
      );
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - the context file is removed after the hook",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const callbacks: CallbacksConfig = {
        success: await writeHook(
          dir,
          "success.sh",
          `echo "$VIBECODER_CALLBACK_CONTEXT" > "${dir}/path.txt"`,
        ),
        timeoutSeconds: 30,
      };

      await run(callbacks, context());

      const contextPath = (await Deno.readTextFile(`${dir}/path.txt`)).trim();
      assert(contextPath !== "", "the hook received a context path");
      let exists = true;
      try {
        await Deno.stat(contextPath);
      } catch {
        exists = false;
      }
      assertEquals(exists, false, `${contextPath} must not outlive the hook`);
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - no worker credential reaches the hook environment",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const callbacks: CallbacksConfig = {
        success: await writeHook(dir, "success.sh", `env > "${dir}/env.txt"`),
        timeoutSeconds: 30,
      };
      await run(callbacks, context());

      const childEnv = await Deno.readTextFile(`${dir}/env.txt`);
      // Checks every name the child actually carries, not one planted
      // token: the worker's own environment holds real credentials, so an
      // allowlist proves none of them — named or not — crossed over.
      // Planting one would mutate the process environment, which races
      // under `deno test --parallel` (Issue #880).
      //
      // The allowlist is spelled out here rather than imported from
      // run_callbacks.ts, so widening what the hook inherits fails this
      // test instead of silently redefining what it asserts.
      const leaked = childEnv.split("\n")
        .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined)
        .filter((name) =>
          !name.startsWith("VIBECODER_") &&
          !["PATH", "HOME", "LANG", "TZ", "TMPDIR"].includes(name) &&
          // `/bin/sh` sets these itself; they carry nothing of the worker's.
          !["PWD", "OLDPWD", "SHLVL", "IFS", "PS1", "_"].includes(name)
        );
      assertEquals(
        leaked,
        [],
        "the worker's environment must not cross into a callback",
      );
      assert(childEnv.includes("VIBECODER_CALLBACK_EVENT=success"));
    });
  },
});

Deno.test({
  name:
    "run_callbacks integration - concurrent runs give each hook its own context",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHookDir(async (dir) => {
      const callbacks: CallbacksConfig = {
        success: await writeHook(
          dir,
          "success.sh",
          `echo "success:$VIBECODER_ISSUE_NUMBER" >> "${dir}/evidence.txt"`,
        ),
        failure: await writeHook(
          dir,
          "failure.sh",
          `echo "failure:$VIBECODER_ISSUE_NUMBER" >> "${dir}/evidence.txt"`,
        ),
        always: await writeHook(
          dir,
          "always.sh",
          `echo "always:$VIBECODER_ISSUE_NUMBER:$VIBECODER_RESULT" >> "${dir}/evidence.txt"`,
        ),
        timeoutSeconds: 30,
      };

      await Promise.all([
        run(callbacks, context({ issueNumber: 101, result: "success" })),
        run(
          callbacks,
          context({ issueNumber: 202, result: "failure", exitCode: 1 }),
        ),
      ]);

      const lines = await evidence(dir);
      assertEquals(lines.length, 4);
      assertEquals(lines.filter((l) => l === "success:101").length, 1);
      assertEquals(lines.filter((l) => l === "failure:202").length, 1);
      assertEquals(
        lines.filter((l) => l === "always:101:success").length,
        1,
      );
      assertEquals(
        lines.filter((l) => l === "always:202:failure").length,
        1,
      );
    });
  },
});
