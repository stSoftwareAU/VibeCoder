/**
 * Tests for workflow_labels.ts (Issue #1711).
 *
 * Uses Australian English throughout.
 */
import { assertEquals } from "@std/assert";
import {
  filterOutWorkflowLabels,
  isWorkflowLabel,
  WORKFLOW_LABEL_NAMES,
} from "../lib/workflow_labels.ts";

Deno.test("workflow_labels - workflow category labels are recognised", () => {
  for (
    const name of [
      "work-on",
      "planning",
      "question",
      "failed",
      "failed-once",
      "needs-revision",
      "needs-human",
      "top-priority",
      "refine-issue",
      "grill-me",
      "documentation",
    ]
  ) {
    assertEquals(
      isWorkflowLabel(name),
      true,
      `'${name}' must be a workflow label`,
    );
  }
});

Deno.test("workflow_labels - deprecated handoff labels are still recognised (Issues #2030, #2031)", () => {
  // Issue #2030 retired `answered`; Issue #2031 retired `needs-clarification`.
  // Both stay in the workflow-label set so any stale label on an older repo
  // is still stripped before issue labels are copied onto a PR.
  assertEquals(isWorkflowLabel("answered"), true);
  assertEquals(isWorkflowLabel("needs-clarification"), true);
});

Deno.test("workflow_labels - deprecated discovery labels are still recognised (Issue #2022)", () => {
  // Issue #2022 retired `help wanted` and `claude` from LABEL_DEFINITIONS,
  // but they remain in the workflow-label set so any stale label on an
  // older repo is still stripped before issue labels are copied onto a PR.
  assertEquals(isWorkflowLabel("help wanted"), true);
  assertEquals(isWorkflowLabel("claude"), true);
});

Deno.test("workflow_labels - ui category labels are recognised", () => {
  assertEquals(
    isWorkflowLabel("needs-screenshot"),
    true,
    "'needs-screenshot' is worker-managed and should not propagate to PRs",
  );
});

Deno.test("workflow_labels - non-workflow labels are not flagged", () => {
  for (
    const name of [
      "bug",
      "enhancement",
      "priority-high",
      "security",
      "performance",
    ]
  ) {
    assertEquals(
      isWorkflowLabel(name),
      false,
      `'${name}' must not be a workflow label`,
    );
  }
});

Deno.test("workflow_labels - filterOutWorkflowLabels keeps content labels and order", () => {
  const labels = ["bug", "work-on", "performance", "planning", "security"];
  const filtered = filterOutWorkflowLabels(labels);
  assertEquals(filtered, ["bug", "performance", "security"]);
});

Deno.test("workflow_labels - filterOutWorkflowLabels returns empty when all workflow", () => {
  const filtered = filterOutWorkflowLabels([
    "work-on",
    "help wanted",
    "planning",
  ]);
  assertEquals(filtered, []);
});

Deno.test("workflow_labels - filterOutWorkflowLabels handles empty input", () => {
  assertEquals(filterOutWorkflowLabels([]), []);
});

Deno.test("workflow_labels - WORKFLOW_LABEL_NAMES exposes a frozen-style read-only set", () => {
  // Sanity check: should contain at least the expected core workflow labels.
  assertEquals(WORKFLOW_LABEL_NAMES.has("work-on"), true);
  assertEquals(WORKFLOW_LABEL_NAMES.has("help wanted"), true);
  assertEquals(WORKFLOW_LABEL_NAMES.has("bug"), false);
});
