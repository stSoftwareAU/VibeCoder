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
import {
  credentialCarryingCommand,
  isUnverifiableCheckout,
  manifestsFor,
  runRepositoryCommand,
} from "../lib/untrusted_gate_spawn.ts";
import { verifyResolvedTree } from "../lib/milestone_resolution_gate.ts";
import { checkMergedTree } from "../lib/milestone_merge_gate.ts";
import { mergeOnlyBindings } from "../lib/milestone_merge_only.ts";
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

/** Whether a spawn is a probe (`test …` or the `find` writability scan). */
function isProbe(executable: string, args: string[]): boolean {
  const at = executable === "sudo" ? args.indexOf("--") + 1 : -1;
  const program = at < 0 ? executable : args[at];
  return program === "test" || program === "find";
}

/**
 * A fake `spawn` that records every gate call and returns `outcome`. The
 * readability probe is recorded apart in `probes` and answers `probeOutcome`.
 */
function recordingSpawn(
  outcome: SpawnOutcome = SUCCESS,
  probeOutcome: SpawnOutcome = SUCCESS,
): {
  spawn: Spawn;
  calls: SpawnCall[];
  probes: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const probes: SpawnCall[] = [];
  const spawn: Spawn = (executable, args, options) => {
    if (isProbe(executable, args)) {
      probes.push({ executable, args: [...args], options });
      return Promise.resolve(probeOutcome);
    }
    calls.push({ executable, args: [...args], options });
    return Promise.resolve(outcome);
  };
  return { spawn, calls, probes };
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

/**
 * A declared credential reaches the child without touching argv: no argv
 * element holds the value, and under sudo it travels on stdin as base64.
 */
function assertCredentialOffArgv(
  call: SpawnCall,
  value: string,
  sudo: boolean,
): void {
  assertEquals(
    call.options?.env?.DECLARED_TOKEN,
    value,
    "control: the child still receives the value",
  );
  for (const element of [call.executable, ...call.args]) {
    assert(
      !element.includes(value),
      `argv element leaks the value: ${element}`,
    );
  }
  if (sudo) {
    assertEquals(call.options?.input, `DECLARED_TOKEN=${btoa(value)}\n`);
  } else {
    assertEquals(call.options?.input, undefined);
  }
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

Deno.test("runRepositoryCommand - passes the checkout, timeout and injected source through to the spawn", async () => {
  await withTempDir(async (dir) => {
    const { spawn, calls } = recordingSpawn();
    await runRepositoryCommand(
      "bash",
      ["-c", "true"],
      { cwd: dir, timeoutMs: 4321 },
      {
        spawn,
        drop: identity,
        source: { PATH: "/injected/only/bin", HOME: "/home/x" },
      },
    );
    const call = onlyCall(calls);
    assertEquals(call.options?.cwd, dir);
    assertEquals(call.options?.timeoutMs, 4321);
    // The child is built from the injected source, not the worker's own.
    assertEquals(call.options?.env?.PATH, "/injected/only/bin");
  });
});

Deno.test("runRepositoryCommand - an ephemeral target directory keyed by the checkout is carried through sudo", async () => {
  await withTempDir(async (dir) => {
    await withTempDir(async (root) => {
      const { spawn, calls } = recordingSpawn();
      await runRepositoryCommand(
        "cargo",
        ["check"],
        { cwd: dir, timeoutMs: 5000 },
        {
          spawn,
          drop: sudoWrapper,
          source: sourceWithSecrets(),
          trimRefused: true,
          root,
        },
      );
      const call = onlyCall(calls);
      const target = call.options?.env?.CARGO_TARGET_DIR;
      assert(target !== undefined, "expected CARGO_TARGET_DIR in the env");
      assert(target.startsWith(`${root}/`), `target ${target} under ${root}`);
      assert(target.endsWith("-agent"), `target ${target} keyed to agent`);
      // Carried through sudo as `env NAME=path` before the command.
      assertEquals(call.executable, "sudo");
      assertEquals(call.args.slice(0, 4), ["-n", "-u", "agent", "--"]);
      assertEquals(call.args.slice(4), [
        "env",
        `CARGO_TARGET_DIR=${target}`,
        "cargo",
        "check",
      ]);
    });
  });
});

Deno.test("runRepositoryCommand - with no ephemeral placement nothing is carried through sudo", async () => {
  await withTempDir(async (dir) => {
    const { spawn, calls } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd: dir, timeoutMs: 5000 },
      {
        spawn,
        drop: sudoWrapper,
        source: sourceWithSecrets(),
        trimRefused: false,
      },
    );
    const call = onlyCall(calls);
    assertEquals(call.options?.env?.CARGO_TARGET_DIR, undefined);
    assertEquals(call.args, ["-n", "-u", "agent", "--", "cargo", "check"]);
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

Deno.test("milestone spawns carry declared credentials through sudo and exclude undeclared credentials", async () => {
  await withTempDir(async (dir) => {
    for (const sudo of [false, true]) {
      for (const gate of ["shared", "task", "type"] as const) {
        const source = sourceWithSecrets();
        source.DECLARED_TOKEN = "declared-fixture+= with spaces";
        const { spawn, calls } = recordingSpawn();
        const deps = {
          spawn,
          drop: sudo ? sudoWrapper : identity,
          source,
          repoCredentialEnv: { DECLARED_TOKEN: source.DECLARED_TOKEN },
        };
        if (gate === "shared") {
          await runRepositoryCommand("bash", ["quality.sh"], {
            cwd: dir,
            timeoutMs: 1000,
          }, deps);
        } else if (gate === "task") {
          await spawnTask({
            kind: "script",
            task: "quality.sh",
            dir,
            args: ["quality.sh"],
            timeoutMs: 1000,
          }, deps);
        } else {
          await spawnTypeCheck({ kind: "cargo", dir, args: ["check"] }, deps);
        }
        const call = onlyCall(calls);
        assertNoSecrets(call.options?.env, source);
        assertEquals(
          call.options?.env?.DECLARED_TOKEN,
          "declared-fixture+= with spaces",
        );
        assertEquals(call.options?.clearEnv, true);
        assertEquals(
          call.options?.commandLabel,
          "repository gate (declared credentials redacted)",
        );
        assertCredentialOffArgv(call, "declared-fixture+= with spaces", sudo);
      }
    }
  });
});

Deno.test("both milestone gates forward declared credentials to every task, including merge-only", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        tasks: {
          check: "deno check mod.ts",
          "check:manifests": "deno check mod.ts",
          "test:unit": "deno test",
        },
      }),
    );
    for (const mergeOnly of [false, true]) {
      const source = sourceWithSecrets();
      const { spawn, calls } = recordingSpawn();
      const deps = {
        spawn,
        drop: sudoWrapper,
        source,
        repoCredentialEnv: { DECLARED_TOKEN: "fixture+= spaces" },
      };
      if (mergeOnly) {
        const bindings = mergeOnlyBindings(
          "fixture budget",
          undefined,
          {},
          deps,
        )!;
        assertEquals((await bindings.mergeGate(dir)).status, "passed");
        assertEquals((await bindings.resolutionGate(dir)).status, "passed");
      } else {
        assertEquals(
          (await checkMergedTree(dir, undefined, undefined, deps)).status,
          "passed",
        );
        assertEquals(
          (await verifyResolvedTree(
            dir,
            undefined,
            undefined,
            undefined,
            undefined,
            deps,
          )).status,
          "passed",
        );
      }
      assertEquals(
        calls.length,
        4,
        "merge check plus resolution check, manifest and unit suite",
      );
      for (const call of calls) {
        assertNoSecrets(call.options?.env, source);
        assertEquals(call.options?.env?.DECLARED_TOKEN, "fixture+= spaces");
        assertCredentialOffArgv(call, "fixture+= spaces", true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PR #4703 review: credentials stay off argv; an unreadable checkout fails closed
// ---------------------------------------------------------------------------

Deno.test("credentialCarryingCommand - the wrapper hands the child exact values from stdin", async () => {
  const values: Record<string, string> = {
    SPACED: "a b=c 'quoted' $HOME `x`",
    MULTILINE: "line1\nline2\n",
    EMPTY: "",
    UNICODE: "caf\u00e9 \u2713",
  };
  const { argv, input } = credentialCarryingCommand(
    Object.entries(values),
    "sh",
    [
      "-c",
      'printf "%s|" "$SPACED" "$MULTILINE" "$EMPTY" "$UNICODE"; read -r rest || echo "stdin-empty"',
    ],
  );
  for (const element of argv) {
    for (const value of Object.values(values).filter(Boolean)) {
      assert(!element.includes(value), `argv leaks ${value}`);
    }
  }
  const child = new Deno.Command(argv[0]!, {
    args: argv.slice(1),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const out = await child.output();
  assertEquals(new TextDecoder().decode(out.stderr), "");
  assertEquals(
    new TextDecoder().decode(out.stdout),
    `${values.SPACED}|${values.MULTILINE}|${values.EMPTY}|${values.UNICODE}|stdin-empty\n`,
  );
});

Deno.test("credentialCarryingCommand - refuses a name that is not an identifier", () => {
  let error: unknown;
  try {
    credentialCarryingCommand([["BAD NAME", "x"]], "true", []);
  } catch (err) {
    error = err;
  }
  assert(error instanceof Error);
  assertEquals(
    error.message,
    "Invalid repository credential environment name",
  );
});

Deno.test("runRepositoryCommand - under sudo the probe checks the checkout and manifest as the dropped account", async () => {
  await withTempDir(async (dir) => {
    const { spawn, calls, probes } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd: dir, timeoutMs: 5000, manifests: ["Cargo.toml"] },
      {
        spawn,
        drop: sudoWrapper,
        source: sourceWithSecrets(),
        trimRefused: false,
      },
    );
    assertEquals(calls.length, 1, "the gate runs once the probes pass");
    // Without a placed target directory cargo also needs a writable checkout.
    assertEquals(probes.length, 2);
    const probe = probes[0]!;
    assertEquals(probe.executable, "sudo");
    assertEquals(probe.args.slice(0, 5), ["-n", "-u", "agent", "--", "test"]);
    assertEquals(probe.args.slice(5), [
      "-r",
      dir,
      "-a",
      "-x",
      dir,
      "-a",
      "-r",
      `${dir}/Cargo.toml`,
    ]);
    assertEquals(probe.options?.clearEnv, true);
  });
});

Deno.test("runRepositoryCommand - a checkout the dropped account cannot read is an error, not a run", async () => {
  await withTempDir(async (dir) => {
    for (
      const probeOutcome of [
        {
          ok: true as const,
          value: {
            code: 1,
            success: false,
            stdout: "",
            stderr: "",
            timedOut: false,
          },
        },
        { ok: false as const, error: new Error("sudo gone") },
      ]
    ) {
      const { spawn, calls } = recordingSpawn(SUCCESS, probeOutcome);
      const result = await runRepositoryCommand(
        "cargo",
        ["check"],
        { cwd: dir, timeoutMs: 5000, manifests: ["Cargo.toml"] },
        { spawn, drop: sudoWrapper, source: sourceWithSecrets() },
      );
      assert(!result.ok, "an unreadable checkout must not report a result");
      assert(result.error.message.includes("'agent' account cannot read"));
      assert(result.error.message.includes("Cargo.toml"));
      assert(
        isUnverifiableCheckout(result.error),
        "an unusable checkout is typed so the sync does not charge it",
      );
      assertEquals(calls.length, 0, "the gate command must not run");
    }
  });
});

Deno.test("runRepositoryCommand - running as the worker needs no probe", async () => {
  await withTempDir(async (dir) => {
    const { spawn, calls, probes } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd: dir, timeoutMs: 5000, manifests: ["Cargo.toml"] },
      { spawn, drop: identity, source: sourceWithSecrets() },
    );
    assertEquals(probes.length, 0);
    assertEquals(calls.length, 1);
  });
});

Deno.test("neither milestone gate reports passed for a checkout the dropped account cannot read", async () => {
  await withTempDir(async (dir) => {
    // A Deno tree with no `check` task: the `deno check **/*.ts` fallback is
    // the command that exits 0 with "No matching files found" when it cannot
    // see the tree.
    await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify({ tasks: {} }));
    await Deno.writeTextFile(`${dir}/mod.ts`, "export const x = 1;\n");
    const unreadable = {
      ok: true as const,
      value: {
        code: 1,
        success: false,
        stdout: "",
        stderr: "",
        timedOut: false,
      },
    };
    for (const readable of [false, true]) {
      const { spawn, calls } = recordingSpawn(
        {
          ok: true,
          value: {
            code: 0,
            success: true,
            stdout: "No matching files found",
            stderr: "",
            timedOut: false,
          },
        },
        readable ? SUCCESS : unreadable,
      );
      const deps = { spawn, drop: sudoWrapper, source: sourceWithSecrets() };
      const merged = await checkMergedTree(
        dir,
        undefined,
        async () => false,
        deps,
      );
      const resolved = await verifyResolvedTree(
        dir,
        undefined,
        undefined,
        undefined,
        async () => false,
        deps,
      );
      if (readable) {
        // Positive control: with a readable tree the same fixture passes.
        assertEquals(merged.status, "passed");
        assertEquals(merged.unverifiable, undefined);
        assert(calls.length > 0);
      } else {
        assertEquals(merged.status, "failed");
        assertEquals(resolved.status, "failed");
        assert(merged.status === "failed" && merged.unverifiable === true);
        assert(resolved.status === "failed" && resolved.unverifiable === true);
        assert(merged.output.includes("cannot read"));
        assertEquals(calls.length, 0, "no gate command may run");
      }
    }
  });
});

Deno.test("manifestsFor - names the file whose readability proves the project is visible", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await manifestsFor("cargo", dir), ["Cargo.toml"]);
    assertEquals(await manifestsFor("script", dir), ["quality.sh"]);
    assertEquals(await manifestsFor("deno", dir), []);
    await Deno.writeTextFile(`${dir}/deno.jsonc`, "{}");
    assertEquals(await manifestsFor("deno", dir), ["deno.jsonc"]);
    await Deno.writeTextFile(`${dir}/deno.json`, "{}");
    assertEquals(await manifestsFor("deno", dir), ["deno.json"]);
  });
});

