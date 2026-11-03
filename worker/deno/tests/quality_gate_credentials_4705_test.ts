/**
 * Declared quality_credentials reach the repository's own command when it is
 * dropped to the `agent` account (Issue #4705).
 *
 * `sudo`'s env_reset strips the environment the worker hands it, so a declared
 * credential placed only in `Deno.Command`'s env never arrived. These tests run
 * the real `sudo -n -u agent` path. Where this host cannot drop to `agent`,
 * each test returns early: the drop is the thing under test, and it is not
 * available to test here.
 *
 * Uses Australian English throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDefaultDeps } from "../lib/quality_gate_phase.ts";
import { canRunAsUntrustedUser } from "../lib/untrusted_command_env.ts";

/** A credential value no real secret can equal. */
const SYNTHETIC_NPM = "synthetic-4705";

/** Prints the declared name, then a worker-only name (or `unset`). */
const PRINT_NPM_AND_GH = 'printf "%s|%s" "$NPM_TOKEN" "${GH_TOKEN-unset}"';

/**
 * Set worker environment variables for the duration of `body`, then restore
 * each one to what it was (or unset it), even when `body` throws.
 */
async function withWorkerEnv<T>(
  vars: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(vars)) {
    previous.set(name, Deno.env.get(name));
  }
  for (const [name, value] of Object.entries(vars)) {
    Deno.env.set(name, value);
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("a declared credential reaches the agent-run command through the stdin channel (Issue #4705)", async () => {
  if (!(await canRunAsUntrustedUser())) return;

  await withWorkerEnv({ GH_TOKEN: "worker-4705" }, async () => {
    const result = await createDefaultDeps({ NPM_TOKEN: SYNTHETIC_NPM })
      .runCommand(["/bin/sh", "-c", PRINT_NPM_AND_GH], { cwd: "/" });

    assertEquals(result.exitCode, 0);
    // The declared name arrives. The worker's own GH_TOKEN does not: the
    // allowlist, not sudo, decides what the agent-run command inherits.
    assertEquals(result.output, "synthetic-4705|unset");
  });
});

Deno.test("an undeclared credential is absent from the agent-run command, even when the worker holds it (Issue #4705)", async () => {
  if (!(await canRunAsUntrustedUser())) return;

  await withWorkerEnv(
    { NPM_TOKEN: "worker-4705", GH_TOKEN: "worker-4705" },
    async () => {
      const result = await createDefaultDeps({})
        .runCommand(["/bin/sh", "-c", PRINT_NPM_AND_GH], { cwd: "/" });

      assertEquals(result.exitCode, 0);
      assertEquals(result.output, "|unset");
    },
  );
});

Deno.test("a declared name that is not a plain identifier is refused, and the output names it but never its value (Issue #4705)", async () => {
  if (!(await canRunAsUntrustedUser())) return;

  const result = await createDefaultDeps({ "BAD NAME": SYNTHETIC_NPM })
    .runCommand(["/bin/sh", "-c", "printf ran"], { cwd: "/" });

  assertEquals(result.exitCode, 1);
  assertStringIncludes(result.output, "BAD NAME");
  assertEquals(
    result.output.includes(SYNTHETIC_NPM),
    false,
    "a credential value must never appear in the output",
  );
});

/** The wrapper's fault line, as the channel writes it to stderr. */
const CHANNEL_FAULT_LINE =
  "[vibe-credential-channel] credential stream ended early";

Deno.test("a channel fault on a declared-credential spawn is reported as a delivery failure, never a pass, and never shows a value (Issue #4705)", async () => {
  if (!(await canRunAsUntrustedUser())) return;

  const result = await createDefaultDeps({ NPM_TOKEN: SYNTHETIC_NPM })
    .runCommand(
      ["/bin/sh", "-c", `echo "${CHANNEL_FAULT_LINE}" >&2; exit 78`],
      { cwd: "/" },
    );

  assertEquals(result.exitCode, 1);
  assertStringIncludes(result.output, CHANNEL_FAULT_LINE);
  assertStringIncludes(result.output, "could not be delivered");
  assertEquals(
    result.output.includes(SYNTHETIC_NPM),
    false,
    "a credential value must never appear in the output",
  );
});

Deno.test("exit 78 without the channel marker is an ordinary failure, not a channel fault (Issue #4705)", async () => {
  if (!(await canRunAsUntrustedUser())) return;

  const result = await createDefaultDeps({ NPM_TOKEN: SYNTHETIC_NPM })
    .runCommand(["/bin/sh", "-c", "echo plain >&2; exit 78"], { cwd: "/" });

  assertEquals(result.exitCode, 78);
  assertStringIncludes(result.output, "plain");
  assertEquals(result.output.includes("could not be delivered"), false);
});

Deno.test("the channel marker on a spawn with no declared credentials is not a channel fault (Issue #4705)", async () => {
  if (!(await canRunAsUntrustedUser())) return;

  const result = await createDefaultDeps({})
    .runCommand(
      ["/bin/sh", "-c", `echo "${CHANNEL_FAULT_LINE}" >&2; exit 78`],
      { cwd: "/" },
    );

  assertEquals(result.exitCode, 78);
  assertStringIncludes(result.output, CHANNEL_FAULT_LINE);
  assertEquals(result.output.includes("could not be delivered"), false);
});
