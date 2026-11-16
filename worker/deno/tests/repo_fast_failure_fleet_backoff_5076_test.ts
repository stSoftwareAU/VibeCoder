/**
 * Issue #5076: a fleet-lookup failure caused by the GitHub rate-limit latch is
 * a degraded-but-continuing case, so it is logged once at WARNING, replayed
 * silently while the cached failure stands, and retried at the first lookup
 * after the quota resets rather than after the full recheck window.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createFleetDiagnosticCache,
  lookupFleetDiagnosticBackOffs,
} from "../lib/repo_fast_failure_tracker.ts";
import { formatRepoFastFailureMarker } from "../lib/repo_fast_failure_issue.ts";
import {
  clearPrimaryQuotaLatch,
  latchPrimaryQuota,
  primaryQuotaSkipMessage,
} from "../lib/primary_quota_latch.ts";

const OWNER = "stSoftwareAU";
const REPO = "stSoftwareAU/example";
const RECHECK = 600;

/** Whether the first test's fake gh is currently refused by the quota. */
let latched = false;

function goodRows(): string {
  return JSON.stringify([{
    number: 99,
    body: formatRepoFastFailureMarker(REPO),
    author: { login: "vibe-bot" },
    state: "open",
    repository: { nameWithOwner: REPO },
  }]);
}

/** Harness: real latch, injected clock, a gh fake that refuses while latched. */
function harness(failWith?: () => string | null) {
  const warnings: string[] = [];
  const cache = createFleetDiagnosticCache();
  let clock = 0;
  let calls = 0;
  const ghCommandFn = (_args: string[]): Promise<string> => {
    calls++;
    const message = failWith ? failWith() : null;
    return message === null
      ? Promise.resolve(goodRows())
      : Promise.reject(new Error(message));
  };
  const scan = (at: number) => {
    clock = at;
    return lookupFleetDiagnosticBackOffs({
      owners: () => [OWNER],
      fleetAuthors: ["vibe-bot"],
      ghCommandFn,
      cache,
      warn: (m: string) => warnings.push(m),
      nowSeconds: () => clock,
    });
  };
  return { warnings, scan, calls: () => calls };
}

Deno.test("fleet lookup - a quota failure warns once, replays silently, and retries after the reset (Issue #5076)", async () => {
  try {
    const h = harness(() => {
      // Refused only while the latch holds; the clock decides.
      return latched ? primaryQuotaSkipMessage(1000) : null;
    });
    latchPrimaryQuota(1027, 1000);
    latched = true;

    const first = await h.scan(1000);
    assertEquals(first.failedOwners, [OWNER]);
    assertEquals(h.calls(), 1);
    assertEquals(h.warnings.length, 1);
    assertStringIncludes(h.warnings[0]!, "GraphQL primary quota exhausted");
    assertStringIncludes(
      h.warnings[0]!,
      "only this host's own back-offs apply",
    );

    for (const at of [1010, 1020]) {
      const replay = await h.scan(at);
      assertEquals(replay.failedOwners, [OWNER]);
    }
    assertEquals(h.calls(), 1);
    assertEquals(h.warnings.length, 1);

    clearPrimaryQuotaLatch();
    latched = false;
    const after = await h.scan(1028);
    assertEquals(h.calls(), 2);
    assertEquals([...after.backedOff.keys()], [REPO]);
    assertEquals(after.failedOwners, []);
    assertEquals(h.warnings.length, 1);
  } finally {
    clearPrimaryQuotaLatch();
    latched = false;
  }
});

Deno.test("fleet lookup - a retry refused by a new latch warns once more with the new message (Issue #5076)", async () => {
  try {
    const h = harness(() => primaryQuotaSkipMessage(1028));
    latchPrimaryQuota(1027, 1000);
    await h.scan(1000);
    assertEquals(h.warnings.length, 1);

    // The old latch lapsed; a fresh one is set before the retry.
    clearPrimaryQuotaLatch();
    latchPrimaryQuota(1100, 1028);
    const retry = await h.scan(1028);
    assertEquals(h.calls(), 2);
    assertEquals(retry.failedOwners, [OWNER]);
    assertEquals(h.warnings.length, 2);
    assertStringIncludes(h.warnings[1]!, "in 1m");
    assert(h.warnings[1] !== h.warnings[0]);

    await h.scan(1040);
    assertEquals(h.calls(), 2);
    assertEquals(h.warnings.length, 2);
  } finally {
    clearPrimaryQuotaLatch();
  }
});

Deno.test("fleet lookup - a non-quota failure warns once and retries only after the recheck window (Issue #5076)", async () => {
  clearPrimaryQuotaLatch();
  const h = harness(() => "gh exploded");
  const first = await h.scan(1000);
  assertEquals(first.failedOwners, [OWNER]);
  assertEquals(h.warnings.length, 1);
  assertStringIncludes(h.warnings[0]!, "gh exploded");

  for (const at of [1030, 1000 + RECHECK - 1]) {
    const replay = await h.scan(at);
    assertEquals(replay.failedOwners, [OWNER]);
  }
  assertEquals(h.calls(), 1);
  assertEquals(h.warnings.length, 1);

  await h.scan(1000 + RECHECK);
  assertEquals(h.calls(), 2);
  assertEquals(h.warnings.length, 2);
});

Deno.test("fleet lookup - a latch reset beyond the recheck window still waits for the recheck (Issue #5076)", async () => {
  try {
    const h = harness(() => primaryQuotaSkipMessage(1000));
    latchPrimaryQuota(1000 + 3600, 1000);
    await h.scan(1000);
    assertEquals(h.warnings.length, 1);

    await h.scan(1000 + RECHECK - 1);
    assertEquals(h.calls(), 1);
    assertEquals(h.warnings.length, 1);

    await h.scan(1000 + RECHECK);
    assertEquals(h.calls(), 2);
    assertEquals(h.warnings.length, 2);
  } finally {
    clearPrimaryQuotaLatch();
  }
});
