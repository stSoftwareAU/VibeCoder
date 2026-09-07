/**
 * Canonical label definitions for all monitored repositories.
 *
 * Single source of truth for label names, colours, and descriptions.
 * Labels are organised into categories:
 *   - workflow: Core workflow labels used by the worker (apply to all repos)
 *   - ui: Labels related to UI/screenshot evidence (only for repos with UI)
 *   - content: Classification/finding labels the fleet applies but does
 *     not seed onto every repo (Issue #368). Defined in
 *     `content_label_definitions.ts` and joined here into
 *     {@link ALL_LABEL_DEFINITIONS}, which is the canonical colour table
 *     {@link getLabelColour} resolves against.
 *
 * Issue #864: Standardise labels across repos we monitor.
 * Issue #923: Migrate to Deno TypeScript.
 * Issue #1748: Add the discovery/watch labels (claude, help wanted) and the
 *   low-priority backlog label so their colours and descriptions are
 *   standardised by the same sync pass as the rest of the workflow labels.
 * Issue #2022: Retire the `claude` and `help wanted` discovery/watch labels.
 *   The hardwired priority order is now
 *   `top-priority` > `work-on` > `low-priority` > `idle-task`. `idle-task`
 *   is the only label the Vibe Coder may self-apply.
 * Issue #2029: Retire the `refined` completion label. The refinement
 *   workflow now signals handoff by adding `needs-human` (the existing
 *   worker-to-human escalation label).
 * Issue #368: Add the `content` category so every fleet-managed label —
 *   `severity:*`, `confidence:*`, `security`, `lang:*`, the per-scan
 *   category labels — has one canonical colour instead of nine call sites
 *   each hard-coding their own literal.
 */

import { CONTENT_LABEL_DEFINITIONS } from "./content_label_definitions.ts";

export { CONTENT_LABEL_DEFINITIONS };

/** Category for a label definition. */
export type LabelCategory = "workflow" | "ui" | "content";

/** A single label definition. */
export interface LabelDefinition {
  /** Label name as shown on GitHub. */
  name: string;
  /** Hex colour code without # prefix. */
  colour: string;
  /** Human-readable description. */
  description: string;
  /** Category determines which repos receive this label. */
  category: LabelCategory;
}

/**
 * All canonical label definitions.
 * Order matches the original shell script for consistency.
 */
