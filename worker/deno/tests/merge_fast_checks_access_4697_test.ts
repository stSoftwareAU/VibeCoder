/**
 * Tests for the access probe of the merge fast checks (Issue #4697).
 *
 * A merge check runs through runRepositoryCommand, which probes whether the
 * `agent` account can reach the checkout before the command runs. A probe that
 * fails leaves the merge unverified, so the push is deferred with no repair
 * round spent on it. A manifest the worker can see is genuinely absent is a
 * failing check, which a repair round can answer.
 *
 * The toolchain is an injected fake, except in the last test, which runs the
 * real `sudo` path where this host has it. Every checkout is a temporary
 * directory made by Deno.makeTempDir. No test mutates the process environment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { Logger } from "../types.ts";
import {
  type FastCheck,
  fastCheckCargoRoot,
  type FastCheckGit,
  runMergeFastChecks,
  spawnFastCheck,
  type VerifyBeforePushOptions,
  verifyMergeBeforePush,
} from "../lib/merge_fast_checks.ts";
import {
  GateAccountUnavailable,
  runRepositoryCommand,
} from "../lib/untrusted_gate_spawn.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";
import { SCRATCH_TMPFS_MOUNTS } from "../lib/container_launch.ts";
import { EPHEMERAL_CARGO_TARGET_ROOT } from "../lib/ephemeral_build_cache.ts";
import {
  asUntrustedUser,
  canRunAsUntrustedUser,
} from "../lib/untrusted_command_env.ts";

const CARGO_MANIFEST = '[package]\nname = "crate"\nversion = "0.1.0"\n';

/** What a fake spawn answers: an exit code and the output it prints. */
interface Answer {
  code: number;
  stdout?: string;
  stderr?: string;
}

/** One spawn call, as the production spawn would have been given it. */
interface SpawnCall {
  executable: string;
  args: string[];
  options: Parameters<typeof runWithTimeout>[2];
}

/**
 * Whether a spawn call is the access probe runRepositoryCommand runs before a
 * command (Issue #4697): `sh -c <probe> sh <cwd>` behind the sudo drop. The
 * credential wrapper names its `$0` vibe-credential-channel instead.
 */
function isProbeCall(args: string[]): boolean {
  return args[5] === "-c" && args[7] === "sh";
}

/** The drop the production path takes: the account is `agent` via sudo. */
function sudoAgent(cmd: readonly string[]): Promise<string[]> {
  return Promise.resolve(["sudo", "-n", "-u", "agent", "--", ...cmd]);
}

/**
 * A fake spawn. The probe answers `probe`; every other call, the command,
 * answers `command`. `calls` records every call and `commands` only commands.
 */
function fakeSpawn(probe: Answer, command: Answer = { code: 0 }) {
  const calls: SpawnCall[] = [];
  const commands: SpawnCall[] = [];
  const spawn: typeof runWithTimeout = (executable, args, options) => {
    const call = { executable, args: [...args], options };
    calls.push(call);
    const probing = isProbeCall(args);
    if (!probing) commands.push(call);
    const answer = probing ? probe : command;
    return Promise.resolve({
      ok: true,
      value: {
        code: answer.code,
        stdout: answer.stdout ?? "",
        stderr: answer.stderr ?? "",
        success: answer.code === 0,
        timedOut: false,
      },
    });
  };
  return { spawn, calls, commands };
}

