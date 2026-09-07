/**
 * Tests for setup/label_definitions.ts
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  DEPRECATED_LABELS,
  getAllLabels,
  getApplicableLabels,
  getLabelByName,
  getLabelCount,
  getLabelsByCategory,
  isProtectedStockLabel,
  LABEL_DEFINITIONS,
  PROTECTED_STOCK_LABELS,
  repoHasUi,
} from "../setup/label_definitions.ts";

// ── LABEL_DEFINITIONS structure ─────────────────────────────────────────

Deno.test("LABEL_DEFINITIONS - contains expected number of labels", () => {
  // 17 workflow + 1 UI = 18 total.
  // History:
  //   - Issue #1616 added grill-me.
  //   - Issue #1748 added claude, help wanted, low-priority.
  //   - Issue #1961 added idle-task.
  //   - Issue #2022 retired claude and help wanted.
  //   - Issue #2031 retired needs-clarification.
  //   - Issue #2030 retired answered.
  //   - Issue #2029 retired refined.
  //   - Issue #2055 added idle-task-pending.
  //   - Issue #2077 retired idle-task-pending.
  //   - Issue #2650 added degraded-model.
  //   - Issue #2904 added orphan-deps.
  //   - Issue #4112 added quorum.
  //   - Issue #59 added needs-failure-detection-repair.
  assertEquals(LABEL_DEFINITIONS.length, 18);
});

Deno.test("LABEL_DEFINITIONS - every label has required fields", () => {
  for (const label of LABEL_DEFINITIONS) {
    assertNotEquals(label.name, "");
    assertNotEquals(label.colour, "");
    assertNotEquals(label.description, "");
    assertEquals(
      label.category === "workflow" || label.category === "ui",
      true,
      `Invalid category: ${label.category}`,
    );
  }
});

Deno.test("LABEL_DEFINITIONS - colour codes are valid 6-char hex", () => {
  const hexRegex = /^[0-9a-f]{6}$/;
  for (const label of LABEL_DEFINITIONS) {
    assertEquals(
      hexRegex.test(label.colour),
      true,
      `Invalid colour for ${label.name}: ${label.colour}`,
    );
  }
});

Deno.test("LABEL_DEFINITIONS - no duplicate names", () => {
  const names = LABEL_DEFINITIONS.map((l) => l.name);
  const uniqueNames = new Set(names);
  assertEquals(names.length, uniqueNames.size);
});

// ── Known labels from the original shell script ─────────────────────────

Deno.test("LABEL_DEFINITIONS - contains all workflow labels from shell script", () => {
  // Issue #2031: needs-clarification retired — see DEPRECATED_LABELS.
  // Issue #2030: answered retired — see DEPRECATED_LABELS.
  // Issue #2029: refined retired — see DEPRECATED_LABELS.
  const expectedWorkflow = [
    "failed",
    "failed-once",
    "refine-issue",
    "planning",
    "question",
    "work-on",
    "documentation",
    "needs-revision",
    "needs-human",
    "top-priority",
  ];
  const names = LABEL_DEFINITIONS.map((l) => l.name);
  for (const name of expectedWorkflow) {
    assertEquals(names.includes(name), true, `Missing workflow label: ${name}`);
  }
});

Deno.test("LABEL_DEFINITIONS - no longer defines refined (Issue #2029)", () => {
  // Issue #2029: `refined` retired — refinement workflow now signals
  // completion via `needs-human`. The label moves to DEPRECATED_LABELS so
  // existing repos get it removed on the next setup run.
  assertEquals(getLabelByName("refined"), undefined);
});

Deno.test("LABEL_DEFINITIONS - no longer defines needs-clarification (Issue #2031)", () => {
  // Issue #2031: needs-clarification was consolidated onto needs-human and
  // moved to DEPRECATED_LABELS so existing repos get it removed on the
  // next setup run.
  assertEquals(getLabelByName("needs-clarification"), undefined);
});

Deno.test("LABEL_DEFINITIONS - no longer defines answered (Issue #2030)", () => {
  // Issue #2030: `answered` retired — question workflow signals handoff
  // with `needs-human`. The label moves to DEPRECATED_LABELS so existing
  // repos get it removed on the next setup run.
  assertEquals(getLabelByName("answered"), undefined);
});

Deno.test("LABEL_DEFINITIONS - no longer defines claude discovery label (Issue #2022)", () => {
  // The legacy `claude` discovery label was retired in Issue #2022.
  // It must no longer appear in LABEL_DEFINITIONS — repos that still
  // carry it will keep the label as a plain GitHub label, but the
  // worker no longer treats it as a pickup signal.
  assertEquals(getLabelByName("claude"), undefined);
});

Deno.test("LABEL_DEFINITIONS - no longer defines help wanted discovery label (Issue #2022)", () => {
  // The legacy `help wanted` discovery label was retired in Issue #2022.
  assertEquals(getLabelByName("help wanted"), undefined);
});

Deno.test("LABEL_DEFINITIONS - contains low-priority workflow label (Issue #1748)", () => {
  const label = getLabelByName("low-priority");
  assertNotEquals(label, undefined);
  assertEquals(label!.category, "workflow");
  assertEquals(label!.colour, "c2e0c6");
  assertEquals(
    label!.description,
    "Backlog work — picked up only when no other eligible work exists",
  );
});

Deno.test("LABEL_DEFINITIONS - contains grill-me workflow label (Issue #1616)", () => {
  const label = getLabelByName("grill-me");
  assertNotEquals(label, undefined);
  assertEquals(label!.category, "workflow");
  assertEquals(label!.colour, "fbca04");
  assertEquals(
    label!.description,
    "Issue being grilled — interactive back-and-forth scoping before planning",
  );
});

Deno.test("LABEL_DEFINITIONS - contains needs-human workflow label (Issue #1469)", () => {
  const label = getLabelByName("needs-human");
  assertNotEquals(label, undefined);
  assertEquals(label!.category, "workflow");
  assertEquals(label!.colour, "fbca04");
  assertEquals(
    label!.description,
    "Worker has escalated this issue to a human",
  );
});

Deno.test("LABEL_DEFINITIONS - contains top-priority workflow label (Issue #1622)", () => {
  const label = getLabelByName("top-priority");
  assertNotEquals(label, undefined);
  assertEquals(label!.category, "workflow");
  assertEquals(label!.colour, "b60205");
  assertEquals(
    label!.description,
    "Highest-priority issue — pick this up before other work",
  );
});

Deno.test("LABEL_DEFINITIONS - contains needs-screenshot UI label", () => {
  const uiLabels = getLabelsByCategory("ui");
  assertEquals(uiLabels.length, 1);
  assertEquals(uiLabels[0]!.name, "needs-screenshot");
});

// ── DEPRECATED_LABELS ───────────────────────────────────────────────────

Deno.test("DEPRECATED_LABELS - contains expected deprecated labels", () => {
  assertEquals(DEPRECATED_LABELS.includes("best-model"), true);
  assertEquals(DEPRECATED_LABELS.includes("skip-clarification"), true);
  // Issue #2031: needs-clarification consolidated onto needs-human.
  assertEquals(DEPRECATED_LABELS.includes("needs-clarification"), true);
  // Issue #2030: answered retired — needs-human signals question handoff.
  assertEquals(DEPRECATED_LABELS.includes("answered"), true);
  // Issue #2022 retired the discovery/watch labels.
  assertEquals(DEPRECATED_LABELS.includes("claude"), true);
  // Issue #2029: refined retired — refinement signals completion via needs-human.
  assertEquals(DEPRECATED_LABELS.includes("refined"), true);
  // Issue #2077: idle-task-pending retired — approval gate added no value.
  assertEquals(DEPRECATED_LABELS.includes("idle-task-pending"), true);
});

Deno.test(
  "DEPRECATED_LABELS - excludes GitHub's stock labels (Issue #1295)",
  () => {
    // `good first issue` and `help wanted` ship with every GitHub repo and
    // are used by human maintainers for their own triage. The fleet never
    // created them, so the sync must never delete them — deletion is
    // irreversible and takes the label's issue associations with it.
    for (const stock of PROTECTED_STOCK_LABELS) {
      assertEquals(DEPRECATED_LABELS.includes(stock), false);
    }
    assertEquals(PROTECTED_STOCK_LABELS.includes("good first issue"), true);
    assertEquals(PROTECTED_STOCK_LABELS.includes("help wanted"), true);
  },
);

Deno.test("isProtectedStockLabel - matches stock labels case-insensitively", () => {
  assertEquals(isProtectedStockLabel("Good First Issue"), true);
  assertEquals(isProtectedStockLabel("  help wanted "), true);
  assertEquals(isProtectedStockLabel("best-model"), false);
  assertEquals(isProtectedStockLabel(""), false);
});

Deno.test(
  "LABEL_DEFINITIONS - no longer defines idle-task-pending (Issue #2077)",
  () => {
    // Issue #2077: `idle-task-pending` retired — `idle-task` is already
    // the lowest priority in the queue, so a separate approval gate
    // added no value. The label moves to DEPRECATED_LABELS so existing
    // repos get it removed on the next setup run.
    assertEquals(getLabelByName("idle-task-pending"), undefined);
  },
);

// ── getLabelCount ───────────────────────────────────────────────────────

Deno.test("getLabelCount - returns correct count", () => {
  // Issue #59 added needs-failure-detection-repair — 18 total.
  assertEquals(getLabelCount(), 18);
});

// ── getAllLabels ─────────────────────────────────────────────────────────

Deno.test("getAllLabels - returns all labels", () => {
  // Issue #59 added needs-failure-detection-repair — 18 total.
  assertEquals(getAllLabels().length, 18);
});

// ── getLabelsByCategory ─────────────────────────────────────────────────

Deno.test("getLabelsByCategory - workflow returns 17 labels", () => {
  // Issue #59 added needs-failure-detection-repair — 17 workflow labels.
  assertEquals(getLabelsByCategory("workflow").length, 17);
});

Deno.test("getLabelsByCategory - ui returns 1 label", () => {
  assertEquals(getLabelsByCategory("ui").length, 1);
});

// ── getLabelByName ──────────────────────────────────────────────────────

Deno.test("getLabelByName - finds existing label", () => {
  const label = getLabelByName("work-on");
  assertNotEquals(label, undefined);
  assertEquals(label!.colour, "5319e7");
});

Deno.test("getLabelByName - returns undefined for non-existent label", () => {
  assertEquals(getLabelByName("nonexistent"), undefined);
});

// ── repoHasUi ───────────────────────────────────────────────────────────

Deno.test("repoHasUi - returns true for repos with JavaScript", () => {
  assertEquals(repoHasUi({ JavaScript: 5000, Go: 3000 }), true);
});

Deno.test("repoHasUi - returns true for repos with TypeScript", () => {
  assertEquals(repoHasUi({ TypeScript: 5000 }), true);
});

Deno.test("repoHasUi - returns true for repos with HTML", () => {
  assertEquals(repoHasUi({ HTML: 1000, Python: 5000 }), true);
});

Deno.test("repoHasUi - returns false for backend-only repos", () => {
  assertEquals(repoHasUi({ Go: 5000, Shell: 2000 }), false);
});

Deno.test("repoHasUi - returns false for empty languages", () => {
  assertEquals(repoHasUi({}), false);
});

// ── getApplicableLabels ─────────────────────────────────────────────────

Deno.test("getApplicableLabels - returns all labels for UI repos", () => {
  // Issue #59 added needs-failure-detection-repair — 18 total.
  assertEquals(getApplicableLabels(true).length, 18);
});

Deno.test("getApplicableLabels - excludes UI labels for non-UI repos", () => {
  // Issue #59 added needs-failure-detection-repair — 17 workflow labels.
  const labels = getApplicableLabels(false);
  assertEquals(labels.length, 17);
  assertEquals(labels.some((l) => l.category === "ui"), false);
});
