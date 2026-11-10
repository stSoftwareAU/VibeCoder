/**
 * The milestone gates run repository commands without the worker's
 * credentials, as `agent` where usable and otherwise as the worker (Issue
 * #4659).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  GateAccountUnavailable,
  manifestsFor,
  runRepositoryCommand,
} from "../lib/untrusted_gate_spawn.ts";
import type { untrustedSpawn } from "../lib/quality_gate_phase.ts";
import { untrustedAccountOf } from "../lib/quality_gate_phase.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import { checkMergedTree } from "../lib/milestone_merge_gate.ts";
import { cargoTargetDirForCheckout } from "../lib/ephemeral_build_cache.ts";
import { makeAgentReachableTempDir } from "./support/gate_child_env.ts";
import {
  ALLOWED_ENV_NAMES,
  asUntrustedUser,
  canRunAsUntrustedUser,
} from "../lib/untrusted_command_env.ts";

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
    // The `.git` marker stops the worktree-root walk (Issue #4927) here, so a
    // test never reads the shared temp directory above the checkout.
    await Deno.mkdir(`${cwd}/.git`);
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

const PROXY = "http://192.168.128.2:3128";

Deno.test("the egress proxy reaches the dropped command past sudo's env_reset (Issue #4877)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      {
        spawn,
        drop: agentDrop,
        source: {
          ...SOURCE,
          HTTPS_PROXY: PROXY,
          https_proxy: PROXY,
          http_proxy: PROXY,
          NO_PROXY: "localhost,127.0.0.1,::1",
        },
        trimRefused: false,
      },
    );
    const final = callAt(calls, calls.length - 1);
    assertEquals(final.executable, "sudo");
    const afterEnv = final.args.slice(final.args.indexOf("env") + 1);
    for (
      const entry of [
        `HTTPS_PROXY=${PROXY}`,
        `https_proxy=${PROXY}`,
        `http_proxy=${PROXY}`,
        "NO_PROXY=localhost,127.0.0.1,::1",
      ]
    ) {
      assert(afterEnv.includes(entry), `missing ${entry}: ${final.args}`);
    }
    assertEquals(final.args.slice(-2), ["cargo", "check"]);
    assert(!final.args.some((arg) => arg.includes("secret")));
  });
});

Deno.test("a proxy URL that carries credentials never goes into argv (Issue #4877)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      {
        spawn,
        drop: agentDrop,
        source: { ...SOURCE, HTTPS_PROXY: "http://user:pw@proxy:3128" },
        trimRefused: false,
      },
    );
    const final = callAt(calls, calls.length - 1);
    assert(!final.args.some((arg) => arg.includes("pw@")), `${final.args}`);
  });
});

Deno.test("a command run as the worker carries the proxy in its env, not argv (Issue #4877)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "npm",
      ["test"],
      { cwd, timeoutMs: 1000 },
      {
        spawn,
        drop: identityDrop,
        source: { ...SOURCE, HTTPS_PROXY: PROXY },
        trimRefused: false,
      },
    );
    const only = callAt(calls, 0);
    assertEquals([only.executable, ...only.args], ["npm", "test"]);
    assertEquals(only.options.env?.HTTPS_PROXY, PROXY);
  });
});

Deno.test("a dropped cargo command trusts its checkout for git, carried in argv (Issue #4927)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
    );
    const final = callAt(calls, calls.length - 1);
    assertEquals(final.executable, "sudo");
    const afterEnv = final.args.slice(final.args.indexOf("env") + 1);
    for (
      const entry of [
        "GIT_CONFIG_COUNT=1",
        "GIT_CONFIG_KEY_0=safe.directory",
        `GIT_CONFIG_VALUE_0=${cwd}`,
      ]
    ) {
      assert(afterEnv.includes(entry), `missing ${entry}: ${final.args}`);
    }
    assertEquals(final.args.slice(-2), ["cargo", "check"]);
  });
});

Deno.test("a command run as the worker gets no git safe.directory entry (Issue #4927)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      { spawn, drop: identityDrop, source: SOURCE, trimRefused: false },
    );
    assertEquals(calls.length, 1);
    const only = callAt(calls, 0);
    const names = Object.keys(only.options.env ?? {});
    assertEquals(names.filter((name) => name.startsWith("GIT_CONFIG")), []);
    assertEquals(only.args.filter((arg) => arg.includes("GIT_CONFIG")), []);
  });
});

Deno.test("a checkout whose path holds a space gets no git entry and does not throw (Issue #4927)", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "vibe 4927 " });
  try {
    // The `.git` marker stops the worktree-root walk here; the space in `cwd`
    // is what CARRIED_ENV_VALUE then rejects.
    await Deno.mkdir(`${cwd}/.git`);
    const { calls, spawn } = recordingSpawn();
    const result = await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
    );
    assert(result.ok, `the command was refused: ${JSON.stringify(result)}`);
    const final = callAt(calls, calls.length - 1);
    assertEquals(final.args.filter((arg) => arg.includes("GIT_CONFIG")), []);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("real sudo: an agent git command runs in a worker-owned checkout (Issue #4927)", async () => {
  // Skipped where this host cannot drop to the agent account.
  if (!await canRunAsUntrustedUser()) return;
  // Under /tmp, not TMPDIR, so the account can reach the directory (Issue #4733).
  const cwd = await makeAgentReachableTempDir("issue-4927-");
  try {
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd,
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(init.code, 0);
    const result = await runRepositoryCommand(
      "git",
      ["rev-parse", "--git-dir"],
      { cwd, timeoutMs: 20_000 },
    );
    assert(result.ok, `the command was refused: ${JSON.stringify(result)}`);
    assertEquals(result.value.code, 0, result.value.stderr);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("real sudo: an agent git command runs from a subdirectory of a worker-owned checkout (Issue #4927)", async () => {
  if (!await canRunAsUntrustedUser()) return;
  const root = await makeAgentReachableTempDir("issue-4927-sub-");
  try {
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: root,
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(init.code, 0);
    const cwd = `${root}/crates/app`;
    await Deno.mkdir(cwd, { recursive: true });
    await Deno.chmod(`${root}/crates`, 0o777);
    await Deno.chmod(cwd, 0o777);
    const result = await runRepositoryCommand(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeoutMs: 20_000 },
    );
    assert(
      result.ok,
      `the command was refused: ${result.ok ? "" : result.error.message}`,
    );
    assertEquals(result.value.code, 0, result.value.stderr);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a dropped command in a nested project dir trusts the worktree root (Issue #4927)", async () => {
  await withCheckout(async (root) => {
    const cwd = `${root}/crates/app`;
    await Deno.mkdir(cwd, { recursive: true });
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand(
      "cargo",
      ["check"],
      { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
      { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
    );
    const final = callAt(calls, calls.length - 1);
    assert(final.args.includes(`GIT_CONFIG_VALUE_0=${root}`), `${final.args}`);
    assert(!final.args.includes(`GIT_CONFIG_VALUE_0=${cwd}`));
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
          "GIT_CONFIG_COUNT=1",
          "GIT_CONFIG_KEY_0=safe.directory",
          `GIT_CONFIG_VALUE_0=${cwd}`,
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
  Deno.test(`an untrusted probe that ${label} leaves the command to CI without changing account (Issue #4659)`, async () => {
    await withCheckout(async (cwd) => {
      const { calls, spawn } = recordingSpawn(first);
      const { result } = await captureConsoleError(() =>
        runRepositoryCommand(
          "cargo",
          ["test"],
          { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
          { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
        )
      );
      assertEquals(calls.length, 1);
      assertEquals(result.ok, false);
      assert(!result.ok);
      assert(result.error instanceof GateAccountUnavailable);
      assert(result.error.message.includes(cwd));
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
    assertEquals(calls.length, 2);
    const final = callAt(calls, 1);
    assertEquals(final.executable, "sudo");
    const target = final.options.env?.CARGO_TARGET_DIR;
    assertEquals(
      target,
      cargoTargetDirForCheckout(cwd, {
        root: `${cwd}/.vibe-cargo-target`,
        account: "agent",
      }),
    );
    assert(final.args.includes(`CARGO_TARGET_DIR=${target}`));
    assertEquals(final.options.env?.GH_TOKEN, undefined);
    assert(!lines.some((line) => line.includes("[SECURITY]")));
    // Repeated gates reuse the same account-specific cache, with no cleanup.
    const again = recordingSpawn({ ok: true, value: { ...OK, code: 2 } });
    await runRepositoryCommand("cargo", ["check"], { cwd, timeoutMs: 1000 }, {
      spawn: again.spawn,
      drop: agentDrop,
      source: SOURCE,
      trimRefused: false,
    });
    assertEquals(callAt(again.calls, 1).options.env?.CARGO_TARGET_DIR, target);
  });
});

Deno.test("access probes distinguish unreadable checkouts from tree-controlled targets (Issue #4659)", async () => {
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

/** The command the credential tests name. Its text is what the spawns record. */
const CHANNEL_SCRIPT = 'printf "%s|%s" "$NPM_TOKEN" "${GH_TOKEN-unset}"';