/** Run `body` in a fresh temporary checkout holding `files`, removed after. */
async function withCheckout<T>(
  files: Record<string, string>,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "issue-4697-" });
  try {
    for (const [name, contents] of Object.entries(files)) {
      await Deno.writeTextFile(`${dir}/${name}`, contents);
    }
    return await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** A Deno lint check in `dir`, with the budget a real run gets. */
function lintCheck(dir: string): FastCheck {
  return {
    dir,
    kind: "deno",
    label: `deno lint in ${dir}`,
    args: ["lint"],
    timeoutMs: 1000,
  };
}

/** A cargo fmt check in `dir`, with the budget a real run gets. */
function cargoCheck(dir: string): FastCheck {
  return {
    dir,
    kind: "cargo",
    label: `cargo fmt in ${dir}`,
    args: ["fmt", "--all", "--", "--check"],
    timeoutMs: 1000,
  };
}

/** A fake git that lists one touched path and has no staged merge or log. */
const gitListing: FastCheckGit = (args) =>
  Promise.resolve(
    args[0] === "diff"
      ? { code: 0, stdout: "src/main.rs\0", stderr: "" }
      : { code: 1, stdout: "", stderr: "" },
  );

/** A logger that drops everything. */
function silentLogger(): Logger {
  const drop = () => {};
  return {
    info: drop,
    warn: drop,
    error: drop,
    debug: drop,
    security: drop,
    skipReason: drop,
    timing: drop,
    scanSummary: drop,
    workerSummary: drop,
  };
}

Deno.test("spawnFastCheck: an account that cannot traverse to the checkout is refused, naming the blocked directory, and the command never runs (Issue #4697)", async () => {
  await withCheckout({}, async (dir) => {
    const { spawn, commands } = fakeSpawn({ code: 1, stdout: "/home/vibe\n" });
    const error = await assertRejects(
      () => spawnFastCheck(lintCheck(dir), {}, spawn, sudoAgent),
      GateAccountUnavailable,
      "cannot traverse '/home/vibe'",
    );
    assertStringIncludes(error.message, "/home/vibe");
    assertEquals(commands.length, 0);
  });
});

Deno.test("merge checks: an unreachable checkout leaves the merge unverified, and the push is deferred with no repair round (Issue #4697)", async () => {
  await withCheckout({ "Cargo.toml": CARGO_MANIFEST }, async (dir) => {
    const { spawn, commands } = fakeSpawn({ code: 1, stdout: "/home/vibe\n" });
    const runner = (check: FastCheck) =>
      spawnFastCheck(check, {}, spawn, sudoAgent);

    const outcome = await runMergeFastChecks(dir, ["src/main.rs"], runner);
    assert(outcome.status === "unverified");
    assertStringIncludes(outcome.detail, "could not be run");
    assertStringIncludes(outcome.output, "/home/vibe");
    assertEquals(commands.length, 0);

    let repairs = 0;
    const options: VerifyBeforePushOptions = {
      repoDir: dir,
      headBeforeMerge: "abc123",
      baseBranch: "main",
      git: gitListing,
      park: () => Promise.resolve(null),
      runChecks: (repoDir, touched) =>
        runMergeFastChecks(repoDir, touched, runner),
      runRepairAgent: () => {
        repairs++;
        return Promise.resolve({ ok: true, value: { terminated: false } });
      },
      logger: silentLogger(),
    };
    const verdict = await verifyMergeBeforePush(options);
    assert(verdict.kind === "deferred");
    assertStringIncludes(verdict.detail, "/home/vibe");
    assertEquals(repairs, 0);
    assertEquals(commands.length, 0);
  });
});

Deno.test("merge checks: a manifest the worker sees is absent is a failing check, not an unverified one (Issue #4697)", async () => {
  await withCheckout({}, async (dir) => {
    const { spawn, commands } = fakeSpawn({ code: 1 });
    const result = await spawnFastCheck(cargoCheck(dir), {}, spawn, sudoAgent);
    assertEquals(result, {
      code: 1,
      output: `Cargo.toml is missing from ${dir} in the merged tree`,
    });
    assertEquals(commands.length, 0);
  });
});

Deno.test("merge checks: a manifest that is present, with the probe failing, is an access fault that refuses the check (Issue #4697)", async () => {
  await withCheckout({ "Cargo.toml": CARGO_MANIFEST }, async (dir) => {
    const { spawn, commands } = fakeSpawn({ code: 1 });
    await assertRejects(
      () => spawnFastCheck(cargoCheck(dir), {}, spawn, sudoAgent),
      GateAccountUnavailable,
      "untrusted account cannot use",
    );
    assertEquals(commands.length, 0);
  });
});

Deno.test("merge checks: a probe that passes, then a command that cannot find Cargo.toml, is a failed check (Issue #4697)", async () => {
  await withCheckout({ "Cargo.toml": CARGO_MANIFEST }, async (dir) => {
    const message =
      "error: could not find `Cargo.toml` in `/x` or any parent directory";
    const { spawn, commands } = fakeSpawn({ code: 0 }, {
      code: 101,
      stderr: message,
    });
    const outcome = await runMergeFastChecks(
      dir,
      ["src/main.rs"],
      (check) => spawnFastCheck(check, {}, spawn, sudoAgent),
    );
    assert(outcome.status === "failed");
    assertStringIncludes(outcome.output, message);
    assertEquals(commands.length, 1);
  });
});

Deno.test("merge checks: a cargo target the account cannot write is built in a private target (Issue #4697)", async () => {
  await withCheckout({ "Cargo.toml": CARGO_MANIFEST }, async (dir) => {
    const project = `${dir}/nested`;
    await Deno.mkdir(project);
    await Deno.writeTextFile(`${project}/Cargo.toml`, CARGO_MANIFEST);
    const { spawn, commands } = fakeSpawn({ code: 2 }, { code: 0 });
    const result = await spawnFastCheck(
      cargoCheck(project),
      {},
      spawn,
      sudoAgent,
      { source: { PATH: Deno.env.get("PATH") ?? "" }, trimRefused: false },
      dir,
    );
    assertEquals(result.code, 0);
    assertEquals(commands.length, 1);
    const rootInfo = await Deno.lstat(fastCheckCargoRoot(dir));
    assert(rootInfo.isDirectory);
    assertEquals(rootInfo.mode! & 0o7777, 0o1777);
    const target = commands[0]!.options?.env?.["CARGO_TARGET_DIR"];
    assert(target !== undefined, "the command runs with a CARGO_TARGET_DIR");
    assert(!target.startsWith(`${project}/`));
    // The sub-directory project is not writable (Issue #4782).
    assert(
      target.startsWith(`${fastCheckCargoRoot(dir)}/`),
      `target ${target} is under the clone root`,
    );
  });
});

Deno.test("merge checks: trim refusal retains the ephemeral cargo target", async () => {
  await withCheckout({ "Cargo.toml": CARGO_MANIFEST }, async (dir) => {
    const { spawn, commands } = fakeSpawn({ code: 0 });
    await spawnFastCheck(cargoCheck(dir), {}, spawn, sudoAgent, {
      source: { PATH: Deno.env.get("PATH") ?? "" },
      trimRefused: true,
    }, dir);
    const target = commands[0]!.options?.env?.["CARGO_TARGET_DIR"];
    assert(
      target?.startsWith(`${EPHEMERAL_CARGO_TARGET_ROOT}/`),
      String(target),
    );
  });
});

Deno.test("merge checks: a non-directory private target defers the check", async () => {
  await withCheckout({ "Cargo.toml": CARGO_MANIFEST }, async (dir) => {
    await Deno.writeTextFile(fastCheckCargoRoot(dir), "not a directory");
    const { spawn, commands } = fakeSpawn({ code: 2 });
    await assertRejects(
      () =>
        spawnFastCheck(cargoCheck(dir), {}, spawn, sudoAgent, {
          source: { PATH: Deno.env.get("PATH") ?? "" },
          trimRefused: false,
        }, dir),
      GateAccountUnavailable,
      "cannot provision private cargo target",
    );
    assertEquals(commands.length, 0);
  });
});

Deno.test("merge checks: an unprovisionable private target defers the check", async () => {
  await withCheckout({ "Cargo.toml": CARGO_MANIFEST }, async (dir) => {
    const { spawn, commands } = fakeSpawn({ code: 2 });
    await Deno.chmod(dir, 0o555);
    try {
      await assertRejects(
        () =>
          spawnFastCheck(cargoCheck(dir), {}, spawn, sudoAgent, {
            source: { PATH: Deno.env.get("PATH") ?? "" },
            trimRefused: false,
          }, dir),
        GateAccountUnavailable,
        "cannot provision private cargo target",
      );
      assertEquals(commands.length, 0);
    } finally {
      await Deno.chmod(dir, 0o700);
    }
  });
});

Deno.test("merge checks: a private target owned by another uid is refused", async () => {
  await withCheckout({}, async (dir) => {
    const root = fastCheckCargoRoot(dir);
    await Deno.mkdir(root, { mode: 0o700 });
    const info = await Deno.lstat(root);
    assert(info.uid !== null);
    const { spawn, commands } = fakeSpawn({ code: 2 });
    const result = await runRepositoryCommand("cargo", ["test"], {
      cwd: dir,
      timeoutMs: 1000,
      requireWritableCheckout: false,
    }, {
      spawn,
      drop: sudoAgent,
      privateTargetRoot: root,
      workerUid: () => Promise.resolve(info.uid! + 1),
      source: { PATH: Deno.env.get("PATH") ?? "" },
      trimRefused: false,
    });
    assert(!result.ok);
    assert(result.error instanceof GateAccountUnavailable);
    assertEquals((await Deno.lstat(root)).mode! & 0o7777, 0o700);
    assertEquals(commands.length, 0);
  });
});

Deno.test("merge checks: a symlinked private target is refused", async () => {
  await withCheckout({ "Cargo.toml": CARGO_MANIFEST }, async (dir) => {
    const destination = `${dir}/destination`;
    await Deno.mkdir(destination, { mode: 0o700 });
    await Deno.symlink(destination, fastCheckCargoRoot(dir));
    const { spawn, commands } = fakeSpawn({ code: 2 });
    await assertRejects(
      () =>
        spawnFastCheck(
          cargoCheck(dir),
          {},
          spawn,
          sudoAgent,
          { source: { PATH: Deno.env.get("PATH") ?? "" }, trimRefused: false },
          dir,
        ),
      GateAccountUnavailable,
    );
    assertEquals((await Deno.stat(destination)).mode! & 0o777, 0o700);
    assertEquals(commands.length, 0);
  });
});

Deno.test("real sudo: a checkout the agent can reach runs its command, and one it cannot traverse is refused before any command runs (Issue #4697)", async () => {
  // Skipped where this host cannot drop to the agent account.
  if (!await canRunAsUntrustedUser()) return;
  // Under /tmp, not TMPDIR: a run's TMPDIR can itself be mode 0700 (the
  // mutation runner's is), and the account could then reach neither directory.
  const readable = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "issue-4697-readable-",
  });
  const blocked = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "issue-4697-blocked-",
  });
  try {
    // The account must be able to write the checkout and read its manifest.
    await Deno.chmod(readable, 0o777);
    await Deno.writeTextFile(`${readable}/deno.json`, "{}");
    // Nothing but the worker can traverse this directory.
    await Deno.chmod(blocked, 0o700);
    const drop = (cmd: readonly string[]) =>
      Promise.resolve(asUntrustedUser(cmd, { enabled: true }));
    const evalArgs = ["eval", "--no-config", "console.log('ok')"];

    const reachable = await spawnFastCheck(
      {
        dir: readable,
        kind: "deno",
        label: "deno eval",
        args: evalArgs,
        timeoutMs: 20_000,
      },
      {},
      runWithTimeout,
      drop,
    );
    assertEquals(reachable.code, 0);
    assertEquals(reachable.output, "ok");

    const seen: string[][] = [];
    const spy: typeof runWithTimeout = (executable, args, options) => {
      seen.push([executable, ...args]);
      return runWithTimeout(executable, args, options);
    };
    const error = await assertRejects(
      () =>
        spawnFastCheck(
          {
            dir: blocked,
            kind: "deno",
            label: "deno eval",
            args: evalArgs,
            timeoutMs: 20_000,
          },
          {},
          spy,
          drop,
        ),
      GateAccountUnavailable,
      "cannot traverse",
    );
    assertStringIncludes(error.message, blocked.split("/").pop()!);
    // Only the probe ran; the command never reached the spawn.
    assertEquals(seen.length, 1);
    assertEquals(seen[0]!.includes("eval"), false);
  } finally {
    await Deno.remove(readable, { recursive: true });
    await Deno.remove(blocked, { recursive: true });
  }
});

