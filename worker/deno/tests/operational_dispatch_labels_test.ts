/**
 * Tests for operational_dispatch_labels.ts (Issue #3083).
 */

import { assertEquals } from "@std/assert";
import {
  operationalDispatchLabels,
  requiresLabelAdderTrust,
} from "../lib/operational_dispatch_labels.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

Deno.test("operationalDispatchLabels - returns the six configured dispatch labels", () => {
  const config = makeConfig({
    refineIssueLabel: "refine-issue",
    grillMeLabel: "grill-me",
    // Issue #4112: `quorum` joined the dispatch set — it runs three top-tier
    // agents, so the label adder must be trusted like planning's.
    quorumLabel: "quorum",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
  });
  assertEquals(operationalDispatchLabels(config), [
    "refine-issue",
    "grill-me",
    "quorum",
    "planning",
    "question",
    "needs-revision",
  ]);
});

Deno.test("requiresLabelAdderTrust - true for each operational dispatch label", () => {
  const config = makeConfig();
  for (
    const label of [
      "refine-issue",
      "grill-me",
      "quorum",
      "planning",
      "question",
      "needs-revision",
    ]
  ) {
    assertEquals(
      requiresLabelAdderTrust(config, label),
      true,
      `expected ${label} to require label-adder trust`,
    );
  }
});

Deno.test("requiresLabelAdderTrust - false for a non-operational label", () => {
  const config = makeConfig();
  assertEquals(requiresLabelAdderTrust(config, "work-on"), false);
  assertEquals(requiresLabelAdderTrust(config, "bug"), false);
  assertEquals(requiresLabelAdderTrust(config, "enhancement"), false);
});

Deno.test("requiresLabelAdderTrust - is case-insensitive", () => {
  const config = makeConfig({ planningLabel: "planning" });
  assertEquals(requiresLabelAdderTrust(config, "PLANNING"), true);
  assertEquals(requiresLabelAdderTrust(config, "Planning"), true);
});

Deno.test("requiresLabelAdderTrust - honours custom configured label names", () => {
  const config = makeConfig({ planningLabel: "needs-plan" });
  // The custom name now requires trust …
  assertEquals(requiresLabelAdderTrust(config, "needs-plan"), true);
  // … and the default name no longer matches.
  assertEquals(requiresLabelAdderTrust(config, "planning"), false);
});
