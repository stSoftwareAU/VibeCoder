/**
 * Credential channel through sudo (Issue #4705).
 *
 * The declared credentials travel on the dropped command's stdin, not in
 * argv and not in the environment `sudo` strips. These tests run the real
 * wrapper through a real `sh` (no sudo) and, when the host has the `agent`
 * account, through the real `sudo -n -u agent`.
 *
 * Uses Australian English throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  carryCredentialsThroughSudo,
  CREDENTIAL_CHANNEL_FAULT_CODE,
  CREDENTIAL_CHANNEL_MARKER,
  credentialChannelFault,
} from "../lib/credential_channel.ts";
import {
  asUntrustedUser,
  canRunAsUntrustedUser,
} from "../lib/untrusted_command_env.ts";
import {
  commandOutputWithTimeout,
  runWithTimeout,
} from "../lib/subprocess_timeout.ts";

const TIMEOUT_MS = 20_000;
const SECRET = "synthetic-secret-4705";
const SUDO_PREFIX = ["sudo", "-n", "-u", "agent", "--"];

/** Base64 of the UTF-8 bytes of `text`, for expected payloads. */
function base64Utf8(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** The argv after the `sudo` prefix: the wrapper and the original command. */
function afterSudo(argv: readonly string[]): string[] {
  const separator = argv.indexOf("--");
  return argv.slice(separator + 1);
}

/**
 * The wrapper argv (`sh -c SCRIPT vibe-credential-channel <command>`) with the
 * sudo prefix removed. The declared value is a probe, not used by the test.
 */
function wrapperArgv(command: string[]): string[] {
  return afterSudo(
    carryCredentialsThroughSudo([...SUDO_PREFIX, ...command], {
      PROBE_4705: "probe",
    }).argv,
  );
}

/** Unwrap a successful `Result`, failing the test on an error result. */
function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: Error },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** The message a function throws, or the empty string when it does not throw. */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

// ---------------------------------------------------------------------------
// 1. carryCredentialsThroughSudo
// ---------------------------------------------------------------------------

Deno.test("credential channel 4705 - a non-sudo argv is unchanged with no stdin", () => {
  const result = carryCredentialsThroughSudo(["git", "status"], {
    NPM_TOKEN: SECRET,
  });
  assertEquals(result.argv, ["git", "status"]);
  assertEquals(result.stdin, undefined);
});

Deno.test("credential channel 4705 - an empty declared set leaves a sudo argv unchanged", () => {
  const sudoArgv = [...SUDO_PREFIX, "make", "check"];
  const result = carryCredentialsThroughSudo(sudoArgv, {});
  assertEquals(result.argv, sudoArgv);
  assertEquals(result.stdin, undefined);
});

Deno.test("credential channel 4705 - a sudo argv gets the wrapper after -- and keeps the original command", () => {
  const original = [
    "env",
    "CARGO_TARGET_DIR=/var/tmp/cargo-4705",
    "cargo",
    "test",
  ];
  const result = carryCredentialsThroughSudo(
    [...SUDO_PREFIX, ...original],
    { NPM_TOKEN: SECRET },
  );
  const argv = result.argv;
  assertEquals(argv.slice(0, 5), ["sudo", "-n", "-u", "agent", "--"]);
  assertEquals(argv.slice(5, 7), ["sh", "-c"]);
  assertStringIncludes(argv[7] ?? "", CREDENTIAL_CHANNEL_MARKER);
  assertEquals(argv[8], "vibe-credential-channel");
  assertEquals(argv.slice(9), original);
});

Deno.test("credential channel 4705 - no declared value appears anywhere in argv", () => {
  const result = carryCredentialsThroughSudo(
    [...SUDO_PREFIX, "/bin/sh", "-c", "true"],
    { NPM_TOKEN: SECRET, GH_TOKEN: `${SECRET}-gh` },
  );
  for (const element of result.argv) {
    assertEquals(element.includes(SECRET), false);
    assertEquals(element.includes(base64Utf8(SECRET)), false);
  }
  assertEquals(result.stdin?.includes(SECRET), false);
});

Deno.test("credential channel 4705 - the stdin payload is a count then NAME=base64 lines", () => {
  const result = carryCredentialsThroughSudo(
    [...SUDO_PREFIX, "/bin/true"],
    { NPM_TOKEN: SECRET, EMPTY_4705: "" },
  );
  assertEquals(
    result.stdin,
    `2\nNPM_TOKEN=${base64Utf8(SECRET)}\nEMPTY_4705=\n`,
  );
});

Deno.test("credential channel 4705 - an invalid name is refused and the error holds no value", () => {
  for (const name of ["A B", "1X", "X;rm"]) {
    const message = thrownMessage(() =>
      carryCredentialsThroughSudo([...SUDO_PREFIX, "/bin/true"], {
        [name]: SECRET,
      })
    );
    assertStringIncludes(message, "Issue #4705");
    assertStringIncludes(message, "refusing to carry credential");
    assertEquals(message.includes(SECRET), false);
  }
});

