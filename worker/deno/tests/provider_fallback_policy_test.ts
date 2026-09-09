/**
 * Tests for opt-in provider fallback (Issue #1700).
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  mayFallbackOn,
  nextFallbackProvider,
  resolveProviderFallbackPolicy,
} from "../lib/provider_fallback_policy.ts";

Deno.test("resolveProviderFallbackPolicy - omitted fallback is pinned", () => {
  const policy = resolveProviderFallbackPolicy({
    preferred: "claude",
    enabled: ["claude", "codex"],
  });
  assertEquals(policy.mode, "pinned");
  assertEquals(policy.alternatives, []);
});

Deno.test("resolveProviderFallbackPolicy - empty fallback is pinned", () => {
  const policy = resolveProviderFallbackPolicy({
    preferred: "claude",
    enabled: ["claude"],
    fallback: [],
  });
  assertEquals(policy.mode, "pinned");
});

Deno.test("resolveProviderFallbackPolicy - ordered list is opt-in", () => {
  const policy = resolveProviderFallbackPolicy({
    preferred: "claude",
    enabled: ["claude", "codex"],
    fallback: ["codex"],
  });
  assertEquals(policy.mode, "ordered");
  assertEquals(policy.alternatives, ["codex"]);
});

Deno.test("resolveProviderFallbackPolicy - refuses an unconfigured alternative", () => {
  assertThrows(
    () =>
      resolveProviderFallbackPolicy({
        preferred: "claude",
        enabled: ["claude"],
        fallback: ["codex"],
      }),
    Error,
    "not enabled",
  );
});

Deno.test("mayFallbackOn - pinned never switches", () => {
  const policy = resolveProviderFallbackPolicy({
    preferred: "claude",
    enabled: ["claude", "codex"],
  });
  assertEquals(mayFallbackOn(policy, "subscription-exhausted", 0), false);
});

Deno.test("mayFallbackOn - ordinary task failure never switches", () => {
  const policy = resolveProviderFallbackPolicy({
    preferred: "claude",
    enabled: ["claude", "codex"],
    fallback: ["codex"],
  });
  assertEquals(mayFallbackOn(policy, "ordinary-task-failure", 0), false);
  assertEquals(mayFallbackOn(policy, "authentication", 0), false);
  assertEquals(mayFallbackOn(policy, "subscription-exhausted", 0), true);
});

Deno.test("mayFallbackOn - switch budget is bounded", () => {
  const policy = resolveProviderFallbackPolicy({
    preferred: "claude",
    enabled: ["claude", "codex"],
    fallback: ["codex"],
    maxSwitches: 1,
  });
  assertEquals(mayFallbackOn(policy, "subscription-exhausted", 1), false);
});

Deno.test("nextFallbackProvider - does not ping-pong", () => {
  const policy = resolveProviderFallbackPolicy({
    preferred: "claude",
    enabled: ["claude", "codex"],
    fallback: ["codex"],
  });
  assertEquals(nextFallbackProvider(policy, "claude", []), "codex");
  assertEquals(nextFallbackProvider(policy, "codex", ["claude"]), null);
});
