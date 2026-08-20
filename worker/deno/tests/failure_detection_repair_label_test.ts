/**
 * Tests for failure_detection_repair_label.ts — the partial Failure-Detection
 * repair marker on a planning parent (Issue #59, part of #54).
 *
 * Covers the happy path (label + comment + reopen), the error paths (a failed
 * label add is reported, a failed comment is non-fatal), and the reservation
 * invariants that stop the planner ever applying the label itself.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyFailureDetectionRepairLabel,
  FAILURE_DETECTION_REPAIR_LABEL,
  recordPartialFailureDetectionRepair,
} from "../lib/failure_detection_repair_label.ts";
import type { FailureDetectionOffender } from "../lib/failure_detection_gate.ts";
import { isReservedLabel } from "../lib/config_defaults.ts";
import { isWorkerAppliableLabel } from "../lib/worker_label_guard.ts";
import { getLabelByName } from "../setup/label_definitions.ts";
import type { Logger } from "../types.ts";

function captureLogger(
  sink: Array<{ level: string; message: string }>,
): Logger {
  return {
    info: (message: string) => sink.push({ level: "info", message }),
    warn: (message: string) => sink.push({ level: "warn", message }),
    error: (message: string) => sink.push({ level: "error", message }),
    debug: (message: string) => sink.push({ level: "debug", message }),
  } as unknown as Logger;
}

const OFFENDERS: FailureDetectionOffender[] = [
  {
    number: 842,
    title: "First",
    reason: "missing `## Failure Detection` section",
  },
  {
    number: 843,
    title: "Second",
    reason: "empty `## Failure Detection` section",
  },
];

/** A gh stub that records calls and reports the label as already existing. */
function ghStub(calls: string[][], failOn?: (args: string[]) => boolean) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    if (failOn?.(args)) return Promise.reject(new Error("gh failed"));
    if (args[0] === "label" && args[1] === "list") {
      return Promise.resolve(`${FAILURE_DETECTION_REPAIR_LABEL}\n`);
    }
    return Promise.resolve("");
  };
}

Deno.test("applyFailureDetectionRepairLabel - adds the label to the parent issue", async () => {
  const calls: string[][] = [];
  const logs: Array<{ level: string; message: string }> = [];

  const applied = await applyFailureDetectionRepairLabel({
    repo: "org/repo",
    parentIssueNumber: 835,
    ghCommandFn: ghStub(calls),
    logger: captureLogger(logs),
    cacheDir: await Deno.makeTempDir(),
  });

  assertEquals(applied, true);
  const labelCall = calls.find((args) =>
    args.includes(`labels[]=${FAILURE_DETECTION_REPAIR_LABEL}`)
  );
  assertEquals(labelCall !== undefined, true);
  assertStringIncludes(
    labelCall!.join(" "),
    "repos/org/repo/issues/835/labels",
  );
});

Deno.test("applyFailureDetectionRepairLabel - reports loudly when the label cannot be applied", async () => {
  const calls: string[][] = [];
  const logs: Array<{ level: string; message: string }> = [];

  const applied = await applyFailureDetectionRepairLabel({
    repo: "org/repo",
    parentIssueNumber: 835,
    // Every label mutation fails — both the REST add and the CLI fallback.
    ghCommandFn: ghStub(
      calls,
      (args) => args[0] === "api" || args[1] === "edit",
    ),
    logger: captureLogger(logs),
    cacheDir: await Deno.makeTempDir(),
  });

  // Never a silent failure (Issue #3234): false result plus an error log.
  assertEquals(applied, false);
  assertEquals(logs.some((l) => l.level === "error"), true);
});

Deno.test("recordPartialFailureDetectionRepair - labels, comments once, and leaves an open parent open", async () => {
  const calls: string[][] = [];
  const comments: Array<{ issueNumber: number; body: string }> = [];

  const labelled = await recordPartialFailureDetectionRepair({
    repo: "org/repo",
    parentIssueNumber: 835,
    offenders: OFFENDERS,
    parentClosed: false,
    ghCommandFn: ghStub(calls),
    postComment: (_repo, issueNumber, body) => {
      comments.push({ issueNumber, body });
      return Promise.resolve();
    },
    logger: captureLogger([]),
    cacheDir: await Deno.makeTempDir(),
  });

  assertEquals(labelled, true);
  assertEquals(comments.length, 1);
  assertEquals(comments[0]!.issueNumber, 835);
  assertStringIncludes(comments[0]!.body, "#842");
  assertStringIncludes(comments[0]!.body, "#843");
  assertStringIncludes(comments[0]!.body, FAILURE_DETECTION_REPAIR_LABEL);
  // An already-open parent is never reopened.
  assertEquals(calls.some((args) => args[1] === "reopen"), false);
});

Deno.test("recordPartialFailureDetectionRepair - reopens a parent Claude closed inline", async () => {
  const calls: string[][] = [];

  await recordPartialFailureDetectionRepair({
    repo: "org/repo",
    parentIssueNumber: 835,
    offenders: OFFENDERS,
    parentClosed: true,
    ghCommandFn: ghStub(calls),
    postComment: () => Promise.resolve(),
    logger: captureLogger([]),
    cacheDir: await Deno.makeTempDir(),
  });

  const reopen = calls.find((args) =>
    args[0] === "issue" && args[1] === "reopen"
  );
  assertEquals(reopen, ["issue", "reopen", "835", "--repo", "org/repo"]);
});

Deno.test("recordPartialFailureDetectionRepair - a failed comment is non-fatal and logged", async () => {
  const calls: string[][] = [];
  const logs: Array<{ level: string; message: string }> = [];

  const labelled = await recordPartialFailureDetectionRepair({
    repo: "org/repo",
    parentIssueNumber: 835,
    offenders: OFFENDERS,
    parentClosed: false,
    ghCommandFn: ghStub(calls),
    postComment: () => Promise.reject(new Error("comment failed")),
    logger: captureLogger(logs),
    cacheDir: await Deno.makeTempDir(),
  });

  // The label still landed, and the comment failure was surfaced.
  assertEquals(labelled, true);
  assertEquals(logs.some((l) => l.level === "warn"), true);
});

Deno.test("needs-failure-detection-repair - reserved against the planner, appliable by the worker (Issue #59)", () => {
  // Reserved: the planner can never apply it as a descriptive label — the
  // creation filter and the sub-issue strip both read `isReservedLabel`.
  assertEquals(isReservedLabel(FAILURE_DETECTION_REPAIR_LABEL), true);
  // Case-insensitively reserved (GitHub treats label names that way).
  assertEquals(isReservedLabel("Needs-Failure-Detection-Repair"), true);
  // The worker itself may still raise it — it is the only thing that does.
  assertEquals(isWorkerAppliableLabel(FAILURE_DETECTION_REPAIR_LABEL), true);
});

Deno.test("needs-failure-detection-repair - has a canonical name, colour and description", () => {
  const def = getLabelByName(FAILURE_DETECTION_REPAIR_LABEL);
  assertEquals(def?.name, FAILURE_DETECTION_REPAIR_LABEL);
  assertEquals(def?.category, "workflow");
  assertEquals(/^[0-9a-f]{6}$/.test(def?.colour ?? ""), true);
  assertEquals((def?.description ?? "").length > 0, true);
});
