/**
 * Which workflow label a run served, for the callback context's `mode`
 * (Issue #2100, part of #2060).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { resolveCallbackRunMode } from "../lib/callback_run_mode.ts";

/** The configured implementation label of a stock fleet. */
const LABELS = { workOnLabel: "work-on" } as const;

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
  assertEquals(resolveCallbackRunMode(["low-priority"], LABELS), "work-on");
});

Deno.test("callback_run_mode - an idle-task wrapper reports idle-task", () => {
  assertEquals(resolveCallbackRunMode(["idle-task"], LABELS), "idle-task");
});

Deno.test("callback_run_mode - the wrapper route wins over the implementation label", () => {
  // `processIssue` routes an idle-task wrapper before the standard pipeline,
  // and every wrapper also carries the discovery label that got it claimed.
  assertEquals(
    resolveCallbackRunMode(["work-on", "idle-task"], LABELS),
    "idle-task",
  );
});

Deno.test("callback_run_mode - the configured equivalent is reported, not the default name", () => {
  assertEquals(
    resolveCallbackRunMode(["hack-on-it"], { workOnLabel: "hack-on-it" }),
    "hack-on-it",
  );
});

Deno.test("callback_run_mode - a label route's name never displaces the implementation mode", () => {
  // The grill-me route declined this issue (it is not one of the labels the
  // claim scan filters out), so the scan claimed it and implemented it. An
  // archive comparing implementation runs must still see this one.
  assertEquals(
    resolveCallbackRunMode(["work-on", "grill-me"], LABELS),
    "work-on",
  );
  assertEquals(
    resolveCallbackRunMode(["top-priority", "quorum"], LABELS),
    "work-on",
  );
});

Deno.test("callback_run_mode - label matching is case-insensitive, as GitHub's own is", () => {
  assertEquals(resolveCallbackRunMode(["Idle-Task"], LABELS), "idle-task");
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

Deno.test("callback_run_mode - an issue label never becomes the mode verbatim", () => {
  // Defence in depth: the value published is always one the host configured,
  // so a label an untrusted party added carries none of its own text through.
  assertEquals(
    resolveCallbackRunMode(["WORK-ON $(id)", "work-on"], LABELS),
    "work-on",
  );
});
