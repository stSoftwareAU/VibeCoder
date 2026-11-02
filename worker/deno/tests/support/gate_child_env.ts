/**
 * Child-process harness for the milestone gates' environment tests (Issue #4659).
 *
 * A gate's test must show what its repository command sees, and the test
 * process cannot show it: the `test:unit` stage hands each test file a built
 * environment that holds none of the worker's names, so a test that planted a
 * credential in its own environment would pass whether or not the gate
 * inherited. The credential is therefore set on a child Deno process's
 * environment, which the test starts with an explicit `env`, and the real
 * default runner runs inside that child. This process's environment is never
 * mutated (Issue #880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { ALLOWED_ENV_NAMES } from "../../lib/untrusted_command_env.ts";

/** A credential the worker holds, which a repository's own command must not inherit. */
export const PARENT_CREDENTIAL = "VIBE_4659_PARENT_SECRET";

/**
 * Names a POSIX shell sets for itself in a child it starts (as
 * untrusted_spawn_env_test.ts does).
 */
const SHELL_SET_NAMES = ["PWD", "SHLVL", "_", "OLDPWD", "IFS"];

/**
 * Names `deno task` writes into the child for npm compatibility. The runner
 * writes them itself: they are not inherited from the worker (checked with
 * `env -i`).
 */
const DENO_TASK_SET_NAMES = ["INIT_CWD", "npm_config_user_agent"];

/** Names the build cache layers on for a checkout (Issue #2247). */
const BUILD_CACHE_NAMES = ["CARGO_TARGET_DIR"];

/**
 * The task body a repository would declare: it lists the child's variable
 * names on one line that starts `ENV `, then fails so the gate reports it. One
 * line keeps the names clear of the gate's output tail, and the echoed task
 * line starts `Task`, so it is never read as a name.
 */
export const NAMES_PROBE =
  `sh -c 'printf "ENV %s\\n" "$(printenv | cut -d= -f1 | tr "\\n" " ")"; exit 1'`;

/** What a gate returned, as the child reported it. */
export interface ChildGateOutcome {
  status: string;
  detail: string;
  output: string;
}

/**
 * Run a gate in a child Deno process that holds the parent credential.
 *
 * @param probeSource - A module that calls the real gate on `Deno.args[0]` and
 *   prints `OUTCOME ` followed by the JSON of the outcome.
 * @param repoDir - The repository the gate verifies.
 * @returns The outcome the gate returned in the child.
 */
export async function runGateInChild(
  probeSource: string,
  repoDir: string,
): Promise<ChildGateOutcome> {
  const dir = await Deno.makeTempDir({ prefix: "issue-4659-probe-" });
  try {
    const probe = `${dir}/probe.ts`;
    await Deno.writeTextFile(probe, probeSource);
    const env: Record<string, string> = { [PARENT_CREDENTIAL]: "s3cret" };
    for (const name of ["PATH", "HOME", "DENO_DIR"]) {
      const value = Deno.env.get(name);
      if (value !== undefined) env[name] = value;
    }
    const config = new URL("../../deno.json", import.meta.url).pathname;
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        config,
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-sys=hostname",
        probe,
        repoDir,
      ],
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 0, `the gate probe failed: ${stderr}`);
    const line = stdout.split("\n").find((l) => l.startsWith("OUTCOME "));
    assert(line !== undefined, `the gate probe printed no outcome: ${stdout}`);
    return JSON.parse(line.slice("OUTCOME ".length)) as ChildGateOutcome;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The names the probe printed, read from the output the gate reports. */
function probedNames(output: string): string[] {
  const line = output.split("\n").find((l) => l.startsWith("ENV "));
  assert(line !== undefined, `the probe printed no names: ${output}`);
  return line.slice("ENV ".length).split(" ").filter((name) => name.length > 0);
}

/**
 * Assert the child saw only names the allowlist, the shell, the task runner or
 * the build cache put there. The parent credential is not among them.
 */
export function assertOnlyAllowlistedNames(output: string): void {
  const permitted = new Set([
    ...ALLOWED_ENV_NAMES,
    ...SHELL_SET_NAMES,
    ...DENO_TASK_SET_NAMES,
    ...BUILD_CACHE_NAMES,
  ]);
  const names = probedNames(output);
  const leaked = names.filter((name) => !permitted.has(name));
  assertEquals(
    leaked,
    [],
    `the child inherited names the allowlist never granted: ${
      leaked.join(", ")
    }`,
  );
  assert(
    names.includes("PATH"),
    "expected PATH, so the built environment is usable",
  );
}