/**
 * Decode a credential channel payload (Issue #4705): a count line, then one
 * `NAME=base64` line per credential.
 */
function decodeChannel(stdin: string): Record<string, string> {
  const [countLine = "", ...rest] = stdin.split("\n");
  const lines = rest.filter((line) => line.length > 0);
  assertEquals(Number(countLine), lines.length);
  const decoded: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf("=");
    const bytes = Uint8Array.from(
      atob(line.slice(at + 1)),
      (char) => char.charCodeAt(0),
    );
    decoded[line.slice(0, at)] = new TextDecoder().decode(bytes);
  }
  return decoded;
}

/** A spawn that records each call. The probe succeeds; the command answers `answer`. */
function spawnAnsweringCommand(answer: Spawned) {
  const calls: Call[] = [];
  const spawn: typeof runWithTimeout = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    return calls.length === 1 ? { ok: true, value: OK } : answer;
  };
  return { calls, spawn };
}

/** Run {@link CHANNEL_SCRIPT} as `agent` through the recording `spawn`. */
function runChannelCommand(
  cwd: string,
  spawn: typeof runWithTimeout,
  credentials: Record<string, string>,
) {
  return runRepositoryCommand(
    "/bin/sh",
    ["-c", CHANNEL_SCRIPT],
    { cwd, timeoutMs: 1000 },
    {
      spawn,
      drop: agentDrop,
      source: SOURCE,
      trimRefused: false,
      credentials: async () => credentials,
    },
  );
}

