/**
 * Tests verifying that obsolete bash scripts removed in Issue #1177
 * have complete Deno TypeScript replacements.
 *
 * Removed scripts:
 *   - worker/shared/audit script → worker/deno/lib/quality_gate.ts (perf audit)
 *   - worker/diagnose-repo.sh → worker/deno/commands/diagnose_repo.ts
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDefaultRegistry } from "../mod.ts";
import { type QualityGateConfig, runQualityGate } from "../lib/quality_gate.ts";
import {
  type BlockingLabelReason,
  formatLabels,
  generateSummary,
  getBlockingLabelReasons,
  type LabelConfig,
  type SummaryCounts,
} from "../lib/diagnose_repo.ts";

// =============================================================================
// diagnose-repo.sh replacement — Deno command registration (Issue #1177)
// =============================================================================

Deno.test("obsolete script removal - diagnose-repo command is registered", () => {
  const registry = createDefaultRegistry();
  assertEquals(registry.has("diagnose-repo"), true);
});

Deno.test("obsolete script removal - diagnose-repo command has description", () => {
  const registry = createDefaultRegistry();
  const descriptions = registry.listWithDescriptions();
  const diagnoseRepo = descriptions.find((d) => d.name === "diagnose-repo");
  assertEquals(diagnoseRepo !== undefined, true);
  if (diagnoseRepo) {
    assertEquals(diagnoseRepo.description.length > 0, true);
  }
});

Deno.test("obsolete script removal - diagnose-repo Deno library formats labels", () => {
  assertEquals(formatLabels(["bug", "help wanted"]), "bug, help wanted");
  assertEquals(formatLabels([]), "none");
});

Deno.test("obsolete script removal - diagnose-repo Deno library detects blocking labels", () => {
  const config: LabelConfig = {
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    // Issue #2031: needs-clarification retired; needs-human is the handoff label.
    needsHumanLabel: "needs-human",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
  };

  const reasons: BlockingLabelReason[] = getBlockingLabelReasons(
    ["failed"],
    config,
  );
  assertEquals(reasons.length > 0, true);
  assertStringIncludes(reasons[0]!.reason, "failed");
});

Deno.test("obsolete script removal - diagnose-repo Deno library generates summary", () => {
  const counts: SummaryCounts = {
    totalIssues: 5,
    eligibleCount: 0,
    prBlockedCount: 2,
    labelBlockedCount: 3,
    dependencyBlockedCount: 0,
    otherBlockedCount: 0,
  };
  const summary = generateSummary(counts);
  assertStringIncludes(summary.formatted, "5");
  assertEquals(summary.totalIssues, 5);
  assertEquals(summary.eligibleCount, 0);
});

// =============================================================================
// benchmark_audit.sh replacement — quality_gate.ts audit (Issue #1177)
// =============================================================================

Deno.test("obsolete script removal - quality gate perf audit passes for clean test files", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const testsDir = `${tmpDir}/worker/deno/tests`;
  Deno.mkdirSync(testsDir, { recursive: true });

  Deno.writeTextFileSync(
    `${testsDir}/clean_test.ts`,
    `Deno.test("should validate input correctly", () => {\n  // clean test\n});\n`,
  );

  const config: QualityGateConfig = {
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
    options: { strict: false, sequential: true, validatePrompts: false },
  };
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const auditCheck = result.value.checks.find((c) =>
      c.name.includes("audit")
    );
    assertEquals(auditCheck !== undefined, true);
    if (auditCheck) {
      assertEquals(auditCheck.status, "PASSED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("obsolete script removal - quality gate perf audit detects violations", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const testsDir = `${tmpDir}/worker/deno/tests`;
  Deno.mkdirSync(testsDir, { recursive: true });

  const prefix = "bench";
  const violatingContent = `Deno.test("${prefix}mark_sorting", () => {});\n`;
  Deno.writeTextFileSync(`${testsDir}/violation_test.ts`, violatingContent);

  const config: QualityGateConfig = {
    scriptDir: tmpDir,
    denoDir: `${tmpDir}/worker/deno`,
    options: { strict: false, sequential: true, validatePrompts: false },
  };
  const result = await runQualityGate(config);

  assertEquals(result.ok, true);
  if (result.ok) {
    const auditCheck = result.value.checks.find((c) =>
      c.name.includes("audit")
    );
    assertEquals(auditCheck !== undefined, true);
    if (auditCheck) {
      assertEquals(auditCheck.status, "FAILED");
    }
  }

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

// =============================================================================
// Remaining shell scripts are essential orchestration (Issue #1177)
// =============================================================================

Deno.test("obsolete script removal - removed scripts no longer exist", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const removedScripts = [
    "worker/diagnose-repo.sh",
    "worker/shared/benchmark_audit.sh",
    // Issue #3504: the bash conductor and its shadow-copy are gone.
    "worker/run_core.sh",
    "worker/.run_core.sh",
    // Issue #3661 (SEC-bfdd5fa86313): the unsourced 1,973-line bash driver is
    // gone — it was still shipped and `git pull`-refreshed onto every worker
    // host despite nothing invoking it.
    "worker/issue_worker.sh",
    // Issue #97: the last two bash bridges. Nothing sourced deno_bridge.sh at
    // runtime, and config_defaults.sh's only reader (the quality gate's config
    // integration check) now seeds its empty arrays inline. Both were shipped
    // and `git pull`-refreshed onto every host with no runtime consumer.
    "worker/shared/deno_bridge.sh",
    "worker/shared/config_defaults.sh",
  ];

  for (const script of removedScripts) {
    let exists = true;
    try {
      await Deno.stat(`${repoRoot}${script}`);
    } catch {
      exists = false;
    }
    assertEquals(
      exists,
      false,
      `${script} should have been removed`,
    );
  }
});
