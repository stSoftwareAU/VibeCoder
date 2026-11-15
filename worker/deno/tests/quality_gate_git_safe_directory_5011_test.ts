/**
 * Git run by the quality-gate runner works in a worker-owned checkout
 * (Issue #5011).
 *
 * The quality-gate runner drops each command to the `agent` account through
 * `sudo -n -u agent`. That account has no `~/.gitconfig`, so git refused the
 * worker-owned checkout with `fatal: detected dubious ownership`. These tests
 * run the real sudo path through `createDefaultDeps().runCommand`. Where this
 * host cannot drop to `agent`, each test returns early: the drop is the thing
 * under test, and it is not available to test here.
 *
 * Uses Australian English throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDefaultDeps } from "../lib/quality_gate_phase.ts";
import {
  canRunAsUntrustedUser,
  UNTRUSTED_USER,
} from "../lib/untrusted_command_env.ts";
import { makeAgentReachableTempDir } from "./support/gate_child_env.ts";

async function gitInit(cwd: string): Promise<void> {
  const init = await new Deno.Command("git", {
    args: ["init", "-q"],
    cwd,
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(init.code, 0);
}

Deno.test("real sudo: the quality-gate runner runs as the agent account (Issue #5011)", async () => {
  if (!(await canRunAsUntrustedUser())) return;

  const result = await createDefaultDeps({})
    .runCommand(["id", "-un"], { cwd: "/" });

  assertEquals(result.exitCode, 0, result.output);
  assertEquals(result.output.trim(), UNTRUSTED_USER);
});

Deno.test("real sudo: git run by the quality-gate runner works in a worker-owned checkout (Issue #5011)", async () => {
  if (!(await canRunAsUntrustedUser())) return;
  const cwd = await makeAgentReachableTempDir("issue-5011-");
  try {
    await gitInit(cwd);
    const result = await createDefaultDeps({})
      .runCommand(["git", "rev-parse", "--git-dir"], { cwd });

    assertEquals(result.exitCode, 0, result.output);
    assertEquals(result.output.includes("dubious ownership"), false);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("real sudo: git run by the quality-gate runner works from a subdirectory of the checkout (Issue #5011)", async () => {
  if (!(await canRunAsUntrustedUser())) return;
  const root = await makeAgentReachableTempDir("issue-5011-sub-");
  try {
    await gitInit(root);
    const cwd = `${root}/crates/app`;
    await Deno.mkdir(cwd, { recursive: true });
    await Deno.chmod(`${root}/crates`, 0o777);
    await Deno.chmod(cwd, 0o777);
    const result = await createDefaultDeps({})
      .runCommand(["git", "rev-parse", "--show-toplevel"], { cwd });

    assertEquals(result.exitCode, 0, result.output);
    assertEquals(result.output.includes("dubious ownership"), false);
    assertStringIncludes(result.output.trim(), Deno.realPathSync(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
