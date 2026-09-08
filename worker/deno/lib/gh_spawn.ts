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
 *      (`auditGhMutation`) once the exit code is known, and
 *   4. notes an issue close/reopen (`noteGhIssueClose`, Issue #181) so the
 *      stale scan-cache entries are dropped and the run never re-claims an
 *      issue it just closed.
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
import {
  enforceGhWriteAllowlist,
  installationTokenRepoScope,
} from "./write_repo_allowlist.ts";
import { auditGhMutation } from "./audit_hook.ts";
import {
  type BodyFileWriter,
  redactGhBodyArgs,
  redactGhBodyText,
} from "./gh_body_redaction.ts";
// The same reader/writer pair the agent's guard child supplies (Issue #1254),
// so the two chokepoints cannot drift on which body classes get scanned.
import { bodyFileWriterIn, denoBodyFileReader } from "./gh_body_file_io.ts";
import { noteGhIssueClose } from "./issue_close_notifier.ts";
import { recordGhCall } from "./gh_call_metrics.ts";
import {
  isPrimaryQuotaLatched,
  isPrimaryRateLimitMessage,
  isQuotaExemptGhCall,
  primaryQuotaSkipMessage,
} from "./primary_quota_latch.ts";

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
  /**
   * Run even while the primary GraphQL quota is latched (Issue #1485).
   * Only the quota probe that learns the reset may set this — it is the
   * one GraphQL call that lifts the latch rather than burning against it.
   */
  bypassQuotaLatch?: boolean;
  /**
   * Where the shared rate-limit signal is written when this call is the one
   * that discovers the primary quota is exhausted (Issue #1540). Defaults to
   * the `WORK_DIR` the run driver exports; `runGhCommandRaw` threads its own
   * override through here.
   */
  workDir?: string;
}

/**
 * What the chokepoint reports when a GraphQL-backed call comes back refused
 * for want of primary quota (Issue #1540).
 */
export interface PrimaryQuotaRefusal {
  /** The `gh` arguments that were refused. */
  args: readonly string[];
  /** The refusal as `gh` printed it. */
  stderr: string;
  /** The caller's signal directory override, when it gave one. */
  workDir?: string;
}

/**
 * Registered by `github.ts` at load: probes the reset, latches the process
 * and writes the shared rate-limit signal (Issue #42). A hook rather than an
 * import because `github.ts` imports this module. Null until registered, so
 * a tool or test that never loads `github.ts` spawns exactly as before.
 */
export type PrimaryQuotaExhaustionHook = (
  refusal: PrimaryQuotaRefusal,
) => Promise<void>;

let quotaExhaustionHook: PrimaryQuotaExhaustionHook | null = null;

/**
 * Install the exhaustion hook the chokepoint calls on the first refusal
 * (Issue #1540). `github.ts` registers the production one at module load.
 */
