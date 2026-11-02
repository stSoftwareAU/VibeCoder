/**
 * Runs the repository's own gate commands as the untrusted account (Issue #4659).
 *
 * The milestone merge and resolution gates run a repository's own tasks: a
 * type check, a manifest check, a unit suite. Those tasks are the repository's
 * code, so they must not inherit the worker's environment. This module drops
 * the command to the `agent` account and builds its environment from the
 * allowlist of Issues #571, #572, #1214 and #2247, with the ephemeral build
 * cache placement carried through `sudo`. It is the same path
 * `spawnFastCheck` in `merge_fast_checks.ts` takes for the merge fast checks.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  carryEnvThroughSudo,
  untrustedAccountOf,
  untrustedQualityCommandEnv,
  untrustedSpawn,
} from "./quality_gate_phase.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/** How long the readability probe may run. */
const PROBE_TIMEOUT_MS = 15_000;

/** Injected seams for {@link runRepositoryCommand}. Production takes the defaults. */
export interface UntrustedGateSpawnDeps {
  /** Credentials explicitly declared for this repository. */
  repoCredentialEnv?: Record<string, string>;
  /** Spawns the dropped command. Injected in tests. */
  spawn?: typeof runWithTimeout;
  /** Drops the argv to the untrusted account. Injected in tests. */
  drop?: typeof untrustedSpawn;
  /** The environment the child is built from. Injected in tests. */
  source?: Record<string, string>;
  /** The launch's trim verdict. Injected in tests; production reads the launch's. */
  trimRefused?: boolean;
  /** Where the ephemeral target directories live. Injected in tests. */
  root?: string;
}

/** The shell that reads the declared credentials from stdin, then execs the gate. */
const CREDENTIAL_WRAPPER = "while IFS= read -r l; do n=${l%%=*}; " +
  'v=$(printf %s "${l#*=}" | base64 -d; printf x); export "$n=${v%x}"; ' +
  'done; exec "$@" </dev/null';

