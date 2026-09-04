/**
 * Tests for the rate-limit signal's block kind (Issue #855).
 *
 * Fleet telemetry has to tell "we ran out of GitHub calls" from "we ran
 * out of model tokens", and the shared signal file is the only record the
 * pausing loop sees.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  readRateLimitBlockKind,
  readRateLimitSignal,
  writeRateLimitSignal,
} from "../lib/rate_limit_signal.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "rate-limit-kind-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("rate_limit_signal - a usage-limit signal records its kind", async () => {
  await withTempDir(async (dir) => {
    const written = await writeRateLimitSignal(dir, 300, undefined, "usage");
    assertEquals(written.ok, true);
    const read = await readRateLimitSignal(dir);
    assertEquals(read.ok && read.value.kind, "usage");
    assertEquals(await readRateLimitBlockKind(dir), "usage");
  });
});

Deno.test("rate_limit_signal - the default kind is a GitHub rate limit", async () => {
  await withTempDir(async (dir) => {
    await writeRateLimitSignal(dir, 60);
    assertEquals(await readRateLimitBlockKind(dir), "github");
  });
});

Deno.test("rate_limit_signal - a signal predating the kind field reads as github", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/.rate_limit_signal`,
      JSON.stringify({ timestamp: 1, waitSeconds: 60 }),
    );
    assertEquals(await readRateLimitBlockKind(dir), "github");
  });
});

Deno.test("rate_limit_signal - a missing signal reads as github", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readRateLimitBlockKind(dir), "github");
  });
});

Deno.test("rate_limit_signal - an unrecognised kind falls back to github", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/.rate_limit_signal`,
      JSON.stringify({ timestamp: 1, waitSeconds: 60, kind: "bogus" }),
    );
    assertEquals(await readRateLimitBlockKind(dir), "github");
  });
});
