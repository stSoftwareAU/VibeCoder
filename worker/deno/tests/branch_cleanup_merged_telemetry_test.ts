/**
 * Tests for the merged-PR tier telemetry in `cleanupMergedPrBranches`
 * (Issue #3404): each merged PR in the listing is counted once per telemetry
 * window by the sub-agent tier named in its body marker.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { cleanupMergedPrBranches } from "../lib/branch_cleanup.ts";
import {
  getFleetTelemetry,
  resetFleetTelemetry,
  startFleetTelemetry,
} from "../lib/fleet_telemetry.ts";
import { IssueCache } from "../lib/issue_cache.ts";

const T0 = Date.parse("2026-09-01T00:00:00Z");
const AFTER = "2026-09-02T00:00:00Z";
const HAIKU_BODY = 'Summary\n\n<!-- vibe-sub-agent-tier tier="haiku" -->';

function mockGh(listing: unknown[]) {
  return async (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("--state merged")) return JSON.stringify(listing);
    return "";
  };
}

async function withTelemetry(
  body: (ghDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "merged-telemetry-" });
  resetFleetTelemetry();
  startFleetTelemetry(T0);
  try {
    await body(dir);
  } finally {
    resetFleetTelemetry();
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("cleanupMergedPrBranches - counts a haiku-marked merged PR as haiku (Issue #3404)", async () => {
  await withTelemetry(async () => {
    const ghCommandFn = mockGh([
      {
        number: 1,
        title: "t",
        headRefName: "issue-1",
        mergedAt: AFTER,
        body: HAIKU_BODY,
      },
    ]);
    await cleanupMergedPrBranches(["o/r"], "bot", { ghCommandFn });
    const t = getFleetTelemetry();
    assertEquals(t.mergedPrsHaiku, 1);
    assertEquals(t.mergedPrsSonnet, 0);
  });
});

Deno.test("cleanupMergedPrBranches - counts an unmarked merged PR as sonnet (Issue #3404)", async () => {
  await withTelemetry(async () => {
    const ghCommandFn = mockGh([
      {
        number: 2,
        title: "t",
        headRefName: "issue-2",
        mergedAt: AFTER,
        body: "No marker",
      },
    ]);
    await cleanupMergedPrBranches(["o/r"], "bot", { ghCommandFn });
    const t = getFleetTelemetry();
    assertEquals(t.mergedPrsSonnet, 1);
    assertEquals(t.mergedPrsHaiku, 0);
  });
});

Deno.test("cleanupMergedPrBranches - the same listing on two runs counts once (Issue #3404)", async () => {
  await withTelemetry(async () => {
    const ghCommandFn = mockGh([
      {
        number: 3,
        title: "t",
        headRefName: "issue-3",
        mergedAt: AFTER,
        body: HAIKU_BODY,
      },
    ]);
    await cleanupMergedPrBranches(["o/r"], "bot", { ghCommandFn });
    await cleanupMergedPrBranches(["o/r"], "bot", { ghCommandFn });
    assertEquals(getFleetTelemetry().mergedPrsHaiku, 1);
  });
});

Deno.test("cleanupMergedPrBranches - a merged PR with no head branch is still counted (Issue #3404)", async () => {
  await withTelemetry(async () => {
    const ghCommandFn = mockGh([
      {
        number: 4,
        title: "t",
        headRefName: "",
        mergedAt: AFTER,
        body: HAIKU_BODY,
      },
    ]);
    await cleanupMergedPrBranches(["o/r"], "bot", { ghCommandFn });
    assertEquals(getFleetTelemetry().mergedPrsHaiku, 1);
  });
});

Deno.test("cleanupMergedPrBranches - an old-shape cached entry without a tier is not counted (Issue #3404)", async () => {
  await withTelemetry(async (dir) => {
    const cache = new IssueCache(dir);
    await cache.write("o/r", "prs_merged_bot", [
      {
        number: 5,
        title: "old",
        headRefName: "issue-5",
        mergedAt: AFTER,
        closingRefs: [],
      },
    ]);
    const ghCommandFn = mockGh([]);
    await cleanupMergedPrBranches(["o/r"], "bot", { ghCommandFn, cache });
    const t = getFleetTelemetry();
    assertEquals(t.mergedPrsHaiku, 0);
    assertEquals(t.mergedPrsSonnet, 0);
  });
});
