/**
 * Tests for provider-scoped usage cooldowns (Issue #1696).
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  usageSignalBlocksProvider,
  usageSignalPausesHost,
} from "../lib/provider_quota_scope.ts";
import type { RateLimitSignalData } from "../lib/rate_limit_signal.ts";

function signal(
  kind: RateLimitSignalData["kind"],
  provider?: string,
): RateLimitSignalData {
  return {
    timestamp: 1,
    waitSeconds: 60,
    kind,
    ...(provider ? { provider } : {}),
  };
}

Deno.test("usageSignalBlocksProvider - GitHub blocks every provider", () => {
  const s = signal("github");
  assertEquals(usageSignalBlocksProvider(s, "claude"), true);
  assertEquals(usageSignalBlocksProvider(s, "codex"), true);
});

Deno.test("usageSignalBlocksProvider - Claude usage does not block Codex", () => {
  const s = signal("usage", "claude");
  assertEquals(usageSignalBlocksProvider(s, "claude"), true);
  assertEquals(usageSignalBlocksProvider(s, "codex"), false);
});

Deno.test("usageSignalBlocksProvider - a legacy usage signal is Claude", () => {
  const s = signal("usage");
  assertEquals(usageSignalBlocksProvider(s, "claude"), true);
  assertEquals(usageSignalBlocksProvider(s, "codex"), false);
});

Deno.test("usageSignalPausesHost - GitHub always pauses the host", () => {
  assertEquals(
    usageSignalPausesHost(signal("github"), ["claude", "codex"]),
    true,
  );
});

Deno.test("usageSignalPausesHost - Claude-only host pauses on Claude usage", () => {
  assertEquals(
    usageSignalPausesHost(signal("usage", "claude"), ["claude"]),
    true,
  );
});

Deno.test("usageSignalPausesHost - mixed host keeps going when Codex is healthy", () => {
  assertEquals(
    usageSignalPausesHost(signal("usage", "claude"), ["claude", "codex"]),
    false,
  );
});

Deno.test("usageSignalPausesHost - Codex usage does not pause a Claude-only host", () => {
  assertEquals(
    usageSignalPausesHost(signal("usage", "codex"), ["claude"]),
    false,
  );
});
