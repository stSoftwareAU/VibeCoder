/**
 * In-flight host disk floor (Issue #4360).
 *
 * The 46 GB floor used to gate only new claims. A build already running could
 * fill the host, the guest went read-only, and the fallout (a security-fix
 * gate block, a failed callback) was charged to the issue. These tests pin
 * the decision with an injected reading: a read-only or no-space failure is a
 * host fault, and a build below the floor is parked as infrastructure.
 *
 * The live fill (60 GB to 0) is not reproduced here.
 *
 * A quality-fix agent and a security-fix retry that stop for this disk return
 * `internal_error` at once. The quality loop does not start another gate run,
 * and the security-fix retry does not report a gate block.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  detectHostFault,
  hostDiskInfrastructureFailure,
} from "../lib/host_fault.ts";
import { SECURITY_FIX_GATE_MARKER } from "../lib/failure_diagnosis.ts";
import { classifyRunFailure } from "../lib/run_outcome_classifier.ts";
import {
  classifyCodingFailure,
  planCodingFailure,
} from "../lib/coding_failure_ladder.ts";
import {
  type HeavyBuildDiskReading,
  hostDiskLaunchStopReason,
  inFlightParkReason,
} from "../lib/heavy_build_gate.ts";
import { formatRootFilesystemFault } from "../lib/root_filesystem_fault.ts";
import { invokeMutationCheck } from "../lib/mutation_check_invocation.ts";
import {
  defaultMutationRunnerSeams,
  mutationChildEnv,
  type MutationRunnerSeams,
} from "../lib/mutation_runner.ts";
import { runSecurityFixDiscrimination } from "../lib/security_fix_discrimination.ts";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import { recoverFromSecurityGateBlock } from "../lib/security_fix_gate_retry.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { CheckResult } from "../lib/quality_helpers.ts";
import type { GitHubClient } from "../types.ts";

/** The discrimination failure the guest wrote once `/` was read-only. */
const READ_ONLY_DISCRIMINATION =
  "discrimination runner failed: Read-only file system (os error 30): tmpdir";

Deno.test("Issue #4360 - os error 30 is a disk-full host fault, not an issue failure", () => {
  assertEquals(
    detectHostFault(READ_ONLY_DISCRIMINATION, "internal_error"),
    "disk-full",
  );
  const classified = classifyRunFailure(
    "internal_error",
    READ_ONLY_DISCRIMINATION,
    true,
  );
  assertEquals(classified.failureClass, "disk-full");
  const decision = classifyCodingFailure(
    READ_ONLY_DISCRIMINATION,
    "internal_error",
  );
  assertEquals(decision.disposition, "transient");
  const plan = planCodingFailure({
    success: false,
    expectedSkip: false,
    reason: READ_ONLY_DISCRIMINATION,
    category: "internal_error",
  });
  assertEquals(plan.applyLadder, false);
});

Deno.test("Issue #4360 - a marked security-fix gate quoting os error 30 stays an issue failure", () => {
  const marked =
    `${SECURITY_FIX_GATE_MARKER}: Read-only file system (os error 30): tmpdir`;
  assertEquals(detectHostFault(marked, "security_fix_gate"), null);
  assertEquals(
    classifyRunFailure("security_fix_gate", marked, true).failureClass,
    "agent-outcome",
  );
  assertEquals(
    classifyCodingFailure(marked, "security_fix_gate").disposition,
    "ladder",
  );
});

Deno.test("Issue #4360 - ENOSPC and 'No space left on device' stay disk-full", () => {
  for (
    const message of [
      "No space left on device",
      "write failed: ENOSPC",
    ]
  ) {
    assertEquals(detectHostFault(message, "internal_error"), "disk-full");
    assertEquals(
      classifyRunFailure("internal_error", message, true).failureClass,
      "disk-full",
    );
  }
  assert(
    classifyRunFailure(
      "internal_error",
      READ_ONLY_DISCRIMINATION,
      true,
    ).failureClass ===
      classifyRunFailure(
        "internal_error",
        "write failed: ENOSPC",
        true,
      ).failureClass,
    "one failure class, so the existing filer dedupes them onto one alert",
  );
});

const GB = 1_073_741_824;

function reading(
  level: "ok" | "low" | "unknown",
  trimRefused: boolean,
  free = 60 * GB,
): HeavyBuildDiskReading {
  return {
    status: {
      level,
      availableBytes: free,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: level === "low"
        ? "host (estimated from the launcher's reading 5 min ago) 6.9 GB free (1.5%) of 460.4 GB, floor 46.0 GB — below the floor"
        : "60.0 GB free, floor 46.0 GB",
    },
    floorBytes: 46 * GB,
    trimRefused,
  };
}

