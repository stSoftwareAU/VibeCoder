/**
 * The milestone sync's conflict ladder (Issue #1777).
 *
 * The PR pass climbs three rungs before it gives up on a conflict: the
 * deterministic triage, the dependency rules, then the resolution agent. The
 * milestone sync stopped at the first — a single `rival-designs` file aborted
 * the whole merge, and #1754, #1756 and #1764 were three-to-six-line hunks
 * escalated that way. This module is the two rungs the sync was missing,
 * applied only to the paths the triage could not decide.
 *
 * Nothing here judges the merge: it reports which rung decided each file so
 * the merge commit, the log and the sync's report all name it, and a rung that
 * fails is returned as a still-escalated file rather than swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { portedDecision, resolvePortedPaths } from "./milestone_conflict_ported.ts";
import { applyDependencyConflictRules } from "./dependency_conflict_apply.ts";
import { unstageStateAndAssertSafe } from "./git_push.ts";
import { readPrResponseMessage } from "./pr_branch_preparation.ts";
import { describeGitFailure } from "./milestone_merge_state.ts";
/**
 * The reason the agent rung leaves when the **worker** ended the run — the
 * watchdog's SIGTERM at the cycle deadline, not the agent's own ceiling
 * (Issue #1693).
 *
 * Spelled once here because `judgeSyncFailure` reads it back to tell a kill
 * from a judged failure: a kill concludes `disrupted` and is charged nothing,
 * while an agent that ran out its own timeout is a failed attempt like any
 * other (Issue #2305).
 */ export const AGENT_RUN_ENDED_BY_WORKER = "the run was ended by the worker before it finished";
/**
 * Why the agent rung stopped when the provider refused the run — a 402
 * insufficient balance, an auth failure or an exhausted 429/5xx. Read back by
 * `judgeSyncFailure`, which concludes it `disrupted`: nothing is charged, no
 * roll-back runs and the next cycle retries once the provider answers
 * (Issue #2613).
 */ export const AGENT_PROVIDER_UNAVAILABLE = "the agent provider was unavailable";
