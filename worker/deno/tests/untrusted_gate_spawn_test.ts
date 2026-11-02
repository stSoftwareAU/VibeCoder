/**
 * Regression tests for the milestone merge and resolution gates' child
 * environment (Issue #4659).
 *
 * The two milestone gates ran repository tasks — `quality.sh`, `deno task`,
 * `cargo check` and `cargo test` — with the worker's inherited environment, so
 * every credential the run held (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, …) was
 * readable by code the worker did not write. Both gates now route through
 * `runRepositoryCommand` in `lib/untrusted_gate_spawn.ts`, which builds an
 * allowlisted environment, starts the child with `clearEnv: true` and wraps
 * the argv in the untrusted account where one is available.
 *
 * Every case uses a recording fake `spawn`, so nothing is executed and no
 * process-wide state is read or mutated (Issue #880). Each secret assertion
 * is preceded by a positive control that the secret really is in the source
 * environment, so the test fails if the input is ever wrong.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { runRepositoryCommand } from "../lib/untrusted_gate_spawn.ts";
import { spawnTask } from "../lib/milestone_resolution_gate.ts";
import type { ResolutionTask } from "../lib/milestone_resolution_gate.ts";
import { spawnTypeCheck } from "../lib/milestone_merge_gate.ts";
import type { TypeCheckProject } from "../lib/milestone_merge_gate.ts";
import type { runWithTimeout } from "../lib/subprocess_timeout.ts";

type Spawn = typeof runWithTimeout;
type SpawnOutcome = Awaited<ReturnType<Spawn>>;
type SpawnOptions = Parameters<Spawn>[2];

/** One call the recording fake `spawn` received. */
interface SpawnCall {
  executable: string;
  args: string[];
  options: SpawnOptions;
}

/** The result a clean, successful child returns. */
const SUCCESS: SpawnOutcome = {
  ok: true,
  value: { code: 0, success: true, stdout: "", stderr: "", timedOut: false },
};

/** Secrets the worker's environment holds, which must never reach a child. */
const SECRETS: Record<string, string> = {
  GH_TOKEN: "secret-gh",
  CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth",
};

/** The worker's environment as the gates read it: secrets plus ordinary names. */
function sourceWithSecrets(): Record<string, string> {
  return { PATH: "/usr/bin", HOME: "/home/x", ...SECRETS };
}

/** Identity wrapper: the argv runs as the worker (no untrusted account). */
const identity = (cmd: readonly string[]): Promise<string[]> =>
  Promise.resolve([...cmd]);

/** The `sudo -n -u agent --` wrapper the untrusted account adds. */
const sudoWrapper = (cmd: readonly string[]): Promise<string[]> =>
  Promise.resolve(["sudo", "-n", "-u", "agent", "--", ...cmd]);

/** A fake `spawn` that records every call and returns `outcome`. */
function recordingSpawn(outcome: SpawnOutcome = SUCCESS): {
  spawn: Spawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: Spawn = (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    return Promise.resolve(outcome);
  };
  return { spawn, calls };
}

/** Run `run` with a fresh temporary directory, removed afterwards. */
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Positive control: the secrets really are in the source environment. */
function assertSecretsInSource(source: Record<string, string>): void {
  assertEquals(source.GH_TOKEN, "secret-gh", "control: GH_TOKEN in source");
  assertEquals(
    source.CLAUDE_CODE_OAUTH_TOKEN,
    "secret-oauth",
    "control: CLAUDE_CODE_OAUTH_TOKEN in source",
  );
}

/** Assert the child environment carries neither secret, after the control. */
function assertNoSecrets(
  env: Record<string, string> | undefined,
  source: Record<string, string>,
): void {
  assertSecretsInSource(source);
  assertEquals(env?.GH_TOKEN, undefined, "GH_TOKEN must not reach the child");
  assertEquals(
    env?.CLAUDE_CODE_OAUTH_TOKEN,
    undefined,
    "CLAUDE_CODE_OAUTH_TOKEN must not reach the child",
  );
}

