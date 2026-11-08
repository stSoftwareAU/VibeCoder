/**
 * The babysitter's cargo-deny runner (PR #4895 review, C36). The runner must
 * only run `cargo deny`, only under `codex sandbox` with the repair agent's
 * permissions profile, and only tools found outside the clone.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  babysitterCargoDenyRunner,
  buildSandboxedArgv,
  type SandboxedCargoDenyOptions,
  sandboxedCargoDenyRunner,
} from "../lib/fleet_babysitter_cargo_deny_sandbox.ts";
import {
  type PreFlightCommandResult,
  type PreFlightRunOptions,
  tokeniseCommand,
} from "../lib/pre_flight_gate.ts";

const DIR = "/work/clone";
const SCRATCH = "/work/scratch";
const KEY = "/home/u/.vibe-coder/fleet-pr-babysitter/app.pem";
const OK: PreFlightCommandResult = {
  started: true,
  code: 0,
  stdout: "",
  stderr: "",
};

function options(
  overrides: Partial<SandboxedCargoDenyOptions> = {},
): SandboxedCargoDenyOptions {
  return {
    codex: "/opt/codex/codex",
    dir: DIR,
    scratch: SCRATCH,
    protectedPaths: [KEY],
    home: "/home/u",
    os: "darwin",
    pathVariable: "relative/bin:/usr/bin",
    toolchain: "stable",
    isExecutable: (path) =>
      Promise.resolve(
        path === "/usr/bin/cargo-deny" || path === "/usr/bin/cargo",
      ),
    ...overrides,
  };
}

function recorder() {
  const calls: { command: string; options: PreFlightRunOptions }[] = [];
  const inner = (command: string, runOptions: PreFlightRunOptions) => {
    calls.push({ command, options: runOptions });
    return Promise.resolve(OK);
  };
  return { calls, inner };
}

const RUN: PreFlightRunOptions = { cwd: DIR, timeoutSeconds: 60 };

Deno.test("sandbox runner: cargo deny runs under codex sandbox with the repair profile", async () => {
  const { calls, inner } = recorder();
  const runner = sandboxedCargoDenyRunner(options({ inner }));
  const result = await runner("'cargo' 'deny' '--all-features' 'check'", RUN);
  assertEquals(result, OK);
  assertEquals(calls.length, 1);
  const argv = tokeniseCommand(calls[0]!.command);
  assertEquals(argv[0], "/opt/codex/codex");
  assertEquals(argv.slice(-7), [
    "sandbox",
    "macos",
    "--",
    "/usr/bin/cargo-deny",
    "deny",
    "--all-features",
    "check",
  ]);
  // The profile denies the protected path, as it does for the Codex agent.
  assert(argv.some((arg) => arg.includes(`${JSON.stringify(KEY)} = "none"`)));
  assertEquals(calls[0]!.options.cwd, DIR);
  const env = calls[0]!.options.env ?? {};
  assertEquals(env.CARGO, "/usr/bin/cargo");
  assertEquals(env.CARGO_HOME, `${SCRATCH}/cargo-home`);
  assertEquals(env.RUSTUP_TOOLCHAIN, "stable");
  assertEquals(env.RUSTC_WRAPPER, "");
});

Deno.test("sandbox runner: Linux uses the linux sandbox", async () => {
  const { calls, inner } = recorder();
  await sandboxedCargoDenyRunner(options({ inner, os: "linux" }))(
    "'cargo' 'deny' 'check'",
    RUN,
  );
  assertStringIncludes(calls[0]!.command, "'sandbox' 'linux' '--'");
});

Deno.test("sandbox runner: it refuses to run anything but cargo deny", async () => {
  const { calls, inner } = recorder();
  const runner = sandboxedCargoDenyRunner(options({ inner }));
  for (const command of ["'cargo' 'build'", "'sh' '-c' 'id'", ""]) {
    const result = await runner(command, RUN);
    assertEquals(result.started, false, command);
    assertStringIncludes(result.stderr, "only cargo deny runs there");
  }
  assertEquals(calls, []);
});

Deno.test("sandbox runner: a host with no codex sandbox does not run the check", async () => {
  const { calls, inner } = recorder();
  const result = await sandboxedCargoDenyRunner(
    options({ inner, os: "windows" }),
  )("'cargo' 'deny' 'check'", RUN);
  assertEquals(result.started, false);
  assertStringIncludes(result.stderr, "no support for windows");
  assertEquals(calls, []);
});

Deno.test("sandbox runner: a working directory outside the clone is refused", async () => {
  const { calls, inner } = recorder();
  const runner = sandboxedCargoDenyRunner(options({ inner }));
  for (const cwd of ["/work/clone-evil", "/etc", `${SCRATCH}/x`]) {
    const result = await runner("'cargo' 'deny' 'check'", { ...RUN, cwd });
    assertEquals(result.started, false, cwd);
    assertStringIncludes(result.stderr, "outside the clone");
  }
  // The same command in a sub-directory of the clone is accepted.
  const ok = await runner("'cargo' 'deny' 'check'", {
    ...RUN,
    cwd: `${DIR}/crates/a`,
  });
  assertEquals(ok, OK);
  assertEquals(calls.length, 1);
});

Deno.test("sandbox runner: tools found in the clone, scratch or a relative PATH entry are not used", async () => {
  const { calls, inner } = recorder();
  const planted = new Set([
    `${DIR}/bin/cargo-deny`,
    `${DIR}/bin/cargo`,
    `${SCRATCH}/cargo-deny`,
    "relative/bin/cargo-deny",
    "relative/bin/cargo",
  ]);
  const result = await sandboxedCargoDenyRunner(options({
    inner,
    pathVariable: `${DIR}/bin:${SCRATCH}:relative/bin:`,
    isExecutable: (path) => Promise.resolve(planted.has(path)),
  }))("'cargo' 'deny' 'check'", RUN);
  assertEquals(result.started, false);
  assertStringIncludes(result.stderr, "not found outside the clone");
  assertEquals(calls, []);
});

Deno.test("sandbox runner: a toolchain that cannot be pinned does not run the check", async () => {
  const { calls, inner } = recorder();
  const result = await sandboxedCargoDenyRunner(options({
    inner,
    toolchain: undefined,
    activeToolchain: () => Promise.reject(new Error("rustup exploded")),
  }))("'cargo' 'deny' 'check'", RUN);
  assertEquals(result.started, false);
  assertStringIncludes(result.stderr, "rustup exploded");
  assertEquals(calls, []);
  // Without rustup there is no toolchain to pin, so none is set.
  const none = recorder();
  await sandboxedCargoDenyRunner(options({
    inner: none.inner,
    toolchain: undefined,
    activeToolchain: () => Promise.resolve(undefined),
  }))("'cargo' 'deny' 'check'", RUN);
  assertEquals("RUSTUP_TOOLCHAIN" in (none.calls[0]!.options.env ?? {}), false);
});

Deno.test("sandbox argv: the clone may not sit inside a protected path", () => {
  let message = "";
  try {
    buildSandboxedArgv(
      { codex: "codex", dir: DIR, scratch: SCRATCH, protectedPaths: ["/work"] },
      "linux",
      ["cargo-deny"],
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "is inside protected path");
});

Deno.test("production runner: sets the sandbox up lazily and passes the profile to a real process", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-deny-sandbox-" });
  try {
    const home = await Deno.realPath(root);
    const dir = `${home}/clone`;
    const scratch = `${home}/scratch`;
    const bin = `${home}/.cargo/bin`;
    await Deno.mkdir(dir);
    await Deno.mkdir(scratch);
    await Deno.mkdir(bin, { recursive: true });
    for (const tool of ["cargo", "cargo-deny"]) {
      await Deno.writeTextFile(`${bin}/${tool}`, "#!/bin/sh\n");
      await Deno.chmod(`${bin}/${tool}`, 0o755);
    }
    // A stand-in `codex` that prints how it was called.
    const codex = `${home}/codex`;
    await Deno.writeTextFile(
      codex,
      '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\nprintf "CARGO_HOME=%s\\n" "$CARGO_HOME"\n',
    );
    await Deno.chmod(codex, 0o755);
    const key = `${home}/.vibe-coder/fleet-pr-babysitter/app.pem`;
    let resolved = 0;
    const runner = babysitterCargoDenyRunner({
      privateKeyPath: key,
      home,
      configPath: `${home}/missing-config.json`,
      dir,
      scratch,
      resolveCodex: () => {
        resolved++;
        return Promise.resolve(codex);
      },
      env: (name) => name === "RUSTUP_TOOLCHAIN" ? "stable" : undefined,
    });
    assertEquals(resolved, 0, "nothing is set up before the first run");
    const result = await runner("'cargo' 'deny' 'check'", {
      cwd: dir,
      timeoutSeconds: 30,
    });
    assertEquals(result.code, 0, result.stderr);
    const lines = result.stdout.split("\n");
    assert(lines.includes("sandbox"), result.stdout);
    assert(lines.includes(`${bin}/cargo-deny`), result.stdout);
    assert(
      lines.some((line) => line.includes(`${JSON.stringify(key)} = "none"`)),
      "the App key must be denied in the profile",
    );
    assert(lines.includes(`CARGO_HOME=${scratch}/cargo-home`), result.stdout);
    await runner("'cargo' 'deny' 'check'", { cwd: dir, timeoutSeconds: 30 });
    assertEquals(resolved, 1, "the sandbox is set up once");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("production runner: a sandbox that cannot be set up does not run the check", async () => {
  const result = await babysitterCargoDenyRunner({
    privateKeyPath: "/home/u/.vibe-coder/fleet-pr-babysitter/app.pem",
    home: "/home/u",
    configPath: "/nonexistent/config.json",
    dir: DIR,
    scratch: SCRATCH,
    resolveCodex: () => Promise.reject(new Error("no pinned codex for host")),
  })("'cargo' 'deny' 'check'", RUN);
  assertEquals(result.started, false);
  assertStringIncludes(result.stderr, "no pinned codex for host");
});
