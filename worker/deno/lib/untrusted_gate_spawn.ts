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
 * Access failures leave commands to CI and never select the worker account.
 * A refusal names the topmost directory the account cannot traverse (Issue #4733).
 * Only the absence of an agent account selects the restricted worker
 * environment. Declared credentials cannot, and neither can tree-controlled
 * layouts or permissions. Declared credentials reach an agent command through
 * the stdin channel of credential_channel.ts (Issue #4705).
 * Unwritable cargo targets use the configured, persistent per-account cache.
 *
 * Australian English spelling used throughout.
 */

import {
  carryEnvThroughSudo,
  untrustedAccountOf,
  untrustedQualityCommandEnv,
  untrustedSpawn,
} from "./quality_gate_phase.ts";
import {
  carryCredentialsThroughSudo,
  credentialChannelFault,
} from "./credential_channel.ts";
import type { ChannelledCommand } from "./credential_channel.ts";
import { cargoTargetDirForCheckout } from "./ephemeral_build_cache.ts";
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

/** A host access probe could not safely run the command as the chosen account. */
export class GateAccountUnavailable extends Error {}

/** Injection seams for {@link runRepositoryCommand}. Production omits them. */
export interface UntrustedGateSpawnDeps {
  spawn?: typeof runWithTimeout;
  drop?: typeof untrustedSpawn;
  source?: Record<string, string>;
  trimRefused?: boolean;
  root?: string;
  /** Root for the probe-exit-2 fallback, independent of trim placement. */
  privateTargetRoot?: string;
  workerUid?: () => Promise<number>;
  /** The repository's declared credentials. Default: the registered source. */
  credentials?: GateCredentialSource;
}

/** The probe exits with this when the account cannot read the checkout. */
const PROBE_UNREADABLE = 1;

/** The probe exits with this when the account cannot write the cargo target. */
const PROBE_TARGET_UNWRITABLE = 2;

/** Project access can be shaped by the tree; never use it to select an account. */
const PROBE_CHECKOUT_UNWRITABLE = 3;

/** The probe is a few `test` and `find` calls. Seconds. */
const PROBE_TIMEOUT_MS = 15_000;

async function workerUid(deps: UntrustedGateSpawnDeps): Promise<number> {
  if (deps.workerUid) return await deps.workerUid();
  const uid = await runWithTimeout("id", ["-u"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const value = uid.ok ? uid.value.stdout.trim() : "";
  if (
    !uid.ok || uid.value.code !== 0 || uid.value.timedOut ||
    !/^\d+$/.test(value)
  ) {
    throw new Error("cannot determine worker uid");
  }
  return Number(value);
}

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
    ? `[ -z "$(find "$1/target" ! -exec test -w {} \\; -print -quit)" ]`
    : `test -w "$1"`;
}

/**
 * Prints the topmost ancestor of `$1` the account cannot traverse, or nothing.
 * It walks down from `/`: a deeper `test -x` fails for every descendant of a
 * blocked ancestor, so only the first failure is the cause (Issue #4733).
 * Read-only POSIX sh; `$1` is an argument and is never embedded in the text.
 */
const TRAVERSAL_WALK =
  `( IFS=/; set -f; p=; for c in $1; do [ -n "$c" ] || continue; p="$p/$c"; [ -x "$p" ] || { printf '%s\\n' "$p"; break; }; done )`;

/**
 * The directory a probe named as untraversable, or undefined when its stdout
 * is not one plausible absolute path. The first line, trimmed, must start with
 * `/`, hold no control characters, and be at most 300 characters (Issue #4733).
 */
function blockedDirectoryOf(stdout: string): string | undefined {
  const line = (stdout.split("\n")[0] ?? "").trim();
  if (!line.startsWith("/") || line.length > 300) return undefined;
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return line;
}

/**
 * The probe script. `$1` is the checkout and is passed as an argument, never
 * interpolated, so a path cannot change the script.
 *
 * @throws When a manifest name is not a plain file name.
 */
function probeScript(
  manifests: readonly string[],
  tail: string,
  requireWritable = true,
): string {
  const reads = manifests.map((name) => {
    if (!SAFE_MANIFEST.test(name)) {
      throw new Error(
        `refusing to probe manifest '${name}': only a plain file name may be ` +
          `embedded in the probe (Issue #4659)`,
      );
    }
    return ` -a -r "$1/${name}"`;
  });
  const readable = `${TRAVERSAL_WALK}; test -r "$1" -a -x "$1"${
    reads.join("")
  } || exit ${PROBE_UNREADABLE}${
    requireWritable ? `; test -w "$1" || exit ${PROBE_CHECKOUT_UNWRITABLE}` : ""
  }`;
  return tail === ""
    ? readable
    : `${readable}; ${tail} || exit ${PROBE_TARGET_UNWRITABLE}`;
}

/**
 * Run a repository command with the allowlisted environment and explicitly
 * declared credentials, as `agent` when it can use the checkout. Declared
 * credentials cross sudo's environment reset on the stdin channel (Issue
 * #4705), so they never select the worker account.
 *
 * The account is probed with a command of its own. Access faults leave the
 * command to CI, without changing its account. A refusal names the topmost
 * directory the account cannot traverse, when the probe reports one.
 *
 * @param executable - The command, e.g. `cargo` or `deno`.
 * @param args - Its arguments.
 * @param options.cwd - The checkout the command runs in.
 * @param options.timeoutMs - The budget for the command itself.
 * @param options.manifests - Files the command reads from the checkout; each
 *   must be readable by the account the command runs as.
 * @param options.requireWritableCheckout - Whether the account must also be able
 *   to write `cwd` (default `true`). A read-only command, such as the merge fast
 *   checks, sets `false`: sub-directories of a clone are readable but not
 *   writable by `agent` (Issue #4782). The cargo target check still runs.
 * @param deps - Injection seams. Production omits them.
 * @returns The spawn result of the command.
 * @throws When a manifest name is not a plain file name.
 */
export async function runRepositoryCommand(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    manifests?: readonly string[];
    requireWritableCheckout?: boolean;
  },
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
    if (info && info.uid !== null) {
      const ownerUid = await workerUid(deps);
      if (info.uid !== ownerUid) {
        return {
          ok: false,
          error: new Error(
            `refusing to run '${executable}': '${name}' is not owned by the worker (Issue #4659)`,
          ),
        };
      }
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
  {
    const spawnable = await drop([executable, ...args]);
    if (untrustedAccountOf(spawnable) !== undefined) {
      const writesTarget = executable === "cargo" &&
        buildEnv(spawnable)["CARGO_TARGET_DIR"] === undefined;
      const probe = await drop([
        "sh",
        "-c",
        probeScript(
          manifests,
          writesTarget ? await targetWriteCheck(options.cwd) : "",
          options.requireWritableCheckout ?? true,
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
        if (deps.privateTargetRoot !== undefined) {
          try {
            try {
              await Deno.mkdir(deps.privateTargetRoot);
            } catch (error) {
              if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
            }
            const root = await Deno.lstat(deps.privateTargetRoot);
            if (
              !root.isDirectory || root.uid === null ||
              root.uid !== await workerUid(deps)
            ) {
              throw new Error("private target is not a worker-owned directory");
            }
            await Deno.chmod(deps.privateTargetRoot, 0o1777);
          } catch {
            return {
              ok: false,
              error: new GateAccountUnavailable(
                `cannot provision private cargo target '${deps.privateTargetRoot}' — left to CI (Issue #4697)`,
              ),
            };
          }
        }
        privateTarget = cargoTargetDirForCheckout(options.cwd, {
          root: deps.privateTargetRoot ?? deps.root ??
            `${options.cwd}/.vibe-cargo-target`,
          account: untrustedAccountOf(spawnable)!,
        });
      } else if (!verdict.ok || code !== 0 || verdict.value.timedOut) {
        // Only the unreadable verdict says which directory blocks the account.
        const blocked = verdict.ok && code === PROBE_UNREADABLE &&
            !verdict.value.timedOut
          ? blockedDirectoryOf(verdict.value.stdout)
          : undefined;
        const cause = `probe ${code ?? "failed"}`;
        const reason = blocked === undefined
          ? cause
          : `${cause}; cannot traverse '${blocked}'`;
        return {
          ok: false,
          error: new GateAccountUnavailable(
            `untrusted account cannot use '${options.cwd}' (${reason}) — left to CI (Issue #4659)`,
          ),
        };
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
    let channelled: ChannelledCommand;
    try {
      channelled = carryCredentialsThroughSudo(final, declared);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    const [command = "", ...commandArgs] = channelled.argv;
    const result = await spawn(command, commandArgs, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env,
      clearEnv: true,
      stdin: channelled.stdin,
    });
    const fault = result.ok && channelled.stdin !== undefined
      ? credentialChannelFault(result.value)
      : undefined;
    if (fault !== undefined) {
      return {
        ok: false,
        error: new GateAccountUnavailable(
          `the repository's declared quality_credentials could not be ` +
            `delivered to the untrusted account (${fault}) — left to CI ` +
            `(Issue #4705)`,
        ),
      };
    }
    return result;
  }
}
