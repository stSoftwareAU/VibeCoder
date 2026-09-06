/**
 * The single `gh` subprocess chokepoint for the worker process (Issue #3703).
 *
 * `write_repo_allowlist.ts` documents `runGhCommandRaw` as the one place every
 * worker `gh` write flows through, but ~20 modules spawned `gh` with their own
 * `new Deno.Command("gh", …)`, so remote branch deletion, PR merge, issue
 * close and branch-protection rewrites skipped both the write-repo allowlist
 * and the audit journal. This module is that chokepoint made real: it is the
 * only place in `worker/deno/` permitted to spawn `gh`, and it always
 *
 *   1. enforces the per-run write-repo allowlist (`enforceGhWriteAllowlist`)
 *      *before* the process starts,
 *   2. redacts secrets from every published body — the arguments
 *      (`redactGhBodyArgs`, Issue #3707), the `--body-file` / `--input` files
 *      they name, and the body piped on stdin (Issue #1254) — then
 *   3. journals the mutation to the tamper-evident audit log
 *      (`auditGhMutation`) once the exit code is known, and
 *   4. notes an issue close/reopen (`noteGhIssueClose`, Issue #181) so the
 *      stale scan-cache entries are dropped and the run never re-claims an
 *      issue it just closed.
 *
 * Every call also runs under a **default** timeout (`gh_timeout.ts`,
 * Issue #1229) unless the caller installs its own signal — a control at the
 * chokepoint is one no new caller can forget, and a stalled GitHub call no
 * longer hangs the run until the host is killed.
 *
 * A quality-gate check (`gh_spawn_chokepoint_check.ts`) fails the build on any
 * direct `new Deno.Command("gh", …)` outside this file, so the invariant
 * cannot silently rot again.
 *
 * ```mermaid
 * flowchart LR
 *     C["~20 caller modules"] --> S["spawnGh()"]
 *     S --> A["enforceGhWriteAllowlist<br/>(allowlist, fail closed)"]
 *     A -->|allowed| R["redactGhBodyArgs + redactSecrets<br/>(argv, body files, stdin)"]
 *     R --> P["gh subprocess"]
 *     A -->|refused| E["throw — no subprocess"]
 *     P --> J["auditGhMutation<br/>(audit journal)"]
 *     J --> N["noteGhIssueClose<br/>(cache + run registry)"]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { getGhTokenForSubprocess } from "./github_app_auth.ts";
import {
  type EnsureGhConfigDirOptions,
  ensureUsableGhConfigDir,
  isGhAuthMissingFailure,
  MAX_RESTAGE_ATTEMPTS,
} from "./gh_credential_stage.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { enforceGhWriteAllowlist } from "./write_repo_allowlist.ts";
import { auditGhMutation } from "./audit_hook.ts";
import { redactGhBodyArgs } from "./gh_body_redaction.ts";
import { denoBodyFileReader, denoBodyFileWriter } from "./gh_body_file_io.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { noteGhIssueClose } from "./issue_close_notifier.ts";
import {
  getGhTimeoutForOperation,
  GH_TIMEOUT_EXIT_CODE,
} from "./gh_timeout.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";

/** Options for a single `gh` invocation. */
export interface GhSpawnOptions {
  /** Text piped to the process's stdin (for `gh api --input -`). */
  stdin?: string;
  /** Capture stdout (default) or discard it. */
  stdout?: "piped" | "null";
  /** Capture stderr (default) or discard it. */
  stderr?: "piped" | "null";
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Extra environment variables, merged over the resolved `gh` environment. */
  env?: Record<string, string>;
  /**
   * Abort signal — used by the timeout wrapper in `gh_wrapper.ts`.
   *
   * Supplying one replaces the chokepoint's own default timeout, and its
   * abort propagates to the caller as an `AbortError` rather than being
   * converted to {@link GH_TIMEOUT_EXIT_CODE}: the caller owns the deadline
   * it installed.
   */
  signal?: AbortSignal;
  /**
   * Override the default timeout in seconds (Issue #1229).
   *
   * Ignored when {@link GhSpawnOptions.signal} is supplied. Without either,
   * `getGhTimeoutForOperation` picks the budget from the arguments, so no
   * `gh` call runs unbounded.
   */
  timeoutSeconds?: number;
  /**
   * Host roots the credential re-stage reads (Issue #967) — `GH_CONFIG_DIR`,
   * `HOME`, `VIBE_STATE_DIR`, `VIBE_SCRATCH_DIR` and `TMPDIR`. Defaults to the
   * process environment, so production callers pass nothing; a test hands in a
   * fixed map rather than moving the roots every parallel worker shares.
   *
   * Unrelated to {@link GhSpawnOptions.env}, which is the subprocess's own
   * environment.
   */
  hostEnv?: EnvLookup;
  /**
   * Establishes the re-staged `GH_CONFIG_DIR` in the run environment;
   * defaults to `Deno.env.set`, which is what every later `gh` and `git`
   * child inherits.
   */
  setHostEnv?: (name: string, value: string) => void;
}