Deno.test("declared credentials cross sudo on the stdin channel and the account stays agent (Issue #4705)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    const { result, lines } = await captureConsoleError(() =>
      runChannelCommand(cwd, spawn, { NPM_TOKEN: "declared" })
    );
    assert(result.ok);
    assertEquals(calls.length, 2);
    const final = callAt(calls, 1);
    assertEquals(final.executable, "sudo");
    assertEquals(
      untrustedAccountOf([final.executable, ...final.args]),
      "agent",
    );
    assertEquals(final.args.slice(0, 4), ["-n", "-u", "agent", "--"]);
    assertEquals(final.args.slice(4, 6), ["sh", "-c"]);
    assert(!final.args.join(" ").includes("declared"));
    assertEquals(final.options.clearEnv, true);
    assertEquals(final.options.env?.GH_TOKEN, undefined);
    const stdin = final.options.stdin;
    assert(stdin !== undefined);
    assertEquals(decodeChannel(stdin), { NPM_TOKEN: "declared" });
    assertEquals(lines.filter((line) => line.includes("[SECURITY]")), []);
  });
});

Deno.test("only the declared names are carried, never an ambient credential (Issue #4705)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    // SOURCE holds GH_TOKEN and ANTHROPIC_API_KEY, which nothing declared.
    await runChannelCommand(cwd, spawn, {
      NPM_TOKEN: "npm-4705",
      REGISTRY_TOKEN: "registry-4705",
    });
    const final = callAt(calls, 1);
    const stdin = final.options.stdin;
    assert(stdin !== undefined);
    assertEquals(
      decodeChannel(stdin),
      { NPM_TOKEN: "npm-4705", REGISTRY_TOKEN: "registry-4705" },
    );
    assertEquals(final.options.env?.GH_TOKEN, undefined);
    assertEquals(final.options.env?.ANTHROPIC_API_KEY, undefined);
  });
});

