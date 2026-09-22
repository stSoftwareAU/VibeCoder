/**
 * Tests for the pace-aware provider fallback (Issue #2470).
 *
 * The week-pace guard (Issue #1885) parks the backlog when the preferred
 * provider's weekly quota is projected to run out. With an operator-named
 * fallback list, the backlog should instead run on the alternative provider:
 * the pure decision says which, and the tier-drop flag must flip off once a
 * fallback took the backlog — the scan, the census and the filer all read the
 * same adjusted verdict.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  paceFallbackProviderId,
  paceTierDrop,
} from "../lib/pace_provider_fallback.ts";
import type { ProviderFallbackPolicy } from "../lib/provider_fallback_policy.ts";

function policy(
  mode: ProviderFallbackPolicy["mode"],
  alternatives: readonly string[],
): ProviderFallbackPolicy {
  return {
    mode,
    preferred: "claude",
    alternatives,
    maxSwitches: 1,
  };
}

Deno.test("paceFallbackProviderId - an engaged guard with an ordered fallback names the first alternative", () => {
  assertEquals(
    paceFallbackProviderId({
      paceEngaged: true,
      policy: policy("ordered", ["deepseek"]),
    }),
    "deepseek",
  );
  assertEquals(
    paceFallbackProviderId({
      paceEngaged: true,
      policy: policy("ordered", ["deepseek", "gemini"]),
    }),
    "deepseek",
  );
});

Deno.test("paceFallbackProviderId - an unengaged guard never names a fallback", () => {
  assertEquals(
    paceFallbackProviderId({
      paceEngaged: false,
      policy: policy("ordered", ["deepseek"]),
    }),
    null,
  );
});

Deno.test("paceFallbackProviderId - a pinned policy or an empty list names nothing", () => {
  assertEquals(
    paceFallbackProviderId({
      paceEngaged: true,
      policy: policy("pinned", []),
    }),
    null,
  );
  assertEquals(
    paceFallbackProviderId({
      paceEngaged: true,
      policy: policy("ordered", []),
    }),
    null,
  );
});

Deno.test("paceTierDrop - the low tiers drop only while the guard is engaged and no fallback took the backlog", () => {
  // Engaged with no fallback — today's behaviour, unchanged.
  assertEquals(
    paceTierDrop({ paceEngaged: true, fallbackProviderId: null }),
    true,
  );
  // Engaged but a fallback provider took the backlog — tiers stay eligible.
  assertEquals(
    paceTierDrop({ paceEngaged: true, fallbackProviderId: "deepseek" }),
    false,
  );
  // Not engaged — never a drop.
  assertEquals(
    paceTierDrop({ paceEngaged: false, fallbackProviderId: null }),
    false,
  );
  assertEquals(
    paceTierDrop({ paceEngaged: false, fallbackProviderId: "deepseek" }),
    false,
  );
});
