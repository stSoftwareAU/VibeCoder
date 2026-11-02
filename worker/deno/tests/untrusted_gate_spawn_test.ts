/**
 * The milestone gates run repository commands without the worker's
 * credentials, as `agent` where usable and otherwise as the worker (Issue
 * #4659).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  manifestsFor,
  runRepositoryCommand,
} from "../lib/untrusted_gate_spawn.ts";
import type { untrustedSpawn } from "../lib/quality_gate_phase.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import { checkMergedTree } from "../lib/milestone_merge_gate.ts";
import { ALLOWED_ENV_NAMES } from "../lib/untrusted_command_env.ts";

type Spawned = Awaited<ReturnType<typeof runWithTimeout>>;
type SpawnOptions = Parameters<typeof runWithTimeout>[2];
interface Call {
  executable: string;
  args: string[];
  options: SpawnOptions;
}

const OK: SubprocessResult = {
  success: true,
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
};

const SOURCE = {
  PATH: "/usr/bin",
  GH_TOKEN: "ghp_secret",
  ANTHROPIC_API_KEY: "sk-secret",
  HOME: "/h",
};

const identityDrop: typeof untrustedSpawn = async (cmd) => [...cmd];

const agentDrop: typeof untrustedSpawn = async (cmd) => [
  "sudo",
  "-n",
  "-u",
  "agent",
  "--",
  ...cmd,
];

/** A spawn that records each call. The first answers `first`; the rest succeed. */
function recordingSpawn(first: Spawned = { ok: true, value: OK }) {
  const calls: Call[] = [];
  const spawn: typeof runWithTimeout = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    return calls.length === 1 ? first : { ok: true, value: OK };
  };
  return { calls, spawn };
}

/** Run `fn` in a fresh temp checkout, removed afterwards. */
async function withCheckout(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await Deno.makeTempDir({ prefix: "vibe_4659_" });
  try {
    await fn(cwd);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
}

/** Collect what `run` writes to console.error, restoring it afterwards. */
async function captureConsoleError<T>(
  run: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...parts: unknown[]) => {
    lines.push(parts.join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

/** The `index`th recorded call. A missing one fails the test. */
function callAt(calls: Call[], index: number): Call {
  const call = calls[index];
  assert(call !== undefined, `expected a call at index ${index}`);
  return call;
}

/** The probe script: the argument after `-c`. */
function probeScriptOf(call: Call): string {
  return call.args[call.args.indexOf("-c") + 1] ?? "";
}

Deno.test("the parent's credentials do not reach a repository command (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "npm",
      ["test"],
      { cwd, timeoutMs: 1000 },
      { spawn, drop: identityDrop, source: SOURCE, trimRefused: false },
    );
    assertEquals(calls.length, 1);
    const env = callAt(calls, 0).options.env ?? {};
    assertEquals(env.GH_TOKEN, undefined);
    assertEquals(env.ANTHROPIC_API_KEY, undefined);
    assertEquals(env.PATH, "/usr/bin");
    assertEquals(callAt(calls, 0).options.clearEnv, true);
  });
});

/**
 * Names a POSIX shell sets for itself in a child it starts. They carry no
 * secret. Same list as untrusted_spawn_env_test.ts (Issue #1214).
 */
const SHELL_SET_NAMES = ["PWD", "SHLVL", "_", "OLDPWD", "IFS"];

/** The variable names a `printenv` child printed, one per line. */
function envNames(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.slice(0, line.indexOf("=")))
    .filter((name) => name.length > 0);
}

// Asserts over the whole name set rather than planting a credential in the
// worker's own environment, so nothing here mutates process state (Issue #880).
Deno.test("a real repository command sees only allowlisted names (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const isolated = await runRepositoryCommand(
      "printenv",
      [],
      { cwd, timeoutMs: 10_000 },
      { drop: identityDrop, trimRefused: false },
    );
    assert(isolated.ok);
    assertEquals(isolated.value.code, 0);
    const seen = envNames(isolated.value.stdout);
    // The dump really happened: PATH is allowlisted and must be present.
    assert(seen.includes("PATH"));

    const permitted = new Set([...ALLOWED_ENV_NAMES, ...SHELL_SET_NAMES]);
    assertEquals(seen.filter((name) => !permitted.has(name)), []);

    // Positive control: without `clearEnv` a name outside the allowlist
    // reaches the child, so the assertion above has teeth. The name is
    // stated here because the test process's own environment may already be
    // allowlisted (the unit runner and the mutation runner both do that).
    const inherited = await runWithTimeout("printenv", [], {
      cwd,
      timeoutMs: 10_000,
      env: { VIBE_4659_CONTROL: "1" },
    });
    assert(inherited.ok);
    assert(envNames(inherited.value.stdout).includes("VIBE_4659_CONTROL"));
  });
});

