/**
 * Tests for the declared-credential channel of the merge fast checks (Issue
 * #4705).
 *
 * A repository's declared `quality_credentials` reach the `agent` account on
 * the stdin of a fixed `sh` wrapper, not in argv and not in an environment
 * `sudo` strips. These tests drive {@link spawnFastCheck} itself: the argv,
 * stdin and options it builds are asserted against an injected recording
 * spawn, and one test runs the real `sudo` path where this host has it.
 *
 * No test mutates the process environment: an ambient secret is placed in the
 * environment handed to the spawn, not in the worker's own.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { type FastCheck, spawnFastCheck } from "../lib/merge_fast_checks.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";
import {
  ALLOWED_ENV_NAMES,
  asUntrustedUser,
  canRunAsUntrustedUser,
} from "../lib/untrusted_command_env.ts";

/** A declared value no test expects to see in argv, env or a log. */
const DECLARED = "synthetic-4705-value";

/** One call the recording spawn received. */
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

/**
 * A spawn that records its call and answers with `answer`. The access probe
 * that runs first passes and is not recorded: `calls` holds the command calls.
 */
function recordingSpawn(
  calls: SpawnCall[],
  answer: { code: number; stderr: string },
): typeof runWithTimeout {
  return (executable, args, options) => {
    if (isProbeCall(args)) {
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
    }
    calls.push({ executable, args, options });
    return Promise.resolve({
      ok: true,
      value: {
        code: answer.code,
        stdout: "",
        stderr: answer.stderr,
        success: answer.code === 0,
        timedOut: false,
      },
    });
  };
}

/** The drop the production path takes: the account is `agent` via sudo. */
function sudoAgent(cmd: readonly string[]): Promise<string[]> {
  return Promise.resolve(["sudo", "-n", "-u", "agent", "--", ...cmd]);
}

/** A cargo fmt check whose directory is never entered by a recording spawn. */
function cargoFmtCheck(): FastCheck {
  return {
    dir: "/tmp",
    kind: "cargo",
    label: "cargo fmt",
    args: ["fmt", "--all", "--", "--check"],
    timeoutMs: 1000,
  };
}

Deno.test("spawnFastCheck: declared credentials ride the stdin channel, never argv, behind the sudo wrapper (Issue #4705)", async () => {
  const calls: SpawnCall[] = [];
  const result = await spawnFastCheck(
    cargoFmtCheck(),
    { NPM_TOKEN: DECLARED },
    recordingSpawn(calls, { code: 0, stderr: "" }),
    sudoAgent,
    {
      source: {
        PATH: "/usr/bin:/bin",
        CARGO_TARGET_DIR: "/fixture/target",
        GH_TOKEN: "synthetic-ambient-secret",
        HTTPS_PROXY: "http://proxy.test:3128",
        NO_PROXY: "localhost",
      },
    },
  );
  assertEquals(result.code, 0);
  assertEquals(calls.length, 1);
  const { executable, args, options } = calls[0]!;

  // The argv begins with the sudo drop and the fixed wrapper, then the
  // original command. The target and egress proxy settings cross sudo's
  // env_reset as explicit non-secret environment assignments.
  assertEquals(executable, "sudo");
  assertEquals(args.slice(0, 6), ["-n", "-u", "agent", "--", "sh", "-c"]);
  const target = options?.env?.["CARGO_TARGET_DIR"];
  const prefix = target === undefined
    ? []
    : ["env", `CARGO_TARGET_DIR=${target}`];
  assertEquals(args.slice(7), [
    "vibe-credential-channel",
    ...prefix,
    "HTTPS_PROXY=http://proxy.test:3128",
    "NO_PROXY=localhost",
    "GIT_CONFIG_COUNT=1",
    "GIT_CONFIG_KEY_0=safe.directory",
    "GIT_CONFIG_VALUE_0=/tmp",
    "cargo",
    "fmt",
    "--all",
    "--",
    "--check",
  ]);

  // No declared value is in argv.
  assertEquals(args.join("\n").includes(DECLARED), false);

  // The payload is on stdin: a count, then NAME=base64 of the value.
  assertEquals(options?.clearEnv, true);
  const [header, entry] = (options?.stdin ?? "").split("\n");
  assertEquals(header, "1");
  assertEquals(entry?.startsWith("NPM_TOKEN="), true);
  assertEquals(atob(entry!.slice("NPM_TOKEN=".length)), DECLARED);

  // The worker's GH_TOKEN is not in the environment, and every name that is
  // there is allowlisted or the one declared name.
  assertEquals(options?.env?.["GH_TOKEN"], undefined);
  for (const name of Object.keys(options?.env ?? {})) {
    assert(
      ALLOWED_ENV_NAMES.includes(name) || name === "NPM_TOKEN",
      `unexpected name ${name} in the spawn environment`,
    );
  }
});