Deno.test("real sudo: a project the agent can read but not write runs its fast check instead of being deferred (Issue #4782)", async () => {
  // Skipped where this host cannot drop to the agent account.
  if (!await canRunAsUntrustedUser()) return;
  // Under /tmp, not TMPDIR (see the test above). The sub-directory is mode 0755
  // and worker-owned, as git creates it under a clone: readable, not writable.
  const clone = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "issue-4782-clone-",
  });
  try {
    await Deno.chmod(clone, 0o755);
    const project = `${clone}/nested`;
    await Deno.mkdir(project, { mode: 0o755 });
    await Deno.chmod(project, 0o755);
    await Deno.writeTextFile(`${project}/deno.json`, "{}");
    await Deno.chmod(`${project}/deno.json`, 0o644);
    const drop = (cmd: readonly string[]) =>
      Promise.resolve(asUntrustedUser(cmd, { enabled: true }));
    const result = await spawnFastCheck(
      {
        dir: project,
        kind: "deno",
        label: "deno eval",
        args: ["eval", "--no-config", "console.log('ran')"],
        timeoutMs: 20_000,
      },
      {},
      runWithTimeout,
      drop,
    );
    assertEquals(result.code, 0);
    assertEquals(result.output, "ran");
  } finally {
    await Deno.remove(clone, { recursive: true });
  }
});