/** A credential name that may become an environment variable name. */
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Base64 of the UTF-8 bytes of `value`, so a value carries no newline or quote. */
function base64Utf8(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * The argv that runs `executable` with the declared credentials, plus the
 * stdin text that carries them. The values travel on stdin, never in argv: the
 * process table shows an argv, and sudo stays resident as the gate's parent
 * for the whole run. `sh` reads one `NAME=base64` line per credential after
 * sudo's `env_reset` has run, exports it, then execs the command.
 *
 * @throws When a name is not a plain identifier.
 */
export function credentialCarryingCommand(
  entries: ReadonlyArray<readonly [string, string]>,
  executable: string,
  args: readonly string[],
): { argv: string[]; input: string } {
  for (const [name] of entries) {
    if (!CREDENTIAL_NAME.test(name)) {
      throw new Error("Invalid repository credential environment name");
    }
  }
  return {
    argv: ["sh", "-c", CREDENTIAL_WRAPPER, "sh", executable, ...args],
    input: entries.map(([name, value]) => `${name}=${base64Utf8(value)}\n`)
      .join(""),
  };
}

/**
 * The file and directory modes the dropped account must have on the checkout
 * before its gate result can mean anything. A command that cannot see the
 * project can exit 0 ("No matching files found") or fail for the wrong reason,
 * so neither result is evidence about the tree.
 */
function readabilityProbe(cwd: string, manifests: readonly string[]): string[] {
  const probe = ["test", "-r", cwd, "-a", "-x", cwd];
  for (const manifest of manifests) {
    probe.push("-a", "-r", `${cwd}/${manifest}`);
  }
  return probe;
}

/**
 * The manifest files whose readability proves the dropped account can see a
 * project of this kind. A Deno project is a `deno.json` or `deno.jsonc`,
 * whichever the worker finds on disk.
 */
export async function manifestsFor(
  kind: "deno" | "cargo" | "script",
  dir: string,
): Promise<string[]> {
  if (kind === "cargo") return ["Cargo.toml"];
  if (kind === "script") return ["quality.sh"];
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      if ((await Deno.stat(`${dir}/${name}`)).isFile) return [name];
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return [];
}

/**
 * Run one of the repository's own gate commands as the untrusted account.
 *
 * Mirrors `spawnFastCheck` in `merge_fast_checks.ts` (Issue #4659). Unlike
 * `spawnFastCheck`, an unavailable `agent` account does not throw here:
 * `untrustedSpawn` already falls back to running as the worker on an image that
 * predates the account, so the issue's "where the image provides one" holds.
 *
 * Only explicitly declared repository credentials are added to the allowlist.
 * Under `sudo` they reach the child on stdin (see
 * {@link credentialCarryingCommand}), never in argv.
 *
 * Fails closed: when the command is dropped to another account, that account
 * must be able to read the checkout and the named manifests first. Otherwise
 * the result is an error, because a check that could not see the tree says
 * nothing about it (the shared clone, Issue #4697).
 *
 * @param executable - The program to run, e.g. `cargo` or the Deno binary.
 * @param args - The argv after the executable.
 * @param options.cwd - The checkout the command runs in.
 * @param options.timeoutMs - How long the command may run.
 * @param options.manifests - Files under `cwd` the dropped account must read.
 * @param deps - Injected seams; production omits them.
 * @returns The subprocess result from `runWithTimeout`.
 */
export async function runRepositoryCommand(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; manifests?: readonly string[] },
  deps: UntrustedGateSpawnDeps = {},
): ReturnType<typeof runWithTimeout> {
  const entries = Object.entries(deps.repoCredentialEnv ?? {});
  for (const [name] of entries) {
    if (!CREDENTIAL_NAME.test(name)) {
      throw new Error("Invalid repository credential environment name");
    }
  }
  const drop = deps.drop ?? untrustedSpawn;
  const spawn = deps.spawn ?? runWithTimeout;
  let dropped = await drop([executable, ...args]);
  const account = untrustedAccountOf(dropped);
  let input: string | undefined;
  if (account !== undefined && entries.length > 0) {
    const carrying = credentialCarryingCommand(entries, executable, args);
    dropped = await drop(carrying.argv);
    input = carrying.input;
  }
  const env = untrustedQualityCommandEnv({
    spawnable: dropped,
    cwd: options.cwd,
    repoCredentialEnv: deps.repoCredentialEnv ?? {},
    ...(deps.source === undefined ? {} : { source: deps.source }),
    ...(deps.trimRefused === undefined
      ? {}
      : { trimRefused: deps.trimRefused }),
    ...(deps.root === undefined ? {} : { root: deps.root }),
  });
  const target = env["CARGO_TARGET_DIR"];
  const command = carryEnvThroughSudo(
    dropped,
    target === undefined ? {} : { CARGO_TARGET_DIR: target },
  );
  if (account !== undefined) {
    const probe = carryEnvThroughSudo(
      await drop(readabilityProbe(options.cwd, options.manifests ?? [])),
      {},
    );
    const seen = await spawn(probe[0]!, probe.slice(1), {
      cwd: options.cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
      env: {},
      clearEnv: true,
    });
    if (!seen.ok || seen.value.code !== 0) {
      return {
        ok: false,
        error: new Error(
          `the '${account}' account cannot read '${options.cwd}'` +
            `${
              (options.manifests ?? []).length > 0
                ? ` or ${(options.manifests ?? []).join(", ")}`
                : ""
            } — the repository's check was not run, so nothing verified ` +
            `the tree (Issue #4697)`,
        ),
      };
    }
  }
  return spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env,
    clearEnv: true,
    ...(input === undefined ? {} : { input }),
    ...(entries.length === 0
      ? {}
      : { commandLabel: "repository gate (declared credentials redacted)" }),
  });
}
