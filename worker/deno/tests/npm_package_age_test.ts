/**
 * Tests for lib/npm_package_age.ts (Issue #2799).
 *
 * The npm registry `time`-based quarantine gate for hard-coded `npm:`
 * subprocess specifiers (e.g. the Playwright constants in setup/screenshot.ts).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  checkNpmVersionAge,
  evaluateNpmVersionAge,
  extractNpmTimeMap,
  fetchNpmTimeData,
  type NpmAgeFetchDeps,
  npmRegistryUrl,
  verifyNpmPackagesQuarantine,
} from "../lib/npm_package_age.ts";

const NOW = new Date("2026-06-15T12:00:00Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

// ── npmRegistryUrl ──────────────────────────────────────────────────────

Deno.test("npmRegistryUrl - encodes the slash in a scoped package name", () => {
  assertEquals(
    npmRegistryUrl("@playwright/mcp"),
    "https://registry.npmjs.org/@playwright%2Fmcp",
  );
});

Deno.test("npmRegistryUrl - leaves an unscoped name untouched", () => {
  assertEquals(
    npmRegistryUrl("playwright"),
    "https://registry.npmjs.org/playwright",
  );
});

// ── evaluateNpmVersionAge (pure) ────────────────────────────────────────

Deno.test("evaluateNpmVersionAge - eligible when older than the window", () => {
  const time = { "1.60.0": hoursAgo(72) };
  const v = evaluateNpmVersionAge("playwright", "1.60.0", time, 24, NOW);
  assertEquals(v.eligible, true);
  assertEquals(v.indeterminate, false);
  assert(v.ageHours !== null && v.ageHours >= 72);
  assertStringIncludes(v.reason, ">= 24h quarantine");
});

Deno.test("evaluateNpmVersionAge - blocked when newer than the window", () => {
  const time = { "1.61.0": hoursAgo(3) };
  const v = evaluateNpmVersionAge("playwright", "1.61.0", time, 24, NOW);
  assertEquals(v.eligible, false);
  assertEquals(v.indeterminate, false);
  assertStringIncludes(v.reason, "< 24h quarantine");
});

Deno.test("evaluateNpmVersionAge - boundary: exactly the window is eligible", () => {
  const time = { "2.0.0": hoursAgo(24) };
  const v = evaluateNpmVersionAge("pkg", "2.0.0", time, 24, NOW);
  assertEquals(v.eligible, true);
});

Deno.test("evaluateNpmVersionAge - indeterminate when version is unknown", () => {
  const v = evaluateNpmVersionAge(
    "pkg",
    "9.9.9",
    { "1.0.0": hoursAgo(48) },
    24,
    NOW,
  );
  assertEquals(v.indeterminate, true);
  assertEquals(v.eligible, false);
  assertEquals(v.ageHours, null);
});

Deno.test("evaluateNpmVersionAge - indeterminate when time map is missing", () => {
  const v = evaluateNpmVersionAge("pkg", "1.0.0", undefined, 24, NOW);
  assertEquals(v.indeterminate, true);
  assertEquals(v.publishedAt, null);
});

Deno.test("evaluateNpmVersionAge - indeterminate on an unparseable timestamp", () => {
  const v = evaluateNpmVersionAge(
    "pkg",
    "1.0.0",
    { "1.0.0": "not-a-date" },
    24,
    NOW,
  );
  assertEquals(v.indeterminate, true);
  assertEquals(v.publishedAt, "not-a-date");
});

Deno.test("evaluateNpmVersionAge - zero/negative window makes any known version eligible", () => {
  const time = { "1.0.0": hoursAgo(0.1) };
  assertEquals(
    evaluateNpmVersionAge("pkg", "1.0.0", time, 0, NOW).eligible,
    true,
  );
  assertEquals(
    evaluateNpmVersionAge("pkg", "1.0.0", time, -5, NOW).eligible,
    true,
  );
});

// ── checkNpmVersionAge (injected fetch) ─────────────────────────────────

function depsReturning(
  map: Record<string, Record<string, string> | undefined>,
): NpmAgeFetchDeps {
  return {
    fetchTimeData: (pkg) => Promise.resolve(map[pkg]),
    now: () => NOW,
  };
}

Deno.test("checkNpmVersionAge - eligible via injected registry data", async () => {
  const deps = depsReturning({ playwright: { "1.60.0": hoursAgo(100) } });
  const v = await checkNpmVersionAge("playwright", "1.60.0", 24, deps);
  assertEquals(v.eligible, true);
});

Deno.test("checkNpmVersionAge - fetch throwing yields an indeterminate verdict", async () => {
  const deps: NpmAgeFetchDeps = {
    fetchTimeData: () => Promise.reject(new Error("network down")),
    now: () => NOW,
  };
  const v = await checkNpmVersionAge("playwright", "1.60.0", 24, deps);
  assertEquals(v.indeterminate, true);
  assertEquals(v.eligible, false);
  // Issue #3711: the failure cause must survive into the refusal reason.
  assertStringIncludes(v.reason, "network down");
});

// ── verifyNpmPackagesQuarantine (batch) ─────────────────────────────────

Deno.test("verifyNpmPackagesQuarantine - ok when all packages clear the window", async () => {
  const deps = depsReturning({
    "@playwright/mcp": { "0.0.75": hoursAgo(500) },
    playwright: { "1.60.0": hoursAgo(500) },
  });
  const report = await verifyNpmPackagesQuarantine(
    [
      { name: "@playwright/mcp", version: "0.0.75" },
      { name: "playwright", version: "1.60.0" },
    ],
    24,
    deps,
  );
  assertEquals(report.ok, true);
  assertEquals(report.blocked.length, 0);
  assertEquals(report.verdicts.length, 2);
});

Deno.test("verifyNpmPackagesQuarantine - blocks a too-new package", async () => {
  const deps = depsReturning({
    "@playwright/mcp": { "0.0.99": hoursAgo(2) },
    playwright: { "1.60.0": hoursAgo(500) },
  });
  const report = await verifyNpmPackagesQuarantine(
    [
      { name: "@playwright/mcp", version: "0.0.99" },
      { name: "playwright", version: "1.60.0" },
    ],
    24,
    deps,
  );
  assertEquals(report.ok, false);
  assertEquals(report.blocked.length, 1);
  assertEquals(report.blocked[0]?.package, "@playwright/mcp");
});

// Issue #3711 — behaviour change: an indeterminate verdict used to pass the
// gate ("indeterminate does not block"), so a dropped or 5xx registry lookup
// converted a block into a pass for a package that then ran under
// `--allow-all`. It now fails closed. The test below is the same scenario,
// re-asserted against the fail-closed contract.
Deno.test("verifyNpmPackagesQuarantine - indeterminate refuses (fail closed)", async () => {
  const deps = depsReturning({
    "@playwright/mcp": undefined, // registry unreachable
    playwright: { "1.60.0": hoursAgo(500) },
  });
  const report = await verifyNpmPackagesQuarantine(
    [
      { name: "@playwright/mcp", version: "0.0.75" },
      { name: "playwright", version: "1.60.0" },
    ],
    24,
    deps,
  );
  assertEquals(report.ok, false);
  assertEquals(report.indeterminate.length, 1);
  // Still reported separately from a definitively-too-new version.
  assertEquals(report.blocked.length, 0);
  assertEquals(report.refused.length, 1);
  assertEquals(report.refused[0]?.package, "@playwright/mcp");
});

Deno.test("verifyNpmPackagesQuarantine - refuses both too-new and unverifiable", async () => {
  const deps = depsReturning({
    "@playwright/mcp": { "0.0.99": hoursAgo(2) }, // too new
    playwright: undefined, // registry unreachable
  });
  const report = await verifyNpmPackagesQuarantine(
    [
      { name: "@playwright/mcp", version: "0.0.99" },
      { name: "playwright", version: "1.60.0" },
    ],
    24,
    deps,
  );
  assertEquals(report.ok, false);
  assertEquals(report.blocked.length, 1);
  assertEquals(report.indeterminate.length, 1);
  assertEquals(report.refused.length, 2);
});

Deno.test("verifyNpmPackagesQuarantine - a rejected lookup refuses and names the cause", async () => {
  const deps: NpmAgeFetchDeps = {
    fetchTimeData: () => Promise.reject(new Error("connection reset")),
    now: () => NOW,
  };
  const report = await verifyNpmPackagesQuarantine(
    [{ name: "playwright", version: "1.60.0" }],
    24,
    deps,
  );
  assertEquals(report.ok, false);
  assertEquals(report.refused.length, 1);
  assertStringIncludes(report.refused[0]!.reason, "connection reset");
});

Deno.test("verifyNpmPackagesQuarantine - refused is empty when every package clears", async () => {
  const deps = depsReturning({ playwright: { "1.60.0": hoursAgo(500) } });
  const report = await verifyNpmPackagesQuarantine(
    [{ name: "playwright", version: "1.60.0" }],
    24,
    deps,
  );
  assertEquals(report.ok, true);
  assertEquals(report.refused.length, 0);
});

// --- Issue #3710: bounded outbound fetches ---

/** Swap globalThis.fetch for the duration of `body`. */
async function withStubbedFetch(
  stub: typeof globalThis.fetch,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("fetchNpmTimeData - a hung registry aborts on the timeout and throws", async () => {
  await withStubbedFetch(
    ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason));
      })) as typeof globalThis.fetch,
    async () => {
      await assertRejects(() => fetchNpmTimeData("playwright", 30));
    },
  );
});