export function setPrimaryQuotaExhaustionHook(
  hook: PrimaryQuotaExhaustionHook | null,
): void {
  quotaExhaustionHook = hook;
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
 *
 * The token is minted **scoped to the run's write-repo allowlist**
 * (Issue #1391) — the credential handed to the subprocess cannot reach a repo
 * this run may not write to, so a write that gets past
 * `enforceGhWriteAllowlist` is still refused by GitHub. Before a run seeds an
 * allowlist the scope is `null` and the token keeps the installation's full
 * reach, matching the allowlist's own fail-open-until-seeded rule.
 */
export async function buildGhEnv(): Promise<
  Record<string, string> | undefined
> {
  const token = await mintRunScopedGhToken();
  if (!token) return undefined;

  const env: Record<string, string> = { ...Deno.env.toObject() };
  env["GH_TOKEN"] = token;
  return env;
}

/** Mints the credential a subprocess authenticates with. Injectable for tests. */
export type GhTokenMinter = () => Promise<string | undefined>;

/**
 * Mint an installation token scoped to the run's write-repo allowlist.
 *
 * The one place that decides how a run-scoped credential is obtained, shared
 * by {@link buildGhEnv} (the worker's own `gh` calls) and
 * {@link withRunScopedGhToken} (the coding agent's). Two copies of this would
 * be two scopes to keep in step, and the one that drifted would be the one
 * handed to the agent.
 */
export function mintRunScopedGhToken(): Promise<string | undefined> {
  return getGhTokenForSubprocess(
    Deno.env.get("GITHUB_APP_ID"),
    Deno.env.get("GITHUB_APP_INSTALLATION_ID"),
    Deno.env.get("GITHUB_APP_PRIVATE_KEY_PATH"),
    undefined,
    installationTokenRepoScope(),
  );
}

/**
 * Overlay a run-scoped `GH_TOKEN` onto an ALREADY-SANITISED child environment
 * (Issue #1423).
 *
 * The write-repo allowlist defends in two layers: the argv classifier refuses
 * an off-allowlist write before `gh` is spawned, and — since Issue #1391 —
 * the credential itself cannot reach beyond the run's scope, so a write that
 * gets past the classifier is still refused by GitHub. The second layer
 * existed only for the worker's own calls. The coding agent's `gh` runs
 * through the PATH shim (`gh_guard_shim.ts`) and never reached
 * {@link buildGhEnv}, so it authenticated with whatever ambient credential
 * was staged for the container — the installation's full reach. For the one
 * component driven by untrusted issue and comment text, only layer one
 * applied.
 *
 * This is deliberately NOT `buildGhEnv` (Issue #1423). That function builds
 * its environment from `Deno.env.toObject()` — the worker's WHOLE
 * environment, `GITHUB_APP_PRIVATE_KEY_PATH` among it. Handing that to the
 * agent would undo every exclusion `agent_env.ts`/`claude_env.ts` make and
 * put the PEM that mints installation tokens in reach of a prompt-injected
 * shell: a far worse leak than the scoping gap being closed. So the caller's
 * sanitised environment is the base, and exactly one value is overlaid onto
 * it.
 *
 * `GITHUB_TOKEN` is overwritten when the base carries one, because `gh`
 * accepts it as an alternative name: leaving the ambient value in place would
 * park an unscoped credential beside the scoped one.
 *
 * Degrades rather than breaks. A host with no GitHub App configured mints
 * nothing, and the environment is returned untouched so the agent keeps the
 * ambient auth it has always used — the same fallback `buildGhEnv`'s callers
 * make.
 *
 * Residual risk, recorded rather than hidden: the credential
 * `gh_credential_stage.ts` stages into `GH_CONFIG_DIR`'s `hosts.yml` is still
 * on disk and still unscoped. `gh` prefers `GH_TOKEN`, so the guarded path
 * gets the scoped credential, but a process that reads that file directly
 * does not. Removing it from the agent's reach is a mount-and-staging change,
 * tracked separately.
 *
 * @param baseEnv - The sanitised child environment, secrets already dropped.
 * @param mint - How to obtain the token; defaults to
 *   {@link mintRunScopedGhToken}.
 * @returns The environment with the scoped credential overlaid, or `baseEnv`
 *   unchanged when no token could be minted.
 */
export async function withRunScopedGhToken(
  baseEnv: Record<string, string>,
  mint: GhTokenMinter = mintRunScopedGhToken,
): Promise<Record<string, string>> {
  const token = await mint();
  if (!token) return baseEnv;

  const scoped: Record<string, string> = { ...baseEnv, GH_TOKEN: token };
  if ("GITHUB_TOKEN" in baseEnv) scoped["GITHUB_TOKEN"] = token;
  return scoped;
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
  // Issue #42 / #1485: once the primary GraphQL quota is exhausted, every
  // further GraphQL-backed call in the window is guaranteed to fail. The
  // short-circuit used to live in `runGhCommandRaw` alone, so the thirty-odd
  // modules that call this chokepoint directly kept spawning doomed `gh`
  // processes after the latch had fired. It lives here now, at the one
  // place every `gh` spawn passes — before the spawn and before the
  // telemetry — and a REST `gh api <path>` still rides the core quota.
  if (
    !options.bypassQuotaLatch && !isQuotaExemptGhCall(args) &&
    isPrimaryQuotaLatched()
  ) {
    return {
      code: 1,
      success: false,
      stdout: "",
      stderr: primaryQuotaSkipMessage(),
    };
  }
  // Issue #1671 / #1485: per-iteration `gh` call telemetry, recorded at the
  // chokepoint so every invocation — from any module — is counted exactly
  // once per attempt.
  recordGhCall(args);
  // Mask secrets in the published body arguments (Issue #3707) — the last
  // point before a comment or PR body leaves the worker for GitHub.
  //
  // The reader and writer are the same pair the agent's guard child supplies
  // (Issue #1254): without them this call passed argv alone, so a
  // `--body-file` / `-F <path>` / `--input <file>` body was neither scanned
  // nor refused, and a module switching from `--body` to `--body-file` would
  // have published unscanned while looking like a refactor.
  //
  // Issue #1364: a masked `--input` copy needs a directory that owns it. The
  // guard child cannot clean up — it exits before its `gh` child reads the
  // file — but this chokepoint awaits the child, so it can, and does, in the
  // `finally` below. The directory is created only when a body is actually
  // masked, so an ordinary call does no filesystem work.
  let maskedBodyDir: string | undefined;
  const writeMaskedBody: BodyFileWriter = (content) => {
    maskedBodyDir ??= Deno.makeTempDirSync({ prefix: "gh-spawn-body-" });
    return bodyFileWriterIn(maskedBodyDir)(content);
  };
  const stdinScanned = options.stdin !== undefined;
  const redacted = redactGhBodyArgs(
    args,
    denoBodyFileReader,
    writeMaskedBody,
    stdinScanned,
  );
  // Issue #1421: `gh api --input -` carries its body on STDIN, where there is
  // no argument to rewrite — so it never passed through the mask above. The
  // module doc promises every public sink inherits redaction by construction;
  // that was true of the argv route only. Latent rather than live today (no
  // production caller supplies stdin), which is exactly why it should be
  // closed now rather than when one appears.
  const spawnOptions = options.stdin === undefined
    ? options
    : { ...options, stdin: redactGhBodyText(options.stdin) };
  try {
    let result = await runner(redacted, spawnOptions);
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
        // The retry is a second real `gh` process against the same quota.
        recordGhCall(args);
        result = await runner(
          redacted,
          withStagedGhConfigDir(spawnOptions, hostEnv),
        );
      }
    }
    // Issue #1540: the latch used to be SET only from `runGhCommandRaw`'s
    // catch, so the thirty-odd modules that spawn through this chokepoint
    // directly saw the refusal, logged it, retried it — four real spawns on
    // one auto-merge — and never latched. The refusal is recognised here,
    // where it is seen, and handed to the registered hook, which probes the
    // reset, latches the process and writes the shared signal. Not for the
    // probe itself (`bypassQuotaLatch`): it is the call that learns the reset,
    // and the hook coalesces a refusal it is already recording.
    if (
      !result.success && !options.bypassQuotaLatch &&
      !isQuotaExemptGhCall(args) && quotaExhaustionHook !== null &&
      isPrimaryRateLimitMessage(result.stderr)
    ) {
      try {
        await quotaExhaustionHook({
          args,
          stderr: result.stderr,
          ...(options.workDir !== undefined
            ? { workDir: options.workDir }
            : {}),
        });
      } catch {
        // Best-effort bookkeeping: the caller still sees its own failure.
      }
    }
    // Best-effort — never lets journalling alter or abort the gh call.
    await auditGhMutation(args, result.code);
    // Issue #181: a close the worker just performed invalidates the scan-cache
    // entries that still describe the issue as open, and marks it finished for
    // the rest of the run so no slot re-claims it. Also best-effort.
    await noteGhIssueClose(args, result.code);
    return result;
  } finally {
    // The `gh` child has exited by the time the call above resolves, so the
    // masked copy it read is safe to remove (Issue #1364). Best-effort: a
    // cleanup failure must never turn a completed `gh` call into a thrown one.
    if (maskedBodyDir !== undefined) {
      try {
        Deno.removeSync(maskedBodyDir, { recursive: true });
      } catch {
        // Nothing to do — the directory is under TMPDIR either way.
      }
    }
  }
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
