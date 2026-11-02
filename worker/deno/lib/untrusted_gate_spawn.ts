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
  untrustedQualityCommandEnv,
  untrustedSpawn,
} from "./quality_gate_phase.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/** Injected seams for {@link runRepositoryCommand}. Production takes the defaults. */
export interface UntrustedGateSpawnDeps {
  /** Spawns the dropped command. Injected in tests. */
  spawn?: typeof runWithTimeout;
  /** Drops the argv to the untrusted account. Injected in tests. */
  drop?: typeof untrustedSpawn;
  /** The environment the child is built from. Injected in tests. */
  source?: Record<string, string>;
}

/**
 * Run one of the repository's own gate commands as the untrusted account.
 *
 * Mirrors `spawnFastCheck` in `merge_fast_checks.ts` (Issue #4659). Unlike
 * `spawnFastCheck`, an unavailable `agent` account does not throw here:
 * `untrustedSpawn` already falls back to running as the worker on an image that
 * predates the account, so the issue's "where the image provides one" holds.
 *
 * Declared `quality_credentials` are not threaded to the milestone sync path,
 * so a task that needs one fails rather than running with the worker's whole
 * environment.
 *
 * @param executable - The program to run, e.g. `cargo` or the Deno binary.
 * @param args - The argv after the executable.
 * @param options.cwd - The checkout the command runs in.
 * @param options.timeoutMs - How long the command may run.
 * @param deps - Injected seams; production omits them.
 * @returns The subprocess result from `runWithTimeout`.
 */
export async function runRepositoryCommand(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
  deps: UntrustedGateSpawnDeps = {},
): ReturnType<typeof runWithTimeout> {
  const dropped = await (deps.drop ?? untrustedSpawn)([executable, ...args]);
  const env = untrustedQualityCommandEnv({
    spawnable: dropped,
    cwd: options.cwd,
    repoCredentialEnv: {},
    ...(deps.source === undefined ? {} : { source: deps.source }),
  });
  const target = env["CARGO_TARGET_DIR"];
  const command = carryEnvThroughSudo(
    dropped,
    target === undefined ? {} : { CARGO_TARGET_DIR: target },
  );
  return (deps.spawn ?? runWithTimeout)(command[0]!, command.slice(1), {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    env,
    clearEnv: true,
  });
}