Deno.test("fetchNpmTimeData - parses the time map from a bounded read", async () => {
  await withStubbedFetch(
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ time: { "1.0.0": "2020-01-01T00:00:00.000Z" } }),
          { status: 200 },
        ),
      )) as typeof globalThis.fetch,
    async () => {
      const time = await fetchNpmTimeData("playwright");
      assertEquals(time?.["1.0.0"], "2020-01-01T00:00:00.000Z");
    },
  );
});

Deno.test("fetchNpmTimeData - a non-2xx response throws naming the status", async () => {
  await withStubbedFetch(
    (() =>
      Promise.resolve(
        new Response("nope", { status: 500 }),
      )) as typeof globalThis.fetch,
    async () => {
      const error = await assertRejects(() => fetchNpmTimeData("playwright"));
      assertStringIncludes(
        error instanceof Error ? error.message : String(error),
        "HTTP 500",
      );
    },
  );
});

// =============================================================================
// Issue #4390 — large packuments: only the `time` map is held in memory
// =============================================================================

/** A packument whose `versions` block is padded to `bytes` before `time`. */
function bigPackument(bytes: number, time: Record<string, string>): string {
  const filler = `"description":"${"x".repeat(1024)}"`;
  const versions: string[] = [];
  let size = 0;
  let i = 0;
  while (size < bytes) {
    // A version manifest that itself carries a "time" field (a package.json
    // may) — the extractor must not mistake it for the top-level map.
    const v =
      `"1.0.${i}":{"name":"pkg","version":"1.0.${i}","time":{"built":"never"},${filler}}`;
    versions.push(v);
    size += v.length + 1;
    i++;
  }
  return `{"_id":"pkg","name":"pkg","dist-tags":{"latest":"1.0.0"},"versions":{${
    versions.join(",")
  }},"time":${JSON.stringify(time)},"license":"MIT"}`;
}

