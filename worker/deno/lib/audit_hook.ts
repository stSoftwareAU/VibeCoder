/**
 * Chokepoint hooks that journal GitHub mutations (Issue #2380).
 *
 * These thin, best-effort wrappers are called from the central `gh` and
 * `git` subprocess entry-points (`spawnGh` in gh_spawn.ts and
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
import type { AuditActionKind, AuditComponent } from "./audit_entry.ts";
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
 * Audit and chokepoint plumbing the caller walk passes over.
 *
 * Each file sits between the requesting module and the hook: the `gh` and
 * `git` chokepoints, the retry and wrapper layers above them, and the audit
 * modules themselves. `git_push.ts` is the push primitive (`pushUnpushedCommits`
 * and `commitAndPushPending`) that every worker push runs through on its way to
 * `runGitCommand`; it does not decide that a push happens, so the module that
 * asked for the push is the first frame above it. The first frame outside this
 * list is therefore the module that asked for the mutation. Matched on the
 * whole file name, so `infra_retry.ts` is not mistaken for `retry.ts`.
 */
const PLUMBING_FILES: ReadonlyArray<string> = [
  "audit_hook.ts",
  "audit_journal.ts",
  "audit_mutation_classifier.ts",
  "gh_spawn.ts",
  "gh_wrapper.ts",
  "git_push.ts",
  "git_timeout.ts",
  "github.ts",
  "retry.ts",
];

/**
 * Pick the requesting module out of a stack trace.
 *
 * Walks frames to the first `worker/deno/lib/<file>.ts` (or a file under a
 * `lib/` subdirectory, such as `lib/phases/`) or `worker/deno/commands/<file>.ts`
 * that is not one of the {@link PLUMBING_FILES}. Exported so the
 * skip list can be tested against a fixed stack.
 *
 * @param stack - A stack trace, or undefined when none was captured.
 * @returns The `worker/deno/...` path of the requesting module, or undefined.
 */
export function callerFromStack(
  stack: string | undefined,
): string | undefined {
  if (!stack) return undefined;
  for (const line of stack.split("\n")) {
    const match = line.match(
      /(worker\/deno\/(?:lib|commands)\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+\.ts)/,
    );
    if (match && match[1]) {
      const path = match[1];
      const file = path.slice(path.lastIndexOf("/") + 1);
      if (!PLUMBING_FILES.includes(file)) return path;
    }
  }
  return undefined;
}

/** Best-effort caller resolution from the current stack trace. */
function resolveCaller(): string | undefined {
  return callerFromStack(new Error().stack);
}

/**
 * Modules that positively identify the worker as the requester.
 *
 * Only these name the worker. Any other caller, or none, is `unknown`
 * rather than assumed to be the worker.
 */
const WORKER_CALLERS: ReadonlyArray<string> = [
  "wip_checkpoint",
  "run_wip_preservation",
  "declared_handoff",
  "push_recovery_retry",
  "agent_pr_adoption",
  "completion_phase",
  "pr_ci_processor",
  "pr_feedback_processor",
  "pr_maintenance",
];

/**
 * Classify the component that requested a mutation from its caller path.
 *
 * Exported for tests; production reaches it only through {@link record}.
 *
 * @param caller - The `worker/deno/...` caller path, if one was resolved.
 */
export function componentFor(caller?: string): AuditComponent {
  if (!caller) return "unknown";
  if (caller.includes("fleet_pr_babysitter")) return "babysitter";
  if (caller.includes("review_round")) return "reviewer";
  if (WORKER_CALLERS.some((name) => caller.includes(name))) return "worker";
  return "unknown";
}

/** Callers whose `git push` updates a PR branch that already exists. */
const REPAIR_PUSH_CALLERS: ReadonlyArray<string> = [
  "fleet_pr_babysitter",
  "pr_ci_processor",
  "pr_feedback_processor",
  "pr_merge_conflict_processor",
  "pr_spelling_processor",
];

