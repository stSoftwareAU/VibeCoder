/**
 * Label add/ensure operations for the Vibe Coder worker.
 *
 * Provides `addLabelToIssue` (add a label to an issue) and
 * `ensureLabelExists` (create a label if it does not already exist),
 * both with REST-API-primary, CLI-fallback behaviour (Issue #976).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGhCommand } from "./github.ts";
import { defaultLabelCacheDir, getCachedLabels, labelCacheInvalidate } from "./label_cache.ts";
import { invalidateTimelineCache } from "./timeline_cache.ts";
import { getLabelByName, getLabelColour, getLabelDescription } from "../setup/label_definitions.ts";
import { assertWorkerCanApplyLabel } from "./worker_label_guard.ts";
/**
 * Whether a label create/add error means the label already exists.
 *
 * The REST POST returns HTTP 422 with a body naming the `already_exists`
 * code; `gh label create` prints "already exists". Either way the desired
 * state — the label is present — already holds, so the caller should treat
 * it as success rather than a failed mutation (Issue #42).
 */ export function isLabelAlreadyExistsError(message) {
  const lower = message.toLowerCase();
  return lower.includes("already_exists") || lower.includes("already exists");
}
/**
 * Add a label to an issue using the GitHub REST API with CLI fallback.
 *
 * Primary: `gh api -X POST /repos/{owner}/{repo}/issues/{issue_number}/labels`
 * Fallback: `gh issue edit --add-label`
 *
 * Issue #976 — Some service accounts cannot add labels via `gh issue edit
 * --add-label` due to insufficient permissions. The REST API may work with
 * the token's current permission scope.
 */ export async function addLabelToIssue(repo, issueNumber, label, deps = {}) {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  // Rule-of-Two runtime guard (Issue #2382): refuse to mutate GitHub
  // state with labels outside the worker's positive allowlist. This is
  // defence-in-depth — `label_security.ts` already strips such labels on
  // the next scan, but this stops the call before it ever hits GitHub.
  const guard = assertWorkerCanApplyLabel(label, {
    caller: `addLabelToIssue(${repo}#${issueNumber})`
  });
  if (!guard.ok) {
    return guard;
  }
  // Primary: REST API
  try {
    await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${issueNumber}/labels`,
      "-f",
      `labels[]=${label}`
    ]);
    // Issue #1673: A worker-applied label changes the timeline; invalidate
    // the cached entry so the next label-author check reads fresh data.
    await invalidateTimelineCache(repo, issueNumber, deps.timelineCache);
    return {
      ok: true,
      value: undefined
    };
  } catch  {
  // REST API failed — fall back to CLI
  }
  // Fallback: gh issue edit --add-label
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      label
    ]);
    await invalidateTimelineCache(repo, issueNumber, deps.timelineCache);
    return {
      ok: true,
      value: undefined
    };
  } catch  {
    return {
      ok: false,
      error: new Error(`Failed to add label '${label}' to issue #${issueNumber} in ${repo} (both REST API and CLI failed)`)
    };
  }
}
/**
 * Ensure a label exists in a repository, creating it if necessary.
 *
 * Checks the label cache first, then creates if missing. Self-heals on
 * race conditions by refreshing the cache after a failed creation.
 *
 * Issue #976 — Uses REST API as primary method for label creation,
 * with CLI fallback.
 *
 * Issue #368 — `colour` and `description` are resolved from the canonical
 * label table when the caller omits them. Before this, the parameter
 * defaulted to red and each call site hard-coded its own literal, so a
 * label's colour was decided by whichever call site created it first in
 * that repo — the same label ended up a different colour in every repo.
 * Pass a colour explicitly only when the label is genuinely not
 * fleet-managed.
 */ export async function ensureLabelExists(repo, labelName, colour, description, deps = {}) {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const canonicalColour = colour ?? getLabelColour(labelName);
  const canonicalDescription = description ?? getLabelDescription(labelName);
  // Issue #1242: a per-account directory, not the fixed
  // `${TMPDIR}/vibe-label-cache` every account on the host shared.
  const cacheDir = deps.cacheDir ?? defaultLabelCacheDir();
  const ttlSeconds = deps.cacheTtlSeconds ?? 3600;
  // Check cached labels first (Issue #333)
  const cachedResult = await getCachedLabels(cacheDir, repo, ttlSeconds, ghCommandFn);
  if (cachedResult.ok && cachedResult.value.includes(labelName)) {
    return {
      ok: true,
      value: undefined
    };
  }
  // Label not in cache — try to create it via REST API first (Issue #976)
  let restError = null;
  try {
    await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/labels`,
      "-f",
      `name=${labelName}`,
      "-f",
      `color=${canonicalColour}`,
      ...canonicalDescription ? [
        "-f",
        `description=${canonicalDescription}`
      ] : []
    ]);
    await labelCacheInvalidate(cacheDir, repo);
    return {
      ok: true,
      value: undefined
    };
  } catch (err) {
    restError = err instanceof Error ? err.message : String(err);
    // Issue #42: a 422 `already_exists` means the label is already there —
    // that is success, not a reason to fall through to a second create that
    // will fail the same way (and, when the quota is exhausted, re-list
    // against a dead GraphQL budget and mis-report a rate-limit outage as a
    // label bug).
    if (isLabelAlreadyExistsError(restError)) {
      await labelCacheInvalidate(cacheDir, repo);
      return {
        ok: true,
        value: undefined
      };
    }
  }
  // Fallback: gh label create (CLI)
  const createArgs = [
    "label",
    "create",
    labelName,
    "--repo",
    repo,
    "--color",
    canonicalColour
  ];
  if (canonicalDescription) {
    createArgs.push("--description", canonicalDescription);
  }
  try {
    await ghCommandFn(createArgs);
    // Invalidate cache so next lookup sees the new label
    await labelCacheInvalidate(cacheDir, repo);
    return {
      ok: true,
      value: undefined
    };
  } catch (err) {
    const cliError = err instanceof Error ? err.message : String(err);
    if (isLabelAlreadyExistsError(cliError)) {
      await labelCacheInvalidate(cacheDir, repo);
      return {
        ok: true,
        value: undefined
      };
    }
    // Self-healing: creation failed — perhaps a race condition or stale cache.
    await labelCacheInvalidate(cacheDir, repo);
    const refreshed = await getCachedLabels(cacheDir, repo, ttlSeconds, ghCommandFn);
    if (refreshed.ok && refreshed.value.includes(labelName)) {
      return {
        ok: true,
        value: undefined
      };
    }
    // Issue #42: carry the underlying cause so a quota outage
    // ("API rate limit already exceeded") does not masquerade as a
    // permissions/label defect. The CLI error is the most recent; the REST
    // error is the fallback when the CLI produced none.
    const underlying = cliError || restError;
    return {
      ok: false,
      error: new Error(`Failed to create label '${labelName}' in ${repo}${underlying ? `: ${underlying}` : ""}`)
    };
  }
}
/**
 * Ensure the `idle-task` label exists on a repository (Issue #1961).
 *
 * Convenience wrapper over `ensureLabelExists` that resolves the
 * canonical colour and description from `LABEL_DEFINITIONS`, so callers
 * (idle-task issue filing in particular) cannot drift from the single
 * source of truth. Idempotent — a no-op when the label already exists.
 */ export async function ensureIdleTaskLabel(repo, deps = {}) {
  const def = getLabelByName("idle-task");
  if (!def) {
    return {
      ok: false,
      error: new Error("idle-task label missing from LABEL_DEFINITIONS")
    };
  }
  return await ensureLabelExists(repo, def.name, def.colour, def.description, deps);
} // Issue #2077: `ensureIdleTaskPendingLabel` removed alongside the
 // `idle-task-pending` label. The `idle-task` pickup label remains the
 // single label the framework ensures before filing a wrapper issue.
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9sYWJlbF9vcGVyYXRpb25zLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTGFiZWwgYWRkL2Vuc3VyZSBvcGVyYXRpb25zIGZvciB0aGUgVmliZSBDb2RlciB3b3JrZXIuXG4gKlxuICogUHJvdmlkZXMgYGFkZExhYmVsVG9Jc3N1ZWAgKGFkZCBhIGxhYmVsIHRvIGFuIGlzc3VlKSBhbmRcbiAqIGBlbnN1cmVMYWJlbEV4aXN0c2AgKGNyZWF0ZSBhIGxhYmVsIGlmIGl0IGRvZXMgbm90IGFscmVhZHkgZXhpc3QpLFxuICogYm90aCB3aXRoIFJFU1QtQVBJLXByaW1hcnksIENMSS1mYWxsYmFjayBiZWhhdmlvdXIgKElzc3VlICM5NzYpLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBydW5HaENvbW1hbmQgfSBmcm9tIFwiLi9naXRodWIudHNcIjtcbmltcG9ydCB0eXBlIHsgTGFiZWxNYW5hZ2VyRGVwcyB9IGZyb20gXCIuL2xhYmVsX3R5cGVzLnRzXCI7XG5pbXBvcnQge1xuICBkZWZhdWx0TGFiZWxDYWNoZURpcixcbiAgZ2V0Q2FjaGVkTGFiZWxzLFxuICBsYWJlbENhY2hlSW52YWxpZGF0ZSxcbn0gZnJvbSBcIi4vbGFiZWxfY2FjaGUudHNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVUaW1lbGluZUNhY2hlIH0gZnJvbSBcIi4vdGltZWxpbmVfY2FjaGUudHNcIjtcbmltcG9ydCB7XG4gIGdldExhYmVsQnlOYW1lLFxuICBnZXRMYWJlbENvbG91cixcbiAgZ2V0TGFiZWxEZXNjcmlwdGlvbixcbn0gZnJvbSBcIi4uL3NldHVwL2xhYmVsX2RlZmluaXRpb25zLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnRXb3JrZXJDYW5BcHBseUxhYmVsIH0gZnJvbSBcIi4vd29ya2VyX2xhYmVsX2d1YXJkLnRzXCI7XG5cbi8qKlxuICogV2hldGhlciBhIGxhYmVsIGNyZWF0ZS9hZGQgZXJyb3IgbWVhbnMgdGhlIGxhYmVsIGFscmVhZHkgZXhpc3RzLlxuICpcbiAqIFRoZSBSRVNUIFBPU1QgcmV0dXJucyBIVFRQIDQyMiB3aXRoIGEgYm9keSBuYW1pbmcgdGhlIGBhbHJlYWR5X2V4aXN0c2BcbiAqIGNvZGU7IGBnaCBsYWJlbCBjcmVhdGVgIHByaW50cyBcImFscmVhZHkgZXhpc3RzXCIuIEVpdGhlciB3YXkgdGhlIGRlc2lyZWRcbiAqIHN0YXRlIOKAlCB0aGUgbGFiZWwgaXMgcHJlc2VudCDigJQgYWxyZWFkeSBob2xkcywgc28gdGhlIGNhbGxlciBzaG91bGQgdHJlYXRcbiAqIGl0IGFzIHN1Y2Nlc3MgcmF0aGVyIHRoYW4gYSBmYWlsZWQgbXV0YXRpb24gKElzc3VlICM0MikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0xhYmVsQWxyZWFkeUV4aXN0c0Vycm9yKG1lc3NhZ2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IG1lc3NhZ2UudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIGxvd2VyLmluY2x1ZGVzKFwiYWxyZWFkeV9leGlzdHNcIikgfHwgbG93ZXIuaW5jbHVkZXMoXCJhbHJlYWR5IGV4aXN0c1wiKTtcbn1cblxuLyoqXG4gKiBBZGQgYSBsYWJlbCB0byBhbiBpc3N1ZSB1c2luZyB0aGUgR2l0SHViIFJFU1QgQVBJIHdpdGggQ0xJIGZhbGxiYWNrLlxuICpcbiAqIFByaW1hcnk6IGBnaCBhcGkgLVggUE9TVCAvcmVwb3Mve293bmVyfS97cmVwb30vaXNzdWVzL3tpc3N1ZV9udW1iZXJ9L2xhYmVsc2BcbiAqIEZhbGxiYWNrOiBgZ2ggaXNzdWUgZWRpdCAtLWFkZC1sYWJlbGBcbiAqXG4gKiBJc3N1ZSAjOTc2IOKAlCBTb21lIHNlcnZpY2UgYWNjb3VudHMgY2Fubm90IGFkZCBsYWJlbHMgdmlhIGBnaCBpc3N1ZSBlZGl0XG4gKiAtLWFkZC1sYWJlbGAgZHVlIHRvIGluc3VmZmljaWVudCBwZXJtaXNzaW9ucy4gVGhlIFJFU1QgQVBJIG1heSB3b3JrIHdpdGhcbiAqIHRoZSB0b2tlbidzIGN1cnJlbnQgcGVybWlzc2lvbiBzY29wZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFkZExhYmVsVG9Jc3N1ZShcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBsYWJlbDogc3RyaW5nLFxuICBkZXBzOiBMYWJlbE1hbmFnZXJEZXBzID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBjb25zdCBnaENvbW1hbmRGbiA9IGRlcHMuZ2hDb21tYW5kRm4gPz8gcnVuR2hDb21tYW5kO1xuXG4gIC8vIFJ1bGUtb2YtVHdvIHJ1bnRpbWUgZ3VhcmQgKElzc3VlICMyMzgyKTogcmVmdXNlIHRvIG11dGF0ZSBHaXRIdWJcbiAgLy8gc3RhdGUgd2l0aCBsYWJlbHMgb3V0c2lkZSB0aGUgd29ya2VyJ3MgcG9zaXRpdmUgYWxsb3dsaXN0LiBUaGlzIGlzXG4gIC8vIGRlZmVuY2UtaW4tZGVwdGgg4oCUIGBsYWJlbF9zZWN1cml0eS50c2AgYWxyZWFkeSBzdHJpcHMgc3VjaCBsYWJlbHMgb25cbiAgLy8gdGhlIG5leHQgc2NhbiwgYnV0IHRoaXMgc3RvcHMgdGhlIGNhbGwgYmVmb3JlIGl0IGV2ZXIgaGl0cyBHaXRIdWIuXG4gIGNvbnN0IGd1YXJkID0gYXNzZXJ0V29ya2VyQ2FuQXBwbHlMYWJlbChsYWJlbCwge1xuICAgIGNhbGxlcjogYGFkZExhYmVsVG9Jc3N1ZSgke3JlcG99IyR7aXNzdWVOdW1iZXJ9KWAsXG4gIH0pO1xuICBpZiAoIWd1YXJkLm9rKSB7XG4gICAgcmV0dXJuIGd1YXJkO1xuICB9XG5cbiAgLy8gUHJpbWFyeTogUkVTVCBBUElcbiAgdHJ5IHtcbiAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImFwaVwiLFxuICAgICAgXCItWFwiLFxuICAgICAgXCJQT1NUXCIsXG4gICAgICBgcmVwb3MvJHtyZXBvfS9pc3N1ZXMvJHtpc3N1ZU51bWJlcn0vbGFiZWxzYCxcbiAgICAgIFwiLWZcIixcbiAgICAgIGBsYWJlbHNbXT0ke2xhYmVsfWAsXG4gICAgXSk7XG4gICAgLy8gSXNzdWUgIzE2NzM6IEEgd29ya2VyLWFwcGxpZWQgbGFiZWwgY2hhbmdlcyB0aGUgdGltZWxpbmU7IGludmFsaWRhdGVcbiAgICAvLyB0aGUgY2FjaGVkIGVudHJ5IHNvIHRoZSBuZXh0IGxhYmVsLWF1dGhvciBjaGVjayByZWFkcyBmcmVzaCBkYXRhLlxuICAgIGF3YWl0IGludmFsaWRhdGVUaW1lbGluZUNhY2hlKHJlcG8sIGlzc3VlTnVtYmVyLCBkZXBzLnRpbWVsaW5lQ2FjaGUpO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH0gY2F0Y2gge1xuICAgIC8vIFJFU1QgQVBJIGZhaWxlZCDigJQgZmFsbCBiYWNrIHRvIENMSVxuICB9XG5cbiAgLy8gRmFsbGJhY2s6IGdoIGlzc3VlIGVkaXQgLS1hZGQtbGFiZWxcbiAgdHJ5IHtcbiAgICBhd2FpdCBnaENvbW1hbmRGbihbXG4gICAgICBcImlzc3VlXCIsXG4gICAgICBcImVkaXRcIixcbiAgICAgIFN0cmluZyhpc3N1ZU51bWJlciksXG4gICAgICBcIi0tcmVwb1wiLFxuICAgICAgcmVwbyxcbiAgICAgIFwiLS1hZGQtbGFiZWxcIixcbiAgICAgIGxhYmVsLFxuICAgIF0pO1xuICAgIGF3YWl0IGludmFsaWRhdGVUaW1lbGluZUNhY2hlKHJlcG8sIGlzc3VlTnVtYmVyLCBkZXBzLnRpbWVsaW5lQ2FjaGUpO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgRmFpbGVkIHRvIGFkZCBsYWJlbCAnJHtsYWJlbH0nIHRvIGlzc3VlICMke2lzc3VlTnVtYmVyfSBpbiAke3JlcG99IChib3RoIFJFU1QgQVBJIGFuZCBDTEkgZmFpbGVkKWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBFbnN1cmUgYSBsYWJlbCBleGlzdHMgaW4gYSByZXBvc2l0b3J5LCBjcmVhdGluZyBpdCBpZiBuZWNlc3NhcnkuXG4gKlxuICogQ2hlY2tzIHRoZSBsYWJlbCBjYWNoZSBmaXJzdCwgdGhlbiBjcmVhdGVzIGlmIG1pc3NpbmcuIFNlbGYtaGVhbHMgb25cbiAqIHJhY2UgY29uZGl0aW9ucyBieSByZWZyZXNoaW5nIHRoZSBjYWNoZSBhZnRlciBhIGZhaWxlZCBjcmVhdGlvbi5cbiAqXG4gKiBJc3N1ZSAjOTc2IOKAlCBVc2VzIFJFU1QgQVBJIGFzIHByaW1hcnkgbWV0aG9kIGZvciBsYWJlbCBjcmVhdGlvbixcbiAqIHdpdGggQ0xJIGZhbGxiYWNrLlxuICpcbiAqIElzc3VlICMzNjgg4oCUIGBjb2xvdXJgIGFuZCBgZGVzY3JpcHRpb25gIGFyZSByZXNvbHZlZCBmcm9tIHRoZSBjYW5vbmljYWxcbiAqIGxhYmVsIHRhYmxlIHdoZW4gdGhlIGNhbGxlciBvbWl0cyB0aGVtLiBCZWZvcmUgdGhpcywgdGhlIHBhcmFtZXRlclxuICogZGVmYXVsdGVkIHRvIHJlZCBhbmQgZWFjaCBjYWxsIHNpdGUgaGFyZC1jb2RlZCBpdHMgb3duIGxpdGVyYWwsIHNvIGFcbiAqIGxhYmVsJ3MgY29sb3VyIHdhcyBkZWNpZGVkIGJ5IHdoaWNoZXZlciBjYWxsIHNpdGUgY3JlYXRlZCBpdCBmaXJzdCBpblxuICogdGhhdCByZXBvIOKAlCB0aGUgc2FtZSBsYWJlbCBlbmRlZCB1cCBhIGRpZmZlcmVudCBjb2xvdXIgaW4gZXZlcnkgcmVwby5cbiAqIFBhc3MgYSBjb2xvdXIgZXhwbGljaXRseSBvbmx5IHdoZW4gdGhlIGxhYmVsIGlzIGdlbnVpbmVseSBub3RcbiAqIGZsZWV0LW1hbmFnZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBlbnN1cmVMYWJlbEV4aXN0cyhcbiAgcmVwbzogc3RyaW5nLFxuICBsYWJlbE5hbWU6IHN0cmluZyxcbiAgY29sb3VyPzogc3RyaW5nLFxuICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgZGVwczogTGFiZWxNYW5hZ2VyRGVwcyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3QgZ2hDb21tYW5kRm4gPSBkZXBzLmdoQ29tbWFuZEZuID8/IHJ1bkdoQ29tbWFuZDtcbiAgY29uc3QgY2Fub25pY2FsQ29sb3VyID0gY29sb3VyID8/IGdldExhYmVsQ29sb3VyKGxhYmVsTmFtZSk7XG4gIGNvbnN0IGNhbm9uaWNhbERlc2NyaXB0aW9uID0gZGVzY3JpcHRpb24gPz8gZ2V0TGFiZWxEZXNjcmlwdGlvbihsYWJlbE5hbWUpO1xuICAvLyBJc3N1ZSAjMTI0MjogYSBwZXItYWNjb3VudCBkaXJlY3RvcnksIG5vdCB0aGUgZml4ZWRcbiAgLy8gYCR7VE1QRElSfS92aWJlLWxhYmVsLWNhY2hlYCBldmVyeSBhY2NvdW50IG9uIHRoZSBob3N0IHNoYXJlZC5cbiAgY29uc3QgY2FjaGVEaXIgPSBkZXBzLmNhY2hlRGlyID8/IGRlZmF1bHRMYWJlbENhY2hlRGlyKCk7XG4gIGNvbnN0IHR0bFNlY29uZHMgPSBkZXBzLmNhY2hlVHRsU2Vjb25kcyA/PyAzNjAwO1xuXG4gIC8vIENoZWNrIGNhY2hlZCBsYWJlbHMgZmlyc3QgKElzc3VlICMzMzMpXG4gIGNvbnN0IGNhY2hlZFJlc3VsdCA9IGF3YWl0IGdldENhY2hlZExhYmVscyhcbiAgICBjYWNoZURpcixcbiAgICByZXBvLFxuICAgIHR0bFNlY29uZHMsXG4gICAgZ2hDb21tYW5kRm4sXG4gICk7XG4gIGlmIChjYWNoZWRSZXN1bHQub2sgJiYgY2FjaGVkUmVzdWx0LnZhbHVlLmluY2x1ZGVzKGxhYmVsTmFtZSkpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgLy8gTGFiZWwgbm90IGluIGNhY2hlIOKAlCB0cnkgdG8gY3JlYXRlIGl0IHZpYSBSRVNUIEFQSSBmaXJzdCAoSXNzdWUgIzk3NilcbiAgbGV0IHJlc3RFcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgYXdhaXQgZ2hDb21tYW5kRm4oW1xuICAgICAgXCJhcGlcIixcbiAgICAgIFwiLVhcIixcbiAgICAgIFwiUE9TVFwiLFxuICAgICAgYHJlcG9zLyR7cmVwb30vbGFiZWxzYCxcbiAgICAgIFwiLWZcIixcbiAgICAgIGBuYW1lPSR7bGFiZWxOYW1lfWAsXG4gICAgICBcIi1mXCIsXG4gICAgICBgY29sb3I9JHtjYW5vbmljYWxDb2xvdXJ9YCxcbiAgICAgIC4uLihjYW5vbmljYWxEZXNjcmlwdGlvblxuICAgICAgICA/IFtcIi1mXCIsIGBkZXNjcmlwdGlvbj0ke2Nhbm9uaWNhbERlc2NyaXB0aW9ufWBdXG4gICAgICAgIDogW10pLFxuICAgIF0pO1xuICAgIGF3YWl0IGxhYmVsQ2FjaGVJbnZhbGlkYXRlKGNhY2hlRGlyLCByZXBvKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXN0RXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgLy8gSXNzdWUgIzQyOiBhIDQyMiBgYWxyZWFkeV9leGlzdHNgIG1lYW5zIHRoZSBsYWJlbCBpcyBhbHJlYWR5IHRoZXJlIOKAlFxuICAgIC8vIHRoYXQgaXMgc3VjY2Vzcywgbm90IGEgcmVhc29uIHRvIGZhbGwgdGhyb3VnaCB0byBhIHNlY29uZCBjcmVhdGUgdGhhdFxuICAgIC8vIHdpbGwgZmFpbCB0aGUgc2FtZSB3YXkgKGFuZCwgd2hlbiB0aGUgcXVvdGEgaXMgZXhoYXVzdGVkLCByZS1saXN0XG4gICAgLy8gYWdhaW5zdCBhIGRlYWQgR3JhcGhRTCBidWRnZXQgYW5kIG1pcy1yZXBvcnQgYSByYXRlLWxpbWl0IG91dGFnZSBhcyBhXG4gICAgLy8gbGFiZWwgYnVnKS5cbiAgICBpZiAoaXNMYWJlbEFscmVhZHlFeGlzdHNFcnJvcihyZXN0RXJyb3IpKSB7XG4gICAgICBhd2FpdCBsYWJlbENhY2hlSW52YWxpZGF0ZShjYWNoZURpciwgcmVwbyk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIEZhbGxiYWNrOiBnaCBsYWJlbCBjcmVhdGUgKENMSSlcbiAgY29uc3QgY3JlYXRlQXJncyA9IFtcbiAgICBcImxhYmVsXCIsXG4gICAgXCJjcmVhdGVcIixcbiAgICBsYWJlbE5hbWUsXG4gICAgXCItLXJlcG9cIixcbiAgICByZXBvLFxuICAgIFwiLS1jb2xvclwiLFxuICAgIGNhbm9uaWNhbENvbG91cixcbiAgXTtcbiAgaWYgKGNhbm9uaWNhbERlc2NyaXB0aW9uKSB7XG4gICAgY3JlYXRlQXJncy5wdXNoKFwiLS1kZXNjcmlwdGlvblwiLCBjYW5vbmljYWxEZXNjcmlwdGlvbik7XG4gIH1cblxuICB0cnkge1xuICAgIGF3YWl0IGdoQ29tbWFuZEZuKGNyZWF0ZUFyZ3MpO1xuICAgIC8vIEludmFsaWRhdGUgY2FjaGUgc28gbmV4dCBsb29rdXAgc2VlcyB0aGUgbmV3IGxhYmVsXG4gICAgYXdhaXQgbGFiZWxDYWNoZUludmFsaWRhdGUoY2FjaGVEaXIsIHJlcG8pO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IGNsaUVycm9yID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGlmIChpc0xhYmVsQWxyZWFkeUV4aXN0c0Vycm9yKGNsaUVycm9yKSkge1xuICAgICAgYXdhaXQgbGFiZWxDYWNoZUludmFsaWRhdGUoY2FjaGVEaXIsIHJlcG8pO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgICB9XG4gICAgLy8gU2VsZi1oZWFsaW5nOiBjcmVhdGlvbiBmYWlsZWQg4oCUIHBlcmhhcHMgYSByYWNlIGNvbmRpdGlvbiBvciBzdGFsZSBjYWNoZS5cbiAgICBhd2FpdCBsYWJlbENhY2hlSW52YWxpZGF0ZShjYWNoZURpciwgcmVwbyk7XG4gICAgY29uc3QgcmVmcmVzaGVkID0gYXdhaXQgZ2V0Q2FjaGVkTGFiZWxzKFxuICAgICAgY2FjaGVEaXIsXG4gICAgICByZXBvLFxuICAgICAgdHRsU2Vjb25kcyxcbiAgICAgIGdoQ29tbWFuZEZuLFxuICAgICk7XG4gICAgaWYgKHJlZnJlc2hlZC5vayAmJiByZWZyZXNoZWQudmFsdWUuaW5jbHVkZXMobGFiZWxOYW1lKSkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgICB9XG4gICAgLy8gSXNzdWUgIzQyOiBjYXJyeSB0aGUgdW5kZXJseWluZyBjYXVzZSBzbyBhIHF1b3RhIG91dGFnZVxuICAgIC8vIChcIkFQSSByYXRlIGxpbWl0IGFscmVhZHkgZXhjZWVkZWRcIikgZG9lcyBub3QgbWFzcXVlcmFkZSBhcyBhXG4gICAgLy8gcGVybWlzc2lvbnMvbGFiZWwgZGVmZWN0LiBUaGUgQ0xJIGVycm9yIGlzIHRoZSBtb3N0IHJlY2VudDsgdGhlIFJFU1RcbiAgICAvLyBlcnJvciBpcyB0aGUgZmFsbGJhY2sgd2hlbiB0aGUgQ0xJIHByb2R1Y2VkIG5vbmUuXG4gICAgY29uc3QgdW5kZXJseWluZyA9IGNsaUVycm9yIHx8IHJlc3RFcnJvcjtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byBjcmVhdGUgbGFiZWwgJyR7bGFiZWxOYW1lfScgaW4gJHtyZXBvfSR7XG4gICAgICAgICAgdW5kZXJseWluZyA/IGA6ICR7dW5kZXJseWluZ31gIDogXCJcIlxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIEVuc3VyZSB0aGUgYGlkbGUtdGFza2AgbGFiZWwgZXhpc3RzIG9uIGEgcmVwb3NpdG9yeSAoSXNzdWUgIzE5NjEpLlxuICpcbiAqIENvbnZlbmllbmNlIHdyYXBwZXIgb3ZlciBgZW5zdXJlTGFiZWxFeGlzdHNgIHRoYXQgcmVzb2x2ZXMgdGhlXG4gKiBjYW5vbmljYWwgY29sb3VyIGFuZCBkZXNjcmlwdGlvbiBmcm9tIGBMQUJFTF9ERUZJTklUSU9OU2AsIHNvIGNhbGxlcnNcbiAqIChpZGxlLXRhc2sgaXNzdWUgZmlsaW5nIGluIHBhcnRpY3VsYXIpIGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBzaW5nbGVcbiAqIHNvdXJjZSBvZiB0cnV0aC4gSWRlbXBvdGVudCDigJQgYSBuby1vcCB3aGVuIHRoZSBsYWJlbCBhbHJlYWR5IGV4aXN0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuc3VyZUlkbGVUYXNrTGFiZWwoXG4gIHJlcG86IHN0cmluZyxcbiAgZGVwczogTGFiZWxNYW5hZ2VyRGVwcyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3QgZGVmID0gZ2V0TGFiZWxCeU5hbWUoXCJpZGxlLXRhc2tcIik7XG4gIGlmICghZGVmKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXCJpZGxlLXRhc2sgbGFiZWwgbWlzc2luZyBmcm9tIExBQkVMX0RFRklOSVRJT05TXCIpLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIGF3YWl0IGVuc3VyZUxhYmVsRXhpc3RzKFxuICAgIHJlcG8sXG4gICAgZGVmLm5hbWUsXG4gICAgZGVmLmNvbG91cixcbiAgICBkZWYuZGVzY3JpcHRpb24sXG4gICAgZGVwcyxcbiAgKTtcbn1cblxuLy8gSXNzdWUgIzIwNzc6IGBlbnN1cmVJZGxlVGFza1BlbmRpbmdMYWJlbGAgcmVtb3ZlZCBhbG9uZ3NpZGUgdGhlXG4vLyBgaWRsZS10YXNrLXBlbmRpbmdgIGxhYmVsLiBUaGUgYGlkbGUtdGFza2AgcGlja3VwIGxhYmVsIHJlbWFpbnMgdGhlXG4vLyBzaW5nbGUgbGFiZWwgdGhlIGZyYW1ld29yayBlbnN1cmVzIGJlZm9yZSBmaWxpbmcgYSB3cmFwcGVyIGlzc3VlLlxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7OztDQVFDLEdBR0QsU0FBUyxZQUFZLFFBQVEsY0FBYztBQUUzQyxTQUNFLG9CQUFvQixFQUNwQixlQUFlLEVBQ2Ysb0JBQW9CLFFBQ2YsbUJBQW1CO0FBQzFCLFNBQVMsdUJBQXVCLFFBQVEsc0JBQXNCO0FBQzlELFNBQ0UsY0FBYyxFQUNkLGNBQWMsRUFDZCxtQkFBbUIsUUFDZCxnQ0FBZ0M7QUFDdkMsU0FBUyx5QkFBeUIsUUFBUSwwQkFBMEI7QUFFcEU7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUywwQkFBMEIsT0FBZTtFQUN2RCxNQUFNLFFBQVEsUUFBUSxXQUFXO0VBQ2pDLE9BQU8sTUFBTSxRQUFRLENBQUMscUJBQXFCLE1BQU0sUUFBUSxDQUFDO0FBQzVEO0FBRUE7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxlQUFlLGdCQUNwQixJQUFZLEVBQ1osV0FBbUIsRUFDbkIsS0FBYSxFQUNiLE9BQXlCLENBQUMsQ0FBQztFQUUzQixNQUFNLGNBQWMsS0FBSyxXQUFXLElBQUk7RUFFeEMsbUVBQW1FO0VBQ25FLHFFQUFxRTtFQUNyRSx1RUFBdUU7RUFDdkUscUVBQXFFO0VBQ3JFLE1BQU0sUUFBUSwwQkFBMEIsT0FBTztJQUM3QyxRQUFRLENBQUMsZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLEVBQUUsWUFBWSxDQUFDLENBQUM7RUFDbkQ7RUFDQSxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUU7SUFDYixPQUFPO0VBQ1Q7RUFFQSxvQkFBb0I7RUFDcEIsSUFBSTtJQUNGLE1BQU0sWUFB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
// denoCacheMetadata=13944695291883725960,3509460532963609897