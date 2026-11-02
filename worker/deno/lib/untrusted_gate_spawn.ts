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
 * The `quality_credentials` the repository declared reach the command through
 * the registered {@link GateCredentialSource}, as at the quality gate. A
 * probe that finds only the cargo target unwritable (a property the tree
 * controls) gives the account a target of its own and does not change it.
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

/**
 * Where a gate finds the `quality_credentials` its repository declared
 * (Issue #4659). Keyed by checkout because the gates are handed a directory,
 * not a repository. Production registers one at start-up; an unregistered
 * source declares none. A rejection fails the command rather than running it
 * without the credential it declared.
 */
export type GateCredentialSource = (
  repoDir: string,
) => Promise<Record<string, string>>;

let gateCredentialSource: GateCredentialSource | undefined;

/** Register the source {@link runRepositoryCommand} reads declared credentials from. */
export function setGateCredentialSource(
  source: GateCredentialSource | undefined,
): void {
  gateCredentialSource = source;
}

/** Injection seams for {@link runRepositoryCommand}. Production omits them. */
export interface UntrustedGateSpawnDeps {
  spawn?: typeof runWithTimeout;
  drop?: typeof untrustedSpawn;
  source?: Record<string, string>;
  trimRefused?: boolean;
  root?: string;
  /** The repository's declared credentials. Default: the registered source. */
  credentials?: GateCredentialSource;
}

/** The probe exits with this when the account cannot read the checkout. */
const PROBE_UNREADABLE = 1;

/** The probe exits with this when the account cannot write the cargo target. */
const PROBE_TARGET_UNWRITABLE = 2;

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

/** Lstat `path`, or undefined when it is absent. Other errors propagate. */
async function lstatOrUndefined(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.lstat(path);
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
 * cargo creates one. With one, every entry in it must be. A failure here is
 * not a reason to run the tree's code as the worker: the tree can cause it
 * (a committed `target/` file), so the caller gives the account a target of
 * its own instead.
 */
async function targetWriteCheck(cwd: string): Promise<string> {
  const exists = (await statOrUndefined(`${cwd}/target`)) !== undefined;
  return exists
    ? `[ -z "$(find "$1/target" ! -writable -print -quit)" ]`
    : `test -w "$1"`;
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
  const readable = `test -r "$1" -a -x "$1"${
    reads.join("")
  } || exit ${PROBE_UNREADABLE}`;
  return tail === ""
    ? readable
    : `${readable}; ${tail} || exit ${PROBE_TARGET_UNWRITABLE}`;
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
  const manifests = options.manifests ?? [];

  // A manifest that is a link can point at a file the account cannot read, so
  // the tree would choose which account runs its code. Refuse it (Issue #4659).
  for (const name of manifests) {
    if (!SAFE_MANIFEST.test(name)) probeScript([name], "");
    let info: Deno.FileInfo | undefined;
    try {
      info = await lstatOrUndefined(`${options.cwd}/${name}`);
    } catch (error) {
      return {
        ok: false,
        error: new Error(
          `cannot inspect '${name}' in '${options.cwd}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
    if (info?.isSymlink) {
      return {
        ok: false,
        error: new Error(
          `refusing to run '${executable}': '${name}' in '${options.cwd}' is ` +
            `a symbolic link (Issue #4659)`,
        ),
      };
    }
  }

  let declared: Record<string, string>;
  try {
    declared = await (deps.credentials ?? gateCredentialSource)?.(
      options.cwd,
    ) ?? {};
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `the repository's quality_credentials could not be resolved ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      ),
    };
  }

  const buildEnv = (spawnable: readonly string[]) =>
    untrustedQualityCommandEnv({
      spawnable,
      cwd: options.cwd,
      repoCredentialEnv: declared,
      ...(deps.source === undefined ? {} : { source: deps.source }),
      ...(deps.trimRefused === undefined
        ? {}
        : { trimRefused: deps.trimRefused }),
      ...(deps.root === undefined ? {} : { root: deps.root }),
    });

  let privateTarget: string | undefined;
  try {
    let spawnable = await drop([executable, ...args]);
    if (untrustedAccountOf(spawnable) !== undefined) {
      const writesTarget = executable === "cargo" &&
        buildEnv(spawnable)["CARGO_TARGET_DIR"] === undefined;
      const probe = await drop([
        "sh",
        "-c",
        probeScript(
          manifests,
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
      const code = verdict.ok ? verdict.value.code : undefined;
      if (
        verdict.ok && code === PROBE_TARGET_UNWRITABLE &&
        !verdict.value.timedOut
      ) {
        // The tree can make its own `target` unwritable (a committed file), so
        // that never chooses the account: the account builds elsewhere.
        privateTarget = await Deno.makeTempDir({ prefix: "vibe_gate_target_" });
        await Deno.chmod(privateTarget, 0o777);
      } else if (!verdict.ok || code !== 0 || verdict.value.timedOut) {
        console.error(
          `[SECURITY] the untrusted account cannot use '${options.cwd}' — ` +
            `running '${executable}' as the worker with the allowlisted ` +
            `environment (Issues #4697, #4113)`,
        );
        spawnable = [executable, ...args];
      }
    }

    const env = {
      ...buildEnv(spawnable),
      ...(privateTarget === undefined
        ? {}
        : { CARGO_TARGET_DIR: privateTarget }),
    };
    const target = env["CARGO_TARGET_DIR"];
    const final = carryEnvThroughSudo(
      spawnable,
      target === undefined ? {} : { CARGO_TARGET_DIR: target },
    );
    const [command = "", ...commandArgs] = final;
    return await spawn(command, commandArgs, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env,
      clearEnv: true,
    });
  } finally {
    if (privateTarget !== undefined) {
      // What the account built is its own, so it empties the directory; the
      // worker made the directory and removes it.
      const [emptier = "", ...emptierArgs] = await drop([
        "find",
        privateTarget,
        "-mindepth",
        "1",
        "-delete",
      ]);
      await spawn(emptier, emptierArgs, {
        cwd: "/",
        timeoutMs: PROBE_TIMEOUT_MS,
        env: buildEnv([]),
        clearEnv: true,
      });
      await Deno.remove(privateTarget, { recursive: true }).catch(() => {});
    }
  }
}
