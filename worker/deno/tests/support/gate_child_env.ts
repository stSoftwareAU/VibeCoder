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
import {
  ALLOWED_ENV_NAMES,
  UNTRUSTED_USER,
} from "../../lib/untrusted_command_env.ts";

/**
 * Make a checkout directory the dropped `agent` account can use (Issue #4733).
 *
 * A gate runs its repository command as that account when the host has it, and
 * the account cannot enter a `0700` ancestor. `Deno.makeTempDir` follows
 * `TMPDIR`, which the mutation runner points at a `0700` directory of its own,
 * so the directory is made under `/tmp` — world-traversable — and opened
 * to `0777`. The directory is unique and the caller removes it.
 */
export async function makeAgentReachableTempDir(
  prefix: string,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix, dir: "/tmp" });
  await Deno.chmod(dir, 0o777);
  return dir;
}

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
 * Names `sudo` adds to a dropped child's environment after the allowlist is
 * applied. They are permitted only when the child shows it ran through the
 * sudo drop to the untrusted account (Issue #4733).
 */
const SUDO_SET_NAMES = [
  "MAIL",
  "SUDO_COMMAND",
  "SUDO_GID",
  "SUDO_HOME",
  "SUDO_UID",
  "SUDO_USER",
];

/**
 * Names the worker puts on a dropped child so git trusts the checkout
 * (Issue #4927). They are carried through `sudo` in argv, and are permitted
 * only when the child shows it ran through the sudo drop to the untrusted
 * account.
 */
const GIT_SAFE_DIRECTORY_NAMES = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
];

/**
 * The task body a repository would declare: it lists the child's variable
 * names on one line that starts `ENV `, then reports the invoking uid `sudo`
 * recorded and the account the task ran as on a line that starts `SUDO `, then fails so the gate reports it. One
 * line each keeps them clear of the gate's output tail, and the echoed task
 * line starts `Task`, so it is never read as a name.
 */
export const NAMES_PROBE =
  `sh -c 'printf "ENV %s\\n" "$(printenv | cut -d= -f1 | tr "\\n" " ")"; printf "SUDO %s %s %s\\n" "\${SUDO_UID-}" "$(id -u)" "$(id -un)"; exit 1'`;

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

/** The uid `id -u` reports for an account (or this process), if it has one. */
function uidOf(...account: string[]): string | undefined {
  try {
    const result = new Deno.Command("id", {
      args: ["-u", ...account],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    const uid = new TextDecoder().decode(result.stdout).trim();
    return result.code === 0 && /^\d+$/.test(uid) ? uid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Did the child run through the sudo drop to the untrusted account? Its own
 * report must show it ran as that account, with that account's uid, and that
 * `sudo` recorded this worker's uid as the invoker.
 */
function ranThroughSudoDrop(output: string): boolean {
  const line = output.split("\n").find((l) => l.startsWith("SUDO "));
  if (line === undefined) return false;
  const [, invoker, uid, user] = line.split(" ");
  const expected = uidOf(UNTRUSTED_USER);
  return expected !== undefined && user === UNTRUSTED_USER &&
    uid === expected && invoker === uidOf();
}

/**
 * Assert the child saw only names the allowlist, the shell, the task runner or
 * the build cache put there. The parent credential is not among them. The
 * names `sudo` adds, and the git safe.directory names (Issue #4927), are
 * permitted only when the child ran through the drop to the untrusted account.
 */
export function assertOnlyAllowlistedNames(output: string): void {
  const permitted = new Set([
    ...ALLOWED_ENV_NAMES,
    ...SHELL_SET_NAMES,
    ...DENO_TASK_SET_NAMES,
    ...BUILD_CACHE_NAMES,
    ...(ranThroughSudoDrop(output)
      ? [...SUDO_SET_NAMES, ...GIT_SAFE_DIRECTORY_NAMES]
      : []),
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