Deno.test("Issue #4360 - a low trim-refused reading ends the launch; above the floor it does not", () => {
  const stop = hostDiskLaunchStopReason(reading("low", true, 6.9 * GB));
  assert(stop !== null);
  assertStringIncludes(stop!, "46.0 GB");
  assertStringIncludes(stop!, "trim was refused");
  assertStringIncludes(stop!, "Issue #4360");
  assertEquals(
    formatRootFilesystemFault({ path: "host disk", detail: stop! })
      .startsWith("[HOST_DISK_LOW]"),
    true,
  );
  assertEquals(
    formatRootFilesystemFault({ path: "host disk", detail: stop! })
      .includes("ROOT_FS"),
    false,
  );
  assertEquals(hostDiskLaunchStopReason(reading("low", false)), null);
  assertEquals(hostDiskLaunchStopReason(reading("ok", true)), null);
  assertEquals(hostDiskLaunchStopReason(reading("unknown", true)), null);
});

Deno.test("Issue #4360 - a parked build names the floor and is not a gate verdict", () => {
  const parked = inFlightParkReason(
    "host disk below its floor — floor 46.0 GB (Issue #3178)",
  );
  assert(parked !== null);
  assertStringIncludes(parked!, "46.0 GB");
  assertStringIncludes(parked!, "Parked as infrastructure (Issue #4360).");
  const fault = hostDiskInfrastructureFailure(parked!);
  assertEquals(fault?.category, "internal_error");
  assertEquals(
    detectHostFault(
      `${SECURITY_FIX_GATE_MARKER}: ${parked}`,
      "security_fix_gate",
    ),
    null,
  );
  assertEquals(inFlightParkReason(null), null);
});

Deno.test("Issue #4360 - discrimination does not start cargo when the host is below the floor", async () => {
  const calls: string[] = [];
  const seams = {
    runProcess: (cmd: string) => {
      calls.push(cmd);
      throw new Error("cargo must not start");
    },
  } as unknown as MutationRunnerSeams;
  const result = await runSecurityFixDiscrimination(
    {
      repoPath: "/checkout",
      baseRef: "main",
      productionFiles: ["src/sanitise.ts"],
      tests: [{
        file: "tests/sanitise_test.ts",
        name: "rejects a forged token",
      }],
      budgetSeconds: 60,
    },
    seams,
    () =>
      Promise.resolve(
        "host disk below its floor — floor 46.0 GB. Parked as infrastructure (Issue #4360).",
      ),
  );
  assertEquals(calls, []);
  assertEquals(result.kind, "not_checked");
  if (result.kind !== "not_checked") return;
  const fault = hostDiskInfrastructureFailure(result.reason);
  assertEquals(fault?.status, "failure");
  assertEquals(fault?.category, "internal_error");
  assertEquals(
    classifyRunFailure("internal_error", result.reason, true).failureClass,
    "disk-full",
  );
});

Deno.test("Issue #4360 - mutation check does not start the runner when the host is below the floor", async () => {
  let ran = false;
  const result = await invokeMutationCheck({
    repo: "acme/widgets",
    repoPath: "/checkout",
    repoConfigs: undefined,
    runner: () => {
      ran = true;
      throw new Error("runner must not start");
    },
    collectDiff: () => {
      throw new Error("diff must not run");
    },
    logger: { info: () => {}, warn: () => {} },
    parkBuild: () =>
      Promise.resolve(
        "host disk below its floor — floor 46.0 GB. Parked as infrastructure (Issue #4360).",
      ),
  });
  assertEquals(ran, false);
  assertEquals(result.kind, "error");
  if (result.kind !== "error") return;
  assertEquals(
    planCodingFailure({
      success: false,
      expectedSkip: false,
      reason: result.reason,
      category: "internal_error",
    }).applyLadder,
    false,
  );
});

