/**
 * Tests for planning_degraded_label.ts (Issue #2650).
 *
 * Verifies that the `degraded-model` label is:
 *   - applied to the parent issue and every sub-issue exactly once;
 *   - never stripped (absent from RESERVED_LABELS) and passes the worker guard;
 *   - non-fatal — create/apply failures are logged and never thrown.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { Logger } from "../types.ts";
import {
  applyDegradedModelLabel,
  DEGRADED_MODEL_LABEL,
} from "../lib/planning_degraded_label.ts";
import { RESERVED_LABELS } from "../lib/config_defaults.ts";
import { isWorkerAppliableLabel } from "../lib/worker_label_guard.ts";
import { getLabelByName } from "../setup/label_definitions.ts";

/** A logger that records warn calls for assertions. */
function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  const logger: Logger = {
    info: noop,
    warn: (msg: string) => warnings.push(msg),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, warnings };
}

/**
 * A fake gh runner that records `issue_number`/`labels[]` of each add-label
 * call and the label-create call, succeeding by default.
 */
function fakeGh(opts: { failAdd?: boolean; failCreate?: boolean } = {}) {
  const addLabelCalls: Array<{ issue: number; label: string }> = [];
  let createCalls = 0;
  const ghCommandFn = (args: string[]): Promise<string> => {
    // Label creation: api -X POST repos/{repo}/labels -f name=...
    if (
      args.some((a) => a.endsWith("/labels")) &&
      args.some((a) => a.startsWith("name="))
    ) {
      createCalls++;
      if (opts.failCreate) return Promise.reject(new Error("create failed"));
      return Promise.resolve("");
    }
    // gh label create (CLI fallback)
    if (args[0] === "label" && args[1] === "create") {
      createCalls++;
      if (opts.failCreate) return Promise.reject(new Error("create failed"));
      return Promise.resolve("");
    }
    // Cache fetch (gh label list / api repos/{repo}/labels GET) — return empty.
    if (args[0] === "label" && args[1] === "list") {
      return Promise.resolve("[]");
    }
    // Add-label: api -X POST repos/{repo}/issues/{n}/labels -f labels[]=...
    const labelArg = args.find((a) => a.startsWith("labels[]="));
    if (labelArg) {
      const idx = args.findIndex((a) => /\/issues\/\d+\/labels$/.test(a));
      const issue = idx >= 0
        ? parseInt(args[idx]!.match(/\/issues\/(\d+)\/labels$/)![1]!, 10)
        : -1;
      if (opts.failAdd) return Promise.reject(new Error("add failed"));
      addLabelCalls.push({ issue, label: labelArg.replace("labels[]=", "") });
      return Promise.resolve("");
    }
    // gh issue edit --add-label (CLI fallback)
    if (args[0] === "issue" && args[1] === "edit") {
      const issue = parseInt(args[2]!, 10);
      const li = args.findIndex((a) => a === "--add-label");
      const label = li >= 0 ? args[li + 1]! : "";
      if (opts.failAdd) return Promise.reject(new Error("add failed"));
      addLabelCalls.push({ issue, label });
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { ghCommandFn, addLabelCalls, getCreateCalls: () => createCalls };
}

Deno.test("degraded-model - label is not reserved", () => {
  assert(
    !RESERVED_LABELS.includes(DEGRADED_MODEL_LABEL),
    "degraded-model must not be a reserved label",
  );
});

Deno.test("degraded-model - passes the worker label guard", () => {
  assert(
    isWorkerAppliableLabel(DEGRADED_MODEL_LABEL),
    "degraded-model must be worker-appliable",
  );
});

Deno.test("degraded-model - best-model remains reserved (cannot be reused)", () => {
  // The issue notes best-model is reserved; degraded-model is its
  // non-reserved replacement and must not collide with it.
  assert(!isWorkerAppliableLabel("best-model"));
  assertEquals(DEGRADED_MODEL_LABEL, "degraded-model");
});

Deno.test("degraded-model - exists in LABEL_DEFINITIONS", () => {
  const def = getLabelByName(DEGRADED_MODEL_LABEL);
  assert(def, "degraded-model must be defined in LABEL_DEFINITIONS");
  assertEquals(def!.category, "workflow");
});

Deno.test("applyDegradedModelLabel - labels parent + each sub-issue exactly once", async () => {
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { logger } = recordingLogger();

  await applyDegradedModelLabel({
    repo: "owner/repo",
    parentIssueNumber: 100,
    subIssueNumbers: [101, 102, 103],
    ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  // Parent + 3 sub-issues = 4 add-label calls, each exactly once.
  assertEquals(addLabelCalls.length, 4);
  const issues = addLabelCalls.map((c) => c.issue).sort((a, b) => a - b);
  assertEquals(issues, [100, 101, 102, 103]);
  for (const call of addLabelCalls) {
    assertEquals(call.label, DEGRADED_MODEL_LABEL);
  }
});

Deno.test("applyDegradedModelLabel - de-duplicates parent that is also a sub-issue", async () => {
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { logger } = recordingLogger();

  await applyDegradedModelLabel({
    repo: "owner/repo",
    parentIssueNumber: 100,
    subIssueNumbers: [100, 101],
    ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  const issues = addLabelCalls.map((c) => c.issue).sort((a, b) => a - b);
  assertEquals(issues, [100, 101]);
});

Deno.test("applyDegradedModelLabel - no sub-issues still labels the parent", async () => {
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { logger } = recordingLogger();

  await applyDegradedModelLabel({
    repo: "owner/repo",
    parentIssueNumber: 42,
    subIssueNumbers: [],
    ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  assertEquals(addLabelCalls.length, 1);
  assertEquals(addLabelCalls[0]!.issue, 42);
});

Deno.test("applyDegradedModelLabel - add-label failure is logged, not thrown", async () => {
  const { ghCommandFn } = fakeGh({ failAdd: true });
  const { logger, warnings } = recordingLogger();

  // Must not throw.
  await applyDegradedModelLabel({
    repo: "owner/repo",
    parentIssueNumber: 7,
    subIssueNumbers: [8],
    ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  // One warning per failed add (parent + 1 sub-issue).
  const addWarnings = warnings.filter((w) =>
    w.includes("Failed to apply degraded-model label")
  );
  assertEquals(addWarnings.length, 2);
});

Deno.test("applyDegradedModelLabel - create failure is logged, not thrown", async () => {
  const { ghCommandFn } = fakeGh({ failCreate: true });
  const { logger, warnings } = recordingLogger();

  await applyDegradedModelLabel({
    repo: "owner/repo",
    parentIssueNumber: 7,
    subIssueNumbers: [],
    ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  assert(
    warnings.some((w) =>
      w.includes("Failed to ensure degraded-model label exists")
    ),
    "expected a non-fatal create-failure warning",
  );
});