/** Outcome of a `gh` invocation. */
export interface GhSpawnResult {
  /** Process exit code. */
  code: number;
  /** Whether the process exited zero. */
  success: boolean;
  /** Decoded stdout (empty when discarded). */
  stdout: string;
  /** Decoded stderr (empty when discarded). */
  stderr: string;
}

/** The low-level runner — replaceable in tests via {@link _setGhSpawnRunner}. */
export type GhSpawnRunner = (
  args: readonly string[],
  options: GhSpawnOptions,
) => Promise<GhSpawnResult>;

/**
 * Build the environment for a `gh` subprocess.
 *
 * When GitHub App authentication is configured, injects `GH_TOKEN` for this
 * subprocess only (Issue #959); otherwise returns `undefined` so the process
 * inherits ambient OAuth auth.
 */
export async function buildGhEnv(): Promise<
  Record<string, string> | undefined
> {
  const token = await getGhTokenForSubprocess(
    Deno.env.get("GITHUB_APP_ID"),
    Deno.env.get("GITHUB_APP_INSTALLATION_ID"),
    Deno.env.get("GITHUB_APP_PRIVATE_KEY_PATH"),
  );
  if (!token) return undefined;

  const env: Record<string, string> = { ...Deno.env.toObject() };
  env["GH_TOKEN"] = token;
  return env;
}

/**
 * Decode a finished command's output into a {@link GhSpawnResult}.
 *
 * Deno's `CommandOutput.stdout`/`.stderr` getters THROW when the stream was
 * opened with `"null"` (Issue #3748), so a discarded stream must never be
 * read — it decodes to `""` per the `GhSpawnResult` contract.
 */
function decodeOutput(
  output: Deno.CommandOutput,
  options: GhSpawnOptions,
): GhSpawnResult {
  const decoder = new TextDecoder();
  return {
    code: output.code,
    success: output.code === 0,
    stdout: (options.stdout ?? "piped") === "piped"
      ? decoder.decode(output.stdout)
      : "",
    stderr: (options.stderr ?? "piped") === "piped"
      ? decoder.decode(output.stderr)
      : "",
  };
}

