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

Deno.test("readPrLiveState - an open PR reads as open", async () => {
  const calls: string[][] = [];
  const reading = await readPrLiveState("owner/repo", 12, (args) => {
    calls.push(args);
    return Promise.resolve("OPEN\n");
  });

  assertEquals(reading, { open: true });
  assertEquals(calls, [[
    "pr",
    "view",
    "12",
    "--repo",
    "owner/repo",
    "--json",
    "state",
    "--jq",
    ".state",
  ]]);
});

Deno.test("readPrLiveState - CLOSED and MERGED are reported apart", async () => {
  assertEquals(
    await readPrLiveState("owner/repo", 1, () => Promise.resolve("CLOSED")),
    { open: false, state: "CLOSED" },
  );
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
    gh: () => Promise.resolve("OPEN"),
    logger,
  });

  assertEquals(reading, { open: true });
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