Deno.test("spawnFastCheck: a channel fault throws the fault line and never a value, so the check is unverified (Issue #4705)", async () => {
  const faultLine = "[vibe-credential-channel] credential stream ended early";
  // The probe passed, so the worker can see the manifest; a checkout without a
  // Cargo.toml would be a missing manifest and return exit 1 instead (Issue
  // #4697), so this fixture has one.
  const dir = await Deno.makeTempDir({ prefix: "vibe_4705_fault_" });
  try {
    await Deno.writeTextFile(`${dir}/Cargo.toml`, "[package]\n");
    const error = await assertRejects(
      () =>
        spawnFastCheck(
          { ...cargoFmtCheck(), dir },
          { NPM_TOKEN: DECLARED },
          recordingSpawn([], { code: 78, stderr: faultLine }),
          sudoAgent,
        ),
      Error,
      faultLine,
    );
    assertStringIncludes(error.message, "could not be delivered");
    assertStringIncludes(error.message, "Issue #4705");
    assertEquals(error.message.includes(DECLARED), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spawnFastCheck: exit 78 without the marker is an ordinary failing check, not a fault (Issue #4705)", async () => {
  const result = await spawnFastCheck(
    cargoFmtCheck(),
    { NPM_TOKEN: DECLARED },
    recordingSpawn([], { code: 78, stderr: "credential stream ended early" }),
    sudoAgent,
  );
  assertEquals(result, { code: 78, output: "credential stream ended early" });
});

Deno.test("spawnFastCheck: the channel marker with nothing declared is the check's own failure, not a fault (Issue #4705)", async () => {
  const markerLine = "[vibe-credential-channel] printed by the check itself";
  const result = await spawnFastCheck(
    cargoFmtCheck(),
    {},
    recordingSpawn([], { code: 78, stderr: markerLine }),
    sudoAgent,
  );
  assertEquals(result, { code: 78, output: markerLine });
});

Deno.test("spawnFastCheck: with nothing declared there is no wrapper and no stdin (Issue #4705)", async () => {
  const calls: SpawnCall[] = [];
  await spawnFastCheck(
    {
      dir: "/tmp",
      kind: "deno",
      label: "deno lint",
      args: ["lint"],
      timeoutMs: 1000,
    },
    {},
    recordingSpawn(calls, { code: 0, stderr: "" }),
    sudoAgent,
  );
  assertEquals(calls.length, 1);
  const { executable, args, options } = calls[0]!;
  assertEquals(executable, "sudo");
  assertEquals(args.slice(0, 4), ["-n", "-u", "agent", "--"]);
  assertEquals(args.includes("vibe-credential-channel"), false);
  assertEquals(args.includes("sh"), false);
  assertEquals(args.at(-1), "lint");
  assertEquals(options?.stdin, undefined);
});

Deno.test("spawnFastCheck: a declared credential reaches the real agent account's command through the channel (Issue #4705)", async () => {
  // Skipped where this host cannot drop to the agent account.
  if (!await canRunAsUntrustedUser()) return;

  // An ambient secret is added to the environment handed to sudo, not to the
  // worker's process environment. sudo's env_reset must strip it, so the
  // agent-run command sees the declared value and not the ambient one.
  const withAmbientSecret: typeof runWithTimeout = (executable, args, opts) =>
    runWithTimeout(executable, args, {
      ...opts,
      env: { ...opts.env, GH_TOKEN: "ambient-secret" },
    });

  const result = await spawnFastCheck(
    {
      dir: "/",
      kind: "deno",
      label: "credential channel probe",
      args: [],
      timeoutMs: 20_000,
    },
    { NPM_TOKEN: "synthetic-4705" },
    withAmbientSecret,
    (_cmd) =>
      Promise.resolve(
        asUntrustedUser(
          [
            "/bin/sh",
            "-c",
            'printf "%s|%s" "$NPM_TOKEN" "${GH_TOKEN-unset}"',
          ],
          { enabled: true },
        ),
      ),
  );
  assertEquals(result.code, 0);
  assertEquals(result.output, "synthetic-4705|unset");
});