export const LABEL_DEFINITIONS: readonly LabelDefinition[] = [
  // Workflow labels — apply to all repos
  {
    name: "failed",
    colour: "d73a4a",
    description: "Issue failed permanently after two attempts",
    category: "workflow",
  },
  {
    name: "failed-once",
    colour: "fbca04",
    description: "Issue failed once - will be retried",
    category: "workflow",
  },
  // Issue #2031: needs-clarification retired — see DEPRECATED_LABELS below.
  {
    name: "refine-issue",
    colour: "0366d6",
    description: "Issue being refined collaboratively before implementation",
    category: "workflow",
  },
  {
    name: "planning",
    colour: "1d76db",
    description:
      "Issue in planning mode - creating sub-issues and task breakdown",
    category: "workflow",
  },
  {
    name: "question",
    colour: "cc317c",
    description: "Issue has a question to be answered",
    category: "workflow",
  },
  // Issue #2030: `answered` retired — question workflow now signals handoff
  // with `needs-human`. See DEPRECATED_LABELS below.
  {
    name: "work-on",
    colour: "5319e7",
    description: "Signal to work on this issue",
    category: "workflow",
  },
  {
    name: "documentation",
    colour: "0075ca",
    description: "Documentation only change",
    category: "workflow",
  },
  {
    name: "needs-revision",
    colour: "e99695",
    description: "Issue needs revision based on review",
    category: "workflow",
  },
  {
    name: "needs-human",
    colour: "fbca04",
    description: "Worker has escalated this issue to a human",
    category: "workflow",
  },
  {
    name: "grill-me",
    colour: "fbca04",
    description:
      "Issue being grilled — interactive back-and-forth scoping before planning",
    category: "workflow",
  },
  // Issue #4112: quorum — a human applies it to run a three-agent plan-off
  // ahead of planning. Reserved: the worker never self-applies it.
  {
    name: "quorum",
    colour: "5319e7",
    description:
      "Apply by hand to run a Quorum plan-off — two agents draft a plan, a third judges, ahead of planning",
    category: "workflow",
  },
  {
    name: "top-priority",
    colour: "b60205",
    description: "Highest-priority issue — pick this up before other work",
    category: "workflow",
  },
  {
    name: "low-priority",
    colour: "c2e0c6",
    description:
      "Backlog work — picked up only when no other eligible work exists",
    category: "workflow",
  },
  // Idle-task label — worker-filed busywork. Lowest priority in the queue (Issue #1961).
  {
    name: "idle-task",
    colour: "cccccc",
    description:
      "Worker-filed task to run when no claimable work exists. Lowest priority.",
    category: "workflow",
  },
  // Issue #2077: `idle-task-pending` retired — `idle-task` is already
  // the lowest priority in the queue, so the separate approval gate
  // added no value. See DEPRECATED_LABELS below.
  // Issue #2650: degraded-model — worker-appliable (non-reserved) signal that a
  // planning run was served by a model other than the configured planning model.
  // `best-model` is reserved and cannot carry this signal — this is its
  // non-reserved replacement. Humans clear it after investigating.
  {
    name: "degraded-model",
    colour: "e99695",
    description:
      "Generated by a model other than the configured planning model",
    category: "workflow",
  },
  // Issue #59 (part of #54): needs-failure-detection-repair — the planning run
  // published a usable plan, but one or more sub-issues still lack a filled
  // `## Failure Detection` section after the self-repair. Reserved (the planner
  // may never self-apply it) and raised only by the worker.
  {
    name: "needs-failure-detection-repair",
    colour: "d4c5f9",
    description:
      "Published sub-issues still need their `## Failure Detection` criterion",
    category: "workflow",
  },
  // Issue #2904: orphan-deps — label carried by orphan-dependency idle-task
  // findings (the sixth idle-task template). Seeded on monitored repos so
  // onboarding / label-sync create it ahead of the first scan.
  {
    name: "orphan-deps",
    colour: "0e8a16",
    description:
      "Orphan / unmaintained dependency finding from the orphan-deps idle-task scan",
    category: "workflow",
  },
  // UI labels — only for repos with UI/screenshot capability
  {
    name: "needs-screenshot",
    colour: "d93f0b",
    description: "Previous attempt was blocked for missing screenshot evidence",
    category: "ui",
  },
] as const;

/**
 * The canonical colour table for **every** label the fleet manages
 * (Issue #368).
 *
 * {@link LABEL_DEFINITIONS} carries the workflow/UI labels seeded onto
 * every monitored repo at onboarding; {@link CONTENT_LABEL_DEFINITIONS}
 * carries the classification/finding labels that appear only once a scan
 * files something. Both halves are colour-authoritative, so lookups —
 * `ensureLabelExists`, and the colour reconcile pass — resolve against
 * this union rather than against either half.
 */
export const ALL_LABEL_DEFINITIONS: readonly LabelDefinition[] = [
  ...LABEL_DEFINITIONS,
  ...CONTENT_LABEL_DEFINITIONS,
];

/**
 * Colour used for a label the canonical table does not name.
 *
 * GitHub's own "bug" red. A label that lands here is not fleet-managed —
 * the reconcile pass ignores it, and only a create-if-missing call ever
 * paints it.
 */
export const DEFAULT_LABEL_COLOUR = "d73a4a";

/**
 * Labels that have been deprecated and should be removed from repos.
 * Add entries here when retiring a label.
 *
 * Only labels the fleet itself created belong here. GitHub's stock labels
 * are listed in {@link PROTECTED_STOCK_LABELS} and are never deleted
 * (Issue #1295).
 */