/** A spawn that really runs the probe script as this account, and fakes the command. */
function realProbeSpawn() {
  const commands: SpawnCall[] = [];
  const spawn: typeof runWithTimeout = (executable, args, options) => {
    if (isProbeCall(args)) {
      return runWithTimeout("sh", ["-c", args[6]!, "sh", args[8]!], {
        timeoutMs: 5000,
      });
    }
    commands.push({ executable, args: [...args], options });
    return Promise.resolve({
      ok: true,
      value: {
        code: 0,
        stdout: "",
        stderr: "",
        success: true,
        timedOut: false,
      },
    });
  };
  return { spawn, commands };
}

Deno.test("merge checks: the real probe script lets a readable, unwritable sub-directory project run its fast check (Issue #4782)", async () => {
  await withCheckout({ "deno.json": "{}" }, async (dir) => {
    await Deno.chmod(dir, 0o555);
    try {
      // Positive control: with a write requirement the same probe refuses (3).
      const strict = realProbeSpawn();
      const refused = await runRepositoryCommand(
        Deno.execPath(),
        ["lint"],
        { cwd: dir, timeoutMs: 1000, manifests: ["deno.json"] },
        { spawn: strict.spawn, drop: sudoAgent },
      );
      assert(!refused.ok && refused.error instanceof GateAccountUnavailable);
      assertStringIncludes(refused.error.message, "probe 3");
      assertEquals(strict.commands.length, 0);

      const { spawn, commands } = realProbeSpawn();
      const result = await spawnFastCheck(lintCheck(dir), {}, spawn, sudoAgent);
      assertEquals(result.code, 0);
      assertEquals(commands.length, 1);
    } finally {
      await Deno.chmod(dir, 0o755);
    }
  });
});

