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
 *   2. redacts secrets from the published body arguments
 *      (`redactGhBodyArgs`, Issue #3707), then
 *   3. journals the mutation to the tamper-evident audit log
 *      (`auditGhMutation`) once the exit code is known.
 *
 * A quality-gate check (`gh_spawn_chokepoint_check.ts`) fails the build on any
 * direct `new Deno.Command("gh", …)` outside this file, so the invariant
 * cannot silently rot again.
 *
 * ```mermaid
 * flowchart LR
 *     C["~20 caller modules"] --> S["spawnGh()"]
 *     S --> A["enforceGhWriteAllowlist<br/>(allowlist, fail closed)"]
 *     A -->|allowed| R["redactGhBodyArgs<br/>(public body args)"]
 *     R --> P["gh subprocess"]
 *     A -->|refused| E["throw — no subprocess"]
 *     P --> J["auditGhMutation<br/>(audit journal)"]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { getGhTokenForSubprocess } from "./github_app_auth.ts";
import { enforceGhWriteAllowlist } from "./write_repo_allowlist.ts";
import { auditGhMutation } from "./audit_hook.ts";
import { redactGhBodyArgs } from "./gh_body_redaction.ts";

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
  /** Abort signal — used by the timeout wrapper in `gh_wrapper.ts`. */
  signal?: AbortSignal;
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
 * Run `gh` through the worker's chokepoint.
 *
 * Enforces the write-repo allowlist before the process starts (so a refused
 * write never reaches GitHub) and journals the mutation afterwards. Never
 * throws on a non-zero exit — inspect {@link GhSpawnResult.success}.
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
  const result = await runner(redactGhBodyArgs(args), options);
  // Best-effort — never lets journalling alter or abort the gh call.
  await auditGhMutation(args, result.code);
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