/** Bind a {@link ConflictGitRunner} to the clone the merge is in. */ function gitRunner(options) {
  return async (args)=>{
    const result = await runGitCommand([
      ...args
    ], options);
    // "Could not run git" is not "git was happy" — fold a spawn failure into
    // a non-zero code rather than an empty success.
    return result.ok ? {
      code: result.value.code,
      stdout: result.value.stdout,
      stderr: result.value.stderr
    } : {
      code: 1,
      stdout: "",
      stderr: result.error.message
    };
  };
}
/**
 * Paths git reports as unmerged, over the whole tree or the paths given.
 *
 * A listing git could not produce is an error, never an empty list: "the
 * check could not run" read as "nothing is unmerged" is exactly the silent
 * pass that lets a half-resolved tree be committed.
 *
 * @param options - Git options; `cwd` is the clone holding the merge
 * @param paths - Restrict the listing to these paths; empty means the tree
 * @returns The unmerged paths, or the failure that stopped the listing
 */ export async function listUnmergedPaths(options, paths = []) {
  const result = await runGitCommand([
    "diff",
    "--name-only",
    "--diff-filter=U",
    ...paths.length > 0 ? [
      "--",
      ...paths
    ] : []
  ], options);
  if (!result.ok || result.value.code !== 0) {
    const detail = (result.ok ? result.value.stderr : result.error.message).trim();
    return {
      ok: false,
      error: new Error(`the unmerged paths could not be listed: ${detail || `git exited ${result.ok ? result.value.code : 1}`}`)
    };
  }
  return {
    ok: true,
    value: result.value.stdout.trim().split("\n").filter(Boolean)
  };
}
/**
 * Whether any of the given paths still carries a conflict marker.
 *
 * A staged file full of `<<<<<<<` is resolved as far as the index is
 * concerned and broken as far as everything else is concerned, so it is
 * checked before the resolution is committed. `git grep` exits 1 for "no
 * match" and 2 or more for a real failure, so the two are told apart rather
 * than both read as a clean tree.
 *
 * @param paths - The paths to check; empty checks nothing and reports none
 * @param options - Git options; `cwd` is the clone holding the merge
 * @returns Whether a marker was found, or the failure that stopped the check
 */ export async function hasConflictMarkers(paths, options) {
  if (paths.length === 0) return {
    ok: true,
    value: false
  };
  const result = await runGitCommand([
    "grep",
    "-l",
    "-I",
    "-E",
    "^(<<<<<<<|>>>>>>>) ",
    "--",
    ...paths
  ], options);
  if (!result.ok || result.value.code > 1) {
    const detail = (result.ok ? result.value.stderr : result.error.message).trim();
    return {
      ok: false,
      error: new Error(`the conflict-marker check could not be run: ${detail || `git exited ${result.ok ? result.value.code : 1}`}`)
    };
  }
  return {
    ok: true,
    value: result.value.code === 0 && result.value.stdout.trim().length > 0
  };
}
/**
 * Stage what the agent produced, exactly as `commitAndPushPending` would.
 *
 * `git add -- <the conflicted paths>` is not enough: an agent that resolves a
 * collision by extracting a helper leaves that new file unstaged, so the
 * merge commit would carry a tree the resolution gate never verified. So the
 * whole working tree is staged, the worker's own state files come straight
 * back out (Issue #1654 — a stray `.heartbeat_*` in the shared clone must not
 * cost the commit), and the pre-commit safety gate then refuses any hidden or
 * secret-bearing path exactly as it does on every other commit path.
 *
 * The gate-repair rung stages the same way (Issue #1965): a repair that adds
 * a file is the same shape as a resolution that extracts a helper.
 *
 * @param options - Git options; `cwd` is the clone holding the merge
 * @returns Nothing on success, or the failure that stopped the staging
 */ export async function stageAgentResolution(options) {
  const added = await runGitCommand([
    "add",
    "-A"
  ], options);
  if (!added.ok || added.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`its resolution could not be staged: ${describeGitFailure(added)}`)
    };
  }
  const safe = await unstageStateAndAssertSafe(options);
  return safe.ok ? {
    ok: true,
    value: undefined
  } : {
    ok: false,
    error: safe.error
  };
}
/**
 * Climb the rules rung, then the agent rung, over the triage's leftovers.
 *
 * The rules run first because a lock file or a manifest needs no judgement —
 * asking the agent to re-reason about a file a rule already staged spends a
 * model run on a decided question. Whatever the rules defer is the agent's,
 * narrowed to exactly those paths.
 *
 * @param input - The undecided files and the rungs to try
 * @returns What each rung settled, and what is left for a human
 */ export async function climbConflictLadder(input) {
  const { escalations, options, milestoneBranch, defaultBranch, agentFn, applyRulesFn = applyDependencyConflictRules, portedFn = resolvePortedPaths, shapeThresholds, timer, logger } = input;
  if (escalations.length === 0) return {
    resolved: [],
    escalations: []
  };
  const byPath = new Map(escalations.map((d)=>[
      d.path,
      d
    ]));
  const resolved = [];
  // --- Rung 2: the deterministic dependency rules ---------------------------
  timer?.start("rules");
  const ruleReport = await applyRulesFn({
    workingDir: options.cwd ?? ".",
    conflictedFiles: escalations.map((d)=>d.path),
    git: gitRunner(options),
    logger: logger ? {
      warn: (message, context)=>logger.warn(message, context),
      info: (message, context)=>logger.info(message, context)
    } : undefined
  });
  timer?.stop();
  for (const file of ruleReport.resolved){
    const decision = byPath.get(file.path);
    if (!decision) continue;
    resolved.push({
      ...decision,
      action: "resolved",
      rung: "rule",
      reason: `${file.kind === "lock" ? "lock file" : "manifest"} resolved by ${file.resolvedBy}`
    });
  }
  const deferred = ruleReport.deferred.map((file)=>file.path).filter((path)=>byPath.has(path));
  if (deferred.length === 0) return {
    resolved,
    escalations: []
  };
  // --- Rung 2b: history — the "ported" rule (Issue #2023) -----------------
  // Ninety files with add/add pairs across directories is not a set of hunks
  // to read; it is a branch whose content the default branch already
  // absorbed under different history. For each path, if the other branch's
  // history carries this side's exact version, the other side contains ours
  // and is taken. The paths it cannot prove stay the agent's, as before.
  const ported = await portedFn({
    paths: deferred,
    options,
    milestoneBranch,
    defaultBranch,
    ...shapeThresholds ? {
      thresholds: shapeThresholds
    } : {},
    log: (message)=>logger?.info(message, {
        milestoneBranch,
        defaultBranch
      })
  });
  for (const settled of ported.resolved){
    const decision = byPath.get(settled.path);
    if (!decision) continue;
    resolved.push(portedDecision(decision, settled, defaultBranch));
  }
  const stillDeferred = ported.undecided.map((u)=>u.path);
  if (stillDeferred.length === 0) return {
    resolved,
    escalations: []
  };
  if (ported.resolved.length > 0) {
    logger?.info("Milestone sync: the ported rule settled some paths; the rest go on " + "up the ladder (Issue #2023)", {
      milestoneBranch,
      defaultBranch,
      remaining: stillDeferred
    });
  }
  deferred.length = 0;
  deferred.push(...stillDeferred);
  // --- Rung 3: the resolution agent ----------------------------------------
  const stillEscalated = (reason)=>deferred.map((path)=>{
      const decision = byPath.get(path);
      return {
        ...decision,
        action: "escalate",
        reason: reason(path)
      };
    });
  if (!agentFn) {
    return {
      resolved,
      escalations: stillEscalated((path)=>`${byPath.get(path).reason} — and no resolution agent was available ` + `to this sync (Issue #1777)`)
    };
  }
  logger?.info("Milestone sync: handing the remaining conflicts to the agent (Issue #1777)", {
    milestoneBranch,
    defaultBranch,
    conflictedFiles: deferred
  });
  timer?.start("agent");
  const outcome = await agentFn({
    conflictedFiles: deferred,
    milestoneBranch,
    defaultBranch,
    workDir: options.cwd ?? "."
  });
  timer?.stop();
  if (!outcome.ok) {
    return {
      resolved,
      escalations: stillEscalated(()=>`agent: ${outcome.error.message}`)
    };
  }
  if (outcome.value.terminated || outcome.value.finishDeadline) {
    // The worker itself ended the run, or the finish deadline did (Issue
    // #4245), so the tree is half-edited through no fault of the conflict.
    // Not a verdict — the merge is abandoned and the branch is left where
    // it was (Issue #1693). A finish deadline is logged as a scheduled
    // release and carries the same marker, so nothing is charged.
    if (outcome.value.finishDeadline) {
      logger?.info("Milestone sync released on schedule: the finish deadline was reached");
    }
    return {
      resolved,
      escalations: stillEscalated(()=>`agent: ${AGENT_RUN_ENDED_BY_WORKER} (Issue #1693)`)
    };
  }
  const providerError = outcome.value.providerUnavailable;
  if (providerError !== undefined) {
    // The provider refused the run, so the conflict was never looked at. Not
    // a verdict either — leave the branch and retry later (Issue #2613).
    return {
      resolved,
      escalations: stillEscalated(()=>`agent: ${AGENT_PROVIDER_UNAVAILABLE} — ${providerError} (Issue #2613)`)
    };
  }
  // Read the index BEFORE staging anything. `git add` on a conflicted path is
  // how a conflict is marked resolved, so staging first would answer this
  // question with its own side effect — and an agent that touched nothing
  // would have the working-tree side committed as if it had decided.
  const unmerged = await listUnmergedPaths(options, deferred);
  if (!unmerged.ok) {
    return {
      resolved,
      escalations: stillEscalated(()=>`agent: its resolution could not be verified — ${unmerged.error.message}`)
    };
  }
  if (unmerged.value.length > 0) {
    return {
      resolved,
      escalations: stillEscalated(()=>`agent: it left ${unmerged.value.length} path(s) unmerged: ${unmerged.value.join(", ")}`)
    };
  }
  const markers = await hasConflictMarkers(deferred, options);
  if (!markers.ok) {
    return {
      resolved,
      escalations: stillEscalated(()=>`agent: its resolution could not be verified — ${markers.error.message}`)
    };
  }
  if (markers.value) {
    return {
      resolved,
      escalations: stillEscalated(()=>`agent: its resolution still contains conflict markers`)
    };
  }
  const staged = await stageAgentResolution(options);
  if (!staged.ok) {
    return {
      resolved,
      escalations: stillEscalated(()=>`agent: ${staged.error.message}`)
    };
  }
  for (const path of deferred){
    resolved.push({
      ...byPath.get(path),
      action: "resolved",
      rung: "agent",
      reason: "resolved by the merge-conflict agent"
    });
  }
  // Read after staging, so consuming the reply file cannot change what the
  // commit carries: `stageAgentResolution` has already taken the worker's
  // own state files back out of the index (Issue #1654).
  const agentReply = await readPrResponseMessage(options.cwd, logger);
  return {
    resolved,
    escalations: [],
    ...agentReply ? {
      agentReply
    } : {}
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfY29uZmxpY3RfbGFkZGVyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIG1pbGVzdG9uZSBzeW5jJ3MgY29uZmxpY3QgbGFkZGVyIChJc3N1ZSAjMTc3NykuXG4gKlxuICogVGhlIFBSIHBhc3MgY2xpbWJzIHRocmVlIHJ1bmdzIGJlZm9yZSBpdCBnaXZlcyB1cCBvbiBhIGNvbmZsaWN0OiB0aGVcbiAqIGRldGVybWluaXN0aWMgdHJpYWdlLCB0aGUgZGVwZW5kZW5jeSBydWxlcywgdGhlbiB0aGUgcmVzb2x1dGlvbiBhZ2VudC4gVGhlXG4gKiBtaWxlc3RvbmUgc3luYyBzdG9wcGVkIGF0IHRoZSBmaXJzdCDigJQgYSBzaW5nbGUgYHJpdmFsLWRlc2lnbnNgIGZpbGUgYWJvcnRlZFxuICogdGhlIHdob2xlIG1lcmdlLCBhbmQgIzE3NTQsICMxNzU2IGFuZCAjMTc2NCB3ZXJlIHRocmVlLXRvLXNpeC1saW5lIGh1bmtzXG4gKiBlc2NhbGF0ZWQgdGhhdCB3YXkuIFRoaXMgbW9kdWxlIGlzIHRoZSB0d28gcnVuZ3MgdGhlIHN5bmMgd2FzIG1pc3NpbmcsXG4gKiBhcHBsaWVkIG9ubHkgdG8gdGhlIHBhdGhzIHRoZSB0cmlhZ2UgY291bGQgbm90IGRlY2lkZS5cbiAqXG4gKiBOb3RoaW5nIGhlcmUganVkZ2VzIHRoZSBtZXJnZTogaXQgcmVwb3J0cyB3aGljaCBydW5nIGRlY2lkZWQgZWFjaCBmaWxlIHNvXG4gKiB0aGUgbWVyZ2UgY29tbWl0LCB0aGUgbG9nIGFuZCB0aGUgc3luYydzIHJlcG9ydCBhbGwgbmFtZSBpdCwgYW5kIGEgcnVuZyB0aGF0XG4gKiBmYWlscyBpcyByZXR1cm5lZCBhcyBhIHN0aWxsLWVzY2FsYXRlZCBmaWxlIHJhdGhlciB0aGFuIHN3YWxsb3dlZC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IExvZ2dlciwgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB0eXBlIHsgR2l0Q29tbWFuZE9wdGlvbnMgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHR5cGUgeyBGaWxlRGVjaXNpb24gfSBmcm9tIFwiLi9taWxlc3RvbmVfY29uZmxpY3RfdHJpYWdlLnRzXCI7XG5pbXBvcnQge1xuICBwb3J0ZWREZWNpc2lvbixcbiAgdHlwZSBQb3J0ZWRGbixcbiAgcmVzb2x2ZVBvcnRlZFBhdGhzLFxuICB0eXBlIFNoYXBlVGhyZXNob2xkcyxcbn0gZnJvbSBcIi4vbWlsZXN0b25lX2NvbmZsaWN0X3BvcnRlZC50c1wiO1xuaW1wb3J0IHtcbiAgYXBwbHlEZXBlbmRlbmN5Q29uZmxpY3RSdWxlcyxcbiAgdHlwZSBDb25mbGljdEdpdFJ1bm5lcixcbiAgdHlwZSBEZXBlbmRlbmN5UnVsZUFwcGxpZXIsXG59IGZyb20gXCIuL2RlcGVuZGVuY3lfY29uZmxpY3RfYXBwbHkudHNcIjtcbmltcG9ydCB0eXBlIHtcbiAgTWVyZ2VDb25mbGljdEFnZW50T3V0Y29tZSxcbiAgTWVyZ2VDb25mbGljdFJlcGFpckNvbnRleHQsXG59IGZyb20gXCIuL21lcmdlX2NvbmZsaWN0X2FnZW50LnRzXCI7XG5pbXBvcnQgeyB1bnN0YWdlU3RhdGVBbmRBc3NlcnRTYWZlIH0gZnJvbSBcIi4vZ2l0X3B1c2gudHNcIjtcbmltcG9ydCB7IHJlYWRQclJlc3BvbnNlTWVzc2FnZSB9IGZyb20gXCIuL3ByX2JyYW5jaF9wcmVwYXJhdGlvbi50c1wiO1xuaW1wb3J0IHsgZGVzY3JpYmVHaXRGYWlsdXJlIH0gZnJvbSBcIi4vbWlsZXN0b25lX21lcmdlX3N0YXRlLnRzXCI7XG5pbXBvcnQgdHlwZSB7IENvbmZsaWN0U3RhZ2VUaW1lciB9IGZyb20gXCIuL2NvbmZsaWN0X3N0YWdlX3RpbWVyLnRzXCI7XG5cbi8qKlxuICogVGhlIHJlYXNvbiB0aGUgYWdlbnQgcnVuZyBsZWF2ZXMgd2hlbiB0aGUgKip3b3JrZXIqKiBlbmRlZCB0aGUgcnVuIOKAlCB0aGVcbiAqIHdhdGNoZG9nJ3MgU0lHVEVSTSBhdCB0aGUgY3ljbGUgZGVhZGxpbmUsIG5vdCB0aGUgYWdlbnQncyBvd24gY2VpbGluZ1xuICogKElzc3VlICMxNjkzKS5cbiAqXG4gKiBTcGVsbGVkIG9uY2UgaGVyZSBiZWNhdXNlIGBqdWRnZVN5bmNGYWlsdXJlYCByZWFkcyBpdCBiYWNrIHRvIHRlbGwgYSBraWxsXG4gKiBmcm9tIGEganVkZ2VkIGZhaWx1cmU6IGEga2lsbCBjb25jbHVkZXMgYGRpc3J1cHRlZGAgYW5kIGlzIGNoYXJnZWQgbm90aGluZyxcbiAqIHdoaWxlIGFuIGFnZW50IHRoYXQgcmFuIG91dCBpdHMgb3duIHRpbWVvdXQgaXMgYSBmYWlsZWQgYXR0ZW1wdCBsaWtlIGFueVxuICogb3RoZXIgKElzc3VlICMyMzA1KS5cbiAqL1xuZXhwb3J0IGNvbnN0IEFHRU5UX1JVTl9FTkRFRF9CWV9XT1JLRVIgPVxuICBcInRoZSBydW4gd2FzIGVuZGVkIGJ5IHRoZSB3b3JrZXIgYmVmb3JlIGl0IGZpbmlzaGVkXCI7XG5cbi8qKlxuICogV2h5IHRoZSBhZ2VudCBydW5nIHN0b3BwZWQgd2hlbiB0aGUgcHJvdmlkZXIgcmVmdXNlZCB0aGUgcnVuIOKAlCBhIDQwMlxuICogaW5zdWZmaWNpZW50IGJhbGFuY2UsIGFuIGF1dGggZmFpbHVyZSBvciBhbiBleGhhdXN0ZWQgNDI5LzV4eC4gUmVhZCBiYWNrIGJ5XG4gKiBganVkZ2VTeW5jRmFpbHVyZWAsIHdoaWNoIGNvbmNsdWRlcyBpdCBgZGlzcnVwdGVkYDogbm90aGluZyBpcyBjaGFyZ2VkLCBub1xuICogcm9sbC1iYWNrIHJ1bnMgYW5kIHRoZSBuZXh0IGN5Y2xlIHJldHJpZXMgb25jZSB0aGUgcHJvdmlkZXIgYW5zd2Vyc1xuICogKElzc3VlICMyNjEzKS5cbiAqL1xuZXhwb3J0IGNvbnN0IEFHRU5UX1BST1ZJREVSX1VOQVZBSUxBQkxFID0gXCJ0aGUgYWdlbnQgcHJvdmlkZXIgd2FzIHVuYXZhaWxhYmxlXCI7XG5cbi8qKiBPbmUgYWdlbnQgcnVuIGFza2VkIGZvciBieSB0aGUgbWlsZXN0b25lIHN5bmMuICovXG5leHBvcnQgaW50ZXJmYWNlIE1pbGVzdG9uZUNvbmZsaWN0QWdlbnRSZXF1ZXN0IHtcbiAgLyoqIFBhdGhzIHRoZSB0cmlhZ2UgYW5kIHRoZSBkZXBlbmRlbmN5IHJ1bGVzIGJvdGggbGVmdCB1bmRlY2lkZWQuICovXG4gIGNvbmZsaWN0ZWRGaWxlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgYnJhbmNoIHRoZSBkZWZhdWx0IGJyYW5jaCBpcyBiZWluZyBtZXJnZWQgaW50by4gKi9cbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmc7XG4gIC8qKiBUaGUgYnJhbmNoIGJlaW5nIG1lcmdlZCBpbi4gKi9cbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nO1xuICAvKiogVGhlIGNsb25lIHRoZSBjb25mbGljdGVkIG1lcmdlIGlzIGluIHByb2dyZXNzIGluLiAqL1xuICB3b3JrRGlyOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBTZXQgd2hlbiB0aGlzIHJ1biByZXBhaXJzIGEgcmVzb2x1dGlvbiB0aGUgdmVyaWZpY2F0aW9uIHJlZnVzZWRcbiAgICogKElzc3VlICMxOTY1KSByYXRoZXIgdGhhbiByZXNvbHZpbmcgdGhlIGNvbmZsaWN0IGl0c2VsZi4gVGhlIG1lcmdlIGlzXG4gICAqIGFscmVhZHkgY29tbWl0dGVkIGluIHRoZSBjbG9uZTsgd2hhdCB0aGUgcnVuIGFuc3dlcnMgaXMgdGhlIGdhdGUnc1xuICAgKiBmYWlsaW5nIGNvbW1hbmQgYW5kIGl0cyBvdXRwdXQuXG4gICAqL1xuICByZXBhaXI/OiBNZXJnZUNvbmZsaWN0UmVwYWlyQ29udGV4dDtcbn1cblxuLyoqXG4gKiBUaGUgYWdlbnQgcnVuZywgaW5qZWN0ZWQgc28gYSB0ZXN0IG5lZWRzIG5vIG1vZGVsIChJc3N1ZSAjMTc3NykuXG4gKlxuICogUHJvZHVjdGlvbiBiaW5kcyB0aGlzIHRvIGBydW5NZXJnZUNvbmZsaWN0QWdlbnRgIHdpdGggYSBicmFuY2ggdGFyZ2V0OyBhXG4gKiBzeW5jIGdpdmVuIG5vbmUgc2ltcGx5IHN0b3BzIGFmdGVyIHRoZSBydWxlcywgd2hpY2ggaXMgdGhlIHByZS0jMTc3N1xuICogYmVoYXZpb3VyIHJhdGhlciB0aGFuIGEgc2lsZW50IHBhc3MuXG4gKi9cbmV4cG9ydCB0eXBlIE1pbGVzdG9uZUNvbmZsaWN0QWdlbnRGbiA9IChcbiAgcmVxdWVzdDogTWlsZXN0b25lQ29uZmxpY3RBZ2VudFJlcXVlc3QsXG4pID0+IFByb21pc2U8UmVzdWx0PE1lcmdlQ29uZmxpY3RBZ2VudE91dGNvbWU+PjtcblxuLyoqIFdoYXQgdGhlIGxhZGRlciBpcyBhc2tlZCB0byBjbGltYi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29uZmxpY3RMYWRkZXJJbnB1dCB7XG4gIC8qKiBUaGUgdHJpYWdlJ3MgdW5kZWNpZGVkIGZpbGVzLCBpbiB0aGUgb3JkZXIgaXQgcmVwb3J0ZWQgdGhlbS4gKi9cbiAgZXNjYWxhdGlvbnM6IHJlYWRvbmx5IEZpbGVEZWNpc2lvbltdO1xuICAvKiogR2l0IG9wdGlvbnM7IGBjd2RgIGlzIHRoZSBjbG9uZSBob2xkaW5nIHRoZSBjb25mbGljdGVkIG1lcmdlLiAqL1xuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucztcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmc7XG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZztcbiAgLyoqIFRoZSBhZ2VudCBydW5nOyBhYnNlbnQgc3RvcHMgdGhlIGxhZGRlciBhZnRlciB0aGUgcnVsZXMuICovXG4gIGFnZW50Rm4/OiBNaWxlc3RvbmVDb25mbGljdEFnZW50Rm47XG4gIC8qKiBUaGUgcnVsZXMgcnVuZzsgZGVmYXVsdHMgdG8gdGhlIHNoYXJlZCBkZXBlbmRlbmN5IHJ1bGVzLiAqL1xuICBhcHBseVJ1bGVzRm4/OiBEZXBlbmRlbmN5UnVsZUFwcGxpZXI7XG4gIC8qKlxuICAgKiBUaGUgcG9ydGVkIHJ1bmcgKElzc3VlICMyMDIzKTsgZGVmYXVsdHMgdG8gdGhlIHJlYWwgb25lLiBSdW5zIGJldHdlZW5cbiAgICogdGhlIHJ1bGVzIGFuZCB0aGUgYWdlbnQsIHNldHRsZXMgb25seSB0aGUgcGF0aHMgd2hvc2Ugb3RoZXIgc2lkZVxuICAgKiBwcm92YWJseSBhYnNvcmJlZCB0aGVtLCBhbmQgbGVhdmVzIHRoZSByZXN0IGZvciB0aGUgYWdlbnQuXG4gICAqL1xuICBwb3J0ZWRGbj86IFBvcnRlZEZuO1xuICAvKiogV2hlbiBhIGNvbmZsaWN0J3Mgc2hhcGUgaXMgbG9nZ2VkIGFzIHdyb25nLWJhc2U7IGRlZmF1bHRzIGFwcGx5LiAqL1xuICBzaGFwZVRocmVzaG9sZHM/OiBTaGFwZVRocmVzaG9sZHM7XG4gIC8qKlxuICAgKiBUaGUgc3luYydzIHN0YWdlIHRpbWVyIChJc3N1ZSAjMjMwOCkuIFRoZSBsYWRkZXIgdGltZXMgaXRzIGBydWxlc2AgYW5kXG4gICAqIGBhZ2VudGAgcnVuZ3MgaW50byBpdDsgYWJzZW50LCBub3RoaW5nIGlzIHRpbWVkIGFuZCB0aGUgbGFkZGVyIGJlaGF2ZXNcbiAgICogZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqL1xuICB0aW1lcj86IENvbmZsaWN0U3RhZ2VUaW1lcjtcbiAgbG9nZ2VyPzogTG9nZ2VyO1xufVxuXG4vKiogV2hpY2ggZmlsZXMgdGhlIGxhZGRlciBzZXR0bGVkLCBhbmQgd2hpY2ggc3RpbGwgbmVlZCBhIGh1bWFuLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb25mbGljdExhZGRlck91dGNvbWUge1xuICAvKiogU2V0dGxlZCBieSBhIHJ1bmcgYmVsb3cgdGhlIGh1bWFuLCBlYWNoIG5hbWluZyB0aGUgcnVuZyB0aGF0IGRpZCBpdC4gKi9cbiAgcmVzb2x2ZWQ6IEZpbGVEZWNpc2lvbltdO1xuICAvKiogU3RpbGwgZm9yIGEgaHVtYW4sIGVhY2ggcmVhc29uIG5hbWluZyB0aGUgcnVuZyB0aGF0IGNvdWxkIG5vdCBkZWNpZGUuICovXG4gIGVzY2FsYXRpb25zOiBGaWxlRGVjaXNpb25bXTtcbiAgLyoqXG4gICAqIFdoYXQgdGhlIGFnZW50IHJ1bmcgd3JvdGUgaW50byBgLnByX3Jlc3BvbnNlX21lc3NhZ2VgIChJc3N1ZSAjMjMwNikuXG4gICAqXG4gICAqIFRoZSBhZ2VudCBuYW1lcyBldmVyeSBqdWRnZW1lbnQgY2FsbCBmaWxlIGJ5IGZpbGUgdGhlcmUsIGFuZCBvbiB0aGlzXG4gICAqIHBhdGggdGhlcmUgaXMgbm8gUFIgY29tbWVudCB0byBjYXJyeSB0aGVtIOKAlCBzbyB0aGUgcmVwbHkgdHJhdmVscyB3aXRoXG4gICAqIHRoZSBvdXRjb21lIGFuZCBsYW5kcyBvbiB0aGUgc3luYyByZXBvcnQgaW5zdGVhZC4gQWJzZW50IHdoZW4gbm8gYWdlbnRcbiAgICogcmFuLCBvciB3aGVuIGl0IHdyb3RlIG5vdGhpbmcuXG4gICAqL1xuICBhZ2VudFJlcGx5Pzogc3RyaW5nO1xufVxuXG4vKiogQmluZCBhIHtAbGluayBDb25mbGljdEdpdFJ1bm5lcn0gdG8gdGhlIGNsb25lIHRoZSBtZXJnZSBpcyBpbi4gKi9cbmZ1bmN0aW9uIGdpdFJ1bm5lcihvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyk6IENvbmZsaWN0R2l0UnVubmVyIHtcbiAgcmV0dXJuIGFzeW5jIChhcmdzKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChbLi4uYXJnc10sIG9wdGlvbnMpO1xuICAgIC8vIFwiQ291bGQgbm90IHJ1biBnaXRcIiBpcyBub3QgXCJnaXQgd2FzIGhhcHB5XCIg4oCUIGZvbGQgYSBzcGF3biBmYWlsdXJlIGludG9cbiAgICAvLyBhIG5vbi16ZXJvIGNvZGUgcmF0aGVyIHRoYW4gYW4gZW1wdHkgc3VjY2Vzcy5cbiAgICByZXR1cm4gcmVzdWx0Lm9rXG4gICAgICA/IHtcbiAgICAgICAgY29kZTogcmVzdWx0LnZhbHVlLmNvZGUsXG4gICAgICAgIHN0ZG91dDogcmVzdWx0LnZhbHVlLnN0ZG91dCxcbiAgICAgICAgc3RkZXJyOiByZXN1bHQudmFsdWUuc3RkZXJyLFxuICAgICAgfVxuICAgICAgOiB7IGNvZGU6IDEsIHN0ZG91dDogXCJcIiwgc3RkZXJyOiByZXN1bHQuZXJyb3IubWVzc2FnZSB9O1xuICB9O1xufVxuXG4vKipcbiAqIFBhdGhzIGdpdCByZXBvcnRzIGFzIHVubWVyZ2VkLCBvdmVyIHRoZSB3aG9sZSB0cmVlIG9yIHRoZSBwYXRocyBnaXZlbi5cbiAqXG4gKiBBIGxpc3RpbmcgZ2l0IGNvdWxkIG5vdCBwcm9kdWNlIGlzIGFuIGVycm9yLCBuZXZlciBhbiBlbXB0eSBsaXN0OiBcInRoZVxuICogY2hlY2sgY291bGQgbm90IHJ1blwiIHJlYWQgYXMgXCJub3RoaW5nIGlzIHVubWVyZ2VkXCIgaXMgZXhhY3RseSB0aGUgc2lsZW50XG4gKiBwYXNzIHRoYXQgbGV0cyBhIGhhbGYtcmVzb2x2ZWQgdHJlZSBiZSBjb21taXR0ZWQuXG4gKlxuICogQHBhcmFtIG9wdGlvbnMgLSBHaXQgb3B0aW9uczsgYGN3ZGAgaXMgdGhlIGNsb25lIGhvbGRpbmcgdGhlIG1lcmdlXG4gKiBAcGFyYW0gcGF0aHMgLSBSZXN0cmljdCB0aGUgbGlzdGluZyB0byB0aGVzZSBwYXRoczsgZW1wdHkgbWVhbnMgdGhlIHRyZWVcbiAqIEByZXR1cm5zIFRoZSB1bm1lcmdlZCBwYXRocywgb3IgdGhlIGZhaWx1cmUgdGhhdCBzdG9wcGVkIHRoZSBsaXN0aW5nXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsaXN0VW5tZXJnZWRQYXRocyhcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nW10+PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1xuICAgICAgXCJkaWZmXCIsXG4gICAgICBcIi0tbmFtZS1vbmx5XCIsXG4gICAgICBcIi0tZGlmZi1maWx0ZXI9VVwiLFxuICAgICAgLi4uKHBhdGhzLmxlbmd0aCA+IDAgPyBbXCItLVwiLCAuLi5wYXRoc10gOiBbXSksXG4gICAgXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIXJlc3VsdC5vayB8fCByZXN1bHQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIGNvbnN0IGRldGFpbCA9IChyZXN1bHQub2sgPyByZXN1bHQudmFsdWUuc3RkZXJyIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UpXG4gICAgICAudHJpbSgpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgdGhlIHVubWVyZ2VkIHBhdGhzIGNvdWxkIG5vdCBiZSBsaXN0ZWQ6ICR7XG4gICAgICAgICAgZGV0YWlsIHx8IGBnaXQgZXhpdGVkICR7cmVzdWx0Lm9rID8gcmVzdWx0LnZhbHVlLmNvZGUgOiAxfWBcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICB2YWx1ZTogcmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCkuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pLFxuICB9O1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYW55IG9mIHRoZSBnaXZlbiBwYXRocyBzdGlsbCBjYXJyaWVzIGEgY29uZmxpY3QgbWFya2VyLlxuICpcbiAqIEEgc3RhZ2VkIGZpbGUgZnVsbCBvZiBgPDw8PDw8PGAgaXMgcmVzb2x2ZWQgYXMgZmFyIGFzIHRoZSBpbmRleCBpc1xuICogY29uY2VybmVkIGFuZCBicm9rZW4gYXMgZmFyIGFzIGV2ZXJ5dGhpbmcgZWxzZSBpcyBjb25jZXJuZWQsIHNvIGl0IGlzXG4gKiBjaGVja2VkIGJlZm9yZSB0aGUgcmVzb2x1dGlvbiBpcyBjb21taXR0ZWQuIGBnaXQgZ3JlcGAgZXhpdHMgMSBmb3IgXCJub1xuICogbWF0Y2hcIiBhbmQgMiBvciBtb3JlIGZvciBhIHJlYWwgZmFpbHVyZSwgc28gdGhlIHR3byBhcmUgdG9sZCBhcGFydCByYXRoZXJcbiAqIHRoYW4gYm90aCByZWFkIGFzIGEgY2xlYW4gdHJlZS5cbiAqXG4gKiBAcGFyYW0gcGF0aHMgLSBUaGUgcGF0aHMgdG8gY2hlY2s7IGVtcHR5IGNoZWNrcyBub3RoaW5nIGFuZCByZXBvcnRzIG5vbmVcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IG9wdGlvbnM7IGBjd2RgIGlzIHRoZSBjbG9uZSBob2xkaW5nIHRoZSBtZXJnZVxuICogQHJldHVybnMgV2hldGhlciBhIG1hcmtlciB3YXMgZm91bmQsIG9yIHRoZSBmYWlsdXJlIHRoYXQgc3RvcHBlZCB0aGUgY2hlY2tcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhc0NvbmZsaWN0TWFya2VycyhcbiAgcGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbik6IFByb21pc2U8UmVzdWx0PGJvb2xlYW4+PiB7XG4gIGlmIChwYXRocy5sZW5ndGggPT09IDApIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogZmFsc2UgfTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJncmVwXCIsIFwiLWxcIiwgXCItSVwiLCBcIi1FXCIsIFwiXig8PDw8PDw8fD4+Pj4+Pj4pIFwiLCBcIi0tXCIsIC4uLnBhdGhzXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIXJlc3VsdC5vayB8fCByZXN1bHQudmFsdWUuY29kZSA+IDEpIHtcbiAgICBjb25zdCBkZXRhaWwgPSAocmVzdWx0Lm9rID8gcmVzdWx0LnZhbHVlLnN0ZGVyciA6IHJlc3VsdC5lcnJvci5tZXNzYWdlKVxuICAgICAgLnRyaW0oKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYHRoZSBjb25mbGljdC1tYXJrZXIgY2hlY2sgY291bGQgbm90IGJlIHJ1bjogJHtcbiAgICAgICAgICBkZXRhaWwgfHwgYGdpdCBleGl0ZWQgJHtyZXN1bHQub2sgPyByZXN1bHQudmFsdWUuY29kZSA6IDF9YFxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIHZhbHVlOiByZXN1bHQudmFsdWUuY29kZSA9PT0gMCAmJiByZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKS5sZW5ndGggPiAwLFxuICB9O1xufVxuXG4vKipcbiAqIFN0YWdlIHdoYXQgdGhlIGFnZW50IHByb2R1Y2VkLCBleGFjdGx5IGFzIGBjb21taXRBbmRQdXNoUGVuZGluZ2Agd291bGQuXG4gKlxuICogYGdpdCBhZGQgLS0gPHRoZSBjb25mbGljdGVkIHBhdGhzPmAgaXMgbm90IGVub3VnaDogYW4gYWdlbnQgdGhhdCByZXNvbHZlcyBhXG4gKiBjb2xsaXNpb24gYnkgZXh0cmFjdGluZyBhIGhlbHBlciBsZWF2ZXMgdGhhdCBuZXcgZmlsZSB1bnN0YWdlZCwgc28gdGhlXG4gKiBtZXJnZSBjb21taXQgd291bGQgY2FycnkgYSB0cmVlIHRoZSByZXNvbHV0aW9uIGdhdGUgbmV2ZXIgdmVyaWZpZWQuIFNvIHRoZVxuICogd2hvbGUgd29ya2luZyB0cmVlIGlzIHN0YWdlZCwgdGhlIHdvcmtlcidzIG93biBzdGF0ZSBmaWxlcyBjb21lIHN0cmFpZ2h0XG4gKiBiYWNrIG91dCAoSXNzdWUgIzE2NTQg4oCUIGEgc3RyYXkgYC5oZWFydGJlYXRfKmAgaW4gdGhlIHNoYXJlZCBjbG9uZSBtdXN0IG5vdFxuICogY29zdCB0aGUgY29tbWl0KSwgYW5kIHRoZSBwcmUtY29tbWl0IHNhZmV0eSBnYXRlIHRoZW4gcmVmdXNlcyBhbnkgaGlkZGVuIG9yXG4gKiBzZWNyZXQtYmVhcmluZyBwYXRoIGV4YWN0bHkgYXMgaXQgZG9lcyBvbiBldmVyeSBvdGhlciBjb21taXQgcGF0aC5cbiAqXG4gKiBUaGUgZ2F0ZS1yZXBhaXIgcnVuZyBzdGFnZXMgdGhlIHNhbWUgd2F5IChJc3N1ZSAjMTk2NSk6IGEgcmVwYWlyIHRoYXQgYWRkc1xuICogYSBmaWxlIGlzIHRoZSBzYW1lIHNoYXBlIGFzIGEgcmVzb2x1dGlvbiB0aGF0IGV4dHJhY3RzIGEgaGVscGVyLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IG9wdGlvbnM7IGBjd2RgIGlzIHRoZSBjbG9uZSBob2xkaW5nIHRoZSBtZXJnZVxuICogQHJldHVybnMgTm90aGluZyBvbiBzdWNjZXNzLCBvciB0aGUgZmFpbHVyZSB0aGF0IHN0b3BwZWQgdGhlIHN0YWdpbmdcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YWdlQWdlbnRSZXNvbHV0aW9uKFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IGFkZGVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJhZGRcIiwgXCItQVwiXSwgb3B0aW9ucyk7XG4gIGlmICghYWRkZWQub2sgfHwgYWRkZWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgaXRzIHJlc29sdXRpb24gY291bGQgbm90IGJlIHN0YWdlZDogJHtkZXNjcmliZUdpdEZhaWx1cmUoYWRkZWQpfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBzYWZlID0gYXdhaXQgdW5zdGFnZVN0YXRlQW5kQXNzZXJ0U2FmZShvcHRpb25zKTtcbiAgcmV0dXJuIHNhZmUub2tcbiAgICA/IHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfVxuICAgIDogeyBvazogZmFsc2UsIGVycm9yOiBzYWZlLmVycm9yIH07XG59XG5cbi8qKlxuICogQ2xpbWIgdGhlIHJ1bGVzIHJ1bmcsIHRoZW4gdGhlIGFnZW50IHJ1bmcsIG92ZXIgdGhlIHRyaWFnZSdzIGxlZnRvdmVycy5cbiAqXG4gKiBUaGUgcnVsZXMgcnVuIGZpcnN0IGJlY2F1c2UgYSBsb2NrIGZpbGUgb3IgYSBtYW5pZmVzdCBuZWVkcyBubyBqdWRnZW1lbnQg4oCUXG4gKiBhc2tpbmcgdGhlIGFnZW50IHRvIHJlLXJlYXNvbiBhYm91dCBhIGZpbGUgYSBydWxlIGFscmVhZHkgc3RhZ2VkIHNwZW5kcyBhXG4gKiBtb2RlbCBydW4gb24gYSBkZWNpZGVkIHF1ZXN0aW9uLiBXaGF0ZXZlciB0aGUgcnVsZXMgZGVmZXIgaXMgdGhlIGFnZW50J3MsXG4gKiBuYXJyb3dlZCB0byBleGFjdGx5IHRob3NlIHBhdGhzLlxuICpcbiAqIEBwYXJhbSBpbnB1dCAtIFRoZSB1bmRlY2lkZWQgZmlsZXMgYW5kIHRoZSBydW5ncyB0byB0cnlcbiAqIEByZXR1cm5zIFdoYXQgZWFjaCBydW5nIHNldHRsZWQsIGFuZCB3aGF0IGlzIGxlZnQgZm9yIGEgaHVtYW5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsaW1iQ29uZmxpY3RMYWRkZXIoXG4gIGlucHV0OiBDb25mbGljdExhZGRlcklucHV0LFxuKTogUHJvbWlzZTxDb25mbGljdExhZGRlck91dGNvbWU+IHtcbiAgY29uc3Qge1xuICAgIGVzY2FsYXRpb25zLFxuICAgIG9wdGlvbnMsXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgYWdlbnRGbixcbiAgICBhcHBseVJ1bGVzRm4gPSBhcHBseURlcGVuZGVuY3lDb25mbGljdFJ1bGVzLFxuICAgIHBvcnRlZEZuID0gcmVzb2x2ZVBvcnRlZFBhdGhzLFxuICAgIHNoYXBlVGhyZXNob2xkcyxcbiAgICB0aW1lcixcbiAgICBsb2dnZXIsXG4gIH0gPSBpbnB1dDtcblxuICBpZiAoZXNjYWxhdGlvbnMubGVuZ3RoID09PSAwKSByZXR1cm4geyByZXNvbHZlZDogW10sIGVzY2FsYXRpb25zOiBbXSB9O1xuXG4gIGNvbnN0IGJ5UGF0aCA9IG5ldyBNYXAoZXNjYWxhdGlvbnMubWFwKChkKSA9PiBbZC5wYXRoLCBkXSkpO1xuICBjb25zdCByZXNvbHZlZDogRmlsZURlY2lzaW9uW10gPSBbXTtcblxuICAvLyAtLS0gUnVuZyAyOiB0aGUgZGV0ZXJtaW5pc3RpYyBkZXBlbmRlbmN5IHJ1bGVzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICB0aW1lcj8uc3RhcnQoXCJydWxlc1wiKTtcbiAgY29uc3QgcnVsZVJlcG9ydCA9IGF3YWl0IGFwcGx5UnVsZXNGbih7XG4gICAgd29ya2luZ0Rpcjogb3B0aW9ucy5jd2QgPz8gXCIuXCIsXG4gICAgY29uZmxpY3RlZEZpbGVzOiBlc2NhbGF0aW9ucy5tYXAoKGQpID0+IGQucGF0aCksXG4gICAgZ2l0OiBnaXRSdW5uZXIob3B0aW9ucyksXG4gICAgbG9nZ2VyOiBsb2dnZXJcbiAgICAgID8ge1xuICAgICAgICB3YXJuOiAobWVzc2FnZSwgY29udGV4dCkgPT4gbG9nZ2VyLndhcm4obWVzc2FnZSwgY29udGV4dCksXG4gICAgICAgIGluZm86IChtZXNzYWdlLCBjb250ZXh0KSA9PiBsb2dnZXIuaW5mbyhtZXNzYWdlLCBjb250ZXh0KSxcbiAgICAgIH1cbiAgICAgIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgdGltZXI/LnN0b3AoKTtcblxuICBmb3IgKGNvbnN0IGZpbGUgb2YgcnVsZVJlcG9ydC5yZXNvbHZlZCkge1xuICAgIGNvbnN0IGRlY2lzaW9uID0gYnlQYXRoLmdldChmaWxlLnBhdGgpO1xuICAgIGlmICghZGVjaXNpb24pIGNvbnRpbnVlO1xuICAgIHJlc29sdmVkLnB1c2goe1xuICAgICAgLi4uZGVjaXNpb24sXG4gICAgICBhY3Rpb246IFwicmVzb2x2ZWRcIixcbiAgICAgIHJ1bmc6IFwicnVsZVwiLFxuICAgICAgcmVhc29uOiBgJHtcbiAgICAgICAgZmlsZS5raW5kID09PSBcImxvY2tcIiA/IFwibG9jayBmaWxlXCIgOiBcIm1hbmlmZXN0XCJcbiAgICAgIH0gcmVzb2x2ZWQgYnkgJHtmaWxlLnJlc29sdmVkQnl9YCxcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IGRlZmVycmVkID0gcnVsZVJlcG9ydC5kZWZlcnJlZFxuICAgIC5tYXAoKGZpbGUpID0+IGZpbGUucGF0aClcbiAgICAuZmlsdGVyKChwYXRoKSA9PiBieVBhdGguaGFzKHBhdGgpKTtcbiAgaWYgKGRlZmVycmVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgcmVzb2x2ZWQsIGVzY2FsYXRpb25zOiBbXSB9O1xuXG4gIC8vIC0tLSBSdW5nIDJiOiBoaXN0b3J5IOKAlCB0aGUgXCJwb3J0ZWRcIiBydWxlIChJc3N1ZSAjMjAyMykgLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gTmluZXR5IGZpbGVzIHdpdGggYWRkL2FkZCBwYWlycyBhY3Jvc3MgZGlyZWN0b3JpZXMgaXMgbm90IGEgc2V0IG9mIGh1bmtzXG4gIC8vIHRvIHJlYWQ7IGl0IGlzIGEgYnJhbmNoIHdob3NlIGNvbnRlbnQgdGhlIGRlZmF1bHQgYnJhbmNoIGFscmVhZHlcbiAgLy8gYWJzb3JiZWQgdW5kZXIgZGlmZmVyZW50IGhpc3RvcnkuIEZvciBlYWNoIHBhdGgsIGlmIHRoZSBvdGhlciBicmFuY2gnc1xuICAvLyBoaXN0b3J5IGNhcnJpZXMgdGhpcyBzaWRlJ3MgZXhhY3QgdmVyc2lvbiwgdGhlIG90aGVyIHNpZGUgY29udGFpbnMgb3Vyc1xuICAvLyBhbmQgaXMgdGFrZW4uIFRoZSBwYXRocyBpdCBjYW5ub3QgcHJvdmUgc3RheSB0aGUgYWdlbnQncywgYXMgYmVmb3JlLlxuICBjb25zdCBwb3J0ZWQgPSBhd2FpdCBwb3J0ZWRGbih7XG4gICAgcGF0aHM6IGRlZmVycmVkLFxuICAgIG9wdGlvbnMsXG4gICAgbWlsZXN0b25lQnJhbmNoLFxuICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgLi4uKHNoYXBlVGhyZXNob2xkcyA/IHsgdGhyZXNob2xkczogc2hhcGVUaHJlc2hvbGRzIH0gOiB7fSksXG4gICAgbG9nOiAobWVzc2FnZSkgPT4gbG9nZ2VyPy5pbmZvKG1lc3NhZ2UsIHsgbWlsZXN0b25lQnJhbmNoLCBkZWZhdWx0QnJhbmNoIH0pLFxuICB9KTtcbiAgZm9yIChjb25zdCBzZXR0bGVkIG9mIHBvcnRlZC5yZXNvbHZlZCkge1xuICAgIGNvbnN0IGRlY2lzaW9uID0gYnlQYXRoLmdldChzZXR0bGVkLnBhdGgpO1xuICAgIGlmICghZGVjaXNpb24pIGNvbnRpbnVlO1xuICAgIHJlc29sdmVkLnB1c2gocG9ydGVkRGVjaXNpb24oZGVjaXNpb24sIHNldHRsZWQsIGRlZmF1bHRCcmFuY2gpKTtcbiAgfVxuICBjb25zdCBzdGlsbERlZmVycmVkID0gcG9ydGVkLnVuZGVjaWRlZC5tYXAoKHUpID0+IHUucGF0aCk7XG4gIGlmIChzdGlsbERlZmVycmVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgcmVzb2x2ZWQsIGVzY2FsYXRpb25zOiBbXSB9O1xuICBpZiAocG9ydGVkLnJlc29sdmVkLmxlbmd0aCA+IDApIHtcbiAgICBsb2dnZXI/LmluZm8oXG4gICAgICBcIk1pbGVzdG9uZSBzeW5jOiB0aGUgcG9ydGVkIHJ1bGUgc2V0dGxlZCBzb21lIHBhdGhzOyB0aGUgcmVzdCBnbyBvbiBcIiArXG4gICAgICAgIFwidXAgdGhlIGxhZGRlciAoSXNzdWUgIzIwMjMpXCIsXG4gICAgICB7IG1pbGVzdG9uZUJyYW5jaCwgZGVmYXVsdEJyYW5jaCwgcmVtYWluaW5nOiBzdGlsbERlZmVycmVkIH0sXG4gICAgKTtcbiAgfVxuICBkZWZlcnJlZC5sZW5ndGggPSAwO1xuICBkZWZlcnJlZC5wdXNoKC4uLnN0aWxsRGVmZXJyZWQpO1xuICAvLyAtLS0gUnVuZyAzOiB0aGUgcmVzb2x1dGlvbiBhZ2VudCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIGNvbnN0IHN0aWxsRXNjYWxhdGVkID0gKHJlYXNvbjogKHBhdGg6IHN0cmluZykgPT4gc3RyaW5nKTogRmlsZURlY2lzaW9uW10gPT5cbiAgICBkZWZlcnJlZC5tYXAoKHBhdGgpID0+IHtcbiAgICAgIGNvbnN0IGRlY2lzaW9uID0gYnlQYXRoLmdldChwYXRoKSE7XG4gICAgICByZXR1cm4geyAuLi5kZWNpc2lvbiwgYWN0aW9uOiBcImVzY2FsYXRlXCIsIHJlYXNvbjogcmVhc29uKHBhdGgpIH07XG4gICAgfSk7XG5cbiAgaWYgKCFhZ2VudEZuKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHJlc29sdmVkLFxuICAgICAgZXNjYWxhdGlvbnM6IHN0aWxsRXNjYWxhdGVkKChwYXRoKSA9PlxuICAgICAgICBgJHtieVBhdGguZ2V0KHBhdGgpIS5yZWFzb259IOKAlCBhbmQgbm8gcmVzb2x1dGlvbiBhZ2VudCB3YXMgYXZhaWxhYmxlIGAgK1xuICAgICAgICBgdG8gdGhpcyBzeW5jIChJc3N1ZSAjMTc3NylgXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBsb2dnZXI/LmluZm8oXG4gICAgXCJNaWxlc3RvbmUgc3luYzogaGFuZGluZyB0aGUgcmVtYWluaW5nIGNvbmZsaWN0cyB0byB0aGUgYWdlbnQgKElzc3VlICMxNzc3KVwiLFxuICAgIHsgbWlsZXN0b25lQnJhbmNoLCBkZWZhdWx0QnJhbmNoLCBjb25mbGljdGVkRmlsZXM6IGRlZmVycmVkIH0sXG4gICk7XG4gIHRpbWVyPy5zdGFydChcImFnZW50XCIpO1xuICBjb25zdCBvdXRjb21lID0gYXdhaXQgYWdlbnRGbih7XG4gICAgY29uZmxpY3RlZEZpbGVzOiBkZWZlcnJlZCxcbiAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgZGVmYXVsdEJyYW5jaCxcbiAgICB3b3JrRGlyOiBvcHRpb25zLmN3ZCA/PyBcIi5cIixcbiAgfSk7XG4gIHRpbWVyPy5zdG9wKCk7XG5cbiAgaWYgKCFvdXRjb21lLm9rKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHJlc29sdmVkLFxuICAgICAgZXNjYWxhdGlvbnM6IHN0aWxsRXNjYWxhdGVkKCgpID0+IGBhZ2VudDogJHtvdXRjb21lLmVycm9yLm1lc3NhZ2V9YCksXG4gICAgfTtcbiAgfVxuICBpZiAob3V0Y29tZS52YWx1ZS50ZXJtaW5hdGVkIHx8IG91dGNvbWUudmFsdWUuZmluaXNoRGVhZGxpbmUpIHtcbiAgICAvLyBUaGUgd29ya2VyIGl0c2VsZiBlbmRlZCB0aGUgcnVuLCBvciB0aGUgZmluaXNoIGRlYWRsaW5lIGRpZCAoSXNzdWVcbiAgICAvLyAjNDI0NSksIHNvIHRoZSB0cmVlIGlzIGhhbGYtZWRpdGVkIHRocm91Z2ggbm8gZmF1bHQgb2YgdGhlIGNvbmZsaWN0LlxuICAgIC8vIE5vdCBhIHZlcmRpY3Qg4oCUIHRoZSBtZXJnZSBpcyBhYmFuZG9uZWQgYW5kIHRoZSBicmFuY2ggaXMgbGVmdCB3aGVyZVxuICAgIC8vIGl0IHdhcyAoSXNzdWUgIzE2OTMpLiBBIGZpbmlzaCBkZWFkbGluZSBpcyBsb2dnZWQgYXMgYSBzY2hlZHVsZWRcbiAgICAvLyByZWxlYXNlIGFuZCBjYXJyaWVzIHRoZSBzYW1lIG1hcmtlciwgc28gbm90aGluZyBpcyBjaGFyZ2VkLlxuICAgIGlmIChvdXRjb21lLnZhbHVlLmZpbmlzaERlYWRsaW5lKSB7XG4gICAgICBsb2dnZXI/LmluZm8oXG4gICAgICAgIFwiTWlsZXN0b25lIHN5bmMgcmVsZWFzZWQgb24gc2NoZWR1bGU6IHRoZSBmaW5pc2ggZGVhZGxpbmUgd2FzIHJlYWNoZWRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICByZXNvbHZlZCxcbiAgICAgIGVzY2FsYXRpb25zOiBzdGlsbEVzY2FsYXRlZCgoKSA9PlxuICAgICAgICBgYWdlbnQ6ICR7QUdFTlRfUlVOX0VOREVEX0JZX1dPUktFUn0gKElzc3VlICMxNjkzKWBcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBjb25zdCBwcm92aWRlckVycm9yID0gb3V0Y29tZS52YWx1ZS5wcm92aWRlclVuYXZhaWxhYmxlO1xuICBpZiAocHJvdmlkZXJFcnJvciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gVGhlIHByb3ZpZGVyIHJlZnVzZWQgdGhlIHJ1biwgc28gdGhlIGNvbmZsaWN0IHdhcyBuZXZlciBsb29rZWQgYXQuIE5vdFxuICAgIC8vIGEgdmVyZGljdCBlaXRoZXIg4oCUIGxlYXZlIHRoZSBicmFuY2ggYW5kIHJldHJ5IGxhdGVyIChJc3N1ZSAjMjYxMykuXG4gICAgcmV0dXJuIHtcbiAgICAgIHJlc29sdmVkLFxuICAgICAgZXNjYWxhdGlvbnM6IHN0aWxsRXNjYWxhdGVkKCgpID0+XG4gICAgICAgIGBhZ2VudDogJHtBR0VOVF9QUk9WSURFUl9VTkFWQUlMQUJMRX0g4oCUICR7cHJvdmlkZXJFcnJvcn0gKElzc3VlICMyNjEzKWBcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIC8vIFJlYWQgdGhlIGluZGV4IEJFRk9SRSBzdGFnaW5nIGFueXRoaW5nLiBgZ2l0IGFkZGAgb24gYSBjb25mbGljdGVkIHBhdGggaXNcbiAgLy8gaG93IGEgY29uZmxpY3QgaXMgbWFya2VkIHJlc29sdmVkLCBzbyBzdGFnaW5nIGZpcnN0IHdvdWxkIGFuc3dlciB0aGlzXG4gIC8vIHF1ZXN0aW9uIHdpdGggaXRzIG93biBzaWRlIGVmZmVjdCDigJQgYW5kIGFuIGFnZW50IHRoYXQgdG91Y2hlZCBub3RoaW5nXG4gIC8vIHdvdWxkIGhhdmUgdGhlIHdvcmtpbmctdHJlZSBzaWRlIGNvbW1pdHRlZCBhcyBpZiBpdCBoYWQgZGVjaWRlZC5cbiAgY29uc3QgdW5tZXJnZWQgPSBhd2FpdCBsaXN0VW5tZXJnZWRQYXRocyhvcHRpb25zLCBkZWZlcnJlZCk7XG4gIGlmICghdW5tZXJnZWQub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgcmVzb2x2ZWQsXG4gICAgICBlc2NhbGF0aW9uczogc3RpbGxFc2NhbGF0ZWQoKCkgPT5cbiAgICAgICAgYGFnZW50OiBpdHMgcmVzb2x1dGlvbiBjb3VsZCBub3QgYmUgdmVyaWZpZWQg4oCUICR7dW5tZXJnZWQuZXJyb3IubWVzc2FnZX1gXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgaWYgKHVubWVyZ2VkLnZhbHVlLmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgcmVzb2x2ZWQsXG4gICAgICBlc2NhbGF0aW9uczogc3RpbGxFc2NhbGF0ZWQoKCkgPT5cbiAgICAgICAgYGFnZW50OiBpdCBsZWZ0ICR7dW5tZXJnZWQudmFsdWUubGVuZ3RofSBwYXRoKHMpIHVubWVyZ2VkOiAke1xuICAgICAgICAgIHVubWVyZ2VkLnZhbHVlLmpvaW4oXCIsIFwiKVxuICAgICAgICB9YFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IG1hcmtlcnMgPSBhd2FpdCBoYXNDb25mbGljdE1hcmtlcnMoZGVmZXJyZWQsIG9wdGlvbnMpO1xuICBpZiAoIW1hcmtlcnMub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgcmVzb2x2ZWQsXG4gICAgICBlc2NhbGF0aW9uczogc3RpbGxFc2NhbGF0ZWQoKCkgPT5cbiAgICAgICAgYGFnZW50OiBpdHMgcmVzb2x1dGlvbiBjb3VsZCBub3QgYmUgdmVyaWZpZWQg4oCUICR7bWFya2Vycy5lcnJvci5tZXNzYWdlfWBcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBpZiAobWFya2Vycy52YWx1ZSkge1xuICAgIHJldHVybiB7XG4gICAgICByZXNvbHZlZCxcbiAgICAgIGVzY2FsYXRpb25zOiBzdGlsbEVzY2FsYXRlZCgoKSA9PlxuICAgICAgICBgYWdlbnQ6IGl0cyByZXNvbHV0aW9uIHN0aWxsIGNvbnRhaW5zIGNvbmZsaWN0IG1hcmtlcnNgXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBzdGFnZWQgPSBhd2FpdCBzdGFnZUFnZW50UmVzb2x1dGlvbihvcHRpb25zKTtcbiAgaWYgKCFzdGFnZWQub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgcmVzb2x2ZWQsXG4gICAgICBlc2NhbGF0aW9uczogc3RpbGxFc2NhbGF0ZWQoKCkgPT4gYGFnZW50OiAke3N0YWdlZC5lcnJvci5tZXNzYWdlfWApLFxuICAgIH07XG4gIH1cblxuICBmb3IgKGNvbnN0IHBhdGggb2YgZGVmZXJyZWQpIHtcbiAgICByZXNvbHZlZC5wdXNoKHtcbiAgICAgIC4uLmJ5UGF0aC5nZXQocGF0aCkhLFxuICAgICAgYWN0aW9uOiBcInJlc29sdmVkXCIsXG4gICAgICBydW5nOiBcImFnZW50XCIsXG4gICAgICByZWFzb246IFwicmVzb2x2ZWQgYnkgdGhlIG1lcmdlLWNvbmZsaWN0IGFnZW50XCIsXG4gICAgfSk7XG4gIH1cbiAgLy8gUmVhZCBhZnRlciBzdGFnaW5nLCBzbyBjb25zdW1pbmcgdGhlIHJlcGx5IGZpbGUgY2Fubm90IGNoYW5nZSB3aGF0IHRoZVxuICAvLyBjb21taXQgY2FycmllczogYHN0YWdlQWdlbnRSZXNvbHV0aW9uYCBoYXMgYWxyZWFkeSB0YWtlbiB0aGUgd29ya2VyJ3NcbiAgLy8gb3duIHN0YXRlIGZpbGVzIGJhY2sgb3V0IG9mIHRoZSBpbmRleCAoSXNzdWUgIzE2NTQpLlxuICBjb25zdCBhZ2VudFJlcGx5ID0gYXdhaXQgcmVhZFByUmVzcG9uc2VNZXNzYWdlKG9wdGlvbnMuY3dkLCBsb2dnZXIpO1xuICByZXR1cm4ge1xuICAgIHJlc29sdmVkLFxuICAgIGVzY2FsYXRpb25zOiBbXSxcbiAgICAuLi4oYWdlbnRSZXBseSA/IHsgYWdlbnRSZXBseSB9IDoge30pLFxuICB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUdELFNBQVMsYUFBYSxRQUFRLG1CQUFtQjtBQUdqRCxTQUNFLGNBQWMsRUFFZCxrQkFBa0IsUUFFYixpQ0FBaUM7QUFDeEMsU0FDRSw0QkFBNEIsUUFHdkIsaUNBQWlDO0FBS3hDLFNBQVMseUJBQXlCLFFBQVEsZ0JBQWdCO0FBQzFELFNBQVMscUJBQXFCLFFBQVEsNkJBQTZCO0FBQ25FLFNBQVMsa0JBQWtCLFFBQVEsNkJBQTZCO0FBR2hFOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sTUFBTSw0QkFDWCxxREFBcUQ7QUFFdkQ7Ozs7OztDQU1DLEdB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
// denoCacheMetadata=9009123310477629335,6543362263660208339