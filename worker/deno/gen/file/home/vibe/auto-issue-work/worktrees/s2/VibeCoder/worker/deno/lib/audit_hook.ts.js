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
 * Gating: auditing is active in production where `WORK_DIR` or
 * `VIBE_AUDIT_DIR` is set, and can be force-disabled with
 * `VIBE_AUDIT_DISABLED=1`. Unit tests that set neither remain inert.
 *
 * Both gating variables, the worker partition and the run id are read through
 * {@link AuditHookOptions} rather than straight off the process (Issue #963),
 * so a test drives the hooks with a fixed map instead of mutating the process
 * environment out from under every other test in the run (Issue #880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { recordMutation, resolveRunId } from "./audit_journal.ts";
import { classifyGhMutation, classifyGitMutation } from "./audit_mutation_classifier.ts";
import { processEnvLookup } from "./env_lookup.ts";
/** True when the audit disable switch has a non-false value. */ export function isAuditJournalSwitchedOff(env = processEnvLookup) {
  const disabled = env("VIBE_AUDIT_DISABLED");
  return Boolean(disabled && disabled !== "0" && disabled.toLowerCase() !== "false");
}
/**
 * True when audit journalling should run for the current process.
 *
 * Exported so other journalling call sites (e.g. `gh_guard_shim.ts`) share one
 * gating rule rather than each re-deriving it.
 *
 * @param env - Environment lookup for the two gating variables (Issue #963).
 *   Defaults to the real process environment.
 */ export function isAuditJournalEnabled(env = processEnvLookup) {
  if (isAuditJournalSwitchedOff(env)) return false;
  // An explicit journal directory supports workers without WORK_DIR.
  return Boolean(env("VIBE_AUDIT_DIR") || env("WORK_DIR"));
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
 */ const PLUMBING_FILES = [
  "audit_hook.ts",
  "audit_journal.ts",
  "audit_mutation_classifier.ts",
  "gh_spawn.ts",
  "gh_wrapper.ts",
  "git_push.ts",
  "git_push_recovery.ts",
  "git_timeout.ts",
  "github.ts",
  "retry.ts"
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
 */ export function callerFromStack(stack) {
  if (!stack) return undefined;
  for (const line of stack.split("\n")){
    const match = line.match(/(worker\/deno\/(?:lib|commands)\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+\.ts)/);
    if (match && match[1]) {
      const path = match[1];
      const file = path.slice(path.lastIndexOf("/") + 1);
      if (!PLUMBING_FILES.includes(file)) return path;
    }
  }
  return undefined;
}
/** Best-effort caller resolution from the current stack trace. */ function resolveCaller() {
  return callerFromStack(new Error().stack);
}
/**
 * Modules that positively identify the worker as the requester.
 *
 * Only these name the worker. Any other caller, or none, is `unknown`
 * rather than assumed to be the worker.
 */ const WORKER_CALLERS = [
  "wip_checkpoint",
  "run_wip_preservation",
  "declared_handoff",
  "push_recovery_retry",
  "agent_pr_adoption",
  "completion_phase",
  "pr_ci_processor",
  "pr_feedback_processor",
  "pr_maintenance",
  "git_pull",
  "direct_merge",
  "pr_manager",
  "pr_auto_merge",
  "pr_comments",
  "pr_merge_conflict_processor",
  "pr_spelling_processor",
  "pre_push_gate_retry",
  "screenshot_gate_retry",
  "summary_rule_gate_retry",
  "pr_body_length"
];
/**
 * Classify the component that requested a mutation from its caller path.
 *
 * Exported for tests; production reaches it only through {@link record}.
 *
 * @param caller - The `worker/deno/...` caller path, if one was resolved.
 */ export function componentFor(caller) {
  if (!caller) return "unknown";
  if (caller.includes("fleet_pr_babysitter")) return "babysitter";
  if (caller.includes("review_round")) return "reviewer";
  if (WORKER_CALLERS.some((name)=>caller.includes(name))) return "worker";
  return "unknown";
}
/** Callers whose `git push` updates a PR branch that already exists. */ const REPAIR_PUSH_CALLERS = [
  "fleet_pr_babysitter",
  "pr_ci_processor",
  "pr_feedback_processor",
  "pr_merge_conflict_processor",
  "pr_spelling_processor"
];
/**
 * Callers whose `git push` publishes the run's own implementation branch.
 *
 * The completion phase's in-run recovery modules make the final push of the
 * run's branch themselves (`commitAndPushPending` after their recovery turn),
 * so they are named here rather than left `unknown`.
 */ const IMPLEMENTATION_PUSH_CALLERS = [
  "wip_checkpoint",
  "run_wip_preservation",
  "declared_handoff",
  "push_recovery_retry",
  "agent_pr_adoption",
  "completion_phase",
  "pr_body_length",
  "pre_push_gate_retry",
  "screenshot_gate_retry",
  "summary_rule_gate_retry"
];
/**
 * Classify the action a mutation performs, without guessing from the verb
 * alone.
 *
 * A `git push` is only `repair` or `implementation` when its caller positively
 * names the module that makes that push; any other push is `unknown`. The one
 * exception is `git_pull.ts`, which makes two kinds of push: a push whose
 * target is a `milestone/` branch is `milestone` (the milestone sync), and any
 * other push from it is `branch-update` (the plain fast-forward update of a PR
 * branch that merges its base in). A `branch-update` is neither a fix round nor
 * verified implementation evidence.
 *
 * Exported for tests; production reaches it only through {@link record}.
 *
 * @param info - The classified mutation.
 * @param caller - The `worker/deno/...` caller path, if one was resolved.
 * @param args - The raw `gh` or `git` arguments, for the dismissal state.
 */ export function actionKindFor(info, caller, args) {
  if (info.verb === "pr-merge") {
    if (args.includes("--auto")) return "merge-arm";
    return args.includes("--disable-auto") ? "unknown" : "merge";
  }
  if (info.verb === "pr-review") return "review";
  if (info.verb === "api-put" && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/update-branch$/.test(info.target ?? "")) return "branch-update";
  if (info.verb === "api-put" && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/reviews\/[1-9]\d*$/.test(info.target ?? "") && args.some((arg)=>/^state=DISMISSED$/i.test(arg))) return "dismissal";
  // The worker's own dismissal (`markCommentProcessed` in pr_comments.ts) PUTs
  // the `/dismissals` sub-endpoint with a `message=` field, not `state=`.
  if (info.verb === "api-put" && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/reviews\/[1-9]\d*\/dismissals$/.test(info.target ?? "")) return "dismissal";
  if (info.verb === "git-push" && caller) {
    if (caller.includes("git_pull")) {
      return (info.target ?? "").startsWith("milestone/") ? "milestone" : "branch-update";
    }
    if (REPAIR_PUSH_CALLERS.some((name)=>caller.includes(name))) {
      return "repair";
    }
    if (IMPLEMENTATION_PUSH_CALLERS.some((name)=>caller.includes(name))) {
      return "implementation";
    }
  }
  return "unknown";
}
/** The head SHA a direct merge is pinned to, when the command supplies one. */ function headShaFor(args) {
  const index = args.indexOf("--match-head-commit");
  const sha = index >= 0 ? args[index + 1] : undefined;
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}
/**
 * The PR number a mutation targets, or undefined when it targets no PR.
 *
 * Taken from a `/pulls/N` API path, or from a numeric target of a `pr-` verb.
 * Exported for tests; production reaches it only through {@link record}.
 *
 * @param info - The classified mutation.
 */ export function prNumberFor(info) {
  if (!info.target) return undefined;
  const apiTarget = info.target.match(/\/pulls\/([1-9]\d*)(?:\/|$)/);
  const raw = apiTarget?.[1] ?? (info.verb.startsWith("pr-") ? info.target : undefined);
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
 */ async function record(info, exitCode, opts, args) {
  const caller = resolveCaller();
  try {
    const result = await recordMutation({
      actionId: crypto.randomUUID(),
      component: componentFor(caller),
      actionKind: actionKindFor(info, caller, args),
      ...info.verb === "pr-merge" && headShaFor(args) ? {
        headSha: headShaFor(args)
      } : {},
      ...info.verb === "git-push" && opts.deliveredCommits !== undefined ? {
        deliveredCommits: opts.deliveredCommits
      } : {},
      ...prNumberFor(info) !== undefined ? {
        prNumber: prNumberFor(info)
      } : {},
      runId: opts.runId ?? resolveRunId(opts.env ?? processEnvLookup),
      verb: info.verb,
      outcome: exitCode === 0 ? "success" : "error",
      ...info.repo ? {
        repo: info.repo
      } : {},
      ...info.target ? {
        target: info.target
      } : {},
      ...exitCode !== undefined ? {
        exitCode
      } : {},
      ...caller ? {
        caller
      } : {}
    }, opts);
    if (!result.ok) {
      console.error(`[SECURITY] [AUDIT_JOURNAL_REFUSED] ${info.verb}: ${result.error.message}`);
    }
  } catch (err) {
    // Best-effort: never let journalling perturb the mutation — but say so.
    console.error(`[SECURITY] [AUDIT_JOURNAL_REFUSED] ${info.verb}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
/**
 * Journal a `gh` invocation if it is a GitHub mutation.
 *
 * @param args - Arguments passed to `gh`
 * @param exitCode - The gh process exit code (undefined if unknown)
 * @param opts - Injected gating, identity and storage location (Issue #963).
 *   Omit in production: every field defaults to the process environment.
 */ export async function auditGhMutation(args, exitCode, opts = {}) {
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
 */ export async function auditGitMutation(args, exitCode, opts = {}) {
  if (!isAuditJournalEnabled(opts.env ?? processEnvLookup)) return;
  const info = classifyGitMutation(args);
  if (!info) return;
  await record(info, exitCode, opts, args);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hdWRpdF9ob29rLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ2hva2Vwb2ludCBob29rcyB0aGF0IGpvdXJuYWwgR2l0SHViIG11dGF0aW9ucyAoSXNzdWUgIzIzODApLlxuICpcbiAqIFRoZXNlIHRoaW4sIGJlc3QtZWZmb3J0IHdyYXBwZXJzIGFyZSBjYWxsZWQgZnJvbSB0aGUgY2VudHJhbCBgZ2hgIGFuZFxuICogYGdpdGAgc3VicHJvY2VzcyBlbnRyeS1wb2ludHMgKGBzcGF3bkdoYCBpbiBnaF9zcGF3bi50cyBhbmRcbiAqIGBydW5HaXRDb21tYW5kYCBpbiBnaXRfdGltZW91dC50cykuIFRoZXkgY2xhc3NpZnkgdGhlIGNvbW1hbmQsIGFuZCB3aGVuXG4gKiBpdCBpcyBhIEdpdEh1YiBtdXRhdGlvbiwgYXBwZW5kIGEgaGFzaC1jaGFpbmVkIGVudHJ5IHRvIHRoZSBhdWRpdFxuICogam91cm5hbC4gRXZlcnkgZmFpbHVyZSBpcyBzd2FsbG93ZWQgc28gam91cm5hbGxpbmcgY2FuIG5ldmVyIGFib3J0IOKAlCBvclxuICogZXZlbiBwZXJ0dXJiIOKAlCB0aGUgbXV0YXRpb24gaXQgaXMgcmVjb3JkaW5nLlxuICpcbiAqIEdhdGluZzogYXVkaXRpbmcgaXMgYWN0aXZlIGluIHByb2R1Y3Rpb24gd2hlcmUgYFdPUktfRElSYCBvclxuICogYFZJQkVfQVVESVRfRElSYCBpcyBzZXQsIGFuZCBjYW4gYmUgZm9yY2UtZGlzYWJsZWQgd2l0aFxuICogYFZJQkVfQVVESVRfRElTQUJMRUQ9MWAuIFVuaXQgdGVzdHMgdGhhdCBzZXQgbmVpdGhlciByZW1haW4gaW5lcnQuXG4gKlxuICogQm90aCBnYXRpbmcgdmFyaWFibGVzLCB0aGUgd29ya2VyIHBhcnRpdGlvbiBhbmQgdGhlIHJ1biBpZCBhcmUgcmVhZCB0aHJvdWdoXG4gKiB7QGxpbmsgQXVkaXRIb29rT3B0aW9uc30gcmF0aGVyIHRoYW4gc3RyYWlnaHQgb2ZmIHRoZSBwcm9jZXNzIChJc3N1ZSAjOTYzKSxcbiAqIHNvIGEgdGVzdCBkcml2ZXMgdGhlIGhvb2tzIHdpdGggYSBmaXhlZCBtYXAgaW5zdGVhZCBvZiBtdXRhdGluZyB0aGUgcHJvY2Vzc1xuICogZW52aXJvbm1lbnQgb3V0IGZyb20gdW5kZXIgZXZlcnkgb3RoZXIgdGVzdCBpbiB0aGUgcnVuIChJc3N1ZSAjODgwKS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQge1xuICByZWNvcmRNdXRhdGlvbixcbiAgdHlwZSBSZWNvcmRPcHRpb25zLFxuICByZXNvbHZlUnVuSWQsXG59IGZyb20gXCIuL2F1ZGl0X2pvdXJuYWwudHNcIjtcbmltcG9ydCB0eXBlIHsgQXVkaXRBY3Rpb25LaW5kLCBBdWRpdENvbXBvbmVudCB9IGZyb20gXCIuL2F1ZGl0X2VudHJ5LnRzXCI7XG5pbXBvcnQge1xuICBjbGFzc2lmeUdoTXV0YXRpb24sXG4gIGNsYXNzaWZ5R2l0TXV0YXRpb24sXG4gIHR5cGUgTXV0YXRpb25JbmZvLFxufSBmcm9tIFwiLi9hdWRpdF9tdXRhdGlvbl9jbGFzc2lmaWVyLnRzXCI7XG5pbXBvcnQgeyB0eXBlIEVudkxvb2t1cCwgcHJvY2Vzc0Vudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcblxuLyoqXG4gKiBFdmVyeXRoaW5nIHRoZSBob29rcyByZWFkIGFib3V0ICp0aGlzKiBydW4sIGFzIHBhcmFtZXRlcnMgKElzc3VlICM5NjMpLlxuICpcbiAqIFRoZSBnYXRpbmcgZmxhZ3MsIHRoZSB3b3JrZXIgcGFydGl0aW9uIGFuZCB0aGUgcnVuIGlkIHdlcmUgYWxsIHJlYWRcbiAqIHN0cmFpZ2h0IGZyb20gdGhlIHByb2Nlc3MsIHNvIHRoZSBvbmx5IHdheSB0byBkcml2ZSB0aGUgaG9va3Mgd2FzIHRvIHNldFxuICogYFdPUktfRElSYCwgYFZJQkVfQVVESVRfRElTQUJMRURgLCBgV09SS0VSX1VOSVFVRV9JRGAgYW5kIGBWSUJFX1JVTl9JRGAgb25cbiAqIHRoZSBwcm9jZXNzIOKAlCB3aGljaCByYWNlcyBldmVyeSBvdGhlciB0ZXN0IHJ1bm5pbmcgYXQgdGhhdCBtb21lbnQgYW5kIGlzXG4gKiB3aGF0IGtlZXBzIHRoZSBnYXRlJ3MgYGRlbm8gdGVzdGAgc3RhZ2Ugc2VyaWFsIChJc3N1ZSAjODgwKS4gRXZlcnkgZmllbGQgaXNcbiAqIG9wdGlvbmFsIGFuZCBkZWZhdWx0cyB0byBleGFjdGx5IHdoYXQgdGhlIGhvb2sgcmVhZCBiZWZvcmUsIHNvIHByb2R1Y3Rpb25cbiAqIGNhbGwgc2l0ZXMgcGFzcyBub3RoaW5nIGFuZCBiZWhhdmUgaWRlbnRpY2FsbHkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXVkaXRIb29rT3B0aW9ucyBleHRlbmRzIFJlY29yZE9wdGlvbnMge1xuICAvKiogUHJvdmVuIHB1c2ggcmFuZ2UsIHN1cHBsaWVkIGJ5IHRoZSBnaXQgY2hva2Vwb2ludCBiZWZvcmUgYSBwdXNoLiAqL1xuICBkZWxpdmVyZWRDb21taXRzPzogc3RyaW5nW107XG4gIC8qKlxuICAgKiBFeHBsaWNpdCBydW4gaWQgZm9yIHRoZSBqb3VybmFsIGVudHJ5LlxuICAgKlxuICAgKiBEZWZhdWx0cyB0byB7QGxpbmsgcmVzb2x2ZVJ1bklkfSBvdmVyIHtAbGluayBBdWRpdEhvb2tPcHRpb25zLmVudn0uXG4gICAqL1xuICBydW5JZD86IHN0cmluZztcbn1cblxuLyoqIFRydWUgd2hlbiB0aGUgYXVkaXQgZGlzYWJsZSBzd2l0Y2ggaGFzIGEgbm9uLWZhbHNlIHZhbHVlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQXVkaXRKb3VybmFsU3dpdGNoZWRPZmYoXG4gIGVudjogRW52TG9va3VwID0gcHJvY2Vzc0Vudkxvb2t1cCxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBkaXNhYmxlZCA9IGVudihcIlZJQkVfQVVESVRfRElTQUJMRURcIik7XG4gIHJldHVybiBCb29sZWFuKFxuICAgIGRpc2FibGVkICYmIGRpc2FibGVkICE9PSBcIjBcIiAmJiBkaXNhYmxlZC50b0xvd2VyQ2FzZSgpICE9PSBcImZhbHNlXCIsXG4gICk7XG59XG5cbi8qKlxuICogVHJ1ZSB3aGVuIGF1ZGl0IGpvdXJuYWxsaW5nIHNob3VsZCBydW4gZm9yIHRoZSBjdXJyZW50IHByb2Nlc3MuXG4gKlxuICogRXhwb3J0ZWQgc28gb3RoZXIgam91cm5hbGxpbmcgY2FsbCBzaXRlcyAoZS5nLiBgZ2hfZ3VhcmRfc2hpbS50c2ApIHNoYXJlIG9uZVxuICogZ2F0aW5nIHJ1bGUgcmF0aGVyIHRoYW4gZWFjaCByZS1kZXJpdmluZyBpdC5cbiAqXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIGZvciB0aGUgdHdvIGdhdGluZyB2YXJpYWJsZXMgKElzc3VlICM5NjMpLlxuICogICBEZWZhdWx0cyB0byB0aGUgcmVhbCBwcm9jZXNzIGVudmlyb25tZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNBdWRpdEpvdXJuYWxFbmFibGVkKFxuICBlbnY6IEVudkxvb2t1cCA9IHByb2Nlc3NFbnZMb29rdXAsXG4pOiBib29sZWFuIHtcbiAgaWYgKGlzQXVkaXRKb3VybmFsU3dpdGNoZWRPZmYoZW52KSkgcmV0dXJuIGZhbHNlO1xuICAvLyBBbiBleHBsaWNpdCBqb3VybmFsIGRpcmVjdG9yeSBzdXBwb3J0cyB3b3JrZXJzIHdpdGhvdXQgV09SS19ESVIuXG4gIHJldHVybiBCb29sZWFuKGVudihcIlZJQkVfQVVESVRfRElSXCIpIHx8IGVudihcIldPUktfRElSXCIpKTtcbn1cblxuLyoqXG4gKiBBdWRpdCBhbmQgY2hva2Vwb2ludCBwbHVtYmluZyB0aGUgY2FsbGVyIHdhbGsgcGFzc2VzIG92ZXIuXG4gKlxuICogRWFjaCBmaWxlIHNpdHMgYmV0d2VlbiB0aGUgcmVxdWVzdGluZyBtb2R1bGUgYW5kIHRoZSBob29rOiB0aGUgYGdoYCBhbmRcbiAqIGBnaXRgIGNob2tlcG9pbnRzLCB0aGUgcmV0cnkgYW5kIHdyYXBwZXIgbGF5ZXJzIGFib3ZlIHRoZW0sIGFuZCB0aGUgYXVkaXRcbiAqIG1vZHVsZXMgdGhlbXNlbHZlcy4gYGdpdF9wdXNoLnRzYCBpcyB0aGUgcHVzaCBwcmltaXRpdmUgKGBwdXNoVW5wdXNoZWRDb21taXRzYFxuICogYW5kIGBjb21taXRBbmRQdXNoUGVuZGluZ2ApIHRoYXQgZXZlcnkgd29ya2VyIHB1c2ggcnVucyB0aHJvdWdoIG9uIGl0cyB3YXkgdG9cbiAqIGBydW5HaXRDb21tYW5kYDsgaXQgZG9lcyBub3QgZGVjaWRlIHRoYXQgYSBwdXNoIGhhcHBlbnMsIHNvIHRoZSBtb2R1bGUgdGhhdFxuICogYXNrZWQgZm9yIHRoZSBwdXNoIGlzIHRoZSBmaXJzdCBmcmFtZSBhYm92ZSBpdC4gVGhlIGZpcnN0IGZyYW1lIG91dHNpZGUgdGhpc1xuICogbGlzdCBpcyB0aGVyZWZvcmUgdGhlIG1vZHVsZSB0aGF0IGFza2VkIGZvciB0aGUgbXV0YXRpb24uIE1hdGNoZWQgb24gdGhlXG4gKiB3aG9sZSBmaWxlIG5hbWUsIHNvIGBpbmZyYV9yZXRyeS50c2AgaXMgbm90IG1pc3Rha2VuIGZvciBgcmV0cnkudHNgLlxuICovXG5jb25zdCBQTFVNQklOR19GSUxFUzogUmVhZG9ubHlBcnJheTxzdHJpbmc+ID0gW1xuICBcImF1ZGl0X2hvb2sudHNcIixcbiAgXCJhdWRpdF9qb3VybmFsLnRzXCIsXG4gIFwiYXVkaXRfbXV0YXRpb25fY2xhc3NpZmllci50c1wiLFxuICBcImdoX3NwYXduLnRzXCIsXG4gIFwiZ2hfd3JhcHBlci50c1wiLFxuICBcImdpdF9wdXNoLnRzXCIsXG4gIFwiZ2l0X3B1c2hfcmVjb3ZlcnkudHNcIixcbiAgXCJnaXRfdGltZW91dC50c1wiLFxuICBcImdpdGh1Yi50c1wiLFxuICBcInJldHJ5LnRzXCIsXG5dO1xuXG4vKipcbiAqIFBpY2sgdGhlIHJlcXVlc3RpbmcgbW9kdWxlIG91dCBvZiBhIHN0YWNrIHRyYWNlLlxuICpcbiAqIFdhbGtzIGZyYW1lcyB0byB0aGUgZmlyc3QgYHdvcmtlci9kZW5vL2xpYi88ZmlsZT4udHNgIChvciBhIGZpbGUgdW5kZXIgYVxuICogYGxpYi9gIHN1YmRpcmVjdG9yeSwgc3VjaCBhcyBgbGliL3BoYXNlcy9gKSBvciBgd29ya2VyL2Rlbm8vY29tbWFuZHMvPGZpbGU+LnRzYFxuICogdGhhdCBpcyBub3Qgb25lIG9mIHRoZSB7QGxpbmsgUExVTUJJTkdfRklMRVN9LiBFeHBvcnRlZCBzbyB0aGVcbiAqIHNraXAgbGlzdCBjYW4gYmUgdGVzdGVkIGFnYWluc3QgYSBmaXhlZCBzdGFjay5cbiAqXG4gKiBAcGFyYW0gc3RhY2sgLSBBIHN0YWNrIHRyYWNlLCBvciB1bmRlZmluZWQgd2hlbiBub25lIHdhcyBjYXB0dXJlZC5cbiAqIEByZXR1cm5zIFRoZSBgd29ya2VyL2Rlbm8vLi4uYCBwYXRoIG9mIHRoZSByZXF1ZXN0aW5nIG1vZHVsZSwgb3IgdW5kZWZpbmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2FsbGVyRnJvbVN0YWNrKFxuICBzdGFjazogc3RyaW5nIHwgdW5kZWZpbmVkLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFzdGFjaykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHN0YWNrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKFxuICAgICAgLyh3b3JrZXJcXC9kZW5vXFwvKD86bGlifGNvbW1hbmRzKVxcLyg/OltBLVphLXowLTlfXStcXC8pKltBLVphLXowLTlfXStcXC50cykvLFxuICAgICk7XG4gICAgaWYgKG1hdGNoICYmIG1hdGNoWzFdKSB7XG4gICAgICBjb25zdCBwYXRoID0gbWF0Y2hbMV07XG4gICAgICBjb25zdCBmaWxlID0gcGF0aC5zbGljZShwYXRoLmxhc3RJbmRleE9mKFwiL1wiKSArIDEpO1xuICAgICAgaWYgKCFQTFVNQklOR19GSUxFUy5pbmNsdWRlcyhmaWxlKSkgcmV0dXJuIHBhdGg7XG4gICAgfVxuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiBCZXN0LWVmZm9ydCBjYWxsZXIgcmVzb2x1dGlvbiBmcm9tIHRoZSBjdXJyZW50IHN0YWNrIHRyYWNlLiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUNhbGxlcigpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gY2FsbGVyRnJvbVN0YWNrKG5ldyBFcnJvcigpLnN0YWNrKTtcbn1cblxuLyoqXG4gKiBNb2R1bGVzIHRoYXQgcG9zaXRpdmVseSBpZGVudGlmeSB0aGUgd29ya2VyIGFzIHRoZSByZXF1ZXN0ZXIuXG4gKlxuICogT25seSB0aGVzZSBuYW1lIHRoZSB3b3JrZXIuIEFueSBvdGhlciBjYWxsZXIsIG9yIG5vbmUsIGlzIGB1bmtub3duYFxuICogcmF0aGVyIHRoYW4gYXNzdW1lZCB0byBiZSB0aGUgd29ya2VyLlxuICovXG5jb25zdCBXT1JLRVJfQ0FMTEVSUzogUmVhZG9ubHlBcnJheTxzdHJpbmc+ID0gW1xuICBcIndpcF9jaGVja3BvaW50XCIsXG4gIFwicnVuX3dpcF9wcmVzZXJ2YXRpb25cIixcbiAgXCJkZWNsYXJlZF9oYW5kb2ZmXCIsXG4gIFwicHVzaF9yZWNvdmVyeV9yZXRyeVwiLFxuICBcImFnZW50X3ByX2Fkb3B0aW9uXCIsXG4gIFwiY29tcGxldGlvbl9waGFzZVwiLFxuICBcInByX2NpX3Byb2Nlc3NvclwiLFxuICBcInByX2ZlZWRiYWNrX3Byb2Nlc3NvclwiLFxuICBcInByX21haW50ZW5hbmNlXCIsXG4gIFwiZ2l0X3B1bGxcIixcbiAgXCJkaXJlY3RfbWVyZ2VcIixcbiAgXCJwcl9tYW5hZ2VyXCIsXG4gIFwicHJfYXV0b19tZXJnZVwiLFxuICBcInByX2NvbW1lbnRzXCIsXG4gIFwicHJfbWVyZ2VfY29uZmxpY3RfcHJvY2Vzc29yXCIsXG4gIFwicHJfc3BlbGxpbmdfcHJvY2Vzc29yXCIsXG4gIFwicHJlX3B1c2hfZ2F0ZV9yZXRyeVwiLFxuICBcInNjcmVlbnNob3RfZ2F0ZV9yZXRyeVwiLFxuICBcInN1bW1hcnlfcnVsZV9nYXRlX3JldHJ5XCIsXG4gIFwicHJfYm9keV9sZW5ndGhcIixcbl07XG5cbi8qKlxuICogQ2xhc3NpZnkgdGhlIGNvbXBvbmVudCB0aGF0IHJlcXVlc3RlZCBhIG11dGF0aW9uIGZyb20gaXRzIGNhbGxlciBwYXRoLlxuICpcbiAqIEV4cG9ydGVkIGZvciB0ZXN0czsgcHJvZHVjdGlvbiByZWFjaGVzIGl0IG9ubHkgdGhyb3VnaCB7QGxpbmsgcmVjb3JkfS5cbiAqXG4gKiBAcGFyYW0gY2FsbGVyIC0gVGhlIGB3b3JrZXIvZGVuby8uLi5gIGNhbGxlciBwYXRoLCBpZiBvbmUgd2FzIHJlc29sdmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tcG9uZW50Rm9yKGNhbGxlcj86IHN0cmluZyk6IEF1ZGl0Q29tcG9uZW50IHtcbiAgaWYgKCFjYWxsZXIpIHJldHVybiBcInVua25vd25cIjtcbiAgaWYgKGNhbGxlci5pbmNsdWRlcyhcImZsZWV0X3ByX2JhYnlzaXR0ZXJcIikpIHJldHVybiBcImJhYnlzaXR0ZXJcIjtcbiAgaWYgKGNhbGxlci5pbmNsdWRlcyhcInJldmlld19yb3VuZFwiKSkgcmV0dXJuIFwicmV2aWV3ZXJcIjtcbiAgaWYgKFdPUktFUl9DQUxMRVJTLnNvbWUoKG5hbWUpID0+IGNhbGxlci5pbmNsdWRlcyhuYW1lKSkpIHJldHVybiBcIndvcmtlclwiO1xuICByZXR1cm4gXCJ1bmtub3duXCI7XG59XG5cbi8qKiBDYWxsZXJzIHdob3NlIGBnaXQgcHVzaGAgdXBkYXRlcyBhIFBSIGJyYW5jaCB0aGF0IGFscmVhZHkgZXhpc3RzLiAqL1xuY29uc3QgUkVQQUlSX1BVU0hfQ0FMTEVSUzogUmVhZG9ubHlBcnJheTxzdHJpbmc+ID0gW1xuICBcImZsZWV0X3ByX2JhYnlzaXR0ZXJcIixcbiAgXCJwcl9jaV9wcm9jZXNzb3JcIixcbiAgXCJwcl9mZWVkYmFja19wcm9jZXNzb3JcIixcbiAgXCJwcl9tZXJnZV9jb25mbGljdF9wcm9jZXNzb3JcIixcbiAgXCJwcl9zcGVsbGluZ19wcm9jZXNzb3JcIixcbl07XG5cbi8qKlxuICogQ2FsbGVycyB3aG9zZSBgZ2l0IHB1c2hgIHB1Ymxpc2hlcyB0aGUgcnVuJ3Mgb3duIGltcGxlbWVudGF0aW9uIGJyYW5jaC5cbiAqXG4gKiBUaGUgY29tcGxldGlvbiBwaGFzZSdzIGluLXJ1biByZWNvdmVyeSBtb2R1bGVzIG1ha2UgdGhlIGZpbmFsIHB1c2ggb2YgdGhlXG4gKiBydW4ncyBicmFuY2ggdGhlbXNlbHZlcyAoYGNvbW1pdEFuZFB1c2hQZW5kaW5nYCBhZnRlciB0aGVpciByZWNvdmVyeSB0dXJuKSxcbiAqIHNvIHRoZXkgYXJlIG5hbWVkIGhlcmUgcmF0aGVyIHRoYW4gbGVmdCBgdW5rbm93bmAuXG4gKi9cbmNvbnN0IElNUExFTUVOVEFUSU9OX1BVU0hfQ0FMTEVSUzogUmVhZG9ubHlBcnJheTxzdHJpbmc+ID0gW1xuICBcIndpcF9jaGVja3BvaW50XCIsXG4gIFwicnVuX3dpcF9wcmVzZXJ2YXRpb25cIixcbiAgXCJkZWNsYXJlZF9oYW5kb2ZmXCIsXG4gIFwicHVzaF9yZWNvdmVyeV9yZXRyeVwiLFxuICBcImFnZW50X3ByX2Fkb3B0aW9uXCIsXG4gIFwiY29tcGxldGlvbl9waGFzZVwiLFxuICBcInByX2JvZHlfbGVuZ3RoXCIsXG4gIFwicHJlX3B1c2hfZ2F0ZV9yZXRyeVwiLFxuICBcInNjcmVlbnNob3RfZ2F0ZV9yZXRyeVwiLFxuICBcInN1bW1hcnlfcnVsZV9nYXRlX3JldHJ5XCIsXG5dO1xuXG4vKipcbiAqIENsYXNzaWZ5IHRoZSBhY3Rpb24gYSBtdXRhdGlvbiBwZXJmb3Jtcywgd2l0aG91dCBndWVzc2luZyBmcm9tIHRoZSB2ZXJiXG4gKiBhbG9uZS5cbiAqXG4gKiBBIGBnaXQgcHVzaGAgaXMgb25seSBgcmVwYWlyYCBvciBgaW1wbGVtZW50YXRpb25gIHdoZW4gaXRzIGNhbGxlciBwb3NpdGl2ZWx5XG4gKiBuYW1lcyB0aGUgbW9kdWxlIHRoYXQgbWFrZXMgdGhhdCBwdXNoOyBhbnkgb3RoZXIgcHVzaCBpcyBgdW5rbm93bmAuIFRoZSBvbmVcbiAqIGV4Y2VwdGlvbiBpcyBgZ2l0X3B1bGwudHNgLCB3aGljaCBtYWtlcyB0d28ga2luZHMgb2YgcHVzaDogYSBwdXNoIHdob3NlXG4gKiB0YXJnZXQgaXMgYSBgbWlsZXN0b25lL2AgYnJhbmNoIGlzIGBtaWxlc3RvbmVgICh0aGUgbWlsZXN0b25lIHN5bmMpLCBhbmQgYW55XG4gKiBvdGhlciBwdXNoIGZyb20gaXQgaXMgYGJyYW5jaC11cGRhdGVgICh0aGUgcGxhaW4gZmFzdC1mb3J3YXJkIHVwZGF0ZSBvZiBhIFBSXG4gKiBicmFuY2ggdGhhdCBtZXJnZXMgaXRzIGJhc2UgaW4pLiBBIGBicmFuY2gtdXBkYXRlYCBpcyBuZWl0aGVyIGEgZml4IHJvdW5kIG5vclxuICogdmVyaWZpZWQgaW1wbGVtZW50YXRpb24gZXZpZGVuY2UuXG4gKlxuICogRXhwb3J0ZWQgZm9yIHRlc3RzOyBwcm9kdWN0aW9uIHJlYWNoZXMgaXQgb25seSB0aHJvdWdoIHtAbGluayByZWNvcmR9LlxuICpcbiAqIEBwYXJhbSBpbmZvIC0gVGhlIGNsYXNzaWZpZWQgbXV0YXRpb24uXG4gKiBAcGFyYW0gY2FsbGVyIC0gVGhlIGB3b3JrZXIvZGVuby8uLi5gIGNhbGxlciBwYXRoLCBpZiBvbmUgd2FzIHJlc29sdmVkLlxuICogQHBhcmFtIGFyZ3MgLSBUaGUgcmF3IGBnaGAgb3IgYGdpdGAgYXJndW1lbnRzLCBmb3IgdGhlIGRpc21pc3NhbCBzdGF0ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFjdGlvbktpbmRGb3IoXG4gIGluZm86IE11dGF0aW9uSW5mbyxcbiAgY2FsbGVyOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogQXVkaXRBY3Rpb25LaW5kIHtcbiAgaWYgKGluZm8udmVyYiA9PT0gXCJwci1tZXJnZVwiKSB7XG4gICAgaWYgKGFyZ3MuaW5jbHVkZXMoXCItLWF1dG9cIikpIHJldHVybiBcIm1lcmdlLWFybVwiO1xuICAgIHJldHVybiBhcmdzLmluY2x1ZGVzKFwiLS1kaXNhYmxlLWF1dG9cIikgPyBcInVua25vd25cIiA6IFwibWVyZ2VcIjtcbiAgfVxuICBpZiAoaW5mby52ZXJiID09PSBcInByLXJldmlld1wiKSByZXR1cm4gXCJyZXZpZXdcIjtcbiAgaWYgKFxuICAgIGluZm8udmVyYiA9PT0gXCJhcGktcHV0XCIgJiZcbiAgICAvXnJlcG9zXFwvW0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rXFwvcHVsbHNcXC9bMS05XVxcZCpcXC91cGRhdGUtYnJhbmNoJC9cbiAgICAgIC50ZXN0KGluZm8udGFyZ2V0ID8/IFwiXCIpXG4gICkgcmV0dXJuIFwiYnJhbmNoLXVwZGF0ZVwiO1xuICBpZiAoXG4gICAgaW5mby52ZXJiID09PSBcImFwaS1wdXRcIiAmJlxuICAgIC9ecmVwb3NcXC9bQS1aYS16MC05Xy4tXStcXC9bQS1aYS16MC05Xy4tXStcXC9wdWxsc1xcL1sxLTldXFxkKlxcL3Jldmlld3NcXC9bMS05XVxcZCokL1xuICAgICAgLnRlc3QoaW5mby50YXJnZXQgPz8gXCJcIikgJiZcbiAgICBhcmdzLnNvbWUoKGFyZykgPT4gL15zdGF0ZT1ESVNNSVNTRUQkL2kudGVzdChhcmcpKVxuICApIHJldHVybiBcImRpc21pc3NhbFwiO1xuICAvLyBUaGUgd29ya2VyJ3Mgb3duIGRpc21pc3NhbCAoYG1hcmtDb21tZW50UHJvY2Vzc2VkYCBpbiBwcl9jb21tZW50cy50cykgUFVUc1xuICAvLyB0aGUgYC9kaXNtaXNzYWxzYCBzdWItZW5kcG9pbnQgd2l0aCBhIGBtZXNzYWdlPWAgZmllbGQsIG5vdCBgc3RhdGU9YC5cbiAgaWYgKFxuICAgIGluZm8udmVyYiA9PT0gXCJhcGktcHV0XCIgJiZcbiAgICAvXnJlcG9zXFwvW0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rXFwvcHVsbHNcXC9bMS05XVxcZCpcXC9yZXZpZXdzXFwvWzEtOV1cXGQqXFwvZGlzbWlzc2FscyQvXG4gICAgICAudGVzdChpbmZvLnRhcmdldCA/PyBcIlwiKVxuICApIHJldHVybiBcImRpc21pc3NhbFwiO1xuICBpZiAoaW5mby52ZXJiID09PSBcImdpdC1wdXNoXCIgJiYgY2FsbGVyKSB7XG4gICAgaWYgKGNhbGxlci5pbmNsdWRlcyhcImdpdF9wdWxsXCIpKSB7XG4gICAgICByZXR1cm4gKGluZm8udGFyZ2V0ID8/IFwiXCIpLnN0YXJ0c1dpdGgoXCJtaWxlc3RvbmUvXCIpXG4gICAgICAgID8gXCJtaWxlc3RvbmVcIlxuICAgICAgICA6IFwiYnJhbmNoLXVwZGF0ZVwiO1xuICAgIH1cbiAgICBpZiAoUkVQQUlSX1BVU0hfQ0FMTEVSUy5zb21lKChuYW1lKSA9PiBjYWxsZXIuaW5jbHVkZXMobmFtZSkpKSB7XG4gICAgICByZXR1cm4gXCJyZXBhaXJcIjtcbiAgICB9XG4gICAgaWYgKElNUExFTUVOVEFUSU9OX1BVU0hfQ0FMTEVSUy5zb21lKChuYW1lKSA9PiBjYWxsZXIuaW5jbHVkZXMobmFtZSkpKSB7XG4gICAgICByZXR1cm4gXCJpbXBsZW1lbnRhdGlvblwiO1xuICAgIH1cbiAgfVxuICByZXR1cm4gXCJ1bmtub3duXCI7XG59XG5cbi8qKiBUaGUgaGVhZCBTSEEgYSBkaXJlY3QgbWVyZ2UgaXMgcGlubmVkIHRvLCB3aGVuIHRoZSBjb21tYW5kIHN1cHBsaWVzIG9uZS4gKi9cbmZ1bmN0aW9uIGhlYWRTaGFGb3IoYXJnczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBpbmRleCA9IGFyZ3MuaW5kZXhPZihcIi0tbWF0Y2gtaGVhZC1jb21taXRcIik7XG4gIGNvbnN0IHNoYSA9IGluZGV4ID49IDAgPyBhcmdzW2luZGV4ICsgMV0gOiB1bmRlZmluZWQ7XG4gIHJldHVybiBzaGEgJiYgL15bMC05YS1mXXs0MH0kL2kudGVzdChzaGEpID8gc2hhIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFRoZSBQUiBudW1iZXIgYSBtdXRhdGlvbiB0YXJnZXRzLCBvciB1bmRlZmluZWQgd2hlbiBpdCB0YXJnZXRzIG5vIFBSLlxuICpcbiAqIFRha2VuIGZyb20gYSBgL3B1bGxzL05gIEFQSSBwYXRoLCBvciBmcm9tIGEgbnVtZXJpYyB0YXJnZXQgb2YgYSBgcHItYCB2ZXJiLlxuICogRXhwb3J0ZWQgZm9yIHRlc3RzOyBwcm9kdWN0aW9uIHJlYWNoZXMgaXQgb25seSB0aHJvdWdoIHtAbGluayByZWNvcmR9LlxuICpcbiAqIEBwYXJhbSBpbmZvIC0gVGhlIGNsYXNzaWZpZWQgbXV0YXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwck51bWJlckZvcihpbmZvOiBNdXRhdGlvbkluZm8pOiBudW1iZXIgfCB1bmRlZmluZWQge1xuICBpZiAoIWluZm8udGFyZ2V0KSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBhcGlUYXJnZXQgPSBpbmZvLnRhcmdldC5tYXRjaCgvXFwvcHVsbHNcXC8oWzEtOV1cXGQqKSg/OlxcL3wkKS8pO1xuICBjb25zdCByYXcgPSBhcGlUYXJnZXQ/LlsxXSA/P1xuICAgIChpbmZvLnZlcmIuc3RhcnRzV2l0aChcInByLVwiKSA/IGluZm8udGFyZ2V0IDogdW5kZWZpbmVkKTtcbiAgaWYgKCFyYXcgfHwgIS9eXFxkKyQvLnRlc3QocmF3KSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbnVtYmVyID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNTYWZlSW50ZWdlcihudW1iZXIpICYmIG51bWJlciA+IDAgPyBudW1iZXIgOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUmVjb3JkIGEgY2xhc3NpZmllZCBtdXRhdGlvbi5cbiAqXG4gKiBUaGUgbXV0YXRpb24gaXRzZWxmIGlzIG5ldmVyIGFib3J0ZWQgYnkgYSBqb3VybmFsbGluZyBmYWlsdXJlLCBidXQgdGhlXG4gKiBmYWlsdXJlIGlzIG5vIGxvbmdlciBpbnZpc2libGU6IGEgcmVmdXNlZCBhcHBlbmQgKG1vc3Qgb2Z0ZW4gYSBjaGFpblxuICogYW5jaG9yIHRoYXQgbm8gbG9uZ2VyIHJlY29uY2lsZXMg4oCUIElzc3VlICMzNzEyKSBpcyBsb2dnZWQgbG91ZCBzbyB0aGVcbiAqIHRhbXBlciBzaWduYWwgcmVhY2hlcyB0aGUgb3BlcmF0b3IgaW5zdGVhZCBvZiBiZWluZyBzaWxlbnRseSBzd2FsbG93ZWRcbiAqIChJc3N1ZSAjMzIzNCkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlY29yZChcbiAgaW5mbzogTXV0YXRpb25JbmZvLFxuICBleGl0Q29kZTogbnVtYmVyIHwgdW5kZWZpbmVkLFxuICBvcHRzOiBBdWRpdEhvb2tPcHRpb25zLFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjYWxsZXIgPSByZXNvbHZlQ2FsbGVyKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb3JkTXV0YXRpb24oe1xuICAgICAgYWN0aW9uSWQ6IGNyeXB0by5yYW5kb21VVUlEKCksXG4gICAgICBjb21wb25lbnQ6IGNvbXBvbmVudEZvcihjYWxsZXIpLFxuICAgICAgYWN0aW9uS2luZDogYWN0aW9uS2luZEZvcihpbmZvLCBjYWxsZXIsIGFyZ3MpLFxuICAgICAgLi4uKGluZm8udmVyYiA9PT0gXCJwci1tZXJnZVwiICYmIGhlYWRTaGFGb3IoYXJncylcbiAgICAgICAgPyB7IGhlYWRTaGE6IGhlYWRTaGFGb3IoYXJncykgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIC4uLihpbmZvLnZlcmIgPT09IFwiZ2l0LXB1c2hcIiAmJiBvcHRzLmRlbGl2ZXJlZENvbW1pdHMgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHsgZGVsaXZlcmVkQ29tbWl0czogb3B0cy5kZWxpdmVyZWRDb21taXRzIH1cbiAgICAgICAgOiB7fSksXG4gICAgICAuLi4ocHJOdW1iZXJGb3IoaW5mbykgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHsgcHJOdW1iZXI6IHByTnVtYmVyRm9yKGluZm8pIH1cbiAgICAgICAgOiB7fSksXG4gICAgICBydW5JZDogb3B0cy5ydW5JZCA/PyByZXNvbHZlUnVuSWQob3B0cy5lbnYgPz8gcHJvY2Vzc0Vudkxvb2t1cCksXG4gICAgICB2ZXJiOiBpbmZvLnZlcmIsXG4gICAgICBvdXRjb21lOiBleGl0Q29kZSA9PT0gMCA/IFwic3VjY2Vzc1wiIDogXCJlcnJvclwiLFxuICAgICAgLi4uKGluZm8ucmVwbyA/IHsgcmVwbzogaW5mby5yZXBvIH0gOiB7fSksXG4gICAgICAuLi4oaW5mby50YXJnZXQgPyB7IHRhcmdldDogaW5mby50YXJnZXQgfSA6IHt9KSxcbiAgICAgIC4uLihleGl0Q29kZSAhPT0gdW5kZWZpbmVkID8geyBleGl0Q29kZSB9IDoge30pLFxuICAgICAgLi4uKGNhbGxlciA/IHsgY2FsbGVyIH0gOiB7fSksXG4gICAgfSwgb3B0cyk7XG4gICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgIGBbU0VDVVJJVFldIFtBVURJVF9KT1VSTkFMX1JFRlVTRURdICR7aW5mby52ZXJifTogJHtyZXN1bHQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIEJlc3QtZWZmb3J0OiBuZXZlciBsZXQgam91cm5hbGxpbmcgcGVydHVyYiB0aGUgbXV0YXRpb24g4oCUIGJ1dCBzYXkgc28uXG4gICAgY29uc29sZS5lcnJvcihcbiAgICAgIGBbU0VDVVJJVFldIFtBVURJVF9KT1VSTkFMX1JFRlVTRURdICR7aW5mby52ZXJifTogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9YCxcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogSm91cm5hbCBhIGBnaGAgaW52b2NhdGlvbiBpZiBpdCBpcyBhIEdpdEh1YiBtdXRhdGlvbi5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBwYXNzZWQgdG8gYGdoYFxuICogQHBhcmFtIGV4aXRDb2RlIC0gVGhlIGdoIHByb2Nlc3MgZXhpdCBjb2RlICh1bmRlZmluZWQgaWYgdW5rbm93bilcbiAqIEBwYXJhbSBvcHRzIC0gSW5qZWN0ZWQgZ2F0aW5nLCBpZGVudGl0eSBhbmQgc3RvcmFnZSBsb2NhdGlvbiAoSXNzdWUgIzk2MykuXG4gKiAgIE9taXQgaW4gcHJvZHVjdGlvbjogZXZlcnkgZmllbGQgZGVmYXVsdHMgdG8gdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhdWRpdEdoTXV0YXRpb24oXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBleGl0Q29kZT86IG51bWJlcixcbiAgb3B0czogQXVkaXRIb29rT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghaXNBdWRpdEpvdXJuYWxFbmFibGVkKG9wdHMuZW52ID8/IHByb2Nlc3NFbnZMb29rdXApKSByZXR1cm47XG4gIGNvbnN0IGluZm8gPSBjbGFzc2lmeUdoTXV0YXRpb24oYXJncyk7XG4gIGlmICghaW5mbykgcmV0dXJuO1xuICBhd2FpdCByZWNvcmQoaW5mbywgZXhpdENvZGUsIG9wdHMsIGFyZ3MpO1xufVxuXG4vKipcbiAqIEpvdXJuYWwgYSBgZ2l0YCBpbnZvY2F0aW9uIGlmIGl0IG11dGF0ZXMgcmVtb3RlIEdpdEh1YiBzdGF0ZSAocHVzaCkuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBBcmd1bWVudHMgcGFzc2VkIHRvIGBnaXRgXG4gKiBAcGFyYW0gZXhpdENvZGUgLSBUaGUgZ2l0IHByb2Nlc3MgZXhpdCBjb2RlICh1bmRlZmluZWQgaWYgdW5rbm93bilcbiAqIEBwYXJhbSBvcHRzIC0gSW5qZWN0ZWQgZ2F0aW5nLCBpZGVudGl0eSBhbmQgc3RvcmFnZSBsb2NhdGlvbiAoSXNzdWUgIzk2MykuXG4gKiAgIE9taXQgaW4gcHJvZHVjdGlvbjogZXZlcnkgZmllbGQgZGVmYXVsdHMgdG8gdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhdWRpdEdpdE11dGF0aW9uKFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgZXhpdENvZGU/OiBudW1iZXIsXG4gIG9wdHM6IEF1ZGl0SG9va09wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIWlzQXVkaXRKb3VybmFsRW5hYmxlZChvcHRzLmVudiA/PyBwcm9jZXNzRW52TG9va3VwKSkgcmV0dXJuO1xuICBjb25zdCBpbmZvID0gY2xhc3NpZnlHaXRNdXRhdGlvbihhcmdzKTtcbiAgaWYgKCFpbmZvKSByZXR1cm47XG4gIGF3YWl0IHJlY29yZChpbmZvLCBleGl0Q29kZSwgb3B0cywgYXJncyk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBRUQsU0FDRSxjQUFjLEVBRWQsWUFBWSxRQUNQLHFCQUFxQjtBQUU1QixTQUNFLGtCQUFrQixFQUNsQixtQkFBbUIsUUFFZCxpQ0FBaUM7QUFDeEMsU0FBeUIsZ0JBQWdCLFFBQVEsa0JBQWtCO0FBd0JuRSw4REFBOEQsR0FDOUQsT0FBTyxTQUFTLDBCQUNkLE1BQWlCLGdCQUFnQjtFQUVqQyxNQUFNLFdBQVcsSUFBSTtFQUNyQixPQUFPLFFBQ0wsWUFBWSxhQUFhLE9BQU8sU0FBUyxXQUFXLE9BQU87QUFFL0Q7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxzQkFDZCxNQUFpQixnQkFBZ0I7RUFFakMsSUFBSSwwQkFBMEIsTUFBTSxPQUFPO0VBQzNDLG1FQUFtRTtFQUNuRSxPQUFPLFFBQVEsSUFBSSxxQkFBcUIsSUFBSTtBQUM5QztBQUVBOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsTUFBTSxpQkFBd0M7RUFDNUM7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRDtBQUVEOzs7Ozs7Ozs7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
// denoCacheMetadata=7444736668471783657,16720854053524587447