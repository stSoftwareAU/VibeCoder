/**
 * Label add/ensure operations for the Vibe Coder worker.
 *
 * Provides `addLabelToIssue` (add a label to an issue) and
 * `ensureLabelExists` (create a label if it does not already exist),
 * both with REST-API-primary, CLI-fallback behaviour (Issue #976).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import type { LabelManagerDeps } from "./label_types.ts";
import { getCachedLabels, labelCacheInvalidate } from "./label_cache.ts";
import { invalidateTimelineCache } from "./timeline_cache.ts";
import { getLabelByName } from "../setup/label_definitions.ts";
import { assertWorkerCanApplyLabel } from "./worker_label_guard.ts";

/**
 * Add a label to an issue using the GitHub REST API with CLI fallback.
 *
 * Primary: `gh api -X POST /repos/{owner}/{repo}/issues/{issue_number}/labels`
 * Fallback: `gh issue edit --add-label`
 *
 * Issue #976 — Some service accounts cannot add labels via `gh issue edit
 * --add-label` due to insufficient permissions. The REST API may work with
 * the token's current permission scope.
 */
export async function addLabelToIssue(
  repo: string,
  issueNumber: number,
  label: string,
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;

  // Rule-of-Two runtime guard (Issue #2382): refuse to mutate GitHub
  // state with labels outside the worker's positive allowlist. This is
  // defence-in-depth — `label_security.ts` already strips such labels on
  // the next scan, but this stops the call before it ever hits GitHub.
  const guard = assertWorkerCanApplyLabel(label, {
    caller: `addLabelToIssue(${repo}#${issueNumber})`,
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
      `labels[]=${label}`,
    ]);
    // Issue #1673: A worker-applied label changes the timeline; invalidate
    // the cached entry so the next label-author check reads fresh data.
    await invalidateTimelineCache(repo, issueNumber, deps.timelineCache);
    return { ok: true, value: undefined };
  } catch {
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
      label,
    ]);
    await invalidateTimelineCache(repo, issueNumber, deps.timelineCache);
    return { ok: true, value: undefined };
  } catch {
    return {
      ok: false,
      error: new Error(
        `Failed to add label '${label}' to issue #${issueNumber} in ${repo} (both REST API and CLI failed)`,
      ),
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
 */
export async function ensureLabelExists(
  repo: string,
  labelName: string,
  colour: string = "d73a4a",
  description: string = "",
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const cacheDir = deps.cacheDir ??
    `${Deno.env.get("TMPDIR") ?? "/tmp"}/vibe-label-cache`;
  const ttlSeconds = deps.cacheTtlSeconds ?? 3600;

  // Check cached labels first (Issue #333)
  const cachedResult = await getCachedLabels(
    cacheDir,
    repo,
    ttlSeconds,
    ghCommandFn,
  );
  if (cachedResult.ok && cachedResult.value.includes(labelName)) {
    return { ok: true, value: undefined };
  }

  // Label not in cache — try to create it via REST API first (Issue #976)
  try {
    await ghCommandFn([
      "api",
      "-X",
      "POST",
      `repos/${repo}/labels`,
      "-f",
      `name=${labelName}`,
      "-f",
      `color=${colour}`,
      ...(description ? ["-f", `description=${description}`] : []),
    ]);
    await labelCacheInvalidate(cacheDir, repo);
    return { ok: true, value: undefined };
  } catch {
    // REST API creation failed — fall back to CLI
  }

  // Fallback: gh label create (CLI)
  const createArgs = [
    "label",
    "create",
    labelName,
    "--repo",
    repo,
    "--color",
    colour,
  ];
  if (description) {
    createArgs.push("--description", description);
  }

  try {
    await ghCommandFn(createArgs);
    // Invalidate cache so next lookup sees the new label
    await labelCacheInvalidate(cacheDir, repo);
    return { ok: true, value: undefined };
  } catch {
    // Self-healing: creation failed — perhaps a race condition or stale cache.
    await labelCacheInvalidate(cacheDir, repo);
    const refreshed = await getCachedLabels(
      cacheDir,
      repo,
      ttlSeconds,
      ghCommandFn,
    );
    if (refreshed.ok && refreshed.value.includes(labelName)) {
      return { ok: true, value: undefined };
    }
    return {
      ok: false,
      error: new Error(`Failed to create label '${labelName}' in ${repo}`),
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
 */
export async function ensureIdleTaskLabel(
  repo: string,
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const def = getLabelByName("idle-task");
  if (!def) {
    return {
      ok: false,
      error: new Error("idle-task label missing from LABEL_DEFINITIONS"),
    };
  }
  return await ensureLabelExists(
    repo,
    def.name,
    def.colour,
    def.description,
    deps,
  );
}

// Issue #2077: `ensureIdleTaskPendingLabel` removed alongside the
// `idle-task-pending` label. The `idle-task` pickup label remains the
// single label the framework ensures before filing a wrapper issue.