Deno.test("runRepositoryCommand - cargo needs a target directory the dropped account can write", async () => {
  const unwritable: SpawnOutcome = {
    ok: true,
    value: { code: 1, success: false, stdout: "", stderr: "", timedOut: false },
  };
  const deps = (spawn: Spawn) => ({
    spawn,
    drop: sudoWrapper,
    source: sourceWithSecrets(),
    trimRefused: false,
  });
  const options = (dir: string) => ({
    cwd: dir,
    timeoutMs: 5000,
    manifests: ["Cargo.toml"],
  });

  // No `target` yet: cargo creates it, so the checkout itself must be writable.
  await withTempDir(async (dir) => {
    const { spawn, calls, probes } = recordingSpawn(SUCCESS, unwritable);
    // Both probes fail here; make the readability probe pass first.
    let probed = 0;
    const answering: Spawn = (executable, args, spawnOptions) => {
      if (isProbe(executable, args)) {
        probed++;
        if (probed === 1) {
          probes.push({ executable, args: [...args], options: spawnOptions });
          return Promise.resolve(SUCCESS);
        }
      }
      return spawn(executable, args, spawnOptions);
    };
    const result = await runRepositoryCommand(
      "cargo",
      ["check"],
      options(dir),
      deps(answering),
    );
    assert(!result.ok);
    assert(isUnverifiableCheckout(result.error));
    assert(result.error.message.includes("write the 'target' directory"));
    assertEquals(calls.length, 0, "cargo must not run");
    assertEquals(probes.at(-1)?.args.slice(-3), ["test", "-w", dir]);
  });

  // An existing `target` the worker created: `find` names the unwritable entry.
  await withTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/target`);
    for (const owned of ["", `${dir}/target/debug\n`]) {
      const { spawn, calls, probes } = recordingSpawn(SUCCESS, {
        ok: true,
        value: {
          code: 0,
          success: true,
          stdout: owned,
          stderr: "",
          timedOut: false,
        },
      });
      const result = await runRepositoryCommand(
        "cargo",
        ["check"],
        options(dir),
        deps(spawn),
      );
      const find = probes.find((p) => p.args.includes("find"));
      assert(find, "an existing target is scanned with find");
      assertEquals(find.args.slice(-6), [
        "find",
        `${dir}/target`,
        "!",
        "-writable",
        "-print",
        "-quit",
      ]);
      if (owned === "") {
        // Positive control: nothing unwritable, so cargo runs.
        assert(result.ok);
        assertEquals(calls.length, 1);
      } else {
        assert(!result.ok);
        assert(isUnverifiableCheckout(result.error));
        assertEquals(calls.length, 0, "cargo must not run");
      }
    }
  });

  // An explicit `CARGO_TARGET_DIR` places the build elsewhere: no scan.
  await withTempDir(async (dir) => {
    const { spawn, calls, probes } = recordingSpawn();
    const result = await runRepositoryCommand(
      "cargo",
      ["check"],
      options(dir),
      {
        ...deps(spawn),
        source: { ...sourceWithSecrets(), CARGO_TARGET_DIR: "/somewhere/else" },
      },
    );
    assert(result.ok);
    assertEquals(calls.length, 1);
    assertEquals(probes.length, 1, "only the readability probe runs");
  });
});

Deno.test("verifyResolvedTree - a manifest task that cannot see the tree is unverifiable, not passed", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    const passedTypeCheck = () =>
      Promise.resolve({
        status: "passed" as const,
        detail: "type check passed",
        output: "",
      });
    const outcomes = [];
    for (const readable of [true, false]) {
      const { spawn, calls } = recordingSpawn(SUCCESS, {
        ok: true,
        value: {
          code: readable ? 0 : 1,
          success: readable,
          stdout: "",
          stderr: "",
          timedOut: false,
        },
      });
      outcomes.push({
        readable,
        calls: calls.length,
        outcome: await verifyResolvedTree(
          dir,
          undefined,
          passedTypeCheck,
          undefined,
          async () => false,
          { spawn, drop: sudoWrapper, source: sourceWithSecrets() },
        ),
        recorded: calls,
      });
    }
    const [control, unseen] = outcomes;
    // Positive control: with a readable tree the same suite task runs and passes.
    assertEquals(control!.outcome.status, "passed");
    assertEquals(control!.recorded.length > 0, true);
    assertEquals(unseen!.outcome.status, "failed");
    assert(
      unseen!.outcome.status === "failed" &&
        unseen!.outcome.unverifiable === true,
    );
    assertEquals(unseen!.recorded.length, 0, "no task may run");
  });
});