Deno.test("a usable untrusted account runs the command dropped, with the cargo target carried (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    await withCheckout(async (root) => {
      const { calls, spawn } = recordingSpawn();
      await runRepositoryCommand(
        "cargo",
        ["test"],
        { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
        { spawn, drop: agentDrop, source: SOURCE, trimRefused: true, root },
      );
      assertEquals(calls.length, 2);

      // The probe runs first, against the checkout.
      assertEquals(callAt(calls, 0).executable, "sudo");
      assertEquals(callAt(calls, 0).args.at(-1), cwd);

      const final = callAt(calls, 1);
      assertEquals(final.executable, "sudo");
      const target = final.options.env?.CARGO_TARGET_DIR;
      assert(target !== undefined && target.startsWith(root));
      assertEquals(
        final.args,
        [
          "-n",
          "-u",
          "agent",
          "--",
          "env",
          `CARGO_TARGET_DIR=${target}`,
          "cargo",
          "test",
        ],
      );
      assertEquals(final.options.clearEnv, true);
      assertEquals(final.options.env?.GH_TOKEN, undefined);
    });
  });
});

const PROBE_FAILURES: [string, Spawned][] = [
  [
    "exits non-zero",
    { ok: true, value: { ...OK, success: false, code: 1 } },
  ],
  ["is not ok", { ok: false, error: new Error("spawn failed") }],
  [
    "times out",
    { ok: true, value: { ...OK, success: false, code: 124, timedOut: true } },
  ],
];

for (const [label, first] of PROBE_FAILURES) {
  Deno.test(`an untrusted probe that ${label} runs the command as the worker (Issue #4659)`, async () => {
    await withCheckout(async (cwd) => {
      const { calls, spawn } = recordingSpawn(first);
      const { lines } = await captureConsoleError(() =>
        runRepositoryCommand(
          "cargo",
          ["test"],
          { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
          { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
        )
      );
      assertEquals(calls.length, 2);
      assertEquals(callAt(calls, 1).executable, "cargo");
      assertEquals(callAt(calls, 1).args, ["test"]);
      assertEquals(callAt(calls, 1).options.env?.GH_TOKEN, undefined);
      assertEquals(callAt(calls, 1).options.clearEnv, true);
      assert(
        lines.some((line) =>
          line.includes("[SECURITY]") && line.includes(`'${cwd}'`)
        ),
      );
    });
  });
}

Deno.test("a command that does not drop account runs once, with no probe (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "npm",
      ["test"],
      { cwd, timeoutMs: 1000 },
      { spawn, drop: identityDrop, source: SOURCE, trimRefused: false },
    );
    assertEquals(calls.length, 1);
    assertEquals(callAt(calls, 0).executable, "npm");
    assertEquals(callAt(calls, 0).args, ["test"]);
  });
});

Deno.test("the probe checks the manifests, and the target only for cargo (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const probeFor = async (
      executable: string,
      manifests: string[],
    ): Promise<string> => {
      const { calls, spawn } = recordingSpawn();
      await runRepositoryCommand(
        executable,
        ["run"],
        { cwd, timeoutMs: 1000, manifests },
        { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
      );
      assertEquals(callAt(calls, 0).args.at(-1), cwd);
      return probeScriptOf(callAt(calls, 0));
    };

    const cargoNoTarget = await probeFor("cargo", ["Cargo.toml"]);
    assert(cargoNoTarget.includes(`"$1/Cargo.toml"`));
    assert(cargoNoTarget.includes(`test -w "$1"`));
    assert(!cargoNoTarget.includes("find"));
    assert(!cargoNoTarget.includes(cwd));

    await Deno.mkdir(`${cwd}/target`);
    const cargoWithTarget = await probeFor("cargo", ["Cargo.toml"]);
    assert(cargoWithTarget.includes(`find "$1/target"`));
    assert(cargoWithTarget.includes(`test -w`));

    const deno = await probeFor("deno", ["deno.json"]);
    assert(deno.includes(`"$1/deno.json"`));
    assert(deno.includes("test -w"));
    assert(!deno.includes("find"));
  });
});