Deno.test("credential channel 4705 - a value with a NUL byte is refused and the error holds no value", () => {
  const value = "s3cret-4705\u0000tail";
  const message = thrownMessage(() =>
    carryCredentialsThroughSudo([...SUDO_PREFIX, "/bin/true"], {
      NPM_TOKEN: value,
    })
  );
  assertStringIncludes(message, "NPM_TOKEN");
  assertStringIncludes(message, "Issue #4705");
  assertEquals(message.includes("s3cret-4705"), false);
});

// ---------------------------------------------------------------------------
// 2. The wrapper through a real shell (no sudo)
// ---------------------------------------------------------------------------

Deno.test("credential channel 4705 - declared values arrive byte-exact and undeclared ones do not", async () => {
  const declared: Record<string, string> = {
    MULTI_4705: "line one\nline two\n",
    SPECIAL_4705: "$HOME `x` \"q\" 'q' =",
    ENDS_X_4705: "box",
    EMPTY_4705: "",
  };
  const names = Object.keys(declared);
  // One base64 line per name, then a sentinel, so trimming the output cannot
  // swallow an empty value at the end.
  const probe = [
    ...names.map((name) =>
      `printf '%s\\n' "$(printf %s "$${name}" | base64 | tr -d '\\n')"`
    ),
    "printf '%s\\n' end",
  ].join("; ");
  const { stdin } = carryCredentialsThroughSudo(
    [...SUDO_PREFIX, "/bin/true"],
    declared,
  );
  const argv = wrapperArgv(["/bin/sh", "-c", probe]);

  const result = unwrap(
    await runWithTimeout(argv[0] ?? "sh", argv.slice(1), {
      clearEnv: true,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdin,
      timeoutMs: TIMEOUT_MS,
    }),
  );
  assertEquals(result.code, 0);
  const lines = result.stdout.split("\n");
  for (const [index, name] of names.entries()) {
    assertEquals(lines[index], base64Utf8(declared[name] ?? ""), name);
  }
  assertEquals(lines[names.length], "end");

  // The child is spawned with only the env passed explicitly above, so a name
  // the parent holds cannot reach it.
  const absent = wrapperArgv([
    "/bin/sh",
    "-c",
    'printf %s "${CREDENTIAL_PARENT_ONLY_4705-absent}"',
  ]);
  const absentResult = unwrap(
    await runWithTimeout(absent[0] ?? "sh", absent.slice(1), {
      clearEnv: true,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdin: "0\n",
      timeoutMs: TIMEOUT_MS,
    }),
  );
  assertEquals(absentResult.stdout, "absent");
});

Deno.test("credential channel 4705 - the command's own stdin is /dev/null", async () => {
  const argv = wrapperArgv([
    "/bin/sh",
    "-c",
    "readlink /proc/$$/fd/0; cat",
  ]);
  const result = unwrap(
    await runWithTimeout(argv[0] ?? "sh", argv.slice(1), {
      clearEnv: true,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdin: "1\nNPM_TOKEN=" + base64Utf8("payload-4705") + "\n",
      timeoutMs: TIMEOUT_MS,
    }),
  );
  // readlink prints the target of the command's stdin; cat then reads nothing.
  assertEquals(result.stdout, "/dev/null");
  assertEquals(result.code, 0);
});

// ---------------------------------------------------------------------------
// 3. Wrapper faults
// ---------------------------------------------------------------------------

Deno.test("credential channel 4705 - wrapper faults exit 78 with the marker on stderr", async () => {
  const faults: Array<{ label: string; stdin: string }> = [
    { label: "empty stdin", stdin: "" },
    {
      label: "header promises two entries, one supplied",
      stdin: `2\nA_4705=${base64Utf8("x")}\n`,
    },
    {
      label: "bad name line",
      stdin: `1\n1X=${base64Utf8("x")}\n`,
    },
    { label: "bad base64", stdin: "1\nA_4705=!!!\n" },
  ];
  for (const fault of faults) {
    const argv = wrapperArgv(["/bin/sh", "-c", "true"]);
    const result = unwrap(
      await runWithTimeout(argv[0] ?? "sh", argv.slice(1), {
        clearEnv: true,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        stdin: fault.stdin,
        timeoutMs: TIMEOUT_MS,
      }),
    );
    assertEquals(result.code, CREDENTIAL_CHANNEL_FAULT_CODE, fault.label);
    const line = credentialChannelFault(result);
    assertEquals(line === undefined, false, fault.label);
    assertStringIncludes(line ?? "", CREDENTIAL_CHANNEL_MARKER);
  }
});

