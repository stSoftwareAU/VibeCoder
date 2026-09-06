/**
 * Tests for heartbeat_freshness.ts — the bounded liveness check that stops a
 * forged or future-dated `.heartbeat_*` file pinning the disk sweeps off
 * (Issue #1232).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_HEARTBEAT_LIVE_WINDOW_SECONDS,
  HEARTBEAT_FUTURE_SKEW_SECONDS,
  isHeartbeatEpochLive,
  isHeartbeatFileLive,
  parseHeartbeatEpoch,
} from "../lib/heartbeat_freshness.ts";

const NOW = 1_786_000_000;
const WINDOW = DEFAULT_HEARTBEAT_LIVE_WINDOW_SECONDS;

Deno.test("isHeartbeatEpochLive - a fresh beat is live, a stale one is not", () => {
  assertEquals(isHeartbeatEpochLive(NOW - 60, NOW, WINDOW), true);
  assertEquals(isHeartbeatEpochLive(NOW, NOW, WINDOW), true);
  assertEquals(isHeartbeatEpochLive(NOW - WINDOW, NOW, WINDOW), true);
  assertEquals(isHeartbeatEpochLive(NOW - WINDOW - 1, NOW, WINDOW), false);
});

Deno.test("isHeartbeatEpochLive - a future-dated beat past the skew is never live", () => {
  // Modest skew stays live — a container clock a minute ahead of the reader.
  assertEquals(
    isHeartbeatEpochLive(NOW + HEARTBEAT_FUTURE_SKEW_SECONDS, NOW, WINDOW),
    true,
  );
  // Beyond the skew is forged: the attacker's `9999999999` and anything else
  // ahead of now by more than the tolerance.
  assertEquals(
    isHeartbeatEpochLive(NOW + HEARTBEAT_FUTURE_SKEW_SECONDS + 1, NOW, WINDOW),
    false,
  );
  assertEquals(isHeartbeatEpochLive(9_999_999_999, NOW, WINDOW), false);
});

Deno.test("isHeartbeatEpochLive - a non-finite epoch is not live", () => {
  assertEquals(isHeartbeatEpochLive(NaN, NOW, WINDOW), false);
  assertEquals(isHeartbeatEpochLive(Infinity, NOW, WINDOW), false);
});

Deno.test("parseHeartbeatEpoch - digits only, bounded to a plausible epoch", () => {
  assertEquals(parseHeartbeatEpoch(` ${NOW}\n`), NOW);
  assertEquals(parseHeartbeatEpoch("0"), 0);
  assertEquals(parseHeartbeatEpoch(""), null);
  assertEquals(parseHeartbeatEpoch("not-an-epoch"), null);
  assertEquals(parseHeartbeatEpoch("9999999999junk"), null);
  assertEquals(parseHeartbeatEpoch("-5"), null);
  // Millisecond-scale (13 digits) is not a second-precision epoch.
  assertEquals(parseHeartbeatEpoch("1786000000000"), null);
});

Deno.test("isHeartbeatFileLive - reads the epoch and bounds it at both ends", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.heartbeat_owner_repo_1`;

    await Deno.writeTextFile(path, `${NOW - 60}`);
    assertEquals(await isHeartbeatFileLive(path, NOW, WINDOW), true);

    await Deno.writeTextFile(path, `${NOW - 5 * 86400}`);
    assertEquals(await isHeartbeatFileLive(path, NOW, WINDOW), false);

    await Deno.writeTextFile(path, "9999999999");
    assertEquals(await isHeartbeatFileLive(path, NOW, WINDOW), false);

    assertEquals(
      await isHeartbeatFileLive(`${dir}/absent`, NOW, WINDOW),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isHeartbeatFileLive - unparseable content falls back to a bounded mtime", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/.heartbeat_owner_repo_1`;
    // A live worker's rewrite can be observed mid-truncation; its mtime is
    // fresh, so the file still reads as running.
    await Deno.writeTextFile(path, "");
    const fresh = new Date((NOW - 30) * 1000);
    await Deno.utime(path, fresh, fresh);
    assertEquals(await isHeartbeatFileLive(path, NOW, WINDOW), true);

    // The same fallback ages out — it is not an unbounded exemption.
    const old = new Date((NOW - 5 * 86400) * 1000);
    await Deno.utime(path, old, old);
    assertEquals(await isHeartbeatFileLive(path, NOW, WINDOW), false);

    // Nor can a future mtime pin it live.
    const ahead = new Date((NOW + 86400) * 1000);
    await Deno.utime(path, ahead, ahead);
    assertEquals(await isHeartbeatFileLive(path, NOW, WINDOW), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