Deno.test("a manifest name that is not a plain file name is refused (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { spawn } = recordingSpawn();
    await assertRejects(
      () =>
        runRepositoryCommand(
          "cargo",
          ["test"],
          { cwd, timeoutMs: 1000, manifests: ["../x"] },
          { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
        ),
      Error,
      "refusing to probe manifest",
    );
  });
});

Deno.test("manifestsFor names the manifests each kind of checkout is probed for (Issue #4659)", async () => {
  await withCheckout(async (dir) => {
    assertEquals(await manifestsFor("cargo", dir), ["Cargo.toml"]);
    assertEquals(await manifestsFor("script", dir), ["quality.sh"]);
    assertEquals(await manifestsFor("deno", dir), []);
    await Deno.writeTextFile(`${dir}/deno.json`, "{}");
    assertEquals(await manifestsFor("deno", dir), ["deno.json"]);
    await Deno.remove(`${dir}/deno.json`);
    await Deno.writeTextFile(`${dir}/deno.jsonc`, "{}");
    assertEquals(await manifestsFor("deno", dir), ["deno.jsonc"]);
  });
});

Deno.test("the repository's declared credentials reach the command and only it (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    const seen: string[] = [];
    await runRepositoryCommand(
      "deno",
      ["task", "check"],
      { cwd, timeoutMs: 1000 },
      {
        spawn,
        drop: identityDrop,
        source: SOURCE,
        trimRefused: false,
        credentials: (dir) => {
          seen.push(dir);
          return Promise.resolve({ NPM_TOKEN: "declared" });
        },
      },
    );
    assertEquals(seen, [cwd]);
    const env = callAt(calls, 0).options.env ?? {};
    assertEquals(env.NPM_TOKEN, "declared");
    assertEquals(env.GH_TOKEN, undefined);
  });
});

Deno.test("a credential source that fails stops the command from running (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    const result = await runRepositoryCommand(
      "deno",
      ["task", "check"],
      { cwd, timeoutMs: 1000 },
      {
        spawn,
        drop: identityDrop,
        source: SOURCE,
        credentials: () => Promise.reject(new Error("mint failed")),
      },
    );
    assertEquals(result.ok, false);
    assert(!result.ok);
    assert(result.error.message.includes("mint failed"));
    assertEquals(calls.length, 0);
  });
});

Deno.test("a target the account cannot write gives it a target of its own, not the worker's account (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn({
      ok: true,
      value: { ...OK, success: false, code: 2 },
    });
    const { lines } = await captureConsoleError(() =>
      runRepositoryCommand(
        "cargo",
        ["test"],
        { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
        { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
      )
    );
    assertEquals(calls.length, 3);
    const final = callAt(calls, 1);
    assertEquals(final.executable, "sudo");
    const target = final.options.env?.CARGO_TARGET_DIR;
    assert(target !== undefined && !target.startsWith(cwd));
    // The account empties what it built; the worker then removes the directory.
    const emptier = callAt(calls, 2);
    assertEquals(emptier.executable, "sudo");
    assertEquals(emptier.args.slice(-5), [
      "find",
      target,
      "-mindepth",
      "1",
      "-delete",
    ]);
    assert(final.args.includes(`CARGO_TARGET_DIR=${target}`));
    assertEquals(final.options.env?.GH_TOKEN, undefined);
    assert(!lines.some((line) => line.includes("[SECURITY]")));
    // Removed once the command has run.
    await assertRejects(() => Deno.stat(target), Deno.errors.NotFound);
  });
});

Deno.test("only an unreadable checkout, not a tree-controlled target, downgrades the account (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    await Deno.mkdir(`${cwd}/target`);
    await Deno.writeTextFile(`${cwd}/target/committed`, "x");
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["test"],
      { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
    );
    const script = probeScriptOf(callAt(calls, 0));
    // Unreadable checkout exits 1 (fallback); an unwritable target exits 2.
    assert(script.includes(`|| exit 1;`));
    assert(script.endsWith(`|| exit 2`));
  });
});

