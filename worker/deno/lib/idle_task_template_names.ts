/**
 * Canonical idle-task template names (Issue #4011).
 *
 * `idle_task_backfill.ts` already derives the same set from its wrapper-title
 * map, but that module pulls in the whole `gh` stack — far too heavy for config
 * load, where a cycle through `config_defaults.ts` breaks module initialisation.
 * This module is therefore deliberately **import-free**: anything that only
 * needs to know "is this a real template name?" — such as the `.config.json`
 * cadence parser — depends on this instead.
 *
 * `tests/idle_task_template_names_test.ts` pins this list against
 * `IDLE_TASK_WRAPPER_TEMPLATE_NAMES`, so the two cannot drift apart: adding a
 * template without extending this set fails that test.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/** Every registered idle-task template name, in registration order. */
export const IDLE_TASK_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  "security-scan",
  "test-audit",
  "best-practices",
  "github-actions-audit",
  "supply-chain-readiness",
  "orphan-deps",
  "dead-code",
  "doc-coverage",
  "format-drift",
  "deprecated-api",
  "bash-script-refs",
  "bash-syntax-audit",
  "documentation-audit",
  "alert-feed",
  "workflow-annotation-scan",
  "private-repo-reference-audit",
  "duplicated-knowledge",
  "retro",
]);
