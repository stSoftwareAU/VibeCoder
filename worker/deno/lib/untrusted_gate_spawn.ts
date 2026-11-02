/**
 * Running repository code at the milestone gates (Issue #4659).
 *
 * `spawnTask` (milestone_resolution_gate.ts) and `spawnTypeCheck`
 * (milestone_merge_gate.ts) run the repository's own commands. They used to
 * inherit the worker's whole environment, so a credential such as `GH_TOKEN`
 * or `ANTHROPIC_API_KEY` reached code the repository controls. This helper
 * runs them with the allowlist of Issue #572 and `clearEnv`, as the `agent`
 * account where that account can use the checkout.
 *
 * The shared clone may be unreadable or unwritable by `agent` (Issues #4697,
 * #4113). A command run there could exit 0 with "No matching files found", or
 * fail for a reason unrelated to the tree. So the account is probed first. On
 * any doubt the command runs as the worker with the same allowlisted
 * environment: no credential variable reaches it, and the verdict stays a
 * verdict on the tree.
 *
 * `quality_credentials` declared by the repository are NOT resolved at the
 * milestone gates, because nothing there mints them. `repoCredentialEnv` is
 * therefore `{}`.
 *
 * Australian English spelling used throughout.
 */

import {
  carryEnvThroughSudo,
  untrustedAccountOf,
  untrustedQualityCommandEnv,
  untrustedSpawn,
} from "./quality_gate_phase.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/** Injection seams for {@link runRepositoryCommand}. Production omits them. */
export interface UntrustedGateSpawnDeps {
  spawn?: typeof runWithTimeout;
  drop?: typeof untrustedSpawn;
  source?: Record<string, string>;
  trimRefused?: boolean;
  root?: string;
}

/** The probe is a few `test` and `find` calls. Seconds. */
const PROBE_TIMEOUT_MS = 15_000;

/** A manifest name the probe script may embed in its text. */
const SAFE_MANIFEST = /^[A-Za-z0-9._-]+$/;

/** Stat `path`, or undefined when it is absent. Other errors propagate. */
async function statOrUndefined(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/**
 * The manifests a gate probes for in a checkout.
 *
 * @param kind - `cargo` gives `Cargo.toml`, `script` gives `quality.sh`, and
 *   `deno` gives whichever of `deno.json` and `deno.jsonc` exists as a file.
 * @param dir - The checkout to look in.
 * @returns The manifest names; empty for a `deno` checkout with neither.
 * @throws When a stat fails for any reason other than the file being absent.
 */
export async function manifestsFor(
  kind: "deno" | "cargo" | "script",
  dir: string,
): Promise<string[]> {
  if (kind === "cargo") return ["Cargo.toml"];
  if (kind === "script") return ["quality.sh"];
  const found: string[] = [];
  for (const name of ["deno.json", "deno.jsonc"]) {
    if ((await statOrUndefined(`${dir}/${name}`))?.isFile) found.push(name);
  }
  return found;
}

/**
 * The shell fragment that checks a cargo build can write its target.
 *
 * Without a `target` directory the checkout itself must be writable, because
 * cargo creates one. With one, every entry in it must be.
 */
async function targetWriteCheck(cwd: string): Promise<string> {
  const exists = (await statOrUndefined(`${cwd}/target`)) !== undefined;
  return exists
    ? ` && [ -z "$(find "$1/target" ! -writable -print -quit)" ]`
    : ` && test -w "$1"`;
}

/**
 * The probe script. `$1` is the checkout and is passed as an argument, never
 * interpolated, so a path cannot change the script.
 *
 * @throws When a manifest name is not a plain file name.
 */
function probeScript(manifests: readonly string[], tail: string): string {
  const reads = manifests.map((name) => {
    if (!SAFE_MANIFEST.test(name)) {
      throw new Error(
        `refusing to probe manifest '${name}': only a plain file name may be ` +
          `embedded in the probe (Issue #4659)`,
      );
    }
    return ` -a -r "$1/${name}"`;
  });
  return `test -r "$1" -a -x "$1"${reads.join("")}${tail}`;
}

/**
 * Run a repository command with the allowlisted environment and no
 * credentials, as the `agent` account when it can use the checkout.
 *
 * The account is probed with a command of its own. Any failed, timed out or
 * non-zero probe runs the command as the worker, with the same environment.
 *
 * @param executable - The command, e.g. `cargo` or `deno`.
 * @param args - Its arguments.
 * @param options.cwd - The checkout the command runs in.
 * @param options.timeoutMs - The budget for the command itself.
 * @param options.manifests - Files the command reads from the checkout; each
 *   must be readable by the account the command runs as.
 * @param deps - Injection seams. Production omits them.
 * @returns The spawn result of the command.
 * @throws When a manifest name is not a plain file name.
 */
export async function runRepositoryCommand(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; manifests?: readonly string[] },
  deps: UntrustedGateSpawnDeps = {},
): ReturnType<typeof runWithTimeout> {
  const spawn = deps.spawn ?? runWithTimeout;
  const drop = deps.drop ?? untrustedSpawn;
  const buildEnv = (spawnable: readonly string[]) =>
    untrustedQualityCommandEnv({
      spawnable,
      cwd: options.cwd,
      repoCredentialEnv: {},
      ...(deps.source === undefined ? {} : { source: deps.source }),
      ...(deps.trimRefused === undefined
        ? {}
        : { trimRefused: deps.trimRefused }),
      ...(deps.root === undefined ? {} : { root: deps.root }),
    });

  let spawnable = await drop([executable, ...args]);
  if (untrustedAccountOf(spawnable) !== undefined) {
    const writesTarget = executable === "cargo" &&
      buildEnv(spawnable)["CARGO_TARGET_DIR"] === undefined;
    const probe = await drop([
      "sh",
      "-c",
      probeScript(
        options.manifests ?? [],
        writesTarget ? await targetWriteCheck(options.cwd) : "",
      ),
      "sh",
      options.cwd,
    ]);
    const [probeCommand = "", ...probeArgs] = probe;
    const verdict = await spawn(probeCommand, probeArgs, {
      cwd: options.cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
      env: buildEnv(spawnable),
      clearEnv: true,
    });
    if (!verdict.ok || verdict.value.code !== 0 || verdict.value.timedOut) {
      console.error(
        `[SECURITY] the untrusted account cannot use '${options.cwd}' — ` +
          `running '${executable}' as the worker with the allowlisted ` +
          `environment (Issues #4697, #4113)`,
      );
      spawnable = [executable, ...args];
    }
  }

  const env = buildEnv(spawnable);
  const target = env["CARGO_TARGET_DIR"];
  const final = carryEnvThroughSudo(
    spawnable,
    target === undefined ? {} : { CARGO_TARGET_DIR: target },
  );
  const [command = "", ...commandArgs] = final;
  return spawn(command, commandArgs, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env,
    clearEnv: true,
  });
}
