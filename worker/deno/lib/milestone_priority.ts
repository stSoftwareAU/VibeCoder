/**
 * Milestone priority ordering via priority labels (Issue #1237).
 *
 * Allows users to control the order in which milestone issues are
 * processed by applying priority labels (priority-high, priority-low).
 * Issues without priority labels default to normal priority.
 *
 * Priority only affects ordering within the same milestone —
 * cross-milestone and cross-repo selection remains globally oldest-first.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Recognised priority label names.
 *
 * Users apply these labels to milestone issues to influence processing order.
 * Higher priority issues are selected before lower priority ones within
 * the same milestone.
 */
export const MILESTONE_PRIORITY_LABELS = {
  high: "priority-high",
  low: "priority-low",
} as const;

/**
 * Numeric priority values — lower number means higher priority.
 *
 * Consistent with labelIndex ordering (lower = picked first).
 */
export const MILESTONE_PRIORITY_VALUES = {
  high: 1,
  normal: 2,
  low: 3,
} as const;

/**
 * Extract milestone priority from an issue's labels.
 *
 * Checks for priority labels and returns the corresponding numeric value.
 * When both high and low are present, high takes precedence.
 * Returns normal priority when no priority label is found.
 *
 * @param labels - Array of label names on the issue
 * @returns Numeric priority value (lower = higher priority)
 */
export function extractMilestonePriority(labels: string[]): number {
  if (labels.includes(MILESTONE_PRIORITY_LABELS.high)) {
    return MILESTONE_PRIORITY_VALUES.high;
  }
  if (labels.includes(MILESTONE_PRIORITY_LABELS.low)) {
    return MILESTONE_PRIORITY_VALUES.low;
  }
  return MILESTONE_PRIORITY_VALUES.normal;
}
