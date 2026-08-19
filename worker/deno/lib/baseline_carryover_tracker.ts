/**
 * Deduplicated, non-fatal baseline-carryover tracking-issue filer
 * (Issue #2605).
 *
 * Companion to the generic baseline-aware quality-gate bypass (Issue #2604).
 * When an unrelated PR is correctly waved through because every current
 * diffable finding (shellcheck, mermaid, markdownlint, docs) was already
 * present at the baseline, the underlying broken artefact is still broken —
 * it would silently rot until something else trips over it. This filer puts
 * that pre-existing breakage on its OWN line as a `needs-human` tracking
 * issue so a human (or a future worker task) fixes it independently, rather
 * than having it ride or block an unrelated PR.
 *
 * Two invariants keep it well-behaved:
 *
 *   1. **Deduplicated** — at most one open tracker per repo. The filer
 *      searches open issues for the stable title AND a body marker before
 *      filing, mirroring `hasOpenSecurityScanWrapper`.
 *   2. **Non-fatal** — every failure is caught, logged, and swallowed. The
 *      filer must never block the bypass or the PR (mirrors the non-fatal
 *      label-sync pattern).
 *
 * Why `needs-human` (not `idle-task`): the idle-task claim handler routes a
 * claimed issue by title to a registered template; no template fixes an
 * arbitrary quality-gate failure, so an `idle-task` tracker would be
 * unactionable. `needs-human` is the only self-appliable label that lands the
 * issue in the existing human-triage queue (permitted by
 * `WORKER_APPLIABLE_LABEL_LITERALS`).
 *
 * Australian English used throughout (behaviour, organisation, favour, etc.).
 */

import { runGhCommand as defaultGhCommand } from "./github.ts";
import { parseGhJsonArray } from "./idle_task_snapshot.ts";
import type { GenericFinding } from "./baseline_gate.ts";

/** Body marker that, with the stable title, identifies an open tracker. */
export const BASELINE_CARRYOVER_MARKER = "<!-- baseline-carryover-tracker -->";

/** The label that lands the tracker in the human-triage queue. */
const TRACKER_LABEL = "needs-human";

/**
 * Build the stable tracker title for a repo. Stable so the dedup search can
 * match it exactly across runs.
 */
export function buildCarryoverTrackerTitle(repo: string): string {
  return `Pre-existing quality-gate failures: ${repo}`;
}

/** Minimal logger surface — satisfied by the worker `Logger` and by `console`. */
interface TrackerLogger {
  warn: (message: string) => void;
}

/** Injectable dependencies (default to the production `gh` runner + console). */
export interface CarryoverTrackerDeps {
  ghCommand?: (args: string[]) => Promise<string>;
  logger?: TrackerLogger;
}

/**
 * Render the tracker issue body: a short explanation of why the issue exists
 * and what to do, the list of carried-over findings, and the dedup marker.
 *
 * Note: the findings are framed as PRE-EXISTING (present at baseline) — the
 * opposite of `formatCarryoverFindings`, whose "new findings" wording would be
 * misleading here. The per-finding `- [check] display` line format matches it.
 */
export function formatCarryoverTrackerBody(
  repo: string,
  findings: GenericFinding[],
): string {
  const lines: string[] = [
    BASELINE_CARRYOVER_MARKER,
    "",
    `## Pre-existing quality-gate failures in \`${repo}\``,
    "",
    "The worker bypassed a failing quality gate on an unrelated PR because " +
    "every current diffable finding was already present on the baseline " +
    "(Issue #2604). Those pre-existing failures are tracked here on their " +
    "own line so they are fixed independently rather than riding or " +
    "blocking an unrelated change.",
    "",
    "### Carried-over findings",
    "",
    ...(findings.length > 0
      ? findings.map((f) => `- [${f.check}] ${f.display}`)
      : ["- (no structured findings captured)"]),
    "",
    "### What a human should do",
    "",
    "Fix the artefacts above (or open targeted issues for them), then close " +
    "this tracker. While it stays open, the worker will not file a " +
    "duplicate — one open tracker per repo.",
  ];
  return lines.join("\n");
}

/**
 * Return true when an open tracking issue already exists for `repo` — matched
 * by the stable title. Mirrors `hasOpenSecurityScanWrapper`.
 */
async function hasOpenCarryoverTracker(
  repo: string,
  ghCommand: (args: string[]) => Promise<string>,
): Promise<boolean> {
  const title = buildCarryoverTrackerTitle(repo);
  const raw = await ghCommand([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `"${title}" in:title`,
    "--json",
    "number,title",
    "--limit",
    "10",
  ]);
  for (const item of parseGhJsonArray(raw, "find carryover tracker")) {
    if (item === null || typeof item !== "object") continue;
    const itemTitle = (item as { title?: unknown }).title;
    if (typeof itemTitle === "string" && itemTitle.trim() === title) {
      return true;
    }
  }
  return false;
}

/**
 * File a deduplicated `needs-human` tracking issue for the pre-existing
 * quality-gate findings carried over on a bypassed PR (Issue #2605).
 *
 * Deduplicated (skips when an open tracker exists) and non-fatal (any failure
 * is logged and swallowed). Never throws.
 *
 * @param repo - `owner/repo` slug the bypass occurred in.
 * @param findings - The pre-existing carryover findings (`decision.preExisting`).
 * @param deps - Optional injectable `gh` runner and logger.
 */
export async function fileBaselineCarryoverTracker(
  repo: string,
  findings: GenericFinding[],
  deps: CarryoverTrackerDeps = {},
): Promise<void> {
  const ghCommand = deps.ghCommand ?? defaultGhCommand;
  const logger = deps.logger ?? { warn: (m: string) => console.error(m) };

  try {
    if (await hasOpenCarryoverTracker(repo, ghCommand)) {
      // A tracker is already open — do not spam a duplicate.
      return;
    }

    await ghCommand([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      buildCarryoverTrackerTitle(repo),
      "--label",
      TRACKER_LABEL,
      "--body",
      formatCarryoverTrackerBody(repo, findings),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Baseline-carryover tracker filing failed (continuing): ${message}`,
    );
  }
}