Deno.test("a manifest that is a symbolic link is refused before anything runs (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    await Deno.symlink("/etc/hostname", `${cwd}/Cargo.toml`);
    const { calls, spawn } = recordingSpawn();
    const result = await runRepositoryCommand(
      "cargo",
      ["test"],
      { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
    );
    assertEquals(result.ok, false);
    assert(!result.ok);
    assert(result.error.message.includes("symbolic link"));
    assertEquals(calls.length, 0);
  });
});

Deno.test("a manifest name that is not a plain file name is refused even when no probe runs (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    // identityDrop never builds a probe, so only the check in the manifest
    // loop can refuse the name.
    await assertRejects(
      () =>
        runRepositoryCommand(
          "npm",
          ["test"],
          { cwd, timeoutMs: 1000, manifests: ["../x"] },
          { spawn, drop: identityDrop, source: SOURCE, trimRefused: false },
        ),
      Error,
      "refusing to probe manifest",
    );
    assertEquals(calls.length, 0);
    // The same call with a plain name is not refused by that rule.
    const accepted = await runRepositoryCommand(
      "npm",
      ["test"],
      { cwd, timeoutMs: 1000, manifests: ["package.json"] },
      { spawn, drop: identityDrop, source: SOURCE, trimRefused: false },
    );
    assertEquals(accepted.ok, true);
    assertEquals(calls.length, 1);
  });
});

Deno.test("a manifest that cannot be inspected stops the command with the cause (Issue #4659)", async () => {
  await withCheckout(async (dir) => {
    // A file where the checkout should be: lstat fails with ENOTDIR, not NotFound.
    const notADirectory = `${dir}/file`;
    await Deno.writeTextFile(notADirectory, "x");
    let cause = "";
    try {
      await Deno.lstat(`${notADirectory}/Cargo.toml`);
    } catch (error) {
      cause = (error as Error).message;
    }
    assert(cause.length > 0, "the fixture must make lstat fail");

    const { calls, spawn } = recordingSpawn();
    const result = await runRepositoryCommand(
      "cargo",
      ["test"],
      { cwd: notADirectory, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
    );
    assertEquals(result.ok, false);
    assert(!result.ok);
    assertEquals(
      result.error.message,
      `cannot inspect 'Cargo.toml' in '${notADirectory}': ${cause}`,
    );
    assertEquals(calls.length, 0);
  });
});

Deno.test("the probe is a shell run in the checkout, handed the checkout as its argument (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "deno",
      ["task", "check"],
      { cwd, timeoutMs: 1000, manifests: ["deno.json"] },
      { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
    );
    const probe = callAt(calls, 0);
    assertEquals(probe.executable, "sudo");
    // `sh -c <script> sh <cwd>`: the second `sh` is the script's $0.
    assertEquals(probe.args, [
      "-n",
      "-u",
      "agent",
      "--",
      "sh",
      "-c",
      probeScriptOf(probe),
      "sh",
      cwd,
    ]);
    assertEquals(probe.options.cwd, cwd);
  });
});

