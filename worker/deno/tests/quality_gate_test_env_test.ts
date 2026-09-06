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
 * Issue #1281 changed what this file asserts. Scrubbing two non-secret names
 * off the worker's environment left every credential in it — `GH_TOKEN`, the
 * provider tokens, the GitHub App PEM — readable by repository-supplied test
 * code the coding agent may have written minutes earlier. The stage now
 * BUILDS its environment from an allowlist like every other
 * repository-controlled spawn, so the two tests that asserted pass-through
 * assert the allowlist instead.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
// `runCommand` is exercised through the intermediate process below, which
// imports it dynamically — the test needs a parent that carries the planted
// variable, and this process must not be it.
import { testStageEnv } from "../lib/quality_gate.ts";
import { TEST_STAGE_EXTRA_ENV_NAMES } from "../lib/unit_test_passes.ts";
import { isCredentialVariableName } from "../lib/untrusted_command_env.ts";

/**
 * The environment a worker actually carries when it reaches the gate.
 *
 * The credentials are the real names: the GitHub installation token, the
 * provider token `credential_preflight.applyProviderCredentialEnv` exports
 * into the process, and the two worker-only secrets `agent_env.ts` denies to
 * every agent child.
 */
const WORKER_ENV: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/vibe",
  DENO_DIR: "/home/vibe/auto-issue-work/.deno-cache",
  GH_TOKEN: "ghs_live_installation_token",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-live-provider-token",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
  GITHUB_APP_PRIVATE_KEY_PATH: "/run/vibe-secrets/app.pem",
  VIBE_IMGBB_API_KEY: "imgbb-live-key",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

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
  // The variable is planted in an intermediate process rather than in this
  // one: the test needs a parent that carries it, and mutating the test
  // runner's own environment is what the parallel-unsafe manifest exists to
  // keep out of this pass. The intermediate calls the gate's real helper, so
  // what is measured is `runCommand`'s contract, not Deno's.
  const scrubbed = "CONFIG_PATH";
  const planted = "/planted/by/the/parent/.config.json";
  const helper = import.meta.resolve("../lib/quality_gate.ts");
  const grandchild =
    'console.log(Deno.env.get("CONFIG_PATH") ?? "ABSENT-IN-GRANDCHILD")';
  const script = `
    const { runCommand } = await import(${JSON.stringify(helper)});
    const probe = [Deno.execPath(), "eval", ${JSON.stringify(grandchild)}];
    const own = Deno.env.get(${JSON.stringify(scrubbed)}) ?? "ABSENT-IN-CHILD";
    const scrubbedRun = await runCommand(probe, {
      env: { HOME: Deno.env.get("HOME") ?? "" },
    });
    const keptRun = await runCommand(probe, {
      env: { HOME: Deno.env.get("HOME") ?? "", CONFIG_PATH: own },
    });
    console.log(JSON.stringify({
      own,
      scrubbed: scrubbedRun.output.trim(),
      kept: keptRun.output.trim(),
    }));
  `;
  const intermediate = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--allow-run", "--allow-env", "--allow-read", script],
    env: { ...Deno.env.toObject(), [scrubbed]: planted },
    stdout: "piped",
    stderr: "piped",
  });
  const result = await intermediate.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0, stderr);

  const observed = JSON.parse(stdout.trim().split("\n").at(-1)!);
  assertEquals(observed.own, planted, "the intermediate must carry the value");
  assertEquals(
    observed.scrubbed,
    "ABSENT-IN-GRANDCHILD",
    "a variable left out of the supplied environment must not be inherited",
  );
  assertEquals(
    observed.kept,
    planted,
    "the supplied environment must reach the child intact",
  );
});

Deno.test("test stage env - a token in the worker's environment cannot be read by the spawned suite (Issue #1281)", async () => {
  // The finding, end to end: plant a credential-shaped variable in a parent
  // that then builds the real `deno test` passes and spawns one through the
  // gate's own `runCommand`. Against the two-name denylist this printed the
  // planted token, because `GH_TOKEN` was never on it. It is planted in an
  // intermediate process rather than this one — the test needs a parent that
  // carries it, and mutating the runner's own environment is what the
  // parallel-unsafe manifest exists to keep out of this pass.
  const planted = "ghs_planted_by_the_parent_0123456789";
  const gate = import.meta.resolve("../lib/quality_gate.ts");
  const stage = import.meta.resolve("../lib/unit_test_passes.ts");
  const grandchild =
    'console.log(Deno.env.get("GH_TOKEN") ?? "ABSENT-IN-GRANDCHILD")';
  const script = `
    const { runCommand } = await import(${JSON.stringify(gate)});
    const { unitTestPasses } = await import(${JSON.stringify(stage)});
    const own = Deno.env.get("GH_TOKEN") ?? "ABSENT-IN-CHILD";
    const passes = unitTestPasses({
      denoCmd: Deno.execPath(),
      env: Deno.env.toObject(),
    });
    const probe = [Deno.execPath(), "eval", ${JSON.stringify(grandchild)}];
    const seen = [];
    for (const pass of passes) {
      const run = await runCommand(probe, { env: pass.env });
      seen.push({ label: pass.label, output: run.output.trim() });
    }
    console.log(JSON.stringify({ own, seen }));
  `;
  const intermediate = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--allow-run", "--allow-env", "--allow-read", script],
    env: { ...Deno.env.toObject(), GH_TOKEN: planted },
    stdout: "piped",
    stderr: "piped",
  });
  const result = await intermediate.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0, stderr);

  const observed = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    own: string;
    seen: { label: string; output: string }[];
  };
  assertEquals(observed.own, planted, "the intermediate must carry the token");
  assertEquals(observed.seen.length, 2, "both passes must be exercised");
  for (const pass of observed.seen) {
    assertEquals(
      pass.output,
      "ABSENT-IN-GRANDCHILD",
      `the ${pass.label} pass handed the suite the worker's GH_TOKEN`,
    );
  }
});

