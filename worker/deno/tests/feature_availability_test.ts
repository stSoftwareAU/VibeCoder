/**
 * Tests for feature_availability.ts — graceful degradation system.
 *
 * Issue #907: Migrated from worker/shared/feature_availability.sh to Deno.
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
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

Deno.test("checkImgbbAvailable - returns true when API key is set", () => {
  const original = Deno.env.get("VIBE_IMGBB_API_KEY");
  try {
    Deno.env.set("VIBE_IMGBB_API_KEY", "test-api-key-123");
    assertEquals(checkImgbbAvailable(), true);
  } finally {
    if (original !== undefined) {
      Deno.env.set("VIBE_IMGBB_API_KEY", original);
    } else {
      Deno.env.delete("VIBE_IMGBB_API_KEY");
    }
  }
});

Deno.test("checkImgbbAvailable - returns false when API key is empty", () => {
  const original = Deno.env.get("VIBE_IMGBB_API_KEY");
  try {
    Deno.env.set("VIBE_IMGBB_API_KEY", "");
    assertEquals(checkImgbbAvailable(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("VIBE_IMGBB_API_KEY", original);
    } else {
      Deno.env.delete("VIBE_IMGBB_API_KEY");
    }
  }
});

Deno.test("checkImgbbAvailable - returns false when API key is unset", () => {
  const original = Deno.env.get("VIBE_IMGBB_API_KEY");
  try {
    Deno.env.delete("VIBE_IMGBB_API_KEY");
    assertEquals(checkImgbbAvailable(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("VIBE_IMGBB_API_KEY", original);
    }
  }
});

Deno.test("checkGithubStatusAvailable - returns true when enabled", () => {
  const original = Deno.env.get("UPDATE_GH_USER_STATUS");
  try {
    Deno.env.set("UPDATE_GH_USER_STATUS", "true");
    assertEquals(checkGithubStatusAvailable(), true);
  } finally {
    if (original !== undefined) {
      Deno.env.set("UPDATE_GH_USER_STATUS", original);
    } else {
      Deno.env.delete("UPDATE_GH_USER_STATUS");
    }
  }
});

Deno.test("checkGithubStatusAvailable - returns false when disabled", () => {
  const original = Deno.env.get("UPDATE_GH_USER_STATUS");
  try {
    Deno.env.set("UPDATE_GH_USER_STATUS", "false");
    assertEquals(checkGithubStatusAvailable(), false);
  } finally {
    if (original !== undefined) {
      Deno.env.set("UPDATE_GH_USER_STATUS", original);
    } else {
      Deno.env.delete("UPDATE_GH_USER_STATUS");
    }
  }
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
  assertEquals(registry.getStatus("health-tracking"), "unknown");
  assertEquals(
    registry.checkAll().some((r) => r.name === "health-tracking"),
    false,
    "health tracking must no longer be a registered feature",
  );

  // Deno should NOT be registered (it is a required dependency, not optional)
  assertEquals(registry.getStatus("deno"), "unknown");
});

Deno.test("registerBuiltinFeatures - checkAll should check all built-in features", () => {
  const original = {
    imgbb: Deno.env.get("VIBE_IMGBB_API_KEY"),
    status: Deno.env.get("UPDATE_GH_USER_STATUS"),
  };

  try {
    Deno.env.set("VIBE_IMGBB_API_KEY", "test-key");
    Deno.env.set("UPDATE_GH_USER_STATUS", "true");

    const registry = createFeatureRegistry();
    registerBuiltinFeatures(registry);
    const results = registry.checkAll();

    assertEquals(results.length, 2);
    for (const result of results) {
      assertEquals(result.status, "available");
    }
  } finally {
    // Restore
    for (
      const [envKey, envVal] of [
        ["VIBE_IMGBB_API_KEY", original.imgbb],
        ["UPDATE_GH_USER_STATUS", original.status],
      ] as const
    ) {
      if (envVal !== undefined) {
        Deno.env.set(envKey, envVal);
      } else {
        Deno.env.delete(envKey);
      }
    }
  }
});