function streamOf(
  text: string,
  chunkSize = 64 * 1024,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

Deno.test("extractNpmTimeMap - finds the top-level time map in a 24 MB packument, skipping per-version time fields (Issue #4390)", async () => {
  const doc = bigPackument(24 * 1024 * 1024, {
    created: "2020-01-17T16:44:00.542Z",
    modified: "2026-08-18T05:36:21.238Z",
    "1.61.0-alpha-1778188671000": "2026-05-07T22:10:19.776Z",
  });
  assert(doc.length > 16 * 1024 * 1024, "the fixture must exceed the old cap");
  const time = await extractNpmTimeMap(streamOf(doc));
  assertEquals(time["1.61.0-alpha-1778188671000"], "2026-05-07T22:10:19.776Z");
  assertEquals(time.modified, "2026-08-18T05:36:21.238Z");
});

Deno.test("extractNpmTimeMap - a time map split across chunk boundaries still parses (Issue #4390)", async () => {
  const doc = bigPackument(300 * 1024, {
    created: "c",
    modified: "m",
    "2.0.0": "2021-02-02T00:00:00.000Z",
  });
  for (const chunk of [7, 100, 1000]) {
    const time = await extractNpmTimeMap(streamOf(doc, chunk));
    assertEquals(time["2.0.0"], "2021-02-02T00:00:00.000Z");
  }
});

Deno.test("extractNpmTimeMap - a document with no top-level time map throws naming the gap (Issue #4390)", async () => {
  const doc = `{"name":"pkg","versions":{"1.0.0":{"time":{"built":"x"}}}}`;
  const error = await assertRejects(() => extractNpmTimeMap(streamOf(doc)));
  assertStringIncludes(String(error), "time");
});

Deno.test("extractNpmTimeMap - a hostile body over the streaming cap is refused, not held (Issue #4390)", async () => {
  // Never-ending JSON with no time map: the reader must give up at the cap.
  let sent = 0;
  const cap = 2 * 1024 * 1024;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > cap * 4) {
        controller.close();
        return;
      }
      const chunk = new TextEncoder().encode(
        `"k${sent}":"${"y".repeat(1000)}",`,
      );
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
  const error = await assertRejects(() =>
    extractNpmTimeMap(endless, { maxBodyBytes: cap })
  );
  assertStringIncludes(String(error), "exceeded");
});

Deno.test("fetchNpmTimeData - resolves a version's publish time from a packument over the old 16 MiB cap (Issue #4390)", async () => {
  const doc = bigPackument(17 * 1024 * 1024, {
    created: "c",
    modified: "m",
    "1.61.0-alpha-1778188671000": "2026-05-07T22:10:19.776Z",
  });
  await withStubbedFetch(
    (() =>
      Promise.resolve(
        new Response(streamOf(doc), { status: 200 }),
      )) as typeof globalThis.fetch,
    async () => {
      const time = await fetchNpmTimeData("playwright-core");
      assertEquals(
        time["1.61.0-alpha-1778188671000"],
        "2026-05-07T22:10:19.776Z",
      );
    },
  );
});
