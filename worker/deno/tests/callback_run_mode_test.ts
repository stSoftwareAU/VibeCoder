/**
 * Which workflow label a run served, for the callback context's `mode`
 * (Issue #2100, part of #2060).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { resolveCallbackRunMode } from "../lib/callback_run_mode.ts";

/** The configured label names a stock fleet dispatches on. */
const LABELS = {
  workOnLabel: "work-on",
  refineIssueLabel: "refine-issue",
  grillMeLabel: "grill-me",
  quorumLabel: "quorum",
  planningLabel: "planning",
  questionLabel: "question",
} as const;

Deno.test("callback_run_mode - an implementation run reports the work-on label", () => {
  assertEquals(
    resolveCallbackRunMode(["work-on", "enhancement"], LABELS),
    "work-on",
  );
});

Deno.test("callback_run_mode - a priority-labelled implementation run still reports work-on", () => {
  // `top-priority` and `low-priority` order the implementation queue; they
  // are not workflows of their own.
  assertEquals(
    resolveCallbackRunMode(["top-priority", "bug"], LABELS),
    "work-on",
  );
  assertEquals(
    resolveCallbackRunMode(["low-priority"], LABELS),
    "work-on",
  );
});

Deno.test("callback_run_mode - a grill-me run reports grill-me", () => {
  assertEquals(resolveCallbackRunMode(["grill-me"], LABELS), "grill-me");
});

Deno.test("callback_run_mode - a question run reports question", () => {
  assertEquals(resolveCallbackRunMode(["question"], LABELS), "question");
});

Deno.test("callback_run_mode - a planning run reports planning", () => {
  assertEquals(resolveCallbackRunMode(["planning"], LABELS), "planning");
});

Deno.test("callback_run_mode - a quorum run reports quorum", () => {
  assertEquals(resolveCallbackRunMode(["quorum"], LABELS), "quorum");
});

Deno.test("callback_run_mode - a refinement run reports refine-issue", () => {
  assertEquals(
    resolveCallbackRunMode(["refine-issue"], LABELS),
    "refine-issue",
  );
});

Deno.test("callback_run_mode - an idle-task wrapper reports idle-task", () => {
  assertEquals(
    resolveCallbackRunMode(["idle-task", "work-on"], LABELS),
    "idle-task",
  );
});

Deno.test("callback_run_mode - the configured equivalent is reported, not the default name", () => {
  assertEquals(
    resolveCallbackRunMode(["hack-on-it"], {
      ...LABELS,
      workOnLabel: "hack-on-it",
    }),
    "hack-on-it",
  );
  assertEquals(
    resolveCallbackRunMode(["interrogate"], {
      ...LABELS,
      grillMeLabel: "interrogate",
    }),
    "interrogate",
  );
});

Deno.test("callback_run_mode - a custom dispatch label is reported as the mode", () => {
  assertEquals(
    resolveCallbackRunMode(["work-on", "triage-sweep"], {
      ...LABELS,
      customLabels: ["triage-sweep"],
    }),
    "triage-sweep",
  );
});

Deno.test("callback_run_mode - label matching is case-insensitive, as GitHub's own is", () => {
  assertEquals(resolveCallbackRunMode(["Grill-Me"], LABELS), "grill-me");
});

Deno.test("callback_run_mode - the higher-priority route wins when two labels are present", () => {
  // The grill-me handler (priority 1.78) dispatches ahead of the issue scan,
  // so a doubly-labelled issue served grill-me, not the implementation flow.
  assertEquals(
    resolveCallbackRunMode(["work-on", "grill-me"], LABELS),
    "grill-me",
  );
  assertEquals(
    resolveCallbackRunMode(["planning", "question"], LABELS),
    "planning",
  );
});

Deno.test("callback_run_mode - an unlabelled run falls back to the implementation workflow", () => {
  assertEquals(resolveCallbackRunMode([], LABELS), "work-on");
});

Deno.test("callback_run_mode - a blank work-on label yields no mode rather than an empty one", () => {
  assertEquals(
    resolveCallbackRunMode(["documentation"], { workOnLabel: "  " }),
    undefined,
  );
});
