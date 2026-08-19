/**
 * Tests for the per-idle-tick filer wrapper (Issue #2158).
 *
 * Pins the four behaviours the regression fix relies on:
 *   1. The back-fill sweep runs before the filer call (so orphans are
 *      labelled before the cross-repo dedup gate sees the repo).
 *   2. A back-fill throw is logged and swallowed — the filer still
 *      runs.
 *   3. The back-fill summary line is always emitted.
 *   4. A filer throw propagates so the caller's existing `try/catch`
 *      can log and continue.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { runIdleTaskFilerCycle } from "../lib/idle_task_filer_run.ts";
import type { BackfillSummary } from "../lib/idle_task_backfill.ts";

function emptySummary(): BackfillSummary {
  return {
    labelled: [],
    alreadyLabelled: 0,
    deliberatelyUnlabelled: [],
    errors: [],
  };
}

Deno.test(
  "runIdleTaskFilerCycle - back-fill runs before the filer call",
  async () => {
    const order: string[] = [];
    const log: string[] = [];

    await runIdleTaskFilerCycle({
      repos: ["org/a", "org/b"],
      log: (line) => log.push(line),
      fileFn: () => {
        order.push("file");
        return Promise.resolve();
      },
      backfillFn: (opts) => {
        order.push("backfill");
        assertEquals(opts.repos, ["org/a", "org/b"]);
        return Promise.resolve(emptySummary());
      },
    });

    assertEquals(order, ["backfill", "file"]);
    // Summary line is always emitted, even on an empty sweep.
    const summaryLine = log.find((l) =>
      l.startsWith("[backfill] action=summary")
    );
    assert(summaryLine !== undefined, "expected a backfill summary log line");
  },
);

Deno.test(
  "runIdleTaskFilerCycle - back-fill labelled events route through the log sink",
  async () => {
    const log: string[] = [];

    await runIdleTaskFilerCycle({
      repos: ["org/a"],
      log: (line) => log.push(line),
      fileFn: () => Promise.resolve(),
      backfillFn: (opts) => {
        // Simulate the helper's own event sink firing for a rescued
        // wrapper. The wrapper helper formats each event before
        // pushing it into the caller's log.
        opts.log?.({ kind: "labelled", repo: "org/a", number: 39 });
        return Promise.resolve({
          labelled: [{ repo: "org/a", number: 39 }],
          alreadyLabelled: 0,
          deliberatelyUnlabelled: [],
          errors: [],
        });
      },
    });

    const labelledLine = log.find((l) =>
      l.includes("repo=org/a") && l.includes("issue=39") &&
      l.includes("action=labelled")
    );
    assert(
      labelledLine !== undefined,
      "expected a `[backfill] ... action=labelled` line for the rescued wrapper",
    );
    const summaryLine = log.find((l) =>
      l.startsWith("[backfill] action=summary") && l.includes("labelled=1")
    );
    assert(
      summaryLine !== undefined,
      "expected summary line reporting one labelled wrapper",
    );
  },
);

Deno.test(
  "runIdleTaskFilerCycle - back-fill throw is logged and the filer still runs",
  async () => {
    const log: string[] = [];
    let filerCalled = false;

    await runIdleTaskFilerCycle({
      repos: ["org/a"],
      log: (line) => log.push(line),
      fileFn: () => {
        filerCalled = true;
        return Promise.resolve();
      },
      backfillFn: () => Promise.reject(new Error("gh blew up")),
    });

    assert(filerCalled, "filer must still run when back-fill throws");
    const errLine = log.find((l) =>
      l.startsWith("[backfill] action=error") && l.includes("gh blew up")
    );
    assert(
      errLine !== undefined,
      "expected `[backfill] action=error reason=...` line on back-fill throw",
    );
  },
);

Deno.test(
  "runIdleTaskFilerCycle - filer throw propagates to the caller",
  async () => {
    const log: string[] = [];

    await assertRejects(
      () =>
        runIdleTaskFilerCycle({
          repos: ["org/a"],
          log: (line) => log.push(line),
          fileFn: () => Promise.reject(new Error("filer crashed")),
          backfillFn: () => Promise.resolve(emptySummary()),
        }),
      Error,
      "filer crashed",
    );
  },
);