/** The one call a fake `spawn` recorded, failing the test if there is not one. */
function onlyCall(calls: SpawnCall[]): SpawnCall {
  assertEquals(calls.length, 1, "expected exactly one spawn");
  return calls[0]!;
}

// ---------------------------------------------------------------------------
// runRepositoryCommand
// ---------------------------------------------------------------------------

Deno.test("runRepositoryCommand - a repository command gets no credential from the worker's environment", async () => {
  await withTempDir(async (dir) => {
    const source = sourceWithSecrets();
    const { spawn, calls } = recordingSpawn();
    await runRepositoryCommand(
      "bash",
      ["-c", "true"],
      { cwd: dir, timeoutMs: 5000 },
      { spawn, drop: identity, source },
    );
    const call = onlyCall(calls);
    assertEquals(call.options?.clearEnv, true);
    assertNoSecrets(call.options?.env, source);
    assert(call.options?.env?.PATH !== undefined, "expected PATH to survive");

    // Positive control: the same source without the secrets yields the same
    // PATH, so the PATH assertion above is not vacuous.
    const control = recordingSpawn();
    await runRepositoryCommand(
      "bash",
      ["-c", "true"],
      { cwd: dir, timeoutMs: 5000 },
      {
        spawn: control.spawn,
        drop: identity,
        source: { PATH: "/usr/bin", HOME: "/home/x" },
      },
    );
    assertEquals(
      onlyCall(control.calls).options?.env?.PATH,
      call.options?.env?.PATH,
    );
  });
});

Deno.test("runRepositoryCommand - the untrusted account wrapper runs with clearEnv and no secret", async () => {
  await withTempDir(async (dir) => {
    const source = sourceWithSecrets();
    const { spawn, calls } = recordingSpawn();
    await runRepositoryCommand(
      "bash",
      ["-c", "true"],
      { cwd: dir, timeoutMs: 5000 },
      { spawn, drop: sudoWrapper, source },
    );
    const call = onlyCall(calls);
    assertEquals(call.executable, "sudo");
    assertEquals(call.args.slice(0, 4), ["-n", "-u", "agent", "--"]);
    // The build-cache env may be carried through sudo (`env VAR=…`) between
    // the `--` and the command, so the original argv is checked as the tail.
    assertEquals(call.args.slice(-3), ["bash", "-c", "true"]);
    assertEquals(call.options?.clearEnv, true);
    assertNoSecrets(call.options?.env, source);
  });
});

Deno.test("runRepositoryCommand - with the untrusted account unavailable it still runs clearEnv and allowlisted", async () => {
  await withTempDir(async (dir) => {
    const source = sourceWithSecrets();
    const { spawn, calls } = recordingSpawn();
    // The identity wrapper stands in for the worker-account fallback: the
    // call must neither throw nor drop the environment controls.
    await runRepositoryCommand(
      "bash",
      ["-c", "true"],
      { cwd: dir, timeoutMs: 5000 },
      { spawn, drop: identity, source },
    );
    const call = onlyCall(calls);
    assertEquals(call.executable, "bash");
    assertEquals(call.options?.clearEnv, true);
    assertNoSecrets(call.options?.env, source);
    assert(call.options?.env?.PATH !== undefined, "expected PATH to survive");
  });
});

// ---------------------------------------------------------------------------
// Milestone resolution gate - spawnTask
// ---------------------------------------------------------------------------

Deno.test("spawnTask - a script task runs under bash with no secret and maps the exit code and output", async () => {
  await withTempDir(async (dir) => {
    const source = sourceWithSecrets();
    const task: ResolutionTask = {
      dir,
      kind: "script",
      task: "quality.sh",
      args: ["quality.sh"],
      timeoutMs: 5000,
    };
    const { spawn, calls } = recordingSpawn({
      ok: true,
      value: {
        code: 3,
        success: false,
        stdout: "boom",
        stderr: "",
        timedOut: false,
      },
    });
    const result = await spawnTask(task, { spawn, drop: identity, source });
    const call = onlyCall(calls);
    assertEquals(call.executable, "bash");
    assertEquals(call.args, ["quality.sh"]);
    assertEquals(call.options?.clearEnv, true);
    assertNoSecrets(call.options?.env, source);
    assertEquals(result, { code: 3, output: "boom" });
  });
});

