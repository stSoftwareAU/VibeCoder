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

/** A spawn that records its call and answers with `answer`. */
function recordingSpawn(
  calls: SpawnCall[],
  answer: { code: number; stderr: string },
): typeof runWithTimeout {
  return (executable, args, options) => {
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

/** Set the named variables, returning a function that puts them back. */
function plantEnv(entries: Record<string, string>): () => void {
  const previous = Object.keys(entries).map((name) =>
    [name, Deno.env.get(name)] as const
  );
  for (const [name, value] of Object.entries(entries)) {
    Deno.env.set(name, value);
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  };
}

Deno.test("spawnFastCheck: declared credentials ride the stdin channel, never argv, behind the sudo wrapper (Issue #4705)", async () => {
  const restore = plantEnv({
    CARGO_TARGET_DIR: "/var/tmp/issue-4705-target",
    GH_TOKEN: "planted-4705-gh",
  });
  try {
    const calls: SpawnCall[] = [];
    const result = await spawnFastCheck(
      cargoFmtCheck(),
      { NPM_TOKEN: DECLARED },
      recordingSpawn(calls, { code: 0, stderr: "" }),
      sudoAgent,
    );
    assertEquals(result.code, 0);
    assertEquals(calls.length, 1);
    const { executable, args, options } = calls[0]!;

    // The argv begins with the sudo drop and the fixed wrapper, then the
    // original command with its CARGO_TARGET_DIR env prefix intact.
    assertEquals(executable, "sudo");
    assertEquals(args.slice(0, 6), ["-n", "-u", "agent", "--", "sh", "-c"]);
    assertEquals(args.slice(7), [
      "vibe-credential-channel",
      "env",
      "CARGO_TARGET_DIR=/var/tmp/issue-4705-target",
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
  } finally {
    restore();
  }
});

Deno.test("spawnFastCheck: a channel fault throws the fault line and never a value, so the check is unverified (Issue #4705)", async () => {
  const faultLine = "[vibe-credential-channel] credential stream ended early";
  const error = await assertRejects(
    () =>
      spawnFastCheck(
        cargoFmtCheck(),
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
  const restore = plantEnv({ GH_TOKEN: "planted-4705-gh" });
  try {
    const result = await spawnFastCheck(
      {
        dir: "/",
        kind: "deno",
        label: "credential channel probe",
        args: [],
        timeoutMs: 20_000,
      },
      { NPM_TOKEN: "synthetic-4705" },
      runWithTimeout,
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
  } finally {
    restore();
  }
});
