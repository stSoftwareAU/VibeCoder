/**
 * Tests for `lib/crates_io_age.ts` (stSoftwareAU/NEAT-AI-scorer#627).
 *
 * The release-age quarantine could resolve npm and JSR publish times only,
 * so every crates.io bump was refused as unverifiable. These tests drive
 * the real resolver through an injected `fetch` and assert the timestamp it
 * returns, and the failures that must yield `undefined` — an indeterminate
 * verdict — rather than a fabricated pass.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CRATES_IO_USER_AGENT,
  cratesVersionUrl,
  fetchCratesPublishTime,
} from "../lib/crates_io_age.ts";

/** A crates.io single-version document. */
function versionDoc(num: string, createdAt: string): string {
  return JSON.stringify({
    version: { id: 1, crate: "serde", num, created_at: createdAt },
  });
}

/** A `fetch` stand-in that records its calls and replies from a table. */
function stubFetch(
  reply: (url: string, init?: RequestInit) => Response | Promise<Response>,
  calls: { url: string; init?: RequestInit }[] = [],
) {
  const fetchFn = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(reply(String(url), init));
  };
  return { fetchFn, calls };
}

Deno.test("cratesVersionUrl - percent-encodes both path segments", () => {
  assertEquals(
    cratesVersionUrl("serde", "1.0.229"),
    "https://crates.io/api/v1/crates/serde/1.0.229",
  );
  assertStringIncludes(cratesVersionUrl("a/b", "1..%2F"), "a%2Fb");
});

Deno.test("fetchCratesPublishTime - returns the release's created_at", async () => {
  const { fetchFn, calls } = stubFetch(() =>
    new Response(versionDoc("1.0.229", "2026-07-18T23:05:13.266456Z"), {
      status: 200,
    })
  );
  assertEquals(
    await fetchCratesPublishTime("serde", "1.0.229", { fetchFn }),
    "2026-07-18T23:05:13.266456Z",
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.url, "https://crates.io/api/v1/crates/serde/1.0.229");
});

Deno.test("fetchCratesPublishTime - identifies itself, because crates.io 403s without a User-Agent", async () => {
  const { fetchFn, calls } = stubFetch(() =>
    new Response(versionDoc("1.0.229", "2026-07-18T23:05:13Z"), { status: 200 })
  );
  await fetchCratesPublishTime("serde", "1.0.229", { fetchFn });
  const headers = new Headers(calls[0]!.init?.headers);
  assertEquals(headers.get("user-agent"), CRATES_IO_USER_AGENT);
});

Deno.test("fetchCratesPublishTime - a document about another release is not an answer", async () => {
  const { fetchFn } = stubFetch(() =>
    new Response(versionDoc("1.0.228", "2025-09-27T16:51:35Z"), { status: 200 })
  );
  assertEquals(
    await fetchCratesPublishTime("serde", "1.0.229", { fetchFn }),
    undefined,
  );
});

Deno.test("fetchCratesPublishTime - a 404, a 403 and a 500 are all indeterminate", async () => {
  for (const status of [403, 404, 500]) {
    const { fetchFn } = stubFetch(() => new Response("nope", { status }));
    assertEquals(
      await fetchCratesPublishTime("serde", "1.0.229", { fetchFn }),
      undefined,
      `status ${status}`,
    );
  }
});

Deno.test("fetchCratesPublishTime - an unparseable or shapeless body is indeterminate", async () => {
  for (const body of ["not json", "{}", '{"version":null}', '{"version":{}}']) {
    const { fetchFn } = stubFetch(() => new Response(body, { status: 200 }));
    assertEquals(
      await fetchCratesPublishTime("serde", "1.0.229", { fetchFn }),
      undefined,
      body,
    );
  }
});

Deno.test("fetchCratesPublishTime - a thrown fetch never escapes", async () => {
  const fetchFn = () => Promise.reject(new Error("connection reset"));
  assertEquals(
    await fetchCratesPublishTime("serde", "1.0.229", { fetchFn }),
    undefined,
  );
});

Deno.test("fetchCratesPublishTime - an oversized body is refused, not truncated", async () => {
  const { fetchFn } = stubFetch(() =>
    new Response("x".repeat(4096), { status: 200 })
  );
  assertEquals(
    await fetchCratesPublishTime("serde", "1.0.229", {
      fetchFn,
      maxBytes: 128,
    }),
    undefined,
  );
});

Deno.test("fetchCratesPublishTime - a crate name or version that is not URL-safe is never requested", async () => {
  const { fetchFn, calls } = stubFetch(() =>
    new Response(versionDoc("1.0.229", "2026-07-18T23:05:13Z"), { status: 200 })
  );
  for (
    const [crate, version] of [
      ["../../secrets", "1.0.0"],
      ["serde", "../../etc/passwd"],
      ["", "1.0.0"],
      ["serde", ""],
    ]
  ) {
    assertEquals(
      await fetchCratesPublishTime(crate!, version!, { fetchFn }),
      undefined,
      `${crate}@${version}`,
    );
  }
  assertEquals(calls.length, 0);
});