Deno.test("test stage env - WORK_DIR is not handed to the suite (Issue #1098)", () => {
  // The same class as CONFIG_PATH, found on the milestone base branch: the
  // container exports the live worker volume, `runCoreLoop` fell back to it
  // for state that outlives a run, and every suite driving the loop then
  // shared the running fleet's `idle_disagreement_streak.json` with three
  // sibling test processes. Issue #1177 removed that fallback at the source;
  // the scrub stays for the other production readers of `WORK_DIR`. Removed,
  // not blanked — a caller reading the raw variable should not see an empty
  // string either.
  const env = testStageEnv({
    WORK_DIR: "/home/vibe/auto-issue-work",
    PATH: "/usr/bin",
  });
  assertEquals(Object.hasOwn(env, "WORK_DIR"), false);
  assertEquals(env.PATH, "/usr/bin");
});

Deno.test("test stage env - what the suite genuinely needs is kept (Issue #1281)", () => {
  // Behaviour change from #891: this used to assert that everything except
  // the two scrubbed names was passed through. The stage now builds its
  // environment from an allowlist, so the assertion is about what a build and
  // this suite genuinely need — running tools at all, the toolchain cache,
  // the container stamp and the worker-count override.
  const env = testStageEnv({
    CONFIG_PATH: "/home/vibe/.vibe-coder/run-config/.config.json",
    PATH: "/usr/bin:/bin",
    HOME: "/home/vibe",
    DENO_DIR: "/cache/deno",
    DENO_JOBS: "2",
    WORK_DIR: "/home/vibe/auto-issue-work",
    VIBE_IMAGE_AGENT_PROVIDERS: "claude",
  });
  assertEquals(env.PATH, "/usr/bin:/bin");
  assertEquals(env.HOME, "/home/vibe");
  assertEquals(env.DENO_DIR, "/cache/deno");
  assertEquals(env.DENO_JOBS, "2");
  assertEquals(env.VIBE_IMAGE_AGENT_PROVIDERS, "claude");
});

Deno.test("test stage env - no worker credential reaches the suite (Issue #1281)", () => {
  // The finding: `deno test` runs repository-supplied test code — including
  // the `*_test.ts` files the coding agent added this run — with the worker's
  // whole environment. A denylist of two non-secret names scrubbed none of
  // this.
  const env = testStageEnv(WORKER_ENV);

  for (const name of Object.keys(env)) {
    assertEquals(
      isCredentialVariableName(name),
      false,
      `${name} reached the repository's own test suite`,
    );
  }
  // By value too, so a credential under an innocuous name cannot slip past.
  const values = Object.values(env).join("\n");
  for (
    const secret of [
      WORKER_ENV.GH_TOKEN,
      WORKER_ENV.CLAUDE_CODE_OAUTH_TOKEN,
      WORKER_ENV.GITHUB_APP_PRIVATE_KEY,
      WORKER_ENV.GITHUB_APP_PRIVATE_KEY_PATH,
      WORKER_ENV.VIBE_IMGBB_API_KEY,
      WORKER_ENV.AWS_SECRET_ACCESS_KEY,
    ]
  ) {
    assertEquals(
      values.includes(secret!),
      false,
      `a credential value reached the test stage: ${secret}`,
    );
  }
  // And the build still works, or the fix would just be a broken gate.
  assertEquals(env.PATH, WORKER_ENV.PATH);
  assertEquals(env.HOME, WORKER_ENV.HOME);
});

Deno.test("test stage env - an unknown variable is absent rather than inherited (Issue #1281)", () => {
  // The allowlist's point: the credential nobody has added yet is already
  // covered. A denylist has to predict the name and is wrong the first time.
  const env = testStageEnv({
    PATH: "/usr/bin",
    VIBE_FUTURE_PROVIDER_CREDENTIAL_2: "not-yet-invented",
    SOME_INTERNAL_ENDPOINT: "https://internal.example",
  });
  assertEquals(Object.keys(env), ["PATH"]);
});

Deno.test("test stage extras - the stage's own allowlist carries no credential name (Issue #1281)", () => {
  // A guard on the guard: adding a name here is a decision about what
  // repository-supplied test code may read.
  for (const name of TEST_STAGE_EXTRA_ENV_NAMES) {
    assertEquals(
      isCredentialVariableName(name),
      false,
      `${name} must not be allowlisted for the test stage`,
    );
  }
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

Deno.test("test stage env - an ambient CONFIG_FILE does not reach the suite either (Issue #1281)", () => {
  // Behaviour change from #891, where this asserted the opposite. `CONFIG_FILE`
  // names the operator's own config — the file the worker's API tokens live in
  // — and under the allowlist it is absent for the same reason `CONFIG_PATH`
  // is. Nothing is lost: a test that wants its own fixture sets `CONFIG_FILE`
  // in the environment of the process IT spawns, which this does not touch.
  const env = testStageEnv({
    CONFIG_FILE: "/home/vibe/.vibe-coder/run-config/.config.json",
    PATH: "/usr/bin",
  });
  assertEquals(Object.hasOwn(env, "CONFIG_FILE"), false);
  assertEquals(env.PATH, "/usr/bin");
});
