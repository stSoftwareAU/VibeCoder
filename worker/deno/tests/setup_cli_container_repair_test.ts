/**
 * Tests for the macOS container-runtime repair wired into the setup CLI
 * (Issues #4136, #4138), plus the run-mode-aware wiring (Issue #4149).
 *
 * The repair flow and the full re-probe are both injected, so no case spawns
 * `brew`, `container` or any probe. What is pinned here is the wiring the CLI
 * depends on: when the repair is attempted at all, and whether the report the
 * operator finally sees is a patched one or a genuinely fresh one.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  prerequisiteSummaryLines,
  repairMacOsContainerRuntime,
} from "../setup/setup_cli.ts";
import type { AllPrerequisitesResult } from "../setup/prerequisites.ts";

/** A report whose container-runtime check failed, as a bare host produces. */
function failedReport(): AllPrerequisitesResult {
  return {
    ok: false,
    results: [
      { ok: true, tool: "git", message: "git is installed" },
      {
        ok: false,
        tool: "container runtime",
        message: "No supported container runtime is available on darwin.",
        hint: "install Apple container and run `container system start`",
      },
    ],
  };
}

/** The same report with the runtime answering. */
function repairedReport(): AllPrerequisitesResult {
  return {
    ok: true,
    results: [
      { ok: true, tool: "git", message: "git is installed" },
      {
        ok: true,
        tool: "container runtime",
        message: "Apple container is installed and answering (container)",
      },
    ],
  };
}

/** A fresh full probe — note the worker-image check the first report lacked. */
function freshReport(): AllPrerequisitesResult {
  return {
    ok: true,
    results: [
      ...repairedReport().results,
      { ok: true, tool: "worker image", message: "worker image is buildable" },
    ],
  };
}

Deno.test("repairMacOsContainerRuntime - a passing runtime is never repaired", async () => {
  const passing: AllPrerequisitesResult = repairedReport();
  let repairCalls = 0;
  let recheckCalls = 0;

  const result = await repairMacOsContainerRuntime(passing, {}, {
    repair: (report) => {
      repairCalls += 1;
      return Promise.resolve(report);
    },
    recheckAll: () => {
      recheckCalls += 1;
      return Promise.resolve(freshReport());
    },
  });

  assertEquals(result, passing, "the report must come back untouched");
  assertEquals(repairCalls, 0, "nothing may be offered for a passing check");
  assertEquals(recheckCalls, 0);
});

Deno.test("repairMacOsContainerRuntime - a repaired runtime re-runs the whole probe", async () => {
  let recheckCalls = 0;

  const result = await repairMacOsContainerRuntime(failedReport(), {}, {
    repair: () => Promise.resolve(repairedReport()),
    recheckAll: () => {
      recheckCalls += 1;
      return Promise.resolve(freshReport());
    },
  });

  // Patching the runtime result alone would leave the worker-image check
  // missing, because it never ran while no runtime answered (Issue #3234).
  assertEquals(recheckCalls, 1);
  assertEquals(result.results.map((r) => r.tool), [
    "git",
    "container runtime",
    "worker image",
  ]);
  assert(result.ok);
});

Deno.test("repairMacOsContainerRuntime - a declined repair keeps the failed report", async () => {
  let recheckCalls = 0;

  const result = await repairMacOsContainerRuntime(failedReport(), {}, {
    // A decline leaves the report exactly as the probe produced it.
    repair: (report) => Promise.resolve(report),
    recheckAll: () => {
      recheckCalls += 1;
      return Promise.resolve(freshReport());
    },
  });

  assertEquals(recheckCalls, 0, "a still-failing runtime must not re-probe");
  assertEquals(result, failedReport());
  assertEquals(result.ok, false, "a declined repair is never masked as ok");
});

// ── Run mode (Issues #4149, #4): container is the only one ───────────────

Deno.test("prerequisiteSummaryLines - names the mode it probed for", () => {
  assertEquals(prerequisiteSummaryLines(true, "container"), [
    "All host prerequisites satisfied (run mode: container)",
  ]);

  const containerFailure = prerequisiteSummaryLines(false, "container");
  assertStringIncludes(containerFailure[0]!, "run mode: container");
  assertStringIncludes(containerFailure[1]!, "container runtime");
  // The escape hatch stays documented.
  assertStringIncludes(containerFailure.join(" "), "VIBE_SKIP_PREREQ_CHECK");
});