Deno.test("spawnTask - a deno task runs under Deno.execPath() with no secret", async () => {
  await withTempDir(async (dir) => {
    const source = sourceWithSecrets();
    const task: ResolutionTask = {
      dir,
      kind: "deno",
      task: "check:manifests",
      args: ["task", "check:manifests"],
      timeoutMs: 5000,
    };
    const { spawn, calls } = recordingSpawn();
    const result = await spawnTask(task, { spawn, drop: identity, source });
    const call = onlyCall(calls);
    assertEquals(call.executable, Deno.execPath());
    assertEquals(call.args, ["task", "check:manifests"]);
    assertEquals(call.options?.clearEnv, true);
    assertNoSecrets(call.options?.env, source);
    assertEquals(result.code, 0);
  });
});

Deno.test("spawnTask - a timed-out task maps to exit code 124", async () => {
  await withTempDir(async (dir) => {
    const task: ResolutionTask = {
      dir,
      kind: "script",
      task: "quality.sh",
      args: ["quality.sh"],
      timeoutMs: 5000,
    };
    const { spawn } = recordingSpawn({
      ok: true,
      value: {
        code: 137,
        success: false,
        stdout: "",
        stderr: "",
        timedOut: true,
      },
    });
    const result = await spawnTask(task, {
      spawn,
      drop: identity,
      source: sourceWithSecrets(),
    });
    assertEquals(result.code, 124);
    assert(
      result.output.includes("timed out"),
      `expected a timeout message, got: ${result.output}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Milestone merge gate - spawnTypeCheck
// ---------------------------------------------------------------------------

Deno.test("spawnTypeCheck - a deno project runs under Deno.execPath() with no secret", async () => {
  await withTempDir(async (dir) => {
    const source = sourceWithSecrets();
    const project: TypeCheckProject = {
      dir,
      kind: "deno",
      args: ["check", "main.ts"],
    };
    const { spawn, calls } = recordingSpawn({
      ok: true,
      value: {
        code: 3,
        success: false,
        stdout: "boom",
        stderr: "",
        timedOut: false,
      },
    });
    const result = await spawnTypeCheck(project, {
      spawn,
      drop: identity,
      source,
    });
    const call = onlyCall(calls);
    assertEquals(call.executable, Deno.execPath());
    assertEquals(call.args, ["check", "main.ts"]);
    assertEquals(call.options?.clearEnv, true);
    assertNoSecrets(call.options?.env, source);
    assertEquals(result, { code: 3, output: "boom" });
  });
});

Deno.test("spawnTypeCheck - a cargo project runs under cargo with no secret and maps a timeout to 124", async () => {
  await withTempDir(async (dir) => {
    const source = sourceWithSecrets();
    const project: TypeCheckProject = {
      dir,
      kind: "cargo",
      args: ["check", "--workspace", "--locked"],
    };
    const { spawn, calls } = recordingSpawn({
      ok: true,
      value: {
        code: 137,
        success: false,
        stdout: "",
        stderr: "",
        timedOut: true,
      },
    });
    const result = await spawnTypeCheck(project, {
      spawn,
      drop: identity,
      source,
    });
    const call = onlyCall(calls);
    assertEquals(call.executable, "cargo");
    assertEquals(call.args, ["check", "--workspace", "--locked"]);
    assertEquals(call.options?.clearEnv, true);
    assertNoSecrets(call.options?.env, source);
    assertEquals(result.code, 124);
  });
});

Deno.test("spawnTypeCheck - a spawn failure maps to exit code 1 with the error message", async () => {
  await withTempDir(async (dir) => {
    const project: TypeCheckProject = {
      dir,
      kind: "cargo",
      args: ["check", "--workspace"],
    };
    const { spawn } = recordingSpawn({
      ok: false,
      error: new Error("no cargo"),
    });
    const result = await spawnTypeCheck(project, {
      spawn,
      drop: identity,
      source: sourceWithSecrets(),
    });
    assertEquals(result, { code: 1, output: "no cargo" });
  });
});