/**
 * Callers whose `git push` publishes the run's own implementation branch.
 *
 * The completion phase's in-run recovery modules make the final push of the
 * run's branch themselves (`commitAndPushPending` after their recovery turn),
 * so they are named here rather than left `unknown`.
 */
const IMPLEMENTATION_PUSH_CALLERS: ReadonlyArray<string> = [
  "wip_checkpoint",
  "run_wip_preservation",
  "declared_handoff",
  "push_recovery_retry",
  "agent_pr_adoption",
  "completion_phase",
  "pr_body_length",
  "pre_push_gate_retry",
  "screenshot_gate_retry",
  "summary_rule_gate_retry",
];

/**
 * Classify the action a mutation performs, without guessing from the verb
 * alone.
 *
 * A `git push` is only `repair` or `implementation` when its caller positively
 * names the module that makes that push; any other push is `unknown`.
 *
 * Exported for tests; production reaches it only through {@link record}.
 *
 * @param info - The classified mutation.
 * @param caller - The `worker/deno/...` caller path, if one was resolved.
 * @param args - The raw `gh` or `git` arguments, for the dismissal state.
 */
export function actionKindFor(
  info: MutationInfo,
  caller: string | undefined,
  args: readonly string[],
): AuditActionKind {
  if (info.verb === "pr-merge") {
    return args.includes("--disable-auto") ? "unknown" : "merge";
  }
  if (info.verb === "pr-review") return "review";
  if (
    info.verb === "api-put" &&
    /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/update-branch$/
      .test(info.target ?? "")
  ) return "branch-update";
  if (
    info.verb === "api-put" &&
    /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/reviews\/[1-9]\d*$/
      .test(info.target ?? "") &&
    args.some((arg) => /^state=DISMISSED$/i.test(arg))
  ) return "dismissal";
  // The worker's own dismissal (`markCommentProcessed` in pr_comments.ts) PUTs
  // the `/dismissals` sub-endpoint with a `message=` field, not `state=`.
  if (
    info.verb === "api-put" &&
    /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/reviews\/[1-9]\d*\/dismissals$/
      .test(info.target ?? "")
  ) return "dismissal";
  if (info.verb === "git-push" && caller) {
    if (REPAIR_PUSH_CALLERS.some((name) => caller.includes(name))) {
      return "repair";
    }
    if (IMPLEMENTATION_PUSH_CALLERS.some((name) => caller.includes(name))) {
      return "implementation";
    }
  }
  return "unknown";
}

/**
 * The PR number a mutation targets, or undefined when it targets no PR.
 *
 * Taken from a `/pulls/N` API path, or from a numeric target of a `pr-` verb.
 * Exported for tests; production reaches it only through {@link record}.
 *
 * @param info - The classified mutation.
 */
export function prNumberFor(info: MutationInfo): number | undefined {
  if (!info.target) return undefined;
  const apiTarget = info.target.match(/\/pulls\/([1-9]\d*)(?:\/|$)/);
  const raw = apiTarget?.[1] ??
    (info.verb.startsWith("pr-") ? info.target : undefined);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
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
  args: readonly string[],
): Promise<void> {
  const caller = resolveCaller();
  try {
    const result = await recordMutation({
      actionId: crypto.randomUUID(),
      component: componentFor(caller),
      actionKind: actionKindFor(info, caller, args),
      ...(prNumberFor(info) !== undefined
        ? { prNumber: prNumberFor(info) }
        : {}),
      runId: opts.runId ?? resolveRunId(opts.env ?? processEnvLookup),
      verb: info.verb,
      outcome: exitCode === 0 ? "success" : "error",
      ...(info.repo ? { repo: info.repo } : {}),
      ...(info.target ? { target: info.target } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(caller ? { caller } : {}),
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
  await record(info, exitCode, opts, args);
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
  await record(info, exitCode, opts, args);
}
