/**
 * Issue #891: the gate must fail on the code, never on its own container.
 *
 * The worker container exports
 * `CONFIG_PATH=/home/vibe/.vibe-coder/run-config/.config.json`. Thirty-three
 * tests across `setup_credential_provisioning_test.ts`, `setup_lockfile_test.ts`,
 * `setup_workdir_reminder_test.ts`, `setup_prerequisites_test.ts` and
 * `setup_provider_credential_flow_test.ts` point `CONFIG_FILE` at their own
 * fixture in a temp directory, and then die on `setup.sh`'s guard:
 *
 * ```text
 * ERROR: CONFIG_FILE and CONFIG_PATH are both set and name different files
 * ```
 *
 * Both sides are right. The guard catches a real misconfiguration — two
 * different config files named at once — and the tests are right to use their
 * own fixture. What was wrong is the gate handing the suite an ambient
 * variable that has nothing to do with the change under test, so
 * `deno tests FAILED` reported the container rather than the code.
 *
 * `env -u CONFIG_PATH ./quality.sh` drops all thirty-three, which is what
 * identified the cause.
 *
 * A gate that fails on the environment it happens to run in is worse than a
 * slow one: every red result becomes ambiguous, and the habit it teaches is
 * to re-run rather than read.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { runCommand, testStageEnv } from "../lib/quality_gate.ts";

Deno.test("test stage env - CONFIG_PATH is not handed to the suite (Issue #891)", () => {
  const env = testStageEnv({
    CONFIG_PATH: "/home/vibe/.vibe-coder/run-config/.config.json",
    PATH: "/usr/bin",
  });
  assertEquals(
    Object.hasOwn(env, "CONFIG_PATH"),
    false,
    "CONFIG_PATH must be removed, not blanked — setup.sh's guard fires on a " +
      "set-but-different value, and an empty string is still set",
  );
});

Deno.test("test stage env - a scrubbed variable really is absent from the child (Issue #1098)", async () => {
  // The scrub is only worth having if the subprocess honours it. `Deno.Command`
  // merges `env` into the parent's by default, so for as long as the scrub has
  // existed the child still inherited `CONFIG_PATH`: the suite loaded the
  // operator's real config and made live `gh` calls from tests that meant to
  // read an empty one. This drives the gate's own spawn helper with an
  // environment that omits a variable the parent has.
  // An existing parent variable stands in for the scrubbed one, so no process
  // state is mutated and this file stays in the parallel pass. Deno supplies
  // `PATH`, `HOME` and its node shim marker to every child it spawns, so the
  // probe is any other variable the parent happens to carry.
  const parentEnv = Deno.env.toObject();
  const supplied = new Set(["PATH", "HOME", "DENO_NODE_SHIM_ACTIVE"]);
  const probeVar = Object.keys(parentEnv).find((name) => !supplied.has(name));
  assert(probeVar !== undefined, "the parent has no variable to omit");
  const probe = [
    Deno.execPath(),
    "eval",
    `console.log(Deno.env.get(${JSON.stringify(probeVar)}) ?? "ABSENT")`,
  ];

  const passedThrough = await runCommand(probe, {
    env: testStageEnv(parentEnv),
  });
  assertEquals(passedThrough.exitCode, 0, passedThrough.output);
  assertEquals(
    passedThrough.output.trim(),
    parentEnv[probeVar],
    "the supplied environment must reach the child intact",
  );

  const { [probeVar]: _omitted, ...withoutProbe } = parentEnv;
  const omitted = await runCommand(probe, { env: testStageEnv(withoutProbe) });
  assertEquals(omitted.exitCode, 0, omitted.output);
  assertEquals(
    omitted.output.trim(),
    "ABSENT",
    "a variable left out of the supplied environment must not be inherited",
  );
});

Deno.test("test stage env - WORK_DIR is not handed to the suite (Issue #1098)", () => {
  // The same class as CONFIG_PATH, found on the milestone base branch: the
  // container exports the live worker volume, `runCoreLoop` falls back to it
  // for state that outlives a run, and every suite driving the loop then
  // shared the running fleet's `idle_disagreement_streak.json` with three
  // sibling test processes. Removed, not blanked — the fallback treats an
  // empty string as absent, but a caller reading the raw variable should not
  // see one either.
  const env = testStageEnv({
    WORK_DIR: "/home/vibe/auto-issue-work",
    PATH: "/usr/bin",
  });
  assertEquals(Object.hasOwn(env, "WORK_DIR"), false);
  assertEquals(env.PATH, "/usr/bin");
});

Deno.test("test stage env - everything else is passed through (Issue #891)", () => {
  const env = testStageEnv({
    CONFIG_PATH: "/home/vibe/.vibe-coder/run-config/.config.json",
    PATH: "/usr/bin:/bin",
    HOME: "/home/vibe",
    WORK_DIR: "/home/vibe/auto-issue-work",
    VIBE_IMAGE_AGENT_PROVIDERS: "claude",
  });
  assertEquals(env.PATH, "/usr/bin:/bin");
  assertEquals(env.HOME, "/home/vibe");
  assertEquals(env.VIBE_IMAGE_AGENT_PROVIDERS, "claude");
});

Deno.test("test stage env - absent CONFIG_PATH is not invented (Issue #891)", () => {
  const env = testStageEnv({ PATH: "/usr/bin" });
  assertEquals(Object.hasOwn(env, "CONFIG_PATH"), false);
  assertEquals(env.PATH, "/usr/bin");
});

Deno.test("test stage env - the caller's object is not mutated (Issue #891)", () => {
  // The gate passes `Deno.env.toObject()`; mutating it would be harmless
  // there but is the kind of surprise a shared helper should not carry.
  const base = { CONFIG_PATH: "/x", PATH: "/usr/bin" };
  testStageEnv(base);
  assertEquals(base.CONFIG_PATH, "/x", "the input must be left alone");
});

Deno.test("test stage env - CONFIG_FILE is left alone (Issue #891)", () => {
  // Only the ambient container variable is scrubbed. A test that sets its own
  // CONFIG_FILE must keep it — that is the fixture the guard should honour.
  const env = testStageEnv({ CONFIG_FILE: "/tmp/fixture/.config.json" });
  assert(Object.hasOwn(env, "CONFIG_FILE"));
  assertEquals(env.CONFIG_FILE, "/tmp/fixture/.config.json");
});