export const DEPRECATED_LABELS: readonly string[] = [
  "best-model", // Removed: opus is always used, label had no effect
  "skip-clarification", // Removed: redundant — documentation label provides identical bypass (Issue #1155)
  "needs-clarification", // Removed: handoff signal consolidated onto `needs-human` (Issue #2031)
  "answered", // Removed: question workflow signals handoff with `needs-human` (Issue #2030)
  "claude", // Removed: replaced by hardwired top-priority/work-on/low-priority/idle-task tiers (Issue #2022)
  "refined", // Removed: refinement workflow now signals completion via needs-human (Issue #2029)
  "idle-task-pending", // Removed: approval gate retired — `idle-task` is already lowest priority (Issue #2077)
] as const;

/**
 * GitHub's own stock labels, which ship with every new repository (Issue #1295).
 *
 * The worker never created them and human maintainers commonly use them for
 * their own triage, so the deprecated-label pass never deletes them —
 * deletion is irreversible and takes the label's attachment to every issue
 * with it. The worker stopped *reading* `help wanted` as a discovery label in
 * Issue #2022, which is a reason to ignore it, not a licence to delete a
 * maintainer's label.
 *
 * The guard is enforced in code (`removeDeprecatedLabels`), so re-adding one
 * of these names to {@link DEPRECATED_LABELS} by mistake still deletes
 * nothing.
 */
export const PROTECTED_STOCK_LABELS: readonly string[] = [
  "good first issue",
  "help wanted",
] as const;

/** True when `name` is one of GitHub's stock labels the fleet must not delete. */
export function isProtectedStockLabel(name: string): boolean {
  const normalised = name.trim().toLowerCase();
  return PROTECTED_STOCK_LABELS.includes(normalised);
}

/**
 * UI languages used to detect repos with frontend components.
 */
const UI_LANGUAGES = [
  "JavaScript",
  "TypeScript",
  "HTML",
  "CSS",
  "Vue",
  "Svelte",
] as const;

/** Get all label definitions. */
export function getAllLabels(): readonly LabelDefinition[] {
  return LABEL_DEFINITIONS;
}

/** Get labels for a specific category. */
export function getLabelsByCategory(
  category: LabelCategory,
): LabelDefinition[] {
  return LABEL_DEFINITIONS.filter((l) => l.category === category);
}

/**
 * Get a label definition by name from the canonical table
 * (returns undefined if the fleet does not manage that label).
 *
 * Matching is case-insensitive because GitHub treats label names that way
 * — `SEVERITY:HIGH` and `severity:high` are the same label, and the
 * reconcile pass must recognise either spelling (Issue #368).
 */
export function getLabelByName(name: string): LabelDefinition | undefined {
  const lower = name.toLowerCase();
  return ALL_LABEL_DEFINITIONS.find((l) => l.name.toLowerCase() === lower);
}

/**
 * Canonical colour for a label name (Issue #368).
 *
 * Returns {@link DEFAULT_LABEL_COLOUR} for a label the table does not
 * name, so a create-if-missing call always has a colour to use.
 */
export function getLabelColour(name: string): string {
  return getLabelByName(name)?.colour ?? DEFAULT_LABEL_COLOUR;
}

/**
 * Canonical description for a label name (Issue #368).
 *
 * Empty string when the table does not name the label — callers pass it
 * straight through to `gh label create`, which omits an empty description.
 */
export function getLabelDescription(name: string): string {
  return getLabelByName(name)?.description ?? "";
}

/** Get the number of defined labels. */
export function getLabelCount(): number {
  return LABEL_DEFINITIONS.length;
}

/**
 * Check if a repository has UI components based on its languages.
 *
 * @param languages - Object mapping language names to byte counts (from GitHub API)
 * @returns true if the repo has any UI-related languages
 */
export function repoHasUi(languages: Record<string, number>): boolean {
  return UI_LANGUAGES.some((lang) => lang in languages);
}

/**
 * Get the labels applicable to a given repo.
 *
 * @param hasUi - Whether the repo has UI components
 * @returns Array of applicable label definitions
 */
export function getApplicableLabels(hasUi: boolean): LabelDefinition[] {
  if (hasUi) {
    return [...LABEL_DEFINITIONS];
  }
  return LABEL_DEFINITIONS.filter((l) => l.category !== "ui");
}