Deno.test("a wrapper fault leaves the command to CI and names the fault, never the value (Issue #4705)", async () => {
  await withCheckout(async (cwd) => {
    const { spawn } = spawnAnsweringCommand({
      ok: true,
      value: {
        ...OK,
        success: false,
        code: 78,
        stderr: "[vibe-credential-channel] undecodable credential NPM_TOKEN\n",
      },
    });
    const result = await runChannelCommand(cwd, spawn, {
      NPM_TOKEN: "declared-4705-value",
    });
    assert(!result.ok);
    assert(result.error instanceof GateAccountUnavailable);
    assert(
      result.error.message.includes(
        "[vibe-credential-channel] undecodable credential NPM_TOKEN",
      ),
    );
    assert(result.error.message.includes("Issue #4705"));
    assert(!result.error.message.includes("declared-4705-value"));
  });
});

Deno.test("exit 78 without the channel marker is an ordinary result (Issue #4705)", async () => {
  await withCheckout(async (cwd) => {
    const { spawn } = spawnAnsweringCommand({
      ok: true,
      value: {
        ...OK,
        success: false,
        code: 78,
        stderr: "the command's own failure\n",
      },
    });
    const result = await runChannelCommand(cwd, spawn, {
      NPM_TOKEN: "declared-4705-value",
    });
    assert(result.ok);
    assertEquals(result.value.code, 78);
  });
});

Deno.test("the channel marker with no declared credentials is the command's own result, not a fault (Issue #4705)", async () => {
  await withCheckout(async (cwd) => {
    const { spawn } = spawnAnsweringCommand({
      ok: true,
      value: {
        ...OK,
        success: false,
        code: 78,
        stderr: "[vibe-credential-channel] printed by the command itself\n",
      },
    });
    const result = await runChannelCommand(cwd, spawn, {});
    assert(result.ok);
    assertEquals(result.value.code, 78);
  });
});

Deno.test("an invalid declared name is a configuration fault that names it and stops the command (Issue #4705)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    const result = await runChannelCommand(cwd, spawn, {
      "NPM-TOKEN": "declared-4705-value",
    });
    assert(!result.ok);
    assert(!(result.error instanceof GateAccountUnavailable));
    assert(result.error.message.includes("NPM-TOKEN"));
    assert(!result.error.message.includes("declared-4705-value"));
    assertEquals(
      calls.filter((call) => call.args.includes(CHANNEL_SCRIPT)).length,
      0,
    );
  });
});

Deno.test("no declared credentials means no wrapper and no stdin (Issue #4705)", async () => {
  await withCheckout(async (cwd) => {
    const { calls, spawn } = recordingSpawn();
    const result = await runChannelCommand(cwd, spawn, {});
    assert(result.ok);
    const final = callAt(calls, 1);
    assertEquals(
      final.args,
      [
        "-n",
        "-u",
        "agent",
        "--",
        "env",
        "GIT_CONFIG_COUNT=1",
        "GIT_CONFIG_KEY_0=safe.directory",
        `GIT_CONFIG_VALUE_0=${cwd}`,
        "/bin/sh",
        "-c",
        CHANNEL_SCRIPT,
      ],
    );
    assertEquals(final.options.stdin, undefined);
  });
});