Deno.test("a cargo target the environment already names is not probed for writability (Issue #4659)", async () => {
  await withCheckout(async (cwd) => {
    const probeFor = async (source: Record<string, string>) => {
      const { calls, spawn } = recordingSpawn();
      await runRepositoryCommand(
        "cargo",
        ["test"],
        { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
        { spawn, drop: agentDrop, source, trimRefused: false },
      );
      return probeScriptOf(callAt(calls, 0));
    };
    // Control: with no target named, the probe checks the checkout is writable.
    assert((await probeFor(SOURCE)).includes(`test -w "$1"`));
    // A target the environment names is not the checkout's, so it is not checked.
    const named = await probeFor({
      ...SOURCE,
      CARGO_TARGET_DIR: "/var/cache/target",
    });
    assert(named.includes(`test -w "$1" || exit 3`));
    assert(!named.includes(`|| exit 2`));
    assert(!named.includes(`find`));
  });
});

Deno.test("declared credentials survive an available agent account", async () => {
  await withCheckout(async (cwd) => {
    const calls: Call[] = [];
    const spawn: typeof runWithTimeout = async (executable, args, options) => {
      calls.push({ executable, args, options });
      return await runWithTimeout(executable, args, options);
    };
    const result = await runRepositoryCommand(
      "/bin/sh",
      ["-c", 'printf %s "$NPM_TOKEN"'],
      { cwd, timeoutMs: 1000 },
      {
        spawn,
        drop: agentDrop,
        source: SOURCE,
        trimRefused: false,
        credentials: async () => ({ NPM_TOKEN: "declared" }),
      },
    );
    assertEquals(calls.length, 1);
    const final = callAt(calls, 0);
    assertEquals(final.executable, "/bin/sh");
    assert(result.ok);
    assertEquals(result.value.code, 0);
    assertEquals(result.value.stdout, "declared");
    assertEquals(final.options.env?.NPM_TOKEN, "declared");
    assertEquals(final.options.env?.GH_TOKEN, undefined);
    assertEquals(final.options.clearEnv, true);
    assert(!final.args.join(" ").includes("declared"));
  });
});

Deno.test("real probe permission verdicts", async () => {
  const uid = await new Deno.Command("id", { args: ["-u"] }).output();
  if (new TextDecoder().decode(uid.stdout).trim() === "0") return;
  await withCheckout(async (cwd) => {
    const manifest = `${cwd}/Cargo.toml`;
    await Deno.writeTextFile(manifest, "[package]");
    const code = async (executable = "cargo") => {
      const { calls, spawn } = recordingSpawn();
      await runRepositoryCommand(executable, ["check"], {
        cwd,
        timeoutMs: 1000,
        manifests: ["Cargo.toml"],
      }, { spawn, drop: agentDrop, source: SOURCE, trimRefused: false });
      return (await new Deno.Command("sh", {
        args: ["-c", probeScriptOf(callAt(calls, 0)), "sh", cwd],
      }).output()).code;
    };
    assertEquals(await code(), 0);
    await Deno.chmod(manifest, 0o000);
    try {
      assertEquals(await code(), 1);
    } finally {
      await Deno.chmod(manifest, 0o644);
    }
    await Deno.remove(manifest);
    assertEquals(await code(), 1);
    await Deno.writeTextFile(manifest, "[package]");
    await Deno.chmod(cwd, 0o555);
    try {
      for (const executable of ["cargo", "deno", "bash"]) {
        assertEquals(await code(executable), 3);
      }
    } finally {
      await Deno.chmod(cwd, 0o755);
    }
    await Deno.mkdir(`${cwd}/target`);
    await Deno.writeTextFile(`${cwd}/target/readonly`, "x");
    await Deno.chmod(`${cwd}/target/readonly`, 0o444);
    try {
      assertEquals(await code(), 2);
    } finally {
      await Deno.chmod(`${cwd}/target/readonly`, 0o644);
    }
    assertEquals(await code(), 0);
  });
});

Deno.test("a read-only agent checkout without Cargo.lock still passes the real cargo merge gate", async () => {
  const uid = await new Deno.Command("id", { args: ["-u"] }).output();
  if (new TextDecoder().decode(uid.stdout).trim() === "0") return;
  await withCheckout(async (cwd) => {
    await Deno.writeTextFile(
      `${cwd}/Cargo.toml`,
      '[package]\nname = "gate_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await Deno.mkdir(`${cwd}/src`);
    await Deno.writeTextFile(`${cwd}/src/lib.rs`, "pub fn value() -> u8 { 1 }");
    const calls: string[] = [];
    const outcome = await checkMergedTree(cwd, async (project) => {
      const result = await runRepositoryCommand("cargo", project.args, {
        cwd: project.dir,
        timeoutMs: 30000,
        manifests: ["Cargo.toml"],
      }, {
        drop: agentDrop,
        source: { ...Deno.env.toObject(), CARGO_TARGET_DIR: `${cwd}/target` },
        trimRefused: false,
        spawn: async (executable, args, options) => {
          calls.push(executable);
          if (executable === "sudo") {
            // Model agent's read-only access, then restore worker's write access.
            // Execute the actual probe; the repository command must bypass sudo.
            assert(args.includes("-c"));
            await Deno.chmod(cwd, 0o555);
            try {
              return await runWithTimeout(
                "sh",
                args.slice(args.indexOf("sh") + 1),
                options,
              );
            } finally {
              await Deno.chmod(cwd, 0o755);
            }
          }
          return await runWithTimeout(executable, args, options);
        },
      });
      assert(result.ok);
      return {
        code: result.value.code,
        output: result.value.stdout + result.value.stderr,
      };
    }, async () => false);
    assertEquals(outcome.status, "passed", JSON.stringify(outcome));
    assertEquals(calls, ["sudo", "cargo"]);
    assert((await Deno.stat(`${cwd}/Cargo.lock`)).isFile);
  });
});