Deno.test("merge checks: a cargo check in a readable, unwritable sub-directory project gets a private target the account can write (Issue #4782)", async () => {
  // Skipped where this host cannot drop to the agent account.
  if (!await canRunAsUntrustedUser()) return;
  const clone = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "issue-4782-cargo-",
  });
  try {
    await Deno.chmod(clone, 0o755);
    const project = `${clone}/nested`;
    await Deno.mkdir(project, { mode: 0o755 });
    await Deno.chmod(project, 0o755);
    await Deno.writeTextFile(`${project}/Cargo.toml`, CARGO_MANIFEST);
    await Deno.chmod(`${project}/Cargo.toml`, 0o644);
    // `sh` stands in for cargo: it creates the directory CARGO_TARGET_DIR names.
    const drop = (cmd: readonly string[]) =>
      Promise.resolve(asUntrustedUser(
        cmd[0] === "cargo"
          ? ["sh", "-c", 'mkdir -p "$CARGO_TARGET_DIR" && echo built']
          : cmd,
        { enabled: true },
      ));
    const result = await spawnFastCheck(
      {
        dir: project,
        kind: "cargo",
        label: "cargo check",
        args: ["check"],
        timeoutMs: 20_000,
      },
      {},
      runWithTimeout,
      drop,
      // An inherited CARGO_TARGET_DIR, or a launch that refused the trim,
      // would mean no private target is needed at all.
      { source: { PATH: Deno.env.get("PATH") ?? "" }, trimRefused: false },
      clone,
    );
    assertEquals(result.code, 0, result.output);
    assertStringIncludes(result.output, "built");
  } finally {
    await Deno.remove(clone, { recursive: true });
  }
});

Deno.test("merge checks: the private target on the work volume is outside noexec scratch mounts", () => {
  const root = fastCheckCargoRoot("/home/vibe/auto-issue-work/repo");
  for (const mount of SCRATCH_TMPFS_MOUNTS) {
    const [path, options] = mount.split(":");
    if (options?.split(",").includes("noexec")) {
      assert(
        root !== path && !root.startsWith(`${path}/`),
        `${root} is under noexec mount ${path}`,
      );
    }
  }
});
