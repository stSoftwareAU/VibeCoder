/**
 * Feature availability and graceful degradation system.
 *
 * Provides a centralised registry for optional features, checks their
 * availability, caches results, and reports status. This makes the worker
 * more resilient in environments where not all optional dependencies are
 * installed (e.g., ImgBB API key, health tracking).
 *
 * Note: Deno is a required dependency, not an optional feature (Issue #518).
 * The Deno worker driver verifies it at bootstrap (run_bootstrap.ts).
 *
 * Issue #196: Implement graceful degradation for optional features.
 * Issue #907: Migrated from worker/shared/feature_availability.sh to Deno.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/**
 * Feature status — tracks whether a feature is available, degraded, or unknown.
 */
export type FeatureStatus = "available" | "degraded" | "unknown";

/**
 * A registered feature with its check function and metadata.
 */
export interface Feature {
  /** Unique feature identifier (e.g., "imgbb", "health-tracking") */
  name: string;
  /** Human-readable description for logging */
  description: string;
  /** Function that returns true if the feature is available */
  check: () => boolean;
  /** Current cached status */
  status: FeatureStatus;
}

/**
 * Summary of a feature check result.
 */
export interface FeatureCheckResult {
  name: string;
  description: string;
  status: FeatureStatus;
}

/**
 * Feature registry — manages optional features with caching and status tracking.
 */
export interface FeatureRegistry {
  /** Register an optional feature with a check function */
  register(
    name: string,
    check: () => boolean,
    description: string,
  ): Result<void>;
  /** Check if a feature is available (uses cached result if available) */
  checkFeature(name: string): boolean;
  /** Get the current status of a feature */
  getStatus(name: string): FeatureStatus;
  /** Clear all cached statuses, forcing re-evaluation on next check */
  clearCache(): void;
  /** Check all registered features */
  checkAll(): FeatureCheckResult[];
  /** Get a summary of all feature statuses */
  getSummary(): FeatureCheckResult[];
}

/**
 * Create a new feature registry.
 */
export function createFeatureRegistry(): FeatureRegistry {
  const features = new Map<string, Feature>();

  return {
    register(
      name: string,
      check: () => boolean,
      description: string,
    ): Result<void> {
      if (!name || !description) {
        return {
          ok: false,
          error: new Error(
            "register: name and description must be non-empty",
          ),
        };
      }

      const existing = features.get(name);
      if (existing) {
        // Update existing registration
        existing.check = check;
        existing.description = description;
      } else {
        features.set(name, { name, description, check, status: "unknown" });
      }

      return { ok: true, value: undefined };
    },

    checkFeature(name: string): boolean {
      const feature = features.get(name);
      if (!feature) {
        return false;
      }

      // Return cached result if already checked
      if (feature.status === "available") return true;
      if (feature.status === "degraded") return false;

      // Run the check
      try {
        const isAvailable = feature.check();
        feature.status = isAvailable ? "available" : "degraded";
        return isAvailable;
      } catch {
        feature.status = "degraded";
        return false;
      }
    },

    getStatus(name: string): FeatureStatus {
      const feature = features.get(name);
      return feature?.status ?? "unknown";
    },

    clearCache(): void {
      for (const feature of features.values()) {
        feature.status = "unknown";
      }
    },

    checkAll(): FeatureCheckResult[] {
      const results: FeatureCheckResult[] = [];
      for (const feature of features.values()) {
        this.checkFeature(feature.name);
        results.push({
          name: feature.name,
          description: feature.description,
          status: feature.status,
        });
      }
      return results;
    },

    getSummary(): FeatureCheckResult[] {
      const results: FeatureCheckResult[] = [];
      for (const feature of features.values()) {
        results.push({
          name: feature.name,
          description: feature.description,
          status: feature.status,
        });
      }
      return results;
    },
  };
}

// =============================================================================
// Built-in feature checks for known optional dependencies
// =============================================================================

/**
 * Check if ImgBB API key is configured.
 *
 * Returns true if VIBE_IMGBB_API_KEY is set and non-empty.
 */
export function checkImgbbAvailable(): boolean {
  const key = Deno.env.get("VIBE_IMGBB_API_KEY");
  return key !== undefined && key !== "";
}

/**
 * Check if GitHub user status updates are available.
 *
 * Returns true if UPDATE_GH_USER_STATUS is set to "true".
 */
export function checkGithubStatusAvailable(): boolean {
  const enabled = Deno.env.get("UPDATE_GH_USER_STATUS");
  return enabled === "true";
}

/**
 * Register all known built-in optional features.
 *
 * Call this at worker startup to register the built-in feature checks.
 * Note: Deno is a required dependency (Issue #518), not an optional feature.
 */
export function registerBuiltinFeatures(registry: FeatureRegistry): void {
  registry.register(
    "imgbb",
    checkImgbbAvailable,
    "ImgBB API for automatic screenshot uploads",
  );
  registry.register(
    "github-status",
    checkGithubStatusAvailable,
    "GitHub user profile status updates",
  );
}
