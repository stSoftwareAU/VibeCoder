/**
 * Chokepoint hooks that journal GitHub mutations (Issue #2380).
 *
 * These thin, best-effort wrappers are called from the central `gh` and
 * `git` subprocess entry-points (`runGhCommandRaw` in github.ts and
 * `runGitCommand` in git_timeout.ts). They classify the command, and when
 * it is a GitHub mutation, append a hash-chained entry to the audit
 * journal. Every failure is swallowed so journalling can never abort — or
 * even perturb — the mutation it is recording.
 *
 * Gating: auditing is active in production (where `WORK_DIR` is set) and
 * can be force-disabled with `VIBE_AUDIT_DISABLED=1`. Unit tests that do
 * not set `WORK_DIR` therefore incur no journalling side-effects.
 *
 * Both gating variables, the worker partition and the run id are read through
 * {@link AuditHookOptions} rather than straight off the process (Issue #963),
 * so a test drives the hooks with a fixed map instead of mutating the process
 * environment out from under every other test in the run (Issue #880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  recordMutation,
  type RecordOptions,
  resolveRunId,
} from "./audit_journal.ts";
import {
  classifyGhMutation,
  classifyGitMutation,
  type MutationInfo,
} from "./audit_mutation_classifier.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/**
 * Everything the hooks read about *this* run, as parameters (Issue #963).
 *
 * The gating flags, the worker partition and the run id were all read
 * straight from the process, so the only way to drive the hooks was to set
 * `WORK_DIR`, `VIBE_AUDIT_DISABLED`, `WORKER_UNIQUE_ID` and `VIBE_RUN_ID` on
 * the process — which races every other test running at that moment and is
 * what keeps the gate's `deno test` stage serial (Issue #880). Every field is
 * optional and defaults to exactly what the hook read before, so production
 * call sites pass nothing and behave identically.
 */
export interface AuditHookOptions extends RecordOptions {
  /**
   * Explicit run id for the journal entry.
   *
   * Defaults to {@link resolveRunId} over {@link AuditHookOptions.env}.
   */
  runId?: string;
}

/**
 * True when audit journalling should run for the current process.
 *
 * Exported so other journalling call sites (e.g. `gh_guard_shim.ts`) share one
 * gating rule rather than each re-deriving it.
 *
 * @param env - Environment lookup for the two gating variables (Issue #963).
 *   Defaults to the real process environment.
 */
export function isAuditJournalEnabled(
  env: EnvLookup = processEnvLookup,
): boolean {
  const disabled = env("VIBE_AUDIT_DISABLED");
  if (disabled && disabled !== "0" && disabled.toLowerCase() !== "false") {
    return false;
  }
  // Journalling is a production-runtime feature keyed to WORK_DIR. Without
  // it there is no stable out-of-tree location to write to, so stay inert.
  return Boolean(env("WORK_DIR"));
}

/**
 * Best-effort caller resolution from the stack trace.
 *
 * Walks frames to the first `worker/deno/lib/<file>.ts` that is not one of
 * the audit/chokepoint plumbing files, so the recorded caller is the code
 * path that actually requested the mutation.
 */
function resolveCaller(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  const skip = [
    "audit_hook.ts",
    "audit_journal.ts",
    "audit_mutation_classifier.ts",
    "git_timeout.ts",
    "github.ts",
  ];
  for (const line of stack.split("\n")) {
    const match = line.match(/(worker\/deno\/lib\/[A-Za-z0-9_]+\.ts)/);
    if (match && match[1]) {
      const path = match[1];
      if (!skip.some((s) => path.endsWith(s))) return path;
    }
  }
  return undefined;
}

/**
 * Record a classified mutation.
 *
 * The mutation itself is never aborted by a journalling failure, but the
 * failure is no longer invisible: a refused append (most often a chain
 * anchor that no longer reconciles — Issue #3712) is logged loud so the
 * tamper signal reaches the operator instead of being silently swallowed
 * (Issue #3234).
 */
async function record(
  info: MutationInfo,
  exitCode: number | undefined,
  opts: AuditHookOptions,
): Promise<void> {
  try {
    const result = await recordMutation({
      runId: opts.runId ?? resolveRunId(opts.env ?? processEnvLookup),
      verb: info.verb,
      outcome: exitCode === 0 ? "success" : "error",
      ...(info.repo ? { repo: info.repo } : {}),
      ...(info.target ? { target: info.target } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(() => {
        const caller = resolveCaller();
        return caller ? { caller } : {};
      })(),
    }, opts);
    if (!result.ok) {
      console.error(
        `[SECURITY] [AUDIT_JOURNAL_REFUSED] ${info.verb}: ${result.error.message}`,
      );
    }
  } catch (err) {
    // Best-effort: never let journalling perturb the mutation — but say so.
    console.error(
      `[SECURITY] [AUDIT_JOURNAL_REFUSED] ${info.verb}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Journal a `gh` invocation if it is a GitHub mutation.
 *
 * @param args - Arguments passed to `gh`
 * @param exitCode - The gh process exit code (undefined if unknown)
 * @param opts - Injected gating, identity and storage location (Issue #963).
 *   Omit in production: every field defaults to the process environment.
 */
export async function auditGhMutation(
  args: readonly string[],
  exitCode?: number,
  opts: AuditHookOptions = {},
): Promise<void> {
  if (!isAuditJournalEnabled(opts.env ?? processEnvLookup)) return;
  const info = classifyGhMutation(args);
  if (!info) return;
  await record(info, exitCode, opts);
}

/**
 * Journal a `git` invocation if it mutates remote GitHub state (push).
 *
 * @param args - Arguments passed to `git`
 * @param exitCode - The git process exit code (undefined if unknown)
 * @param opts - Injected gating, identity and storage location (Issue #963).
 *   Omit in production: every field defaults to the process environment.
 */
export async function auditGitMutation(
  args: readonly string[],
  exitCode?: number,
  opts: AuditHookOptions = {},
): Promise<void> {
  if (!isAuditJournalEnabled(opts.env ?? processEnvLookup)) return;
  const info = classifyGitMutation(args);
  if (!info) return;
  await record(info, exitCode, opts);
}
