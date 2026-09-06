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
import {
  defaultLabelCacheDir,
  getCachedLabels,
  labelCacheInvalidate,
} from "./label_cache.ts";
import { invalidateTimelineCache } from "./timeline_cache.ts";
import {
  getLabelByName,
  getLabelColour,
  getLabelDescription,
} from "../setup/label_definitions.ts";
import { assertWorkerCanApplyLabel } from "./worker_label_guard.ts";

/**
 * Whether a label create/add error means the label already exists.
 *
 * The REST POST returns HTTP 422 with a body naming the `already_exists`
 * code; `gh label create` prints "already exists". Either way the desired
 * state — the label is present — already holds, so the caller should treat
 * it as success rather than a failed mutation (Issue #42).
 */
export function isLabelAlreadyExistsError(message: string): boolean {
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
 *
 * Issue #368 — `colour` and `description` are resolved from the canonical
 * label table when the caller omits them. Before this, the parameter
 * defaulted to red and each call site hard-coded its own literal, so a
 * label's colour was decided by whichever call site created it first in
 * that repo — the same label ended up a different colour in every repo.
 * Pass a colour explicitly only when the label is genuinely not
 * fleet-managed.
 */
export async function ensureLabelExists(
  repo: string,
  labelName: string,
  colour?: string,
  description?: string,
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const canonicalColour = colour ?? getLabelColour(labelName);
  const canonicalDescription = description ?? getLabelDescription(labelName);
  // Issue #1242: a per-account directory, not the fixed
  // `${TMPDIR}/vibe-label-cache` every account on the host shared.
  const cacheDir = deps.cacheDir ?? defaultLabelCacheDir();
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
  let restError: string | null = null;
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
      ...(canonicalDescription
        ? ["-f", `description=${canonicalDescription}`]
        : []),
    ]);
    await labelCacheInvalidate(cacheDir, repo);
    return { ok: true, value: undefined };
  } catch (err) {
    restError = err instanceof Error ? err.message : String(err);
    // Issue #42: a 422 `already_exists` means the label is already there —
    // that is success, not a reason to fall through to a second create that
    // will fail the same way (and, when the quota is exhausted, re-list
    // against a dead GraphQL budget and mis-report a rate-limit outage as a
    // label bug).
    if (isLabelAlreadyExistsError(restError)) {
      await labelCacheInvalidate(cacheDir, repo);
      return { ok: true, value: undefined };
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
    canonicalColour,
  ];
  if (canonicalDescription) {
    createArgs.push("--description", canonicalDescription);
  }

  try {
    await ghCommandFn(createArgs);
    // Invalidate cache so next lookup sees the new label
    await labelCacheInvalidate(cacheDir, repo);
    return { ok: true, value: undefined };
  } catch (err) {
    const cliError = err instanceof Error ? err.message : String(err);
    if (isLabelAlreadyExistsError(cliError)) {
      await labelCacheInvalidate(cacheDir, repo);
      return { ok: true, value: undefined };
    }
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
    // Issue #42: carry the underlying cause so a quota outage
    // ("API rate limit already exceeded") does not masquerade as a
    // permissions/label defect. The CLI error is the most recent; the REST
    // error is the fallback when the CLI produced none.
    const underlying = cliError || restError;
    return {
      ok: false,
      error: new Error(
        `Failed to create label '${labelName}' in ${repo}${
          underlying ? `: ${underlying}` : ""
        }`,
      ),
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