Deno.test("credential channel 4705 - credentialChannelFault ignores code 78 without the marker and code 0 with it", () => {
  assertEquals(
    credentialChannelFault({
      code: CREDENTIAL_CHANNEL_FAULT_CODE,
      stderr: "boom",
    }),
    undefined,
  );
  assertEquals(
    credentialChannelFault({
      code: 0,
      stderr: `${CREDENTIAL_CHANNEL_MARKER} not a fault`,
    }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// 4. The stdin option on the timeout chokepoints
// ---------------------------------------------------------------------------

Deno.test("credential channel 4705 - runWithTimeout writes stdin to the child", async () => {
  const result = unwrap(
    await runWithTimeout("cat", [], {
      timeoutMs: TIMEOUT_MS,
      stdin: "hello 4705\n",
    }),
  );
  assertEquals(result.stdout, "hello 4705");
  assertEquals(result.timedOut, false);
});

Deno.test("credential channel 4705 - runWithTimeout without stdin gives the child EOF at once", async () => {
  const result = unwrap(
    await runWithTimeout("cat", [], { timeoutMs: TIMEOUT_MS }),
  );
  assertEquals(result.stdout, "");
  assertEquals(result.code, 0);
  assertEquals(result.timedOut, false);
});

Deno.test("credential channel 4705 - runWithTimeout does not throw when the child exits without reading a large stdin", async () => {
  const result = unwrap(
    await runWithTimeout("true", [], {
      timeoutMs: TIMEOUT_MS,
      stdin: "x".repeat(1_000_000),
    }),
  );
  assertEquals(result.code, 0);
  assertEquals(result.timedOut, false);
});

Deno.test("credential channel 4705 - runWithTimeout still times out a child with stdin", async () => {
  const result = unwrap(
    await runWithTimeout("sleep", ["5"], {
      timeoutMs: 300,
      stdin: "unread\n",
    }),
  );
  assertEquals(result.timedOut, true);
  assertEquals(result.code, 124);
});

Deno.test("credential channel 4705 - commandOutputWithTimeout writes stdinText to the child", async () => {
  const output = await commandOutputWithTimeout("cat", {
    args: [],
    stdout: "piped",
    stderr: "piped",
    stdinText: "hello 4705\n",
    timeoutMs: TIMEOUT_MS,
  });
  assertEquals(new TextDecoder().decode(output.stdout), "hello 4705\n");
});

Deno.test("credential channel 4705 - commandOutputWithTimeout without stdinText gives EOF at once", async () => {
  const output = await commandOutputWithTimeout("cat", {
    args: [],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    timeoutMs: TIMEOUT_MS,
  });
  assertEquals(output.stdout.length, 0);
  assertEquals(output.success, true);
});

Deno.test("credential channel 4705 - commandOutputWithTimeout does not throw when the child exits without reading a large stdinText", async () => {
  const output = await commandOutputWithTimeout("true", {
    args: [],
    stdout: "piped",
    stderr: "piped",
    stdinText: "x".repeat(1_000_000),
    timeoutMs: TIMEOUT_MS,
  });
  assertEquals(output.success, true);
});

// ---------------------------------------------------------------------------
// 5. Real sudo, when the host has the agent account
// ---------------------------------------------------------------------------

Deno.test("credential channel 4705 - real sudo delivers the declared value and strips the ambient environment", async () => {
  if (!await canRunAsUntrustedUser()) return;

  const command = [
    "/bin/sh",
    "-c",
    'printf "%s|%s" "$NPM_TOKEN" "${GH_TOKEN-unset}"',
  ];
  const env = { GH_TOKEN: "ambient-secret", NPM_TOKEN: "synthetic-token" };

  // Without the channel, sudo's env_reset strips both: this is the bug.
  const bare = asUntrustedUser(command, { enabled: true });
  const bareResult = unwrap(
    await runWithTimeout(bare[0] ?? "sudo", bare.slice(1), {
      cwd: "/",
      env,
      clearEnv: true,
      timeoutMs: TIMEOUT_MS,
    }),
  );
  assertEquals(bareResult.stdout, "|unset");

  // With the channel, the declared value arrives on stdin and is exported.
  const spawnable = asUntrustedUser(command, { enabled: true });
  const channelled = carryCredentialsThroughSudo(spawnable, {
    NPM_TOKEN: "synthetic-token",
  });
  const result = unwrap(
    await runWithTimeout(
      channelled.argv[0] ?? "sudo",
      channelled.argv.slice(1),
      {
        cwd: "/",
        env,
        clearEnv: true,
        stdin: channelled.stdin,
        timeoutMs: TIMEOUT_MS,
      },
    ),
  );
  assertEquals(result.stdout, "synthetic-token|unset");
  assertEquals(result.code, 0);
});
