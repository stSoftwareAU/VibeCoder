/**
 * Tests for per-spawn eligible selection (Issue #1696).
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { CODEX_QUOTA_POLICY } from "../lib/provider_quota.ts";
import { selectEligibleQuota } from "../lib/provider_quota_scheduler.ts";

const NOW = Date.UTC(2026, 8, 10, 0, 0, 0);
const HOUR = 3_600_000;

Deno.test("selectEligibleQuota - refuses when every credential is exhausted", () => {
  const logs: string[] = [];
  const chosen = selectEligibleQuota(
    [{
      providerId: "codex",
      credentialLabel: "spent",
      budget: {
        known: true,
        windows: [{
          name: "primary",
          remainingFraction: 0,
          resetAt: NOW + 24 * HOUR,
          nominalHours: 168,
        }],
      },
    }],
    NOW,
    CODEX_QUOTA_POLICY,
    (line) => logs.push(line),
  );
  assertEquals(chosen, null);
  assertEquals(logs.length, 1);
  assertEquals(logs[0]?.includes("codex/spent"), true);
});

Deno.test("selectEligibleQuota - picks the usable credential of two", () => {
  const chosen = selectEligibleQuota(
    [
      {
        providerId: "codex",
        credentialLabel: "spent",
        budget: {
          known: true,
          windows: [{
            name: "primary",
            remainingFraction: 0,
            resetAt: NOW + 24 * HOUR,
            nominalHours: 168,
          }],
        },
      },
      {
        providerId: "codex",
        credentialLabel: "ok",
        budget: {
          known: true,
          windows: [{
            name: "primary",
            remainingFraction: 0.4,
            resetAt: NOW + 48 * HOUR,
            nominalHours: 168,
          }],
        },
      },
    ],
    NOW,
    CODEX_QUOTA_POLICY,
  );
  assertEquals(chosen?.credentialLabel, "ok");
});
