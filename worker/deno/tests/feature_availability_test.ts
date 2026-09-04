/**
 * Tests for feature_availability.ts — graceful degradation system.
 *
 * Issue #907: Migrated from worker/shared/feature_availability.sh to Deno.
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";
import {
  checkGithubStatusAvailable,
  checkImgbbAvailable,
  createFeatureRegistry,
  registerBuiltinFeatures,
} from "../lib/feature_availability.ts";

// =============================================================================
// Feature Registration
// =============================================================================

Deno.test("feature_availability - register should accept valid inputs", () => {
  const registry = createFeatureRegistry();
  const result = registry.register("test-feature", () => true, "Test feature");
  assertEquals(result.ok, true);
});

Deno.test("feature_availability - register should reject empty name", () => {
  const registry = createFeatureRegistry();
  const result = registry.register("", () => true, "Feature with empty name");
  assertEquals(result.ok, false);
});

Deno.test("feature_availability - register should reject empty description", () => {
  const registry = createFeatureRegistry();
  const result = registry.register("some-feature", () => true, "");
  assertEquals(result.ok, false);
});

Deno.test("feature_availability - register should allow re-registration to update check", () => {
  const registry = createFeatureRegistry();
  registry.register("changing-feature", () => false, "Initially unavailable");

  // First check — unavailable
  assertEquals(registry.checkFeature("changing-feature"), false);
  assertEquals(registry.getStatus("changing-feature"), "degraded");

  // Re-register with a passing check and clear cache
  registry.clearCache();
  registry.register("changing-feature", () => true, "Now available");

  // Second check — available
  assertEquals(registry.checkFeature("changing-feature"), true);
  assertEquals(registry.getStatus("changing-feature"), "available");
});

// =============================================================================
// Feature Checking
// =============================================================================

Deno.test("feature_availability - checkFeature should return true for available feature", () => {
  const registry = createFeatureRegistry();
  registry.register("available-feature", () => true, "Always available");
  assertEquals(registry.checkFeature("available-feature"), true);
});

Deno.test("feature_availability - checkFeature should return false for unavailable feature", () => {
  const registry = createFeatureRegistry();
  registry.register("missing-feature", () => false, "Always missing");
  assertEquals(registry.checkFeature("missing-feature"), false);
});

Deno.test("feature_availability - checkFeature should return false for unregistered feature", () => {
  const registry = createFeatureRegistry();
  assertEquals(registry.checkFeature("nonexistent"), false);
});

Deno.test("feature_availability - checkFeature should cache results", () => {
  let callCount = 0;
  const registry = createFeatureRegistry();
  registry.register("cached-feature", () => {
    callCount++;
    return true;
  }, "Cached feature");

  registry.checkFeature("cached-feature");
  registry.checkFeature("cached-feature");
  registry.checkFeature("cached-feature");

  // Check should only run once due to caching
  assertEquals(callCount, 1);
});

Deno.test("feature_availability - checkFeature should handle throwing checks gracefully", () => {
  const registry = createFeatureRegistry();
  registry.register("throwing-feature", () => {
    throw new Error("boom");
  }, "Feature that throws");

  assertEquals(registry.checkFeature("throwing-feature"), false);
  assertEquals(registry.getStatus("throwing-feature"), "degraded");
});

// =============================================================================
// Status Reporting
// =============================================================================

Deno.test("feature_availability - getStatus should return available for working feature", () => {
  const registry = createFeatureRegistry();
  registry.register("status-feature", () => true, "Status feature");
  registry.checkFeature("status-feature");
  assertEquals(registry.getStatus("status-feature"), "available");
});

Deno.test("feature_availability - getStatus should return degraded for unavailable feature", () => {
  const registry = createFeatureRegistry();
  registry.register("broken-feature", () => false, "Broken feature");
  registry.checkFeature("broken-feature");
  assertEquals(registry.getStatus("broken-feature"), "degraded");
});

Deno.test("feature_availability - getStatus should return unknown for unchecked feature", () => {
  const registry = createFeatureRegistry();
  assertEquals(registry.getStatus("never-registered"), "unknown");
});

Deno.test("feature_availability - getStatus should return unknown for registered but unchecked feature", () => {
  const registry = createFeatureRegistry();
  registry.register("unchecked", () => true, "Not yet checked");
  assertEquals(registry.getStatus("unchecked"), "unknown");
});

// =============================================================================
// Cache Management
// =============================================================================

Deno.test("feature_availability - clearCache should allow re-checking features", () => {
  let callCount = 0;
  const registry = createFeatureRegistry();
  registry.register("recheck-feature", () => {
    callCount++;
    return true;
  }, "Recheck feature");

  registry.checkFeature("recheck-feature");
  registry.clearCache();
  registry.checkFeature("recheck-feature");

  // After clearing cache, check should run again
  assertEquals(callCount, 2);
});

// =============================================================================
// Batch Checking
// =============================================================================

Deno.test("feature_availability - checkAll should check all registered features", () => {
  const registry = createFeatureRegistry();
  registry.register("batch-a", () => true, "Batch A");
  registry.register("batch-b", () => true, "Batch B");

  const results = registry.checkAll();

  assertEquals(results.length, 2);
  assertEquals(results[0]!.status, "available");
  assertEquals(results[1]!.status, "available");
});

Deno.test("feature_availability - checkAll should not fail when some features are unavailable", () => {
  const registry = createFeatureRegistry();
  registry.register("working", () => true, "Works");
  registry.register("broken", () => false, "Broken");

  const results = registry.checkAll();

  assertEquals(results.length, 2);
  const working = results.find((r) => r.name === "working");
  const broken = results.find((r) => r.name === "broken");
  assertEquals(working!.status, "available");
  assertEquals(broken!.status, "degraded");
});

// =============================================================================
// Summary
// =============================================================================

Deno.test("feature_availability - getSummary should list all registered features", () => {
  const registry = createFeatureRegistry();
  registry.register("feat-a", () => true, "Feature A");
  registry.register("feat-b", () => false, "Feature B");

  registry.checkAll();
  const summary = registry.getSummary();

  assertEquals(summary.length, 2);
  const featA = summary.find((r) => r.name === "feat-a");
  const featB = summary.find((r) => r.name === "feat-b");
  assertEquals(featA!.status, "available");
  assertEquals(featB!.status, "degraded");
});

// =============================================================================
// Built-in feature checks
// =============================================================================

// The environment is handed in (Issue #968) rather than exported. Every value
// below is absent from the real process environment, so a check that quietly
// fell back to `Deno.env.get` would read the ambient worker configuration and
// go red here instead of passing on it.

Deno.test("checkImgbbAvailable - returns true when API key is set", () => {
  assertEquals(
    checkImgbbAvailable(envFrom({ VIBE_IMGBB_API_KEY: "test-api-key-123" })),
    true,
  );
});

Deno.test("checkImgbbAvailable - returns false when API key is empty", () => {
  assertEquals(checkImgbbAvailable(envFrom({ VIBE_IMGBB_API_KEY: "" })), false);
});

Deno.test("checkImgbbAvailable - returns false when API key is unset", () => {
  assertEquals(checkImgbbAvailable(emptyEnv), false);
});

Deno.test("checkGithubStatusAvailable - returns true when enabled", () => {
  assertEquals(
    checkGithubStatusAvailable(envFrom({ UPDATE_GH_USER_STATUS: "true" })),
    true,
  );
});

Deno.test("checkGithubStatusAvailable - returns false when disabled", () => {
  assertEquals(
    checkGithubStatusAvailable(envFrom({ UPDATE_GH_USER_STATUS: "false" })),
    false,
  );
});

Deno.test("checkGithubStatusAvailable - returns false when unset", () => {
  assertEquals(checkGithubStatusAvailable(emptyEnv), false);
});

// =============================================================================
// Built-in registration
// =============================================================================

Deno.test("registerBuiltinFeatures - registers imgbb and github-status", () => {
  const registry = createFeatureRegistry();
  registerBuiltinFeatures(registry);

  // Both built-in features should be registered (status "unknown" until checked)
  assertEquals(registry.getStatus("imgbb"), "unknown");
  assertEquals(registry.getStatus("github-status"), "unknown");

  // Issue #805: FLEET health tracking was removed — it is not a feature.
  // `getStatus` returns "unknown" for any unregistered name, so `checkAll()`
  // is what actually proves the registration is gone.
  assertEquals(
    registry.checkAll().some((r) => r.name === "health-tracking"),
    false,
    "health tracking must no longer be a registered feature",
  );

  // Deno should NOT be registered (it is a required dependency, not optional)
  assertEquals(registry.getStatus("deno"), "unknown");
});

Deno.test("registerBuiltinFeatures - checkAll should check all built-in features", () => {
  const registry = createFeatureRegistry();
  registerBuiltinFeatures(
    registry,
    envFrom({
      VIBE_IMGBB_API_KEY: "test-key",
      UPDATE_GH_USER_STATUS: "true",
    }),
  );
  const results = registry.checkAll();

  assertEquals(results.length, 2);
  for (const result of results) {
    assertEquals(result.status, "available");
  }
});

Deno.test("registerBuiltinFeatures - both built-ins degrade on an empty environment", () => {
  // The registered checks must read the environment they were given, not the
  // one the suite happens to run in — this is the assertion that fails if a
  // check falls back to `Deno.env.get` on a host that exports either key.
  const registry = createFeatureRegistry();
  registerBuiltinFeatures(registry, emptyEnv);

  assertEquals(registry.checkFeature("imgbb"), false);
  assertEquals(registry.checkFeature("github-status"), false);
  for (const result of registry.getSummary()) {
    assertEquals(result.status, "degraded");
  }
});