/** Run {@link CHANNEL_SCRIPT} for real as `agent` through the host's sudo. */
async function runAsAgentForReal(credentials: Record<string, string>) {
  const cwd = await makeAgentReachableTempDir("vibe_4705_real_");
  try {
    return await runRepositoryCommand(
      "/bin/sh",
      ["-c", CHANNEL_SCRIPT],
      { cwd, timeoutMs: 20000 },
      {
        drop: (cmd) => Promise.resolve(asUntrustedUser(cmd, { enabled: true })),
        source: { PATH: "/usr/bin:/bin", GH_TOKEN: "ambient-secret" },
        trimRefused: false,
        credentials: async () => credentials,
      },
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
}

Deno.test("a declared credential reaches a real agent command through sudo (Issue #4705)", async () => {
  if (!await canRunAsUntrustedUser()) return;
  const result = await runAsAgentForReal({ NPM_TOKEN: "synthetic-4705" });
  assert(result.ok);
  assertEquals(result.value.code, 0);
  assertEquals(result.value.stdout, "synthetic-4705|unset");
});

Deno.test("with no declared credential a real agent command sees neither (Issue #4705)", async () => {
  if (!await canRunAsUntrustedUser()) return;
  const result = await runAsAgentForReal({});
  assert(result.ok);
  assertEquals(result.value.code, 0);
  assertEquals(result.value.stdout, "|unset");
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

Deno.test("a nested read-only agent checkout without Cargo.lock is left to CI without running as worker", async () => {
  const uid = await new Deno.Command("id", { args: ["-u"] }).output();
  if (new TextDecoder().decode(uid.stdout).trim() === "0") return;
  await withCheckout(async (cwd) => {
    await Deno.mkdir(`${cwd}/nested`);
    const projectDir = `${cwd}/nested`;
    await Deno.writeTextFile(
      `${projectDir}/Cargo.toml`,
      '[package]\nname = "gate_fixture"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await Deno.mkdir(`${projectDir}/src`);
    await Deno.writeTextFile(
      `${projectDir}/src/lib.rs`,
      "pub fn value() -> u8 { 1 }",
    );
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
            await Deno.chmod(projectDir, 0o555);
            try {
              return await runWithTimeout(
                "sh",
                args.slice(args.indexOf("sh") + 1),
                options,
              );
            } finally {
              await Deno.chmod(projectDir, 0o755);
            }
          }
          return await runWithTimeout(executable, args, options);
        },
      });
      if (!result.ok) {
        assert(result.error instanceof GateAccountUnavailable);
        return {
          code: 1,
          output: result.error.message,
          accountUnavailable: result.error.message,
        };
      }
      return {
        code: result.value.code,
        output: result.value.stdout + result.value.stderr,
      };
    }, async () => false);
    assertEquals(outcome.status, "skipped", JSON.stringify(outcome));
    assert(outcome.checkLeftToCi?.includes("probe 3"));
    assertEquals(calls, ["sudo"]);
    await assertRejects(
      () => Deno.stat(`${projectDir}/Cargo.lock`),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("a manifest replaced by another account is refused before any command", async () => {
  await withCheckout(async (cwd) => {
    await Deno.writeTextFile(`${cwd}/deno.json`, "{}");
    const uid = (await Deno.lstat(`${cwd}/deno.json`)).uid;
    assert(uid !== null);
    const { calls, spawn } = recordingSpawn();
    const result = await runRepositoryCommand("deno", ["task", "test"], {
      cwd,
      timeoutMs: 1000,
      manifests: ["deno.json"],
    }, { spawn, drop: agentDrop, workerUid: async () => uid + 1 });
    assertEquals(result.ok, false);
    assert(!result.ok);
    assert(result.error.message.includes("not owned by the worker"));
    assertEquals(calls.length, 0);
  });
});

Deno.test("an unwritable cargo target uses the configured cache root", async () => {
  await withCheckout(async (cwd) => {
    await withCheckout(async (root) => {
      const { calls, spawn } = recordingSpawn({
        ok: true,
        value: { ...OK, code: 2 },
      });
      await runRepositoryCommand("cargo", ["test"], { cwd, timeoutMs: 1000 }, {
        spawn,
        drop: agentDrop,
        source: SOURCE,
        trimRefused: false,
        root,
      });
      const target = callAt(calls, 1).options.env?.CARGO_TARGET_DIR;
      assertEquals(
        target,
        cargoTargetDirForCheckout(cwd, { root, account: "agent" }),
      );
      assert(target?.startsWith(root + "/"));
      assertEquals(calls.length, 2);
    });
  });
});

Deno.test("the probe names the topmost directory the account cannot traverse (Issue #4733)", async () => {
  const uid = await new Deno.Command("id", { args: ["-u"] }).output();
  if (new TextDecoder().decode(uid.stdout).trim() === "0") return;
  await withCheckout(async (cwd) => {
    const outer = `${cwd}/outer`;
    const inner = `${outer}/inner`;
    await Deno.mkdir(inner, { recursive: true });
    await Deno.writeTextFile(`${inner}/Cargo.toml`, "[package]");
    // bash has no target probe, so the script is the walk and the readability checks.
    const { calls, spawn } = recordingSpawn();
    await runRepositoryCommand("bash", ["run"], {
      cwd: inner,
      timeoutMs: 1000,
      manifests: ["Cargo.toml"],
    }, { spawn, drop: agentDrop, source: SOURCE, trimRefused: false });
    const script = probeScriptOf(callAt(calls, 0));
    const probeRun = async () => {
      const out = await new Deno.Command("sh", {
        args: ["-c", script, "sh", inner],
      }).output();
      return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
    };
    const open = await probeRun();
    assertEquals(open.code, 0);
    assertEquals(open.stdout, "");
    await Deno.chmod(outer, 0o000);
    try {
      const blocked = await probeRun();
      assertEquals(blocked.code, 1);
      // The topmost blocked directory, not the inner one that also fails.
      assertEquals(blocked.stdout.trim(), outer);
    } finally {
      await Deno.chmod(outer, 0o755);
    }
  });
});

Deno.test("an unreadable probe names the blocked directory only for one plausible path (Issue #4733)", async () => {
  await withCheckout(async (cwd) => {
    const refusalFor = async (verdict: Spawned): Promise<string> => {
      const { spawn } = recordingSpawn(verdict);
      const { result } = await captureConsoleError(() =>
        runRepositoryCommand(
          "cargo",
          ["test"],
          { cwd, timeoutMs: 1000, manifests: ["Cargo.toml"] },
          { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
        )
      );
      assertEquals(result.ok, false);
      assert(!result.ok);
      assert(result.error instanceof GateAccountUnavailable);
      return result.error.message;
    };
    const unreadable = (stdout: string): Spawned => ({
      ok: true,
      value: { ...OK, success: false, code: 1, stdout },
    });

    const named = await refusalFor(unreadable("/blocked/dir\n"));
    assert(named.includes(`untrusted account cannot use '${cwd}'`));
    assert(named.includes(`(probe 1; cannot traverse '/blocked/dir')`));

    const silent = await refusalFor(unreadable(""));
    assert(silent.includes("(probe 1)"), silent);
    assert(!silent.includes("cannot traverse"), silent);

    for (
      const stdout of ["not a path\n", "/x\u0007y\n", `/${"a".repeat(300)}\n`]
    ) {
      const message = await refusalFor(unreadable(stdout));
      assert(message.includes("(probe 1)"), message);
      assert(!message.includes("cannot traverse"), message);
    }

    // Only the unreadable verdict names a directory; an unwritable checkout does not.
    const unwritable = await refusalFor({
      ok: true,
      value: { ...OK, success: false, code: 3, stdout: "/blocked/dir\n" },
    });
    assert(unwritable.includes("(probe 3)"), unwritable);
    assert(!unwritable.includes("cannot traverse"), unwritable);
  });
});

Deno.test("a read-only checkout drops only the exit-3 write check, never the cargo target check (Issue #4782)", async () => {
  await withCheckout(async (cwd) => {
    const probeFor = async (
      executable: string,
      options: { readOnlyCheckout?: boolean },
    ): Promise<string> => {
      const { calls, spawn } = recordingSpawn();
      await runRepositoryCommand(
        executable,
        ["run"],
        {
          cwd,
          timeoutMs: 1000,
          manifests: [executable === "cargo" ? "Cargo.toml" : "deno.json"],
          ...options,
        },
        { spawn, drop: agentDrop, source: SOURCE, trimRefused: false },
      );
      return probeScriptOf(callAt(calls, 0));
    };

    const deno = await probeFor("deno", { readOnlyCheckout: true });
    assert(!deno.includes("test -w"), deno);
    assert(!deno.includes("exit 3"), deno);
    // Control: the same call without the option keeps the write check.
    const denoControl = await probeFor("deno", {});
    assert(denoControl.includes(`test -w "$1" || exit 3`), denoControl);

    // Cargo still probes its target (no target is named, so the checkout must
    // be writable for cargo to create one); only the exit-3 check is dropped.
    const cargo = await probeFor("cargo", { readOnlyCheckout: true });
    assert(cargo.includes(`test -w "$1" || exit 2`), cargo);
    assert(!cargo.includes("exit 3"), cargo);
  });
});

Deno.test("real probe for a read-only checkout passes a 0555 deno project only with the option (Issue #4782)", async () => {
  const uid = await new Deno.Command("id", { args: ["-u"] }).output();
  if (new TextDecoder().decode(uid.stdout).trim() === "0") return;
  await withCheckout(async (cwd) => {
    await Deno.writeTextFile(`${cwd}/deno.json`, "{}");
    const code = async (
      options: { readOnlyCheckout?: boolean } = {},
    ): Promise<number | undefined> => {
      const { calls, spawn } = recordingSpawn();
      await runRepositoryCommand("deno", ["check"], {
        cwd,
        timeoutMs: 1000,
        manifests: ["deno.json"],
        ...options,
      }, { spawn, drop: agentDrop, source: SOURCE, trimRefused: false });
      return (await new Deno.Command("sh", {
        args: ["-c", probeScriptOf(callAt(calls, 0)), "sh", cwd],
      }).output()).code;
    };
    await Deno.chmod(cwd, 0o555);
    try {
      assertEquals(await code({ readOnlyCheckout: true }), 0);
      assertEquals(await code(), 3);
    } finally {
      await Deno.chmod(cwd, 0o755);
    }
  });
});

Deno.test("a worker-owned sub-directory Deno project at 0755 is not left to CI for a read-only check (Issue #4782)", async () => {
  if (!await canRunAsUntrustedUser()) return;
  // Under /tmp, not TMPDIR: the runner's TMPDIR is 0700 and `agent` cannot
  // traverse it.
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "vibe_4782_" });
  try {
    await Deno.chmod(root, 0o755);
    const sub = `${root}/sub`;
    await Deno.mkdir(sub, { mode: 0o755 });
    await Deno.chmod(sub, 0o755);
    await Deno.writeTextFile(`${sub}/deno.json`, "{}");
    await Deno.chmod(`${sub}/deno.json`, 0o644);
    const run = (options: { readOnlyCheckout?: boolean } = {}) =>
      runRepositoryCommand("/bin/sh", ["-c", "exit 0"], {
        cwd: sub,
        timeoutMs: 20000,
        manifests: ["deno.json"],
        ...options,
      }, {
        drop: (cmd) => Promise.resolve(asUntrustedUser(cmd, { enabled: true })),
        source: { PATH: "/usr/bin:/bin" },
        trimRefused: false,
        credentials: async () => ({}),
      });

    const checked = await run({ readOnlyCheckout: true });
    assert(checked.ok, checked.ok ? "" : checked.error.message);
    assertEquals(checked.value.code, 0);

    const left = await run();
    assert(!left.ok);
    assert(left.error instanceof GateAccountUnavailable, left.error.message);
    assert(left.error.message.includes("probe 3"), left.error.message);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
