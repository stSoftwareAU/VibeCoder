/**
 * Tests for the claim-point PR state re-read (Issue #1774).
 *
 * The behaviour under test is a decision, not a shape: a PR the cached
 * listing called open but `gh pr view` calls CLOSED must be skipped, and a
 * state that cannot be read must never be treated as open.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  guardPrStillOpen,
  isPrLiveStateRead,
  prLiveSkipReason,
  readPrLiveState,
} from "../lib/pr_live_state.ts";
import type { Logger } from "../types.ts";

/** Collecting logger — the skip line is part of the contract. */
function recorder() {
  const infos: { message: string; context?: Record<string, unknown> }[] = [];
  const warns: { message: string; context?: Record<string, unknown> }[] = [];
  const logger: Pick<Logger, "info" | "warn"> = {
    info: (message, context) => infos.push({ message, context }),
    warn: (message, context) => warns.push({ message, context }),
  };
  return { infos, warns, logger };
}

Deno.test("readPrLiveState - an open PR reads as open, with its mergeable verdict", async () => {
  const calls: string[][] = [];
  const reading = await readPrLiveState("owner/repo", 12, (args) => {
    calls.push(args);
    return Promise.resolve('{"mergeable":"CONFLICTING","state":"OPEN"}\n');
  });

  assertEquals(reading, {
    open: true,
    mergeable: "CONFLICTING",
    armed: false,
    behind: false,
  });
  assertEquals(calls, [[
    "pr",
    "view",
    "12",
    "--repo",
    "owner/repo",
    "--json",
    "state,mergeable,autoMergeRequest,mergeStateStatus",
  ]]);
});

Deno.test("readPrLiveState - a PR that merges cleanly reads as open and MERGEABLE", async () => {
  assertEquals(
    await readPrLiveState(
      "owner/repo",
      12,
      () => Promise.resolve('{"mergeable":"MERGEABLE","state":"OPEN"}'),
    ),
    {
      open: true,
      mergeable: "MERGEABLE",
      armed: false,
      behind: false,
    },
  );
});

Deno.test("readPrLiveState - an unreadable mergeable is unknown, never mergeable", async () => {
  // GitHub answers UNKNOWN while it recomputes the merge; a value nobody
  // recognises, a missing field and an unparseable payload read the same way.
  for (
    const raw of [
      '{"mergeable":"UNKNOWN","state":"OPEN"}',
      '{"mergeable":"SOMETHING_NEW","state":"OPEN"}',
      '{"state":"OPEN"}',
      "OPEN",
    ]
  ) {
    assertEquals(
      await readPrLiveState("owner/repo", 12, () => Promise.resolve(raw)),
      {
        open: true,
        mergeable: "UNKNOWN",
        armed: false,
        behind: false,
      },
      `raw payload ${raw} must read as an unknown mergeable`,
    );
  }
});

Deno.test("readPrLiveState - an unparseable payload is never open", async () => {
  const reading = await readPrLiveState(
    "owner/repo",
    12,
    () => Promise.resolve('{"state":"OPEN"'),
  );

  assert(reading.unknown === true, "a broken payload must be unknown");
  assert(reading.open !== true, "a broken payload must never read as open");
});

Deno.test("readPrLiveState - CLOSED and MERGED are reported apart", async () => {
  assertEquals(
    await readPrLiveState(
      "owner/repo",
      1,
      () => Promise.resolve('{"mergeable":"UNKNOWN","state":"CLOSED"}'),
    ),
    { open: false, state: "CLOSED" },
  );
  assertEquals(
    await readPrLiveState(
      "owner/repo",
      1,
      () => Promise.resolve('{"mergeable":"UNKNOWN","state":"MERGED"}'),
    ),
    { open: false, state: "MERGED" },
  );
  // The bare-state shape a `gh` stub still answers keeps working.
  assertEquals(
    await readPrLiveState("owner/repo", 1, () => Promise.resolve("merged\n")),
    { open: false, state: "MERGED" },
  );
});

Deno.test("readPrLiveState - a gh failure is unknown, never open", async () => {
  const reading = await readPrLiveState(
    "owner/repo",
    7,
    () => Promise.reject(new Error("gh: rate limit exceeded")),
  );

  assert(reading.unknown === true, "a failed lookup must be unknown");
  assert(reading.open !== true, "an unreadable state must never read as open");
  assert(reading.error.includes("rate limit"), "the cause must survive");
});

Deno.test("readPrLiveState - an unrecognised state is unknown, never open", async () => {
  const reading = await readPrLiveState(
    "owner/repo",
    7,
    () => Promise.resolve("DRAFT"),
  );

  assert(reading.unknown === true);
  assert(reading.error.includes("DRAFT"), "the raw state must be named");
});

Deno.test("isPrLiveStateRead - recognises this read's own argv, and nothing else", () => {
  // Issue #2307: the field list is the whole point. Five other lookups ask
  // `gh pr view --json state,<something else>`, and a fixture that answered
  // those with a live-state payload would be answering the wrong question.
  assert(
    isPrLiveStateRead([
      "pr",
      "view",
      "7",
      "--json",
      "state,mergeable,autoMergeRequest,mergeStateStatus",
    ]),
  );
  assert(isPrLiveStateRead(["pr", "view", "7", "--json", "state"]));
  assert(!isPrLiveStateRead(["pr", "view", "7", "--json", "state,mergedAt"]));
  assert(
    !isPrLiveStateRead(["pr", "view", "7", "--json", "state,headRefName"]),
  );
  assert(!isPrLiveStateRead(["pr", "view", "7", "--json", "mergeable"]));
  assert(!isPrLiveStateRead(["pr", "view", "7", "--json"]), "no field list");
  assert(!isPrLiveStateRead(["pr", "view", "7"]), "no --json at all");
  assert(!isPrLiveStateRead(["pr", "list", "--json", "state,mergeable"]));
});

