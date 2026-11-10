/**
 * The deterministic pass over a conflicted tree (Issue #466, part of #456).
 *
 * This is the step `pr_merge_conflict_processor.ts` runs **before** the AI
 * agent. It applies the registered manifest rules to each conflicted path,
 * regenerates the lock files whose manifest came out merged, and stages what it
 * resolved. Everything it cannot decide is handed back with a reason, and the
 * agent is then asked about those paths only.
 *
 * ```mermaid
 * flowchart TD
 *     A[Conflicted paths] --> B{Lock file?}
 *     B -- no --> C{Registered rule?}
 *     C -- no --> D[deferred: no rule]
 *     C -- yes --> E[Parse hunks and resolve]
 *     E -- unresolved --> F[deferred: rule reason]
 *     E -- resolved --> G[Write + git add]
 *     G -- stage failed --> H[git checkout --merge] --> F
 *     G -- staged --> I[resolved + decisions]
 *     B -- yes --> J[Regenerate from the merged manifest]
 *     J --> K[resolved or deferred]
 * ```
 *
 * Two invariants hold on every path:
 *
 * - **A deferral stages nothing and changes nothing.** The conflicted file is
 *   left exactly as git wrote it, markers and all, so the AI fallback and the
 *   processor's existing marker/unmerged guards still see the real conflict.
 * - **A resolution is all-or-nothing per file.** The rule core has no `partial`
 *   outcome, so a staged file can never carry a conflict marker.
 *
 * Failures are loud: a write or a stage that fails restores the conflicted file
 * and defers with the git output in the reason, rather than reporting a file as
 * resolved that is not.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { extractDependencyDecisions } from "./dependency_conflict_decisions.ts";
import { manifestRuleRegistry, parseConflictSegments } from "./dependency_conflict_rules.ts";
// Imported for their registration side effect: importing this module is all it
// takes for every ecosystem's rules to be available to the pass.
import "./dependency_conflict_json.ts";
import "./dependency_conflict_native.ts";
// Registered last on purpose: it matches almost every path, so the manifest
// rules above must see their own files first (Issue #1768).
import "./both_inserted_conflict_rule.ts";
import { redactedHead } from "./redacted_text.ts";
import { isSafeRepoRelativePath, lockSpecForPath, regenerateLockFiles } from "./dependency_lock_regen.ts";
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
/** Join a working directory with a repository-relative path. */ function joinPath(workingDir, relative) {
  return `${workingDir.replace(/\/+$/, "")}/${relative}`;
}
function defaultReader(workingDir) {
  return async (path)=>{
    try {
      return await Deno.readTextFile(joinPath(workingDir, path));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
}
function defaultWriter(workingDir) {
  return (path, text)=>Deno.writeTextFile(joinPath(workingDir, path), text);
}
/** Characters of git output quoted in a deferral reason. */ const CONFLICT_DETAIL_CHARS = 500;
/**
 * Git's own words when `git show :1:<path>` finds no stage 1.
 *
 * An add/add conflict has stages 2 and 3 only. Observed from git 2.54:
 * `fatal: path '…' is in the index, but not at stage 1`.
 */ const ABSENT_STAGE_ONE = "not at stage 1";
/** Named outcome for that absence. Logged once per sync, never with git's text. */ const ADDED_ON_BOTH_SIDES = "added on both sides, no merge base";
/** Whether git refused `:1:<path>` because the merge base stage is absent. */ function stageOneAbsent(shown) {
  return shown.stderr.includes(ABSENT_STAGE_ONE) || shown.stdout.includes(ABSENT_STAGE_ONE);
}
/**
 * Bound git output so one runaway command cannot flood a PR comment.
 *
 * Redacted in full before the cut (Issue #1257): the detail is quoted into a
 * public deferral comment, and git's own failure text carries the remote URL.
 * Exported so the ordering is tested behaviourally.
 */ export function formatConflictGitDetail(outcome) {
  const text = `${outcome.stderr}\n${outcome.stdout}`.trim();
  return text.length > 0 ? redactedHead(text, CONFLICT_DETAIL_CHARS) : `exit ${outcome.code}`;
}
// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------
/**
 * Resolve every conflicted path the deterministic rules can decide.
 *
 * Manifests are attempted first: a lock file is only regenerated once its own
 * manifest is known to be merged, which is exactly what the lock-regeneration
 * module refuses to assume on its own.
 *
 * @returns The rule-resolved files (already staged) and the deferred ones.
 */ export async function applyDependencyConflictRules(options) {
  const { workingDir, conflictedFiles, git, registry = manifestRuleRegistry, readFile = defaultReader(workingDir), writeFile = defaultWriter(workingDir), logger } = options;
  const resolved = [];
  const deferred = [];
  const manifestOutcomes = new Map();
  /** Add/add paths, logged once after the pass rather than once per file. */ const addedOnBothSides = [];
  const defer = (path, reason)=>{
    logger?.warn(`Conflicted file left for the AI fallback: ${reason}`, {
      path,
      reason
    });
    deferred.push({
      path,
      reason
    });
  };
  // Issue #4063: a rule declining a file (or no rule matching it) is the
  // routine hand-off to the AI resolver — the expected path, so INFO. The
  // failures above (unreadable, unstageable, ...) stay at WARNING.
  const handOff = (path, reason)=>{
    logger?.info?.(`Conflicted file left for the AI fallback: ${reason}`, {
      path,
      reason
    });
    deferred.push({
      path,
      reason
    });
  };
  const lockFiles = conflictedFiles.filter((path)=>lockSpecForPath(path) !== undefined);
  const manifests = conflictedFiles.filter((path)=>lockSpecForPath(path) === undefined);
  for (const path of manifests){
    if (!isSafeRepoRelativePath(path)) {
      manifestOutcomes.set(path, "unresolved");
      defer(path, `unsafe path outside the working directory: ${path}`);
      continue;
    }
    const rule = registry.find(path);
    if (!rule) {
      manifestOutcomes.set(path, "unresolved");
      handOff(path, "no deterministic rule handles this file");
      continue;
    }
    let text;
    try {
      text = await readFile(path);
    } catch (error) {
      text = null;
      logger?.warn(`Reading the conflicted ${path} failed`, {
        path,
        error: error.message
      });
    }
    if (text === null) {
      manifestOutcomes.set(path, "unresolved");
      defer(path, `${path} could not be read from the working tree`);
      continue;
    }
    const parsed = parseConflictSegments(text);
    if (!parsed.ok) {
      manifestOutcomes.set(path, "unresolved");
      defer(path, `${path} could not be parsed: ${parsed.error}`);
      continue;
    }
    // A rule that has to know what the merge base said reads it from the
    // conflicted index, because the PR merge runs without `diff3` markers
    // (Issue #1768). An absent stage 1 is an add/add: there is no merge base,
    // so those files are named once for the sync and handed to the AI rung
    // (Issue #4361). Any other failure — a timeout, a spawn failure, a path
    // git cannot show — still defers with git's own words, rather than being
    // read as "the base was empty".
    let base = null;
    if (rule.needsBase) {
      const shown = await git([
        "show",
        `:1:${path}`
      ]);
      if (shown.code !== 0) {
        manifestOutcomes.set(path, "unresolved");
        if (stageOneAbsent(shown)) {
          addedOnBothSides.push(path);
          deferred.push({
            path,
            reason: ADDED_ON_BOTH_SIDES
          });
          continue;
        }
        defer(path, `the merge base of ${path} could not be read from the conflicted ` + `index: ${formatConflictGitDetail(shown)}`);
        continue;
      }
      base = shown.stdout;
    }
    const outcome = rule.resolve(parsed.value, {
      path,
      base
    });
    if (outcome.kind === "unresolved") {
      manifestOutcomes.set(path, "unresolved");
      handOff(path, outcome.reason);
      continue;
    }
    /** Put the conflicted file back so the AI fallback sees a real conflict. */ const restore = async ()=>{
      await git([
        "checkout",
        "--merge",
        "--",
        path
      ]);
    };
    try {
      await writeFile(path, outcome.text);
    } catch (error) {
      await restore();
      manifestOutcomes.set(path, "unresolved");
      defer(path, `writing the resolved ${path} failed: ${error.message}`);
      continue;
    }
    const staged = await git([
      "add",
      "--",
      path
    ]);
    if (staged.code !== 0) {
      await restore();
      manifestOutcomes.set(path, "unresolved");
      defer(path, `staging the resolved ${path} failed: ${formatConflictGitDetail(staged)}`);
      continue;
    }
    const decisions = extractDependencyDecisions(parsed.value, outcome.text);
    manifestOutcomes.set(path, "resolved");
    resolved.push({
      path,
      kind: "manifest",
      resolvedBy: rule.name,
      decisions: decisions ?? [],
      decisionsUnattributed: decisions === null
    });
    logger?.info?.(`Resolved ${path} by rule ${rule.name}`, {
      path,
      rule: rule.name,
      decisions: (decisions ?? []).length
    });
  }
  if (addedOnBothSides.length > 0) {
    const count = addedOnBothSides.length;
    const noun = count === 1 ? "file" : "files";
    logger?.info?.(`${count} conflicted ${noun} ${ADDED_ON_BOTH_SIDES}`, {
      count,
      paths: addedOnBothSides
    });
  }
  if (lockFiles.length > 0) {
    const outcomes = await regenerateLockFiles({
      workingDir,
      manifestOutcomes,
      lockFiles,
      ...logger ? {
        logger
      } : {},
      ...options.lockRegen
    });
    for (const outcome of outcomes){
      if (outcome.kind === "unresolved") {
        defer(outcome.path, outcome.reason);
        continue;
      }
      resolved.push({
        path: outcome.path,
        kind: "lock",
        resolvedBy: [
          outcome.command.bin,
          ...outcome.command.args
        ].join(" "),
        decisions: [],
        decisionsUnattributed: false
      });
    }
  }
  return {
    resolved,
    deferred
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kZXBlbmRlbmN5X2NvbmZsaWN0X2FwcGx5LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIGRldGVybWluaXN0aWMgcGFzcyBvdmVyIGEgY29uZmxpY3RlZCB0cmVlIChJc3N1ZSAjNDY2LCBwYXJ0IG9mICM0NTYpLlxuICpcbiAqIFRoaXMgaXMgdGhlIHN0ZXAgYHByX21lcmdlX2NvbmZsaWN0X3Byb2Nlc3Nvci50c2AgcnVucyAqKmJlZm9yZSoqIHRoZSBBSVxuICogYWdlbnQuIEl0IGFwcGxpZXMgdGhlIHJlZ2lzdGVyZWQgbWFuaWZlc3QgcnVsZXMgdG8gZWFjaCBjb25mbGljdGVkIHBhdGgsXG4gKiByZWdlbmVyYXRlcyB0aGUgbG9jayBmaWxlcyB3aG9zZSBtYW5pZmVzdCBjYW1lIG91dCBtZXJnZWQsIGFuZCBzdGFnZXMgd2hhdCBpdFxuICogcmVzb2x2ZWQuIEV2ZXJ5dGhpbmcgaXQgY2Fubm90IGRlY2lkZSBpcyBoYW5kZWQgYmFjayB3aXRoIGEgcmVhc29uLCBhbmQgdGhlXG4gKiBhZ2VudCBpcyB0aGVuIGFza2VkIGFib3V0IHRob3NlIHBhdGhzIG9ubHkuXG4gKlxuICogYGBgbWVybWFpZFxuICogZmxvd2NoYXJ0IFREXG4gKiAgICAgQVtDb25mbGljdGVkIHBhdGhzXSAtLT4gQntMb2NrIGZpbGU/fVxuICogICAgIEIgLS0gbm8gLS0+IEN7UmVnaXN0ZXJlZCBydWxlP31cbiAqICAgICBDIC0tIG5vIC0tPiBEW2RlZmVycmVkOiBubyBydWxlXVxuICogICAgIEMgLS0geWVzIC0tPiBFW1BhcnNlIGh1bmtzIGFuZCByZXNvbHZlXVxuICogICAgIEUgLS0gdW5yZXNvbHZlZCAtLT4gRltkZWZlcnJlZDogcnVsZSByZWFzb25dXG4gKiAgICAgRSAtLSByZXNvbHZlZCAtLT4gR1tXcml0ZSArIGdpdCBhZGRdXG4gKiAgICAgRyAtLSBzdGFnZSBmYWlsZWQgLS0+IEhbZ2l0IGNoZWNrb3V0IC0tbWVyZ2VdIC0tPiBGXG4gKiAgICAgRyAtLSBzdGFnZWQgLS0+IElbcmVzb2x2ZWQgKyBkZWNpc2lvbnNdXG4gKiAgICAgQiAtLSB5ZXMgLS0+IEpbUmVnZW5lcmF0ZSBmcm9tIHRoZSBtZXJnZWQgbWFuaWZlc3RdXG4gKiAgICAgSiAtLT4gS1tyZXNvbHZlZCBvciBkZWZlcnJlZF1cbiAqIGBgYFxuICpcbiAqIFR3byBpbnZhcmlhbnRzIGhvbGQgb24gZXZlcnkgcGF0aDpcbiAqXG4gKiAtICoqQSBkZWZlcnJhbCBzdGFnZXMgbm90aGluZyBhbmQgY2hhbmdlcyBub3RoaW5nLioqIFRoZSBjb25mbGljdGVkIGZpbGUgaXNcbiAqICAgbGVmdCBleGFjdGx5IGFzIGdpdCB3cm90ZSBpdCwgbWFya2VycyBhbmQgYWxsLCBzbyB0aGUgQUkgZmFsbGJhY2sgYW5kIHRoZVxuICogICBwcm9jZXNzb3IncyBleGlzdGluZyBtYXJrZXIvdW5tZXJnZWQgZ3VhcmRzIHN0aWxsIHNlZSB0aGUgcmVhbCBjb25mbGljdC5cbiAqIC0gKipBIHJlc29sdXRpb24gaXMgYWxsLW9yLW5vdGhpbmcgcGVyIGZpbGUuKiogVGhlIHJ1bGUgY29yZSBoYXMgbm8gYHBhcnRpYWxgXG4gKiAgIG91dGNvbWUsIHNvIGEgc3RhZ2VkIGZpbGUgY2FuIG5ldmVyIGNhcnJ5IGEgY29uZmxpY3QgbWFya2VyLlxuICpcbiAqIEZhaWx1cmVzIGFyZSBsb3VkOiBhIHdyaXRlIG9yIGEgc3RhZ2UgdGhhdCBmYWlscyByZXN0b3JlcyB0aGUgY29uZmxpY3RlZCBmaWxlXG4gKiBhbmQgZGVmZXJzIHdpdGggdGhlIGdpdCBvdXRwdXQgaW4gdGhlIHJlYXNvbiwgcmF0aGVyIHRoYW4gcmVwb3J0aW5nIGEgZmlsZSBhc1xuICogcmVzb2x2ZWQgdGhhdCBpcyBub3QuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHtcbiAgdHlwZSBEZXBlbmRlbmN5RGVjaXNpb24sXG4gIGV4dHJhY3REZXBlbmRlbmN5RGVjaXNpb25zLFxufSBmcm9tIFwiLi9kZXBlbmRlbmN5X2NvbmZsaWN0X2RlY2lzaW9ucy50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBNYW5pZmVzdFJ1bGVSZWdpc3RyeSxcbiAgbWFuaWZlc3RSdWxlUmVnaXN0cnksXG4gIHBhcnNlQ29uZmxpY3RTZWdtZW50cyxcbn0gZnJvbSBcIi4vZGVwZW5kZW5jeV9jb25mbGljdF9ydWxlcy50c1wiO1xuLy8gSW1wb3J0ZWQgZm9yIHRoZWlyIHJlZ2lzdHJhdGlvbiBzaWRlIGVmZmVjdDogaW1wb3J0aW5nIHRoaXMgbW9kdWxlIGlzIGFsbCBpdFxuLy8gdGFrZXMgZm9yIGV2ZXJ5IGVjb3N5c3RlbSdzIHJ1bGVzIHRvIGJlIGF2YWlsYWJsZSB0byB0aGUgcGFzcy5cbmltcG9ydCBcIi4vZGVwZW5kZW5jeV9jb25mbGljdF9qc29uLnRzXCI7XG5pbXBvcnQgXCIuL2RlcGVuZGVuY3lfY29uZmxpY3RfbmF0aXZlLnRzXCI7XG4vLyBSZWdpc3RlcmVkIGxhc3Qgb24gcHVycG9zZTogaXQgbWF0Y2hlcyBhbG1vc3QgZXZlcnkgcGF0aCwgc28gdGhlIG1hbmlmZXN0XG4vLyBydWxlcyBhYm92ZSBtdXN0IHNlZSB0aGVpciBvd24gZmlsZXMgZmlyc3QgKElzc3VlICMxNzY4KS5cbmltcG9ydCBcIi4vYm90aF9pbnNlcnRlZF9jb25mbGljdF9ydWxlLnRzXCI7XG5pbXBvcnQgeyByZWRhY3RlZEhlYWQgfSBmcm9tIFwiLi9yZWRhY3RlZF90ZXh0LnRzXCI7XG5pbXBvcnQge1xuICBpc1NhZmVSZXBvUmVsYXRpdmVQYXRoLFxuICB0eXBlIExvY2tSZWdlbkxvZ2dlcixcbiAgdHlwZSBMb2NrUmVnZW5PcHRpb25zLFxuICBsb2NrU3BlY0ZvclBhdGgsXG4gIHR5cGUgTWFuaWZlc3RTdGF0dXMsXG4gIHJlZ2VuZXJhdGVMb2NrRmlsZXMsXG59IGZyb20gXCIuL2RlcGVuZGVuY3lfbG9ja19yZWdlbi50c1wiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFR5cGVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIEV4aXQgc3RhdHVzIG9mIGEgZ2l0IGNvbW1hbmQgdGhlIHBhc3MgcnVucy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29uZmxpY3RHaXRPdXRjb21lIHtcbiAgY29kZTogbnVtYmVyO1xuICBzdGRvdXQ6IHN0cmluZztcbiAgc3RkZXJyOiBzdHJpbmc7XG59XG5cbi8qKlxuICogUnVucyBhIGdpdCBjb21tYW5kIGluIHRoZSByZXBvc2l0b3J5IHdvcmtpbmcgZGlyZWN0b3J5LlxuICpcbiAqIEluamVjdGVkIHNvIHRoaXMgbW9kdWxlIG5ldmVyIGRlY2lkZXMgaG93IGdpdCBpcyBzcGF3bmVkLCBhbmQgc28gdGVzdHMgbmV2ZXJcbiAqIHNoZWxsIG91dC4gQSBzcGF3biBmYWlsdXJlIG11c3QgYmUgZm9sZGVkIGludG8gYSBub24temVybyBjb2RlIGJ5IHRoZSBjYWxsZXJcbiAqIOKAlCBcImNvdWxkIG5vdCBydW4gZ2l0XCIgaXMgbm90IFwiZ2l0IHdhcyBoYXBweVwiLlxuICovXG5leHBvcnQgdHlwZSBDb25mbGljdEdpdFJ1bm5lciA9IChcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4pID0+IFByb21pc2U8Q29uZmxpY3RHaXRPdXRjb21lPjtcblxuLyoqIEEgY29uZmxpY3RlZCBmaWxlIHRoZSBydWxlcyByZXNvbHZlZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZWRDb25mbGljdEZpbGUge1xuICAvKiogUmVwb3NpdG9yeS1yZWxhdGl2ZSBwYXRoLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBXaGV0aGVyIGEgbWFuaWZlc3QgcnVsZSBvciBhIGxvY2sgcmVnZW5lcmF0aW9uIHJlc29sdmVkIGl0LiAqL1xuICBraW5kOiBcIm1hbmlmZXN0XCIgfCBcImxvY2tcIjtcbiAgLyoqIFRoZSBtYW5pZmVzdCBydWxlJ3MgbmFtZSwgb3IgdGhlIGNvbW1hbmQgdGhhdCByZWdlbmVyYXRlZCB0aGUgbG9jay4gKi9cbiAgcmVzb2x2ZWRCeTogc3RyaW5nO1xuICAvKiogUGVyLWRlcGVuZGVuY3kgZGVjaXNpb25zOyBlbXB0eSBmb3IgYSBsb2NrIGZpbGUuICovXG4gIGRlY2lzaW9uczogcmVhZG9ubHkgRGVwZW5kZW5jeURlY2lzaW9uW107XG4gIC8qKlxuICAgKiBUcnVlIHdoZW4gdGhlIHJlc29sdXRpb24gY291bGQgbm90IGJlIGF0dHJpYnV0ZWQgdG8gaW5kaXZpZHVhbFxuICAgKiBkZXBlbmRlbmNpZXMsIHNvIHRoZSBjb21tZW50IHNheXMgc28gaW5zdGVhZCBvZiBuYW1pbmcgYSB3cm9uZyBwaWNrLlxuICAgKi9cbiAgZGVjaXNpb25zVW5hdHRyaWJ1dGVkOiBib29sZWFuO1xufVxuXG4vKiogQSBjb25mbGljdGVkIGZpbGUgdGhlIHJ1bGVzIGxlZnQgZm9yIHRoZSBBSSBmYWxsYmFjay4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGVmZXJyZWRDb25mbGljdEZpbGUge1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBXaHkgaXQgd2FzIGRlZmVycmVkIOKAlCBsb2dnZWQsIGFuZCByZXBvcnRlZCBvbiB0aGUgUFIgd2hlbiBpdCBmYWlscy4gKi9cbiAgcmVhc29uOiBzdHJpbmc7XG59XG5cbi8qKiBXaGF0IHRoZSBkZXRlcm1pbmlzdGljIHBhc3MgZGlkIHdpdGggdGhlIGNvbmZsaWN0ZWQgdHJlZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGV0ZXJtaW5pc3RpY0NvbmZsaWN0UmVwb3J0IHtcbiAgcmVzb2x2ZWQ6IFJlc29sdmVkQ29uZmxpY3RGaWxlW107XG4gIGRlZmVycmVkOiBEZWZlcnJlZENvbmZsaWN0RmlsZVtdO1xufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIGFwcGx5RGVwZW5kZW5jeUNvbmZsaWN0UnVsZXN9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBEZXRlcm1pbmlzdGljQ29uZmxpY3RPcHRpb25zIHtcbiAgLyoqIEFic29sdXRlIHBhdGggb2YgdGhlIHJlcG9zaXRvcnkgd29ya2luZyBkaXJlY3RvcnkuICovXG4gIHdvcmtpbmdEaXI6IHN0cmluZztcbiAgLyoqIFJlcG9zaXRvcnktcmVsYXRpdmUgY29uZmxpY3RlZCBwYXRocywgZnJvbSBgLS1kaWZmLWZpbHRlcj1VYC4gKi9cbiAgY29uZmxpY3RlZEZpbGVzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEdpdCBydW5uZXIsIGFscmVhZHkgYm91bmQgdG8gdGhlIHdvcmtpbmcgZGlyZWN0b3J5LiAqL1xuICBnaXQ6IENvbmZsaWN0R2l0UnVubmVyO1xuICAvKiogUnVsZSByZWdpc3RyeTsgZGVmYXVsdHMgdG8gdGhlIHNoYXJlZCBvbmUgZXZlcnkgZWNvc3lzdGVtIHJlZ2lzdGVycyBpbnRvLiAqL1xuICByZWdpc3RyeT86IE1hbmlmZXN0UnVsZVJlZ2lzdHJ5O1xuICAvKiogTWFuaWZlc3QgcmVhZGVyIOKAlCBkZWZhdWx0cyB0byByZWFkaW5nIHVuZGVyIGB3b3JraW5nRGlyYC4gKi9cbiAgcmVhZEZpbGU/OiAocGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKiogTWFuaWZlc3Qgd3JpdGVyIOKAlCBkZWZhdWx0cyB0byB3cml0aW5nIHVuZGVyIGB3b3JraW5nRGlyYC4gKi9cbiAgd3JpdGVGaWxlPzogKHBhdGg6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+O1xuICBsb2dnZXI/OiBMb2NrUmVnZW5Mb2dnZXI7XG4gIC8qKiBMb2NrLXJlZ2VuZXJhdGlvbiBzZWFtcywgcGFzc2VkIHN0cmFpZ2h0IHRocm91Z2ggKHRlc3RzKS4gKi9cbiAgbG9ja1JlZ2VuPzogUGljazxcbiAgICBMb2NrUmVnZW5PcHRpb25zLFxuICAgIFwicnVubmVyXCIgfCBcImhhc1Rvb2xcIiB8IFwicmVhZExvY2tGaWxlXCIgfCBcInRpbWVvdXRNc1wiXG4gID47XG59XG5cbi8qKiBUaGUgcGFzcyBpdHNlbGYsIGFzIGEgdHlwZSBzbyB0aGUgcHJvY2Vzc29yIGNhbiBpbmplY3QgYSBzdHViIGluIHRlc3RzLiAqL1xuZXhwb3J0IHR5cGUgRGVwZW5kZW5jeVJ1bGVBcHBsaWVyID0gKFxuICBvcHRpb25zOiBEZXRlcm1pbmlzdGljQ29uZmxpY3RPcHRpb25zLFxuKSA9PiBQcm9taXNlPERldGVybWluaXN0aWNDb25mbGljdFJlcG9ydD47XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRGVmYXVsdHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogSm9pbiBhIHdvcmtpbmcgZGlyZWN0b3J5IHdpdGggYSByZXBvc2l0b3J5LXJlbGF0aXZlIHBhdGguICovXG5mdW5jdGlvbiBqb2luUGF0aCh3b3JraW5nRGlyOiBzdHJpbmcsIHJlbGF0aXZlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7d29ya2luZ0Rpci5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpfS8ke3JlbGF0aXZlfWA7XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRSZWFkZXIoXG4gIHdvcmtpbmdEaXI6IHN0cmluZyxcbik6IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICByZXR1cm4gYXN5bmMgKHBhdGgpID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKGpvaW5QYXRoKHdvcmtpbmdEaXIsIHBhdGgpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpIHJldHVybiBudWxsO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9O1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0V3JpdGVyKFxuICB3b3JraW5nRGlyOiBzdHJpbmcsXG4pOiAocGF0aDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gKHBhdGgsIHRleHQpID0+IERlbm8ud3JpdGVUZXh0RmlsZShqb2luUGF0aCh3b3JraW5nRGlyLCBwYXRoKSwgdGV4dCk7XG59XG5cbi8qKiBDaGFyYWN0ZXJzIG9mIGdpdCBvdXRwdXQgcXVvdGVkIGluIGEgZGVmZXJyYWwgcmVhc29uLiAqL1xuY29uc3QgQ09ORkxJQ1RfREVUQUlMX0NIQVJTID0gNTAwO1xuXG4vKipcbiAqIEdpdCdzIG93biB3b3JkcyB3aGVuIGBnaXQgc2hvdyA6MTo8cGF0aD5gIGZpbmRzIG5vIHN0YWdlIDEuXG4gKlxuICogQW4gYWRkL2FkZCBjb25mbGljdCBoYXMgc3RhZ2VzIDIgYW5kIDMgb25seS4gT2JzZXJ2ZWQgZnJvbSBnaXQgMi41NDpcbiAqIGBmYXRhbDogcGF0aCAn4oCmJyBpcyBpbiB0aGUgaW5kZXgsIGJ1dCBub3QgYXQgc3RhZ2UgMWAuXG4gKi9cbmNvbnN0IEFCU0VOVF9TVEFHRV9PTkUgPSBcIm5vdCBhdCBzdGFnZSAxXCI7XG5cbi8qKiBOYW1lZCBvdXRjb21lIGZvciB0aGF0IGFic2VuY2UuIExvZ2dlZCBvbmNlIHBlciBzeW5jLCBuZXZlciB3aXRoIGdpdCdzIHRleHQuICovXG5jb25zdCBBRERFRF9PTl9CT1RIX1NJREVTID0gXCJhZGRlZCBvbiBib3RoIHNpZGVzLCBubyBtZXJnZSBiYXNlXCI7XG5cbi8qKiBXaGV0aGVyIGdpdCByZWZ1c2VkIGA6MTo8cGF0aD5gIGJlY2F1c2UgdGhlIG1lcmdlIGJhc2Ugc3RhZ2UgaXMgYWJzZW50LiAqL1xuZnVuY3Rpb24gc3RhZ2VPbmVBYnNlbnQoc2hvd246IENvbmZsaWN0R2l0T3V0Y29tZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gc2hvd24uc3RkZXJyLmluY2x1ZGVzKEFCU0VOVF9TVEFHRV9PTkUpIHx8XG4gICAgc2hvd24uc3Rkb3V0LmluY2x1ZGVzKEFCU0VOVF9TVEFHRV9PTkUpO1xufVxuXG4vKipcbiAqIEJvdW5kIGdpdCBvdXRwdXQgc28gb25lIHJ1bmF3YXkgY29tbWFuZCBjYW5ub3QgZmxvb2QgYSBQUiBjb21tZW50LlxuICpcbiAqIFJlZGFjdGVkIGluIGZ1bGwgYmVmb3JlIHRoZSBjdXQgKElzc3VlICMxMjU3KTogdGhlIGRldGFpbCBpcyBxdW90ZWQgaW50byBhXG4gKiBwdWJsaWMgZGVmZXJyYWwgY29tbWVudCwgYW5kIGdpdCdzIG93biBmYWlsdXJlIHRleHQgY2FycmllcyB0aGUgcmVtb3RlIFVSTC5cbiAqIEV4cG9ydGVkIHNvIHRoZSBvcmRlcmluZyBpcyB0ZXN0ZWQgYmVoYXZpb3VyYWxseS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdENvbmZsaWN0R2l0RGV0YWlsKG91dGNvbWU6IENvbmZsaWN0R2l0T3V0Y29tZSk6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBgJHtvdXRjb21lLnN0ZGVycn1cXG4ke291dGNvbWUuc3Rkb3V0fWAudHJpbSgpO1xuICByZXR1cm4gdGV4dC5sZW5ndGggPiAwXG4gICAgPyByZWRhY3RlZEhlYWQodGV4dCwgQ09ORkxJQ1RfREVUQUlMX0NIQVJTKVxuICAgIDogYGV4aXQgJHtvdXRjb21lLmNvZGV9YDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUaGUgcGFzc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogUmVzb2x2ZSBldmVyeSBjb25mbGljdGVkIHBhdGggdGhlIGRldGVybWluaXN0aWMgcnVsZXMgY2FuIGRlY2lkZS5cbiAqXG4gKiBNYW5pZmVzdHMgYXJlIGF0dGVtcHRlZCBmaXJzdDogYSBsb2NrIGZpbGUgaXMgb25seSByZWdlbmVyYXRlZCBvbmNlIGl0cyBvd25cbiAqIG1hbmlmZXN0IGlzIGtub3duIHRvIGJlIG1lcmdlZCwgd2hpY2ggaXMgZXhhY3RseSB3aGF0IHRoZSBsb2NrLXJlZ2VuZXJhdGlvblxuICogbW9kdWxlIHJlZnVzZXMgdG8gYXNzdW1lIG9uIGl0cyBvd24uXG4gKlxuICogQHJldHVybnMgVGhlIHJ1bGUtcmVzb2x2ZWQgZmlsZXMgKGFscmVhZHkgc3RhZ2VkKSBhbmQgdGhlIGRlZmVycmVkIG9uZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhcHBseURlcGVuZGVuY3lDb25mbGljdFJ1bGVzKFxuICBvcHRpb25zOiBEZXRlcm1pbmlzdGljQ29uZmxpY3RPcHRpb25zLFxuKTogUHJvbWlzZTxEZXRlcm1pbmlzdGljQ29uZmxpY3RSZXBvcnQ+IHtcbiAgY29uc3Qge1xuICAgIHdvcmtpbmdEaXIsXG4gICAgY29uZmxpY3RlZEZpbGVzLFxuICAgIGdpdCxcbiAgICByZWdpc3RyeSA9IG1hbmlmZXN0UnVsZVJlZ2lzdHJ5LFxuICAgIHJlYWRGaWxlID0gZGVmYXVsdFJlYWRlcih3b3JraW5nRGlyKSxcbiAgICB3cml0ZUZpbGUgPSBkZWZhdWx0V3JpdGVyKHdvcmtpbmdEaXIpLFxuICAgIGxvZ2dlcixcbiAgfSA9IG9wdGlvbnM7XG5cbiAgY29uc3QgcmVzb2x2ZWQ6IFJlc29sdmVkQ29uZmxpY3RGaWxlW10gPSBbXTtcbiAgY29uc3QgZGVmZXJyZWQ6IERlZmVycmVkQ29uZmxpY3RGaWxlW10gPSBbXTtcbiAgY29uc3QgbWFuaWZlc3RPdXRjb21lcyA9IG5ldyBNYXA8c3RyaW5nLCBNYW5pZmVzdFN0YXR1cz4oKTtcbiAgLyoqIEFkZC9hZGQgcGF0aHMsIGxvZ2dlZCBvbmNlIGFmdGVyIHRoZSBwYXNzIHJhdGhlciB0aGFuIG9uY2UgcGVyIGZpbGUuICovXG4gIGNvbnN0IGFkZGVkT25Cb3RoU2lkZXM6IHN0cmluZ1tdID0gW107XG5cbiAgY29uc3QgZGVmZXIgPSAocGF0aDogc3RyaW5nLCByZWFzb246IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGxvZ2dlcj8ud2FybihgQ29uZmxpY3RlZCBmaWxlIGxlZnQgZm9yIHRoZSBBSSBmYWxsYmFjazogJHtyZWFzb259YCwge1xuICAgICAgcGF0aCxcbiAgICAgIHJlYXNvbixcbiAgICB9KTtcbiAgICBkZWZlcnJlZC5wdXNoKHsgcGF0aCwgcmVhc29uIH0pO1xuICB9O1xuICAvLyBJc3N1ZSAjNDA2MzogYSBydWxlIGRlY2xpbmluZyBhIGZpbGUgKG9yIG5vIHJ1bGUgbWF0Y2hpbmcgaXQpIGlzIHRoZVxuICAvLyByb3V0aW5lIGhhbmQtb2ZmIHRvIHRoZSBBSSByZXNvbHZlciDigJQgdGhlIGV4cGVjdGVkIHBhdGgsIHNvIElORk8uIFRoZVxuICAvLyBmYWlsdXJlcyBhYm92ZSAodW5yZWFkYWJsZSwgdW5zdGFnZWFibGUsIC4uLikgc3RheSBhdCBXQVJOSU5HLlxuICBjb25zdCBoYW5kT2ZmID0gKHBhdGg6IHN0cmluZywgcmVhc29uOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBsb2dnZXI/LmluZm8/LihgQ29uZmxpY3RlZCBmaWxlIGxlZnQgZm9yIHRoZSBBSSBmYWxsYmFjazogJHtyZWFzb259YCwge1xuICAgICAgcGF0aCxcbiAgICAgIHJlYXNvbixcbiAgICB9KTtcbiAgICBkZWZlcnJlZC5wdXNoKHsgcGF0aCwgcmVhc29uIH0pO1xuICB9O1xuXG4gIGNvbnN0IGxvY2tGaWxlcyA9IGNvbmZsaWN0ZWRGaWxlcy5maWx0ZXIoKHBhdGgpID0+XG4gICAgbG9ja1NwZWNGb3JQYXRoKHBhdGgpICE9PSB1bmRlZmluZWRcbiAgKTtcbiAgY29uc3QgbWFuaWZlc3RzID0gY29uZmxpY3RlZEZpbGVzLmZpbHRlcigocGF0aCkgPT5cbiAgICBsb2NrU3BlY0ZvclBhdGgocGF0aCkgPT09IHVuZGVmaW5lZFxuICApO1xuXG4gIGZvciAoY29uc3QgcGF0aCBvZiBtYW5pZmVzdHMpIHtcbiAgICBpZiAoIWlzU2FmZVJlcG9SZWxhdGl2ZVBhdGgocGF0aCkpIHtcbiAgICAgIG1hbmlmZXN0T3V0Y29tZXMuc2V0KHBhdGgsIFwidW5yZXNvbHZlZFwiKTtcbiAgICAgIGRlZmVyKHBhdGgsIGB1bnNhZmUgcGF0aCBvdXRzaWRlIHRoZSB3b3JraW5nIGRpcmVjdG9yeTogJHtwYXRofWApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgcnVsZSA9IHJlZ2lzdHJ5LmZpbmQocGF0aCk7XG4gICAgaWYgKCFydWxlKSB7XG4gICAgICBtYW5pZmVzdE91dGNvbWVzLnNldChwYXRoLCBcInVucmVzb2x2ZWRcIik7XG4gICAgICBoYW5kT2ZmKHBhdGgsIFwibm8gZGV0ZXJtaW5pc3RpYyBydWxlIGhhbmRsZXMgdGhpcyBmaWxlXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgbGV0IHRleHQ6IHN0cmluZyB8IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIHRleHQgPSBhd2FpdCByZWFkRmlsZShwYXRoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgdGV4dCA9IG51bGw7XG4gICAgICBsb2dnZXI/Lndhcm4oYFJlYWRpbmcgdGhlIGNvbmZsaWN0ZWQgJHtwYXRofSBmYWlsZWRgLCB7XG4gICAgICAgIHBhdGgsXG4gICAgICAgIGVycm9yOiAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2UsXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKHRleHQgPT09IG51bGwpIHtcbiAgICAgIG1hbmlmZXN0T3V0Y29tZXMuc2V0KHBhdGgsIFwidW5yZXNvbHZlZFwiKTtcbiAgICAgIGRlZmVyKHBhdGgsIGAke3BhdGh9IGNvdWxkIG5vdCBiZSByZWFkIGZyb20gdGhlIHdvcmtpbmcgdHJlZWApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VDb25mbGljdFNlZ21lbnRzKHRleHQpO1xuICAgIGlmICghcGFyc2VkLm9rKSB7XG4gICAgICBtYW5pZmVzdE91dGNvbWVzLnNldChwYXRoLCBcInVucmVzb2x2ZWRcIik7XG4gICAgICBkZWZlcihwYXRoLCBgJHtwYXRofSBjb3VsZCBub3QgYmUgcGFyc2VkOiAke3BhcnNlZC5lcnJvcn1gKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIEEgcnVsZSB0aGF0IGhhcyB0byBrbm93IHdoYXQgdGhlIG1lcmdlIGJhc2Ugc2FpZCByZWFkcyBpdCBmcm9tIHRoZVxuICAgIC8vIGNvbmZsaWN0ZWQgaW5kZXgsIGJlY2F1c2UgdGhlIFBSIG1lcmdlIHJ1bnMgd2l0aG91dCBgZGlmZjNgIG1hcmtlcnNcbiAgICAvLyAoSXNzdWUgIzE3NjgpLiBBbiBhYnNlbnQgc3RhZ2UgMSBpcyBhbiBhZGQvYWRkOiB0aGVyZSBpcyBubyBtZXJnZSBiYXNlLFxuICAgIC8vIHNvIHRob3NlIGZpbGVzIGFyZSBuYW1lZCBvbmNlIGZvciB0aGUgc3luYyBhbmQgaGFuZGVkIHRvIHRoZSBBSSBydW5nXG4gICAgLy8gKElzc3VlICM0MzYxKS4gQW55IG90aGVyIGZhaWx1cmUg4oCUIGEgdGltZW91dCwgYSBzcGF3biBmYWlsdXJlLCBhIHBhdGhcbiAgICAvLyBnaXQgY2Fubm90IHNob3cg4oCUIHN0aWxsIGRlZmVycyB3aXRoIGdpdCdzIG93biB3b3JkcywgcmF0aGVyIHRoYW4gYmVpbmdcbiAgICAvLyByZWFkIGFzIFwidGhlIGJhc2Ugd2FzIGVtcHR5XCIuXG4gICAgbGV0IGJhc2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGlmIChydWxlLm5lZWRzQmFzZSkge1xuICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCBnaXQoW1wic2hvd1wiLCBgOjE6JHtwYXRofWBdKTtcbiAgICAgIGlmIChzaG93bi5jb2RlICE9PSAwKSB7XG4gICAgICAgIG1hbmlmZXN0T3V0Y29tZXMuc2V0KHBhdGgsIFwidW5yZXNvbHZlZFwiKTtcbiAgICAgICAgaWYgKHN0YWdlT25lQWJzZW50KHNob3duKSkge1xuICAgICAgICAgIGFkZGVkT25Cb3RoU2lkZXMucHVzaChwYXRoKTtcbiAgICAgICAgICBkZWZlcnJlZC5wdXNoKHsgcGF0aCwgcmVhc29uOiBBRERFRF9PTl9CT1RIX1NJREVTIH0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGRlZmVyKFxuICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgYHRoZSBtZXJnZSBiYXNlIG9mICR7cGF0aH0gY291bGQgbm90IGJlIHJlYWQgZnJvbSB0aGUgY29uZmxpY3RlZCBgICtcbiAgICAgICAgICAgIGBpbmRleDogJHtmb3JtYXRDb25mbGljdEdpdERldGFpbChzaG93bil9YCxcbiAgICAgICAgKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBiYXNlID0gc2hvd24uc3Rkb3V0O1xuICAgIH1cblxuICAgIGNvbnN0IG91dGNvbWUgPSBydWxlLnJlc29sdmUocGFyc2VkLnZhbHVlLCB7IHBhdGgsIGJhc2UgfSk7XG4gICAgaWYgKG91dGNvbWUua2luZCA9PT0gXCJ1bnJlc29sdmVkXCIpIHtcbiAgICAgIG1hbmlmZXN0T3V0Y29tZXMuc2V0KHBhdGgsIFwidW5yZXNvbHZlZFwiKTtcbiAgICAgIGhhbmRPZmYocGF0aCwgb3V0Y29tZS5yZWFzb24pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLyoqIFB1dCB0aGUgY29uZmxpY3RlZCBmaWxlIGJhY2sgc28gdGhlIEFJIGZhbGxiYWNrIHNlZXMgYSByZWFsIGNvbmZsaWN0LiAqL1xuICAgIGNvbnN0IHJlc3RvcmUgPSBhc3luYyAoKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICBhd2FpdCBnaXQoW1wiY2hlY2tvdXRcIiwgXCItLW1lcmdlXCIsIFwiLS1cIiwgcGF0aF0pO1xuICAgIH07XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgd3JpdGVGaWxlKHBhdGgsIG91dGNvbWUudGV4dCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGF3YWl0IHJlc3RvcmUoKTtcbiAgICAgIG1hbmlmZXN0T3V0Y29tZXMuc2V0KHBhdGgsIFwidW5yZXNvbHZlZFwiKTtcbiAgICAgIGRlZmVyKFxuICAgICAgICBwYXRoLFxuICAgICAgICBgd3JpdGluZyB0aGUgcmVzb2x2ZWQgJHtwYXRofSBmYWlsZWQ6ICR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWAsXG4gICAgICApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2VkID0gYXdhaXQgZ2l0KFtcImFkZFwiLCBcIi0tXCIsIHBhdGhdKTtcbiAgICBpZiAoc3RhZ2VkLmNvZGUgIT09IDApIHtcbiAgICAgIGF3YWl0IHJlc3RvcmUoKTtcbiAgICAgIG1hbmlmZXN0T3V0Y29tZXMuc2V0KHBhdGgsIFwidW5yZXNvbHZlZFwiKTtcbiAgICAgIGRlZmVyKFxuICAgICAgICBwYXRoLFxuICAgICAgICBgc3RhZ2luZyB0aGUgcmVzb2x2ZWQgJHtwYXRofSBmYWlsZWQ6ICR7XG4gICAgICAgICAgZm9ybWF0Q29uZmxpY3RHaXREZXRhaWwoc3RhZ2VkKVxuICAgICAgICB9YCxcbiAgICAgICk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBkZWNpc2lvbnMgPSBleHRyYWN0RGVwZW5kZW5jeURlY2lzaW9ucyhwYXJzZWQudmFsdWUsIG91dGNvbWUudGV4dCk7XG4gICAgbWFuaWZlc3RPdXRjb21lcy5zZXQocGF0aCwgXCJyZXNvbHZlZFwiKTtcbiAgICByZXNvbHZlZC5wdXNoKHtcbiAgICAgIHBhdGgsXG4gICAgICBraW5kOiBcIm1hbmlmZXN0XCIsXG4gICAgICByZXNvbHZlZEJ5OiBydWxlLm5hbWUsXG4gICAgICBkZWNpc2lvbnM6IGRlY2lzaW9ucyA/PyBbXSxcbiAgICAgIGRlY2lzaW9uc1VuYXR0cmlidXRlZDogZGVjaXNpb25zID09PSBudWxsLFxuICAgIH0pO1xuICAgIGxvZ2dlcj8uaW5mbz8uKGBSZXNvbHZlZCAke3BhdGh9IGJ5IHJ1bGUgJHtydWxlLm5hbWV9YCwge1xuICAgICAgcGF0aCxcbiAgICAgIHJ1bGU6IHJ1bGUubmFtZSxcbiAgICAgIGRlY2lzaW9uczogKGRlY2lzaW9ucyA/PyBbXSkubGVuZ3RoLFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKGFkZGVkT25Cb3RoU2lkZXMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGNvdW50ID0gYWRkZWRPbkJvdGhTaWRlcy5sZW5ndGg7XG4gICAgY29uc3Qgbm91biA9IGNvdW50ID09PSAxID8gXCJmaWxlXCIgOiBcImZpbGVzXCI7XG4gICAgbG9nZ2VyPy5pbmZvPy4oXG4gICAgICBgJHtjb3VudH0gY29uZmxpY3RlZCAke25vdW59ICR7QURERURfT05fQk9USF9TSURFU31gLFxuICAgICAgeyBjb3VudCwgcGF0aHM6IGFkZGVkT25Cb3RoU2lkZXMgfSxcbiAgICApO1xuICB9XG5cbiAgaWYgKGxvY2tGaWxlcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qgb3V0Y29tZXMgPSBhd2FpdCByZWdlbmVyYXRlTG9ja0ZpbGVzKHtcbiAgICAgIHdvcmtpbmdEaXIsXG4gICAgICBtYW5pZmVzdE91dGNvbWVzLFxuICAgICAgbG9ja0ZpbGVzLFxuICAgICAgLi4uKGxvZ2dlciA/IHsgbG9nZ2VyIH0gOiB7fSksXG4gICAgICAuLi5vcHRpb25zLmxvY2tSZWdlbixcbiAgICB9KTtcbiAgICBmb3IgKGNvbnN0IG91dGNvbWUgb2Ygb3V0Y29tZXMpIHtcbiAgICAgIGlmIChvdXRjb21lLmtpbmQgPT09IFwidW5yZXNvbHZlZFwiKSB7XG4gICAgICAgIGRlZmVyKG91dGNvbWUucGF0aCwgb3V0Y29tZS5yZWFzb24pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIHJlc29sdmVkLnB1c2goe1xuICAgICAgICBwYXRoOiBvdXRjb21lLnBhdGgsXG4gICAgICAgIGtpbmQ6IFwibG9ja1wiLFxuICAgICAgICByZXNvbHZlZEJ5OiBbb3V0Y29tZS5jb21tYW5kLmJpbiwgLi4ub3V0Y29tZS5jb21tYW5kLmFyZ3NdLmpvaW4oXCIgXCIpLFxuICAgICAgICBkZWNpc2lvbnM6IFtdLFxuICAgICAgICBkZWNpc2lvbnNVbmF0dHJpYnV0ZWQ6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgcmVzb2x2ZWQsIGRlZmVycmVkIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW9DQyxHQUVELFNBRUUsMEJBQTBCLFFBQ3JCLHFDQUFxQztBQUM1QyxTQUVFLG9CQUFvQixFQUNwQixxQkFBcUIsUUFDaEIsaUNBQWlDO0FBQ3hDLCtFQUErRTtBQUMvRSxpRUFBaUU7QUFDakUsT0FBTyxnQ0FBZ0M7QUFDdkMsT0FBTyxrQ0FBa0M7QUFDekMsNEVBQTRFO0FBQzVFLDREQUE0RDtBQUM1RCxPQUFPLG1DQUFtQztBQUMxQyxTQUFTLFlBQVksUUFBUSxxQkFBcUI7QUFDbEQsU0FDRSxzQkFBc0IsRUFHdEIsZUFBZSxFQUVmLG1CQUFtQixRQUNkLDZCQUE2QjtBQWlGcEMsOEVBQThFO0FBQzlFLFdBQVc7QUFDWCw4RUFBOEU7QUFFOUUsOERBQThELEdBQzlELFNBQVMsU0FBUyxVQUFrQixFQUFFLFFBQWdCO0VBQ3BELE9BQU8sR0FBRyxXQUFXLE9BQU8sQ0FBQyxRQUFRLElBQUksQ0FBQyxFQUFFLFVBQVU7QUFDeEQ7QUFFQSxTQUFTLGNBQ1AsVUFBa0I7RUFFbEIsT0FBTyxPQUFPO0lBQ1osSUFBSTtNQUNGLE9BQU8sTUFBTSxLQUFLLFlBQVksQ0FBQyxTQUFTLFlBQVk7SUFDdEQsRUFBRSxPQUFPLE9BQU87TUFDZCxJQUFJLGlCQUFpQixLQUFLLE1BQU0sQ0FBQyxRQUFRLEVBQUUsT0FBTztNQUNsRCxNQUFN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
// denoCacheMetadata=2873047878371729438,3835709643936155866