Deno.test("Issue #4360 - cargo and deno take the ephemeral target when the trim is refused; git does not", () => {
  const cargo = mutationChildEnv("cargo", "/checkout/widgets", {
    trimRefused: true,
    root: "/var/tmp/vibe-cargo-target",
    source: { PATH: "/usr/bin" },
  });
  assertStringIncludes(
    cargo["CARGO_TARGET_DIR"] ?? "",
    "/var/tmp/vibe-cargo-target/",
  );
  const deno = mutationChildEnv("deno", "/checkout/widgets", {
    trimRefused: true,
    root: "/var/tmp/vibe-cargo-target",
    source: { PATH: "/usr/bin" },
  });
  assert(deno["CARGO_TARGET_DIR"] !== undefined);
  const git = mutationChildEnv("git", "/checkout/widgets", {
    trimRefused: true,
    root: "/var/tmp/vibe-cargo-target",
    source: { PATH: "/usr/bin" },
  });
  assertEquals(git["CARGO_TARGET_DIR"], undefined);
  const honoured = mutationChildEnv("cargo", "/checkout/widgets", {
    trimRefused: false,
    root: "/var/tmp/vibe-cargo-target",
    source: { PATH: "/usr/bin" },
  });
  assertEquals(honoured["CARGO_TARGET_DIR"], undefined);
});

Deno.test("Issue #4360 - a running build is stopped when the disk reading crosses the floor", async () => {
  const seams = defaultMutationRunnerSeams(undefined, 50, {
    diskPollMs: 20,
    park: () =>
      Promise.resolve(
        "host disk below its floor — floor 46.0 GB. Parked as infrastructure (Issue #4360).",
      ),
  });
  const error = await assertRejects(
    () => seams.runProcess("sleep", ["30"], { cwd: "/tmp", timeoutMs: 10_000 }),
    Error,
    "Parked as infrastructure (Issue #4360).",
  );
  assertEquals(
    detectHostFault(error.message, "internal_error"),
    "disk-full",
  );
});

/** The park sentence a stopped agent returns when the host is below the floor. */
function parkedForHostDisk(): string {
  const parked = inFlightParkReason(
    "host disk below its floor — floor 46.0 GB (Issue #3178)",
  );
  assert(parked !== null);
  return parked;
}

function diskFloorContext(): IssueContext {
  const config = buildDefaultWorkerConfig();
  // A mistaken infrastructure retry must fail the assertion, not sleep.
  config.infraRetryBackoffMs = 0;
  return {
    repo: "acme/widgets",
    issueNumber: 4360,
    issueTitle: "Host disk floor",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function diskFloorState(repoPath: string): PhaseState {
  return {
    branchName: "issue-4360",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    baselineFailedChecks: [],
  };
}

Deno.test("Issue #4360 - a quality-fix agent stopped for the host disk does not start another quality run", async () => {
  const parked = parkedForHostDisk();
  let qualityRuns = 0;
  const result = await workOnIssueQualityGate(
    diskFloorContext(),
    diskFloorState("/tmp/test-repo"),
    createMockDeps({
      quality: {
        runQualityGate: () => {
          qualityRuns++;
          return Promise.resolve({
            ok: true as const,
            value: {
              checks: [{
                name: "deno test",
                status: "FAILED",
              }] as CheckResult[],
              summary: { text: "failed", passed: false },
              passed: false,
              output: "deno test failed",
            },
          });
        },
        collectDiffableGateFindings: () => Promise.resolve([]),
      },
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: false as const,
            error: new Error(parked),
          }),
      },
    }),
  );

  assertEquals(qualityRuns, 1);
  assertEquals(result, hostDiskInfrastructureFailure(parked));
  assertEquals(detectHostFault(parked, "internal_error"), "disk-full");
});

Deno.test("Issue #4360 - a security-fix retry stopped for the host disk does not record a gate verdict", async () => {
  const parked = parkedForHostDisk();
  const root = await Deno.makeTempDir();
  let gateComments = 0;
  try {
    const ctx = diskFloorContext();
    ctx.config.workDir = `${root}/work`;
    ctx.issueLabels = ["security"];
    const state = diskFloorState(root);
    state.securityGateBlocks = [{
      missing: ["test-file-changed"],
      declarations: [],
      discrimination: null,
    }];
    const result = await recoverFromSecurityGateBlock(
      ctx,
      state,
      createMockDeps({
        github: {
          createClient: () =>
            ({
              postComment: () => {
                gateComments++;
                return Promise.resolve(undefined);
              },
            }) as unknown as GitHubClient,
        },
        claude: {
          runClaudeWithRetry: () =>
            Promise.resolve({
              ok: false as const,
              error: new Error(parked),
            }),
        },
      }),
      () => {
        throw new Error("completion must not re-run");
      },
    );

    assertEquals(gateComments, 0);
    assertEquals(result, hostDiskInfrastructureFailure(parked));
    assertEquals(
      result.status === "failure" ? result.category : "",
      "internal_error",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