Deno.test("prLiveSkipReason - the two closed lines are distinct", () => {
  assertEquals(
    prLiveSkipReason({ open: false, state: "CLOSED" }),
    "skipped: PR closed",
  );
  assertEquals(
    prLiveSkipReason({ open: false, state: "MERGED" }),
    "skipped: PR merged",
  );
  assertEquals(
    prLiveSkipReason({ unknown: true, error: "boom" }),
    "skipped: PR state unknown",
  );
});

Deno.test("guardPrStillOpen - an open PR is not logged as a skip", async () => {
  const { infos, warns, logger } = recorder();
  const reading = await guardPrStillOpen({
    repo: "owner/repo",
    prNumber: 3,
    pass: "CI fix",
    gh: () => Promise.resolve('{"mergeable":"MERGEABLE","state":"OPEN"}'),
    logger,
  });

  assertEquals(reading, {
    open: true,
    mergeable: "MERGEABLE",
    armed: false,
    behind: false,
  });
  assertEquals(infos.length, 0);
  assertEquals(warns.length, 0);
});

Deno.test("guardPrStillOpen - a closed PR logs the skip line with repo and number", async () => {
  const { infos, logger } = recorder();
  const reading = await guardPrStillOpen({
    repo: "owner/repo",
    prNumber: 1732,
    pass: "CI fix",
    gh: () => Promise.resolve("CLOSED"),
    logger,
  });

  assertEquals(reading, { open: false, state: "CLOSED" });
  assertEquals(infos.length, 1);
  const skip = infos[0]!;
  assert(
    skip.message.includes("skipped: PR closed"),
    `expected the skip line, got: ${skip.message}`,
  );
  assertEquals(skip.context?.repo, "owner/repo");
  assertEquals(skip.context?.prNumber, 1732);
});

Deno.test("guardPrStillOpen - a merged PR logs 'skipped: PR merged'", async () => {
  const { infos, logger } = recorder();
  await guardPrStillOpen({
    repo: "owner/repo",
    prNumber: 8,
    pass: "auto-merge",
    gh: () => Promise.resolve("MERGED"),
    logger,
  });

  assert(infos[0]!.message.includes("skipped: PR merged"));
});

Deno.test("guardPrStillOpen - an unreadable state warns rather than passing quietly", async () => {
  const { infos, warns, logger } = recorder();
  const reading = await guardPrStillOpen({
    repo: "owner/repo",
    prNumber: 9,
    pass: "review feedback",
    gh: () => Promise.reject(new Error("network down")),
    logger,
  });

  assert(reading.open !== true);
  assertEquals(infos.length, 0);
  assertEquals(warns.length, 1);
  const unknown = warns[0]!;
  assert(unknown.message.includes("skipped: PR state unknown"));
  assertEquals(unknown.context?.error, "network down");
});

// ---------------------------------------------------------------------------
// Armed / behind (Issue #2462)
// ---------------------------------------------------------------------------

Deno.test("readPrLiveState - an armed, behind PR reads as armed and behind", async () => {
  const reading = await readPrLiveState("owner/repo", 12, () =>
    Promise.resolve(
      JSON.stringify({
        state: "OPEN",
        mergeable: "MERGEABLE",
        autoMergeRequest: { enabledBy: "worker-bot" },
        mergeStateStatus: "BEHIND",
      }),
    ));

  assertEquals(reading, {
    open: true,
    mergeable: "MERGEABLE",
    armed: true,
    behind: true,
  });
});

Deno.test("readPrLiveState - a non-BEHIND mergeStateStatus is never behind", async () => {
  for (const status of ["CLEAN", "BLOCKED", "DIRTY", "UNKNOWN", "HAS_HOOKS"]) {
    const reading = await readPrLiveState(
      "owner/repo",
      12,
      () =>
        Promise.resolve(
          JSON.stringify({
            state: "OPEN",
            mergeable: "MERGEABLE",
            autoMergeRequest: { enabledBy: "worker-bot" },
            mergeStateStatus: status,
          }),
        ),
    );
    assert(reading.open === true, `mergeStateStatus ${status} must read open`);
    assertEquals(reading.behind, false, `mergeStateStatus ${status}`);
  }
});

Deno.test("readPrLiveState - a legacy payload reads unarmed and not behind", async () => {
  // The pre-#2462 shape: `state,mergeable` only. Absent knowledge must
  // never arm a write.
  const reading = await readPrLiveState(
    "owner/repo",
    12,
    () => Promise.resolve('{"state":"OPEN","mergeable":"MERGEABLE"}'),
  );
  assertEquals(reading, {
    open: true,
    mergeable: "MERGEABLE",
    armed: false,
    behind: false,
  });
});

Deno.test("readPrLiveState - a null autoMergeRequest reads unarmed even when behind", async () => {
  // Behind without an arming request is a state, not a write trigger:
  // the sweep only acts when both are known (Issue #2462).
  const reading = await readPrLiveState("owner/repo", 12, () =>
    Promise.resolve(
      '{"state":"OPEN","mergeable":"MERGEABLE","autoMergeRequest":null,"mergeStateStatus":"BEHIND"}',
    ));
  assertEquals(reading, {
    open: true,
    mergeable: "MERGEABLE",
    armed: false,
    behind: true,
  });
});
