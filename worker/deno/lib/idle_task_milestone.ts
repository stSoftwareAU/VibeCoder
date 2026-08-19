/**
 * Per-template, per-repo idle-task milestone helper (Issue #1985).
 *
 * Each idle-task template (e.g. `security-scan`, `maintainability`)
 * owns a single open GitHub milestone named `idle-task: <template>`.
 * Every filed `idle-task` issue is assigned to that milestone so an
 * operator can track a batch of idle-tasks of the same template to
 * completion.
 *
 * `ensureIdleTaskMilestone()` is idempotent — it first lists open
 * milestones via the GitHub REST API and returns an existing match
 * unchanged. Only when no match is found does it POST a new milestone.
 * Repeated invocations therefore make at most one POST per
 * `(repo, template)` pair.
 *
 * Part of parent issue #1975. Sub-issue 3 wires this helper into the
 * idle-task filing flow.
 *
 * Australian English spelling used throughout.
 */

import { runGhCommand } from "./github.ts";
import { SLUG_PATTERN } from "./idle_task_template.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnsureIdleTaskMilestoneOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Template slug, e.g. `security-scan`. */
  template: string;
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
}

export interface IdleTaskMilestone {
  /** Milestone number to pass to `gh issue create --milestone`. */
  number: number;
  /** Exactly `idle-task: <template>` — useful for cross-checks. */
  title: string;
}

// ---------------------------------------------------------------------------
// Title helper
// ---------------------------------------------------------------------------

/**
 * Build the canonical milestone title for an idle-task template.
 * Always returns `idle-task: <template>` — there is no alternative
 * spelling.
 */
export function buildIdleTaskMilestoneTitle(template: string): string {
  return `idle-task: ${template}`;
}

// ---------------------------------------------------------------------------
// ensureIdleTaskMilestone
// ---------------------------------------------------------------------------

/**
 * Build the static description embedded in newly-created milestones.
 * Kept on one line so the GitHub UI renders it cleanly.
 */
function buildDescription(template: string): string {
  return (
    `Auto-managed by the idle-task framework — groups all ${template} ` +
    `idle-tasks for completion tracking.`
  );
}

/**
 * Ensure an open milestone named `idle-task: <template>` exists in
 * `opts.repo`. Returns the existing milestone if one is already open;
 * otherwise creates a new one and returns it.
 *
 * @throws Error when the template slug is invalid, when the listing
 *   call fails, or when the create call fails.
 */
export async function ensureIdleTaskMilestone(
  opts: EnsureIdleTaskMilestoneOptions,
): Promise<IdleTaskMilestone> {
  if (!SLUG_PATTERN.test(opts.template)) {
    throw new Error(
      `ensureIdleTaskMilestone: invalid template name "${opts.template}" — ` +
        `must be lowercase alphanumeric with single hyphens, ` +
        `no leading or trailing hyphen`,
    );
  }

  const gh = opts.ghCommandFn ?? runGhCommand;
  const title = buildIdleTaskMilestoneTitle(opts.template);
  const endpoint = `repos/${opts.repo}/milestones`;

  // 1. List open milestones and look for an exact title match.
  let listingRaw: string;
  try {
    listingRaw = await gh([
      "api",
      `${endpoint}?state=open`,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ensureIdleTaskMilestone: failed to list milestones for ` +
        `${opts.repo}: ${msg}`,
    );
  }

  const existing = findMilestoneByTitle(listingRaw, title);
  if (existing !== null) return existing;

  // 2. None found — POST a new milestone.
  let createRaw: string;
  try {
    createRaw = await gh([
      "api",
      "-X",
      "POST",
      endpoint,
      "-f",
      `title=${title}`,
      "-f",
      `description=${buildDescription(opts.template)}`,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ensureIdleTaskMilestone: failed to create milestone "${title}" in ` +
        `${opts.repo}: ${msg}`,
    );
  }

  const created = parseMilestoneResponse(createRaw);
  if (created === null) {
    throw new Error(
      `ensureIdleTaskMilestone: malformed create response for "${title}" ` +
        `in ${opts.repo}`,
    );
  }
  return created;
}

/**
 * Scan the JSON response from the listing endpoint and return the
 * milestone whose title exactly matches `wantTitle`. Returns null when
 * the listing is malformed or no match is found — malformed listings
 * are treated as "no match" so a fresh POST can recover; the create
 * call has its own error handling.
 */
function findMilestoneByTitle(
  raw: string,
  wantTitle: string,
): IdleTaskMilestone | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (r.title !== wantTitle) continue;
    if (typeof r.number !== "number") continue;
    return { number: r.number, title: wantTitle };
  }
  return null;
}

/** Parse the single-object response from the milestone create endpoint. */
function parseMilestoneResponse(raw: string): IdleTaskMilestone | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.number !== "number") return null;
  if (typeof r.title !== "string") return null;
  return { number: r.number, title: r.title };
}