/** Production runner — the only `gh` spawn in the worker process. */
const productionRunner: GhSpawnRunner = async (args, options) => {
  const baseEnv = await buildGhEnv();
  const env = options.env
    ? { ...(baseEnv ?? Deno.env.toObject()), ...options.env }
    : baseEnv;
  const command = new Deno.Command("gh", {
    args: [...args],
    stdin: options.stdin !== undefined ? "piped" : "null",
    stdout: options.stdout ?? "piped",
    stderr: options.stderr ?? "piped",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(env ? { env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (options.stdin === undefined) {
    return decodeOutput(await command.output(), options);
  }

  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(options.stdin));
  await writer.close();
  return decodeOutput(await child.output(), options);
};

let runner: GhSpawnRunner = productionRunner;

/**
 * Re-stagings this process has performed (Issue #564).
 *
 * Bounded by {@link MAX_RESTAGE_ATTEMPTS}: a credential that keeps vanishing
 * is a fault to report, and a revoked token must fail rather than re-stage on
 * every call for the rest of the run.
 */
let restageAttempts = 0;

/** Reset the re-stage budget. Tests only. */
export function resetGhRestageAttempts(): void {
  restageAttempts = 0;
}

/**
 * Run the low-level runner under a default timeout (Issue #1229).
 *
 * Every attempt gets a freshly armed signal, so the re-stage retry is not
 * handed the remains of the first attempt's budget. A caller that supplied
 * its own `signal` keeps it, and its abort still surfaces as an `AbortError`
 * — `gh_wrapper.ts` converts that into its own timeout result.
 *
 * A timeout fails loud rather than silently: exit
 * {@link GH_TIMEOUT_EXIT_CODE} with a `TIMEOUT:` stderr naming the command
 * and its budget, which `runGhOrThrow` turns into a thrown error.
 *
 * @param args - Redacted arguments passed to the `gh` binary.
 * @param options - Subprocess options, minus the per-attempt signal.
 * @returns The runner's outcome, or the timeout result.
 */
async function runWithTimeout(
  args: readonly string[],
  options: GhSpawnOptions,
): Promise<GhSpawnResult> {
  if (options.signal) return await runner(args, options);

  const timeoutSeconds = options.timeoutSeconds ??
    getGhTimeoutForOperation(args);
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  try {
    return await runner(args, { ...options, signal });
  } catch (error: unknown) {
    if (!signal.aborted) throw error;
    incrementCounter("gh_timeouts");
    return {
      code: GH_TIMEOUT_EXIT_CODE,
      success: false,
      stdout: "",
      stderr: `TIMEOUT: gh ${
        args.join(" ")
      } timed out after ${timeoutSeconds}s (Issue #1229)`,
    };
  }
}

/**
 * The retry's options, with any explicit `GH_CONFIG_DIR` refreshed.
 *
 * Callers that pin the directory per call (`setup/*`, the escalation paths)
 * would otherwise retry against the same broken copy the re-stage replaced.
 */
function withStagedGhConfigDir(
  options: GhSpawnOptions,
  hostEnv: EnvLookup,
): GhSpawnOptions {
  if (options.env?.GH_CONFIG_DIR === undefined) return options;
  const staged = hostEnv("GH_CONFIG_DIR");
  if (staged === undefined) return options;
  return { ...options, env: { ...options.env, GH_CONFIG_DIR: staged } };
}

/**
 * Run `gh` through the worker's chokepoint.
 *
 * Enforces the write-repo allowlist before the process starts (so a refused
 * write never reaches GitHub), applies the default timeout for the operation
 * (Issue #1229) and journals the mutation afterwards. Never throws on a
 * non-zero exit — inspect {@link GhSpawnResult.success}; a timed-out call
 * comes back as {@link GH_TIMEOUT_EXIT_CODE} with a `TIMEOUT:` stderr.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @param options - Subprocess options.
 * @throws WriteRepoBlockedError | WriteTargetUndeterminableError when the
 *   write is refused by the allowlist.
 */
export async function spawnGh(
  args: readonly string[],
  options: GhSpawnOptions = {},
): Promise<GhSpawnResult> {
  await enforceGhWriteAllowlist(args);
  // Mask secrets in the published body arguments (Issue #3707) — the last
  // point before a comment or PR body leaves the worker for GitHub.
  //
  // The reader and writer are the same pair the agent's guard child supplies
  // (Issue #1254), so a `--body-file` / `-F <path>` / `--input <file>` body is
  // scanned here too instead of published unread. An unscannable body raises
  // UnredactableBodyError, which propagates: a failed control fails the call.
  const stdinScanned = options.stdin !== undefined;
  const redacted = redactGhBodyArgs(
    args,
    denoBodyFileReader,
    denoBodyFileWriter,
    stdinScanned,
  );
  // A stdin body (`gh api … --input -`) never appears in argv, so the argument
  // redactor cannot see it — mask it here, at the same chokepoint.
  const spawnOptions = stdinScanned
    ? { ...options, stdin: redactSecrets(options.stdin as string) }
    : options;
  let result = await runWithTimeout(redacted, spawnOptions);
  // Issue #564: a call that failed for want of authentication did nothing,
  // so retrying it is safe — and the credential is very likely recoverable.
  // The writable copy of `hosts.yml` went missing mid-run once already and
  // every later call failed with the intact original still on its mount.
  // Rebuild from the mount and try once more, here at the chokepoint, so
  // every gh caller in the worker inherits the recovery.
  if (
    isGhAuthMissingFailure(result) && restageAttempts < MAX_RESTAGE_ATTEMPTS
  ) {
    restageAttempts++;
    const hostEnv = options.hostEnv ?? processEnvLookup;
    const staging: EnsureGhConfigDirOptions = {
      env: hostEnv,
      ...(options.setHostEnv ? { setEnv: options.setHostEnv } : {}),
    };
    if (ensureUsableGhConfigDir(staging)) {
      result = await runWithTimeout(
        redacted,
        withStagedGhConfigDir(spawnOptions, hostEnv),
      );
    }
  }
  // Best-effort — never lets journalling alter or abort the gh call.
  await auditGhMutation(args, result.code);
  // Issue #181: a close the worker just performed invalidates the scan-cache
  // entries that still describe the issue as open, and marks it finished for
  // the rest of the run so no slot re-claims it. Also best-effort.
  await noteGhIssueClose(args, result.code);
  return result;
}

/**
 * Run `gh` through the chokepoint and return stdout, throwing on failure.
 *
 * The convenience form used by the callers that previously had their own
 * `defaultGhCommand`.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @param options - Subprocess options.
 * @returns Decoded stdout.
 * @throws Error on a non-zero exit, carrying the exit code and stderr.
 */
export async function runGhOrThrow(
  args: readonly string[],
  options: GhSpawnOptions = {},
): Promise<string> {
  const { code, success, stdout, stderr } = await spawnGh(args, options);
  if (!success) {
    throw new Error(
      `gh command failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout;
}

/** Replace the low-level runner. Test-only. */
export function _setGhSpawnRunner(fn: GhSpawnRunner): void {
  runner = fn;
}

/** Restore the production runner. Test-only. */
export function _resetGhSpawnRunner(): void {
  runner = productionRunner;
}
