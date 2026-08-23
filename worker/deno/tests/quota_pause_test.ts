/**
 * Tests for the quota-pause declaration (Issue #342).
 *
 * A run that stops because the host is out of Claude quota must be
 * distinguishable from one that died. These tests pin the durable half of that
 * declaration — the marker file the run writes into the host-visible log
 * directory — and, in particular, that it is *consumed*: one declaration can
 * only ever explain the one launcher outcome it belongs to, so a later run that
 * crashes while the quota is still out is not excused by it.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  consumeQuotaPauseMarker,
  QUOTA_PAUSE_EXIT_STATUS,
  QUOTA_PAUSE_MARKER_MAX_AGE_SECONDS,
  quotaPauseMarkerPath,
  writeQuotaPauseMarker,
} from "../lib/quota_pause.ts";

async function withLogDir(
  fn: (logDir: string) => Promise<void>,
): Promise<void> {
  const logDir = await Deno.makeTempDir({ prefix: "vibe_quota_pause_" });
  try {
    await fn(logDir);
  } finally {
    await Deno.remove(logDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("quota pause - the exit status is outside every other launcher status", () => {
  // 0 clean, 87 wedged container, 124/137 supervisor deadline, 125-127 the
  // runtime CLI's own "could not start", ≥128 signal deaths.
  for (const taken of [0, 1, 87, 124, 125, 126, 127, 137]) {
    assert(
      QUOTA_PAUSE_EXIT_STATUS !== taken,
      `${QUOTA_PAUSE_EXIT_STATUS} collides with the ${taken} status`,
    );
  }
  assert(QUOTA_PAUSE_EXIT_STATUS > 0 && QUOTA_PAUSE_EXIT_STATUS < 128);
});

Deno.test("quota pause - a declaration round-trips through the marker", async () => {
  await withLogDir(async (logDir) => {
    const declaredAtMs = 1_700_000_000_000;
    const resetEpochMs = declaredAtMs + 3600_000;
    const written = await writeQuotaPauseMarker(logDir, {
      declaredAtMs,
      resetEpochMs,
      reason: "Run duration expired",
    });
    assert(written.ok, "the marker must be written");

    const marker = await consumeQuotaPauseMarker(logDir, {
      nowMs: declaredAtMs + 30_000,
    });
    assertEquals(marker?.declaredAtMs, declaredAtMs);
    assertEquals(marker?.resetEpochMs, resetEpochMs);
    assertEquals(marker?.reason, "Run duration expired");
  });
});

Deno.test("quota pause - the marker is consumed, so it explains one outcome only", async () => {
  await withLogDir(async (logDir) => {
    const declaredAtMs = 1_700_000_000_000;
    await writeQuotaPauseMarker(logDir, {
      declaredAtMs,
      reason: "out of quota",
    });

    assert(
      await consumeQuotaPauseMarker(logDir, { nowMs: declaredAtMs }),
      "the first read must see the declaration",
    );
    assertEquals(
      await consumeQuotaPauseMarker(logDir, { nowMs: declaredAtMs }),
      null,
      "a second launcher outcome must not be excused by the same marker",
    );
    // The file itself is gone, not merely ignored.
    await Deno.stat(quotaPauseMarkerPath(logDir))
      .then(() => {
        throw new Error("the marker file must be removed when consumed");
      })
      .catch((err) => {
        assert(err instanceof Deno.errors.NotFound, String(err));
      });
  });
});

Deno.test("quota pause - no marker is the healthy case and stays quiet", async () => {
  await withLogDir(async (logDir) => {
    const warnings: string[] = [];
    assertEquals(
      await consumeQuotaPauseMarker(logDir, { warn: (m) => warnings.push(m) }),
      null,
    );
    assertEquals(warnings, []);
  });
});

Deno.test("quota pause - a stale marker is discarded loudly, not believed", async () => {
  await withLogDir(async (logDir) => {
    const declaredAtMs = 1_700_000_000_000;
    await writeQuotaPauseMarker(logDir, {
      declaredAtMs,
      reason: "out of quota",
    });

    const warnings: string[] = [];
    const marker = await consumeQuotaPauseMarker(logDir, {
      nowMs: declaredAtMs + (QUOTA_PAUSE_MARKER_MAX_AGE_SECONDS + 60) * 1000,
      warn: (m) => warnings.push(m),
    });
    assertEquals(marker, null);
    assertEquals(warnings.length, 1);
    assert(warnings[0]?.includes("discarding"), warnings.join(" | "));
  });
});

Deno.test("quota pause - a corrupt marker is discarded loudly and removed", async () => {
  await withLogDir(async (logDir) => {
    await Deno.writeTextFile(quotaPauseMarkerPath(logDir), "{not json");

    const warnings: string[] = [];
    assertEquals(
      await consumeQuotaPauseMarker(logDir, { warn: (m) => warnings.push(m) }),
      null,
    );
    assertEquals(warnings.length, 1);
    assert(warnings[0]?.includes("unparseable"), warnings.join(" | "));

    // Removed, so it cannot be re-read on every subsequent outcome.
    assertEquals(
      await consumeQuotaPauseMarker(logDir, { warn: (m) => warnings.push(m) }),
      null,
    );
    assertEquals(warnings.length, 1);
  });
});

Deno.test("quota pause - a marker with no declaration time is not believed", async () => {
  await withLogDir(async (logDir) => {
    await Deno.writeTextFile(
      quotaPauseMarkerPath(logDir),
      JSON.stringify({ reason: "out of quota" }),
    );
    const warnings: string[] = [];
    assertEquals(
      await consumeQuotaPauseMarker(logDir, { warn: (m) => warnings.push(m) }),
      null,
    );
    assertEquals(warnings.length, 1);
  });
});

Deno.test("quota pause - writing without a log directory fails loud", async () => {
  const written = await writeQuotaPauseMarker("", {
    declaredAtMs: 1,
    reason: "out of quota",
  });
  assertEquals(written.ok, false);
});
