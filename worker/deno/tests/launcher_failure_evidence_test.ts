/**
 * Tests for launcher_failure_evidence.ts (Issues #633, #638).
 *
 * Issue #633 is an alert the fleet filed about itself that carried nothing a
 * reader could act on: no host, no log, no hypothesis. These cover the three
 * things it should have said.
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  explainExitStatus,
  formatLogTail,
  knownWorkerStatuses,
} from "../lib/launcher_failure_evidence.ts";
import { QUOTA_PAUSE_EXIT_STATUS } from "../lib/quota_pause.ts";
import { BUILD_NOT_HEALABLE_EXIT } from "../commands/container_build_heal.ts";
import { ANOTHER_WORKER_RUNNING_EXIT } from "../commands/container_reap.ts";
import { EXTENSION_START_ABORT_EXIT_STATUS } from "../lib/container_extension_start.ts";

const KNOWN = knownWorkerStatuses(
  QUOTA_PAUSE_EXIT_STATUS,
  BUILD_NOT_HEALABLE_EXIT,
  ANOTHER_WORKER_RUNNING_EXIT,
  EXTENSION_START_ABORT_EXIT_STATUS,
);

// ---------------------------------------------------------------------------
// The status the alert could not explain
// ---------------------------------------------------------------------------

Deno.test("explainExitStatus - 255 is named as NOT the worker's, which is the whole point", () => {
  // The real alert reported "Last launcher exit status: 255" and stopped.
  // Establishing that 255 cannot come from worker code took a manual trace
  // through run.sh, entrypoint.sh, run_entrypoint.ts and run_worker.ts.
  const explanation = explainExitStatus(255, KNOWN);

  assertStringIncludes(explanation, "NOT one the worker produces");
  assertStringIncludes(explanation, "container runtime client");
  // It must point somewhere, not merely rule out.
  assertStringIncludes(explanation, "not at the worker's error handling");
});

Deno.test("explainExitStatus - a status the worker does produce is named as such", () => {
  const explanation = explainExitStatus(1, KNOWN);
  assertStringIncludes(explanation, "produces deliberately");
  // And must NOT send the reader to the runtime, which would be the wrong
  // half of the search space.
  assertEquals(explanation.includes("container runtime client"), false);
});

Deno.test("explainExitStatus - the quota pause is recognised, not called a fault", () => {
  const explanation = explainExitStatus(QUOTA_PAUSE_EXIT_STATUS, KNOWN);
  assertStringIncludes(explanation, "deliberate quota pause");
});

Deno.test("knownWorkerStatuses - the table matches the real exit constants", () => {
  // The library duplicates these as literals to avoid an import cycle with
  // the command modules. This is the guard that says so out loud: if a
  // constant moves, this fails here rather than making an alert quietly wrong.
  assertEquals(QUOTA_PAUSE_EXIT_STATUS, 75);
  assertEquals(BUILD_NOT_HEALABLE_EXIT, 3);
  assertEquals(ANOTHER_WORKER_RUNNING_EXIT, 4);
  // The entrypoint's abort status (Issue #981) is the container's own, and it
  // must collide with none of the others — 75 in particular, which resets the
  // failure streak as a scheduled pause.
  assertEquals(EXTENSION_START_ABORT_EXIT_STATUS, 76);
  assertEquals([...KNOWN.statuses].sort((a, b) => a - b), [0, 1, 3, 4, 75, 76]);
});

Deno.test("explainExitStatus - an aborted extension start is named, not blamed on the runtime (Issue #981)", () => {
  const explanation = explainExitStatus(
    EXTENSION_START_ABORT_EXIT_STATUS,
    KNOWN,
  );
  assertStringIncludes(explanation, "extension start script");
  assertEquals(explanation.includes("container runtime client"), false);
});

// ---------------------------------------------------------------------------
// The log the alert did not quote
// ---------------------------------------------------------------------------

Deno.test("formatLogTail - quotes the tail and says how much it left out", async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const out = await formatLogTail({ path: "/logs/x.log", maxLines: 10 }, {
    readTextFile: () => Promise.resolve(lines.join("\n")),
  });

  assertStringIncludes(out, "Last 10 of 100 lines");
  assertStringIncludes(out, "line 100");
  // The middle is not quoted, so a reader is not misled about completeness.
  assertEquals(out.includes("line 50"), false);
});

Deno.test("formatLogTail - an EMPTY log is reported as the finding it is (Issue #633)", async () => {
  // Both failing cycles wrote only their header line before dying. That
  // emptiness is the strongest evidence available — it says the run died
  // before reaching anything that logs — and a silently omitted section
  // would have thrown it away.
  const out = await formatLogTail({ path: "/logs/x.log", maxLines: 40 }, {
    readTextFile: () => Promise.resolve(""),
  });

  assertStringIncludes(out, "is empty");
  assertStringIncludes(out, "died before reaching anything that logs");
});

Deno.test("formatLogTail - an unreadable log says why, rather than going silent", async () => {
  // An alert that omits the log silently is indistinguishable from one whose
  // log was empty, and those need different responses.
  const out = await formatLogTail({ path: "/logs/gone.log", maxLines: 40 }, {
    readTextFile: () => Promise.reject(new Error("No such file or directory")),
  });

  assertStringIncludes(out, "could not read");
  assertStringIncludes(out, "No such file or directory");
});

Deno.test("formatLogTail - a short log is quoted whole, without a misleading 'last N'", async () => {
  const out = await formatLogTail({ path: "/logs/x.log", maxLines: 40 }, {
    readTextFile: () => Promise.resolve("only line\n"),
  });

  assertStringIncludes(out, "All 1 line(s)");
  assertEquals(out.includes("Last "), false);
});
