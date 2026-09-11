/** Process-local failure memory tests for automatic routing (Issue #1926). */

import { assertEquals } from "@std/assert";
import {
  automaticProviderOutage,
  DEFAULT_AUTO_PROVIDER_QUOTA_RECHECK_MS,
  recordAutomaticProviderOutage,
  resetAutomaticProviderState,
  setAutomaticProviderRoutingActive,
} from "../lib/provider_auto_state.ts";

const NOW = 20_000_000;

function withCleanState(fn: () => void): void {
  resetAutomaticProviderState();
  try {
    fn();
  } finally {
    resetAutomaticProviderState();
  }
}

Deno.test("automatic outage memory is inert in pinned mode", () => {
  withCleanState(() => {
    recordAutomaticProviderOutage("claude", "authentication", {
      observedAt: NOW,
    });
    assertEquals(automaticProviderOutage("claude", NOW), undefined);
  });
});

Deno.test("authentication outage remains unavailable for this process", () => {
  withCleanState(() => {
    setAutomaticProviderRoutingActive(true);
    recordAutomaticProviderOutage("claude", "authentication", {
      observedAt: NOW,
    });

    assertEquals(automaticProviderOutage("claude", NOW + 86_400_000), {
      provider: "claude",
      category: "authentication",
      observedAt: NOW,
    });
  });
});

Deno.test("quota outage suppresses probes only until the stated reset", () => {
  withCleanState(() => {
    const retryAt = NOW + 60_000;
    setAutomaticProviderRoutingActive(true);
    recordAutomaticProviderOutage("codex", "quota-exhausted", {
      observedAt: NOW,
      retryAt,
    });

    assertEquals(
      automaticProviderOutage("codex", retryAt - 1)?.retryAt,
      retryAt,
    );
    assertEquals(automaticProviderOutage("codex", retryAt), undefined);
    assertEquals(automaticProviderOutage("codex", retryAt + 1), undefined);
  });
});

Deno.test("quota outage without a reset uses a bounded recheck cooldown", () => {
  withCleanState(() => {
    setAutomaticProviderRoutingActive(true);
    recordAutomaticProviderOutage("codex", "quota-exhausted", {
      observedAt: NOW,
    });

    assertEquals(
      automaticProviderOutage(
        "codex",
        NOW + DEFAULT_AUTO_PROVIDER_QUOTA_RECHECK_MS - 1,
      )?.retryAt,
      NOW + DEFAULT_AUTO_PROVIDER_QUOTA_RECHECK_MS,
    );
    assertEquals(
      automaticProviderOutage(
        "codex",
        NOW + DEFAULT_AUTO_PROVIDER_QUOTA_RECHECK_MS,
      ),
      undefined,
    );
  });
});
