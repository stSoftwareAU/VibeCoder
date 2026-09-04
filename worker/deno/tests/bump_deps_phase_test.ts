/**
 * Tests for the dependency-bump phase orchestrator (Issue #1613).
 *
 * Verifies the three scenarios called out in the issue's acceptance
 * criteria, exercised through `workOnIssueBumpDeps` with an injected
 * `BumpDepsDeps` stub:
 *   1. Script absent — phase is a no-op, behaves as before.
 *   2. Script present + clean bump — `state.bumpInfo` records the
 *      applied bump.
 *   3. Script present + bump rejected by `bump-deps.sh` — `state.bumpInfo`
 *      records the rejection.
 *
 * Plus environment-variable propagation — the phase reads
 * `GH_TOKEN_HAS_WORKFLOW_SCOPE` and `VIBE_BUMP_QUARANTINE_HOURS` from
 * the parent process and threads them into the script's environment.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildBumpScriptEnv,
  createBumpDepsRuntimeDeps,
  readQuarantineHoursFromEnv,
  readWorkflowScopeFromEnv,
  workOnIssueBumpDeps,
} from "../lib/phases/bump_deps_phase.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { BumpDepsDeps } from "../lib/bump_deps.ts";
import { type BumpAgeDeps, emptyBumpAgeAudit } from "../lib/bump_age_audit.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { loadBumpScriptStreaks } from "../lib/bump_script_failure_streak.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Result } from "../types.ts";

function makeConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 1613,
    issueTitle: "Bump deps",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
    ...overrides,
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-1613-bump-deps",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...overrides,
  };
}

function makeBumpDeps(overrides: Partial<BumpDepsDeps> = {}): BumpDepsDeps {
  return {
    fileExists: () => Promise.resolve(true),
    runScript: () => Promise.resolve({ exitCode: 0, output: "" }),
    getModifiedFiles: () => Promise.resolve([]),
    revertWorkingTree: () => Promise.resolve(),
    getHeadSha: (): Promise<Result<string>> =>
      Promise.resolve({ ok: true, value: "111aaa" }),
    commitFiles: (): Promise<Result<string>> =>
      Promise.resolve({ ok: true, value: "222bbb" }),
    auditBumpedVersions: () => Promise.resolve(emptyBumpAgeAudit()),
    ...overrides,
  };
}

// =============================================================================
// Scenario 1 — script absent
// =============================================================================

Deno.test(
  "workOnIssueBumpDeps - no-op when bump-deps.sh is absent (backwards compatible)",
  async () => {
    const ctx = makeContext();
    const state = makeState();
    let runScriptCalled = false;
    const bumpDeps = makeBumpDeps({
      fileExists: () => Promise.resolve(false),
      runScript: () => {
        runScriptCalled = true;
        return Promise.resolve({ exitCode: 0, output: "" });
      },
    });

    const result = await workOnIssueBumpDeps(
      ctx,
      state,
      createMockDeps(),
      bumpDeps,
    );

    assertEquals(result.status, "continue");
    assertEquals(state.bumpInfo?.status, "absent");
    assertEquals(runScriptCalled, false, "must not invoke missing script");
  },
);

// =============================================================================
// Scenario 2 — clean bump applied
// =============================================================================

Deno.test(
  "workOnIssueBumpDeps - applied: records sha and beforeBumpSha on state",
  async () => {
    const ctx = makeContext();
    const state = makeState();
    const bumpDeps = makeBumpDeps({
      runScript: () =>
        Promise.resolve({ exitCode: 0, output: "bumped 2 deps" }),
      getModifiedFiles: () =>
        Promise.resolve(["package.json", "package-lock.json"]),
      getHeadSha: () => Promise.resolve({ ok: true, value: "111aaa" }),
      commitFiles: () => Promise.resolve({ ok: true, value: "222bbb" }),
    });

    const result = await workOnIssueBumpDeps(
      ctx,
      state,
      createMockDeps(),
      bumpDeps,
    );

    assertEquals(result.status, "continue");
    assertEquals(state.bumpInfo?.status, "applied");
    assertEquals(state.bumpInfo?.sha, "222bbb");
    assertEquals(state.bumpInfo?.beforeBumpSha, "111aaa");
    assertEquals(state.bumpInfo?.files, [
      "package.json",
      "package-lock.json",
    ]);
  },
);

// =============================================================================
// Scenario 3 — script-rejected bump
// =============================================================================

Deno.test(
  "workOnIssueBumpDeps - rejected_by_script when script exits non-zero",
  async () => {
    const ctx = makeContext();
    const state = makeState();
    const bumpDeps = makeBumpDeps({
      runScript: () =>
        Promise.resolve({
          exitCode: 7,
          output: "audit: dep XYZ flagged within quarantine",
        }),
      getModifiedFiles: () => Promise.resolve(["package.json"]),
    });

    const result = await workOnIssueBumpDeps(
      ctx,
      state,
      createMockDeps(),
      bumpDeps,
    );

    assertEquals(result.status, "continue");
    assertEquals(state.bumpInfo?.status, "rejected_by_script");
    assertEquals(state.bumpInfo?.files, ["package.json"]);
    assertStringIncludes(
      state.bumpInfo?.rejectionReason ?? "",
      "exited with status 7",
    );
  },
);

// =============================================================================
// buildBumpScriptEnv — deno-on-PATH defence in depth (Issue #3532)
// =============================================================================

Deno.test(
  "buildBumpScriptEnv - prepends resolved deno directory to PATH",
  () => {
    const env = buildBumpScriptEnv(
      { PATH: "/usr/bin:/bin", HOME: "/Users/worker" },
      { VIBE_BUMP_QUARANTINE_HOURS: "24" },
      "/Users/worker/.deno/bin/deno",
    );
    // Bump-specific value layered on and inherited HOME preserved.
    assertEquals(env["VIBE_BUMP_QUARANTINE_HOURS"], "24");
    assertEquals(env["HOME"], "/Users/worker");
    // The resolved deno's directory is now the first PATH entry.
    assertEquals(env["PATH"], "/Users/worker/.deno/bin:/usr/bin:/bin");
    const firstEntry = env["PATH"]!.split(":")[0];
    assertEquals(firstEntry, "/Users/worker/.deno/bin");
  },
);

Deno.test(
  "buildBumpScriptEnv - does not duplicate deno directory already on PATH",
  () => {
    const env = buildBumpScriptEnv(
      { PATH: "/Users/worker/.deno/bin:/usr/bin" },
      {},
      "/Users/worker/.deno/bin/deno",
    );
    const occurrences = env["PATH"]!
      .split(":")
      .filter((p) => p === "/Users/worker/.deno/bin").length;
    assertEquals(occurrences, 1);
  },
);

Deno.test(
  "buildBumpScriptEnv - leaves PATH untouched when deno could not be resolved",
  () => {
    const env = buildBumpScriptEnv(
      { PATH: "/usr/bin:/bin" },
      { GH_TOKEN_HAS_WORKFLOW_SCOPE: "false" },
      undefined,
    );
    assertEquals(env["PATH"], "/usr/bin:/bin");
    assertEquals(env["GH_TOKEN_HAS_WORKFLOW_SCOPE"], "false");
  },
);

// =============================================================================
// Environment-variable propagation
// =============================================================================

Deno.test(
  "workOnIssueBumpDeps - reads GH_TOKEN_HAS_WORKFLOW_SCOPE and VIBE_BUMP_QUARANTINE_HOURS from the lookup it is given",
  async () => {
    const ctx = makeContext();
    const state = makeState();
    const recorded: Array<Record<string, string>> = [];
    const bumpDeps = makeBumpDeps({
      runScript: (_cwd, _scriptPath, env) => {
        recorded.push(env);
        return Promise.resolve({ exitCode: 0, output: "" });
      },
      getModifiedFiles: () => Promise.resolve([]),
    });

    await workOnIssueBumpDeps(
      ctx,
      state,
      createMockDeps(),
      bumpDeps,
      "",
      envFrom({
        GH_TOKEN_HAS_WORKFLOW_SCOPE: "true",
        // A window no host exports: a read that fell back to the process
        // would answer the 24h default and fail here.
        VIBE_BUMP_QUARANTINE_HOURS: "964",
      }),
    );

    assertEquals(recorded.length, 1);
    assertEquals(recorded[0]!["GH_TOKEN_HAS_WORKFLOW_SCOPE"], "true");
    assertEquals(recorded[0]!["VIBE_BUMP_QUARANTINE_HOURS"], "964");
  },
);

Deno.test(
  "workOnIssueBumpDeps - defaults to scope=false / hours=24 when env unset",
  async () => {
    const ctx = makeContext();
    const state = makeState();
    const recorded: Array<Record<string, string>> = [];
    const bumpDeps = makeBumpDeps({
      runScript: (_cwd, _scriptPath, env) => {
        recorded.push(env);
        return Promise.resolve({ exitCode: 0, output: "" });
      },
    });

    await workOnIssueBumpDeps(
      ctx,
      state,
      createMockDeps(),
      bumpDeps,
      "",
      emptyEnv,
    );

    assertEquals(recorded[0]!["GH_TOKEN_HAS_WORKFLOW_SCOPE"], "false");
    assertEquals(recorded[0]!["VIBE_BUMP_QUARANTINE_HOURS"], "24");
  },
);

Deno.test(
  "bump_deps_phase - the two readers answer from the injected lookup alone (Issue #964)",
  () => {
    // Only a case-insensitive "true" is the workflow scope.
    assertEquals(
      readWorkflowScopeFromEnv(
        envFrom({ GH_TOKEN_HAS_WORKFLOW_SCOPE: "TRUE" }),
      ),
      true,
    );
    assertEquals(
      readWorkflowScopeFromEnv(
        envFrom({ GH_TOKEN_HAS_WORKFLOW_SCOPE: "sentinel-964" }),
      ),
      false,
    );
    assertEquals(readWorkflowScopeFromEnv(emptyEnv), false);

    // A window value no host exports, so an ambient read cannot supply it.
    assertEquals(
      readQuarantineHoursFromEnv(envFrom({ VIBE_BUMP_QUARANTINE_HOURS: "964" })),
      964,
    );
    assertEquals(readQuarantineHoursFromEnv(emptyEnv), 24);
  },
);

// =============================================================================
// Quarantine-window validation (Issue #3649, SEC-a6cf30184e72)
//
// The guard rejected only `parsed < 0`, so `VIBE_BUMP_QUARANTINE_HOURS=0`
// silently disabled the external supply-chain embargo and was propagated
// verbatim to `bump-deps.sh`. The documented contract is a fallback for
// anything that is "not a positive integer".
// =============================================================================

/** Run the phase with `VIBE_BUMP_QUARANTINE_HOURS` reading as `raw`. */
async function quarantineHoursFor(raw: string | undefined): Promise<string> {
  const recorded: Array<Record<string, string>> = [];
  await workOnIssueBumpDeps(
    makeContext(),
    makeState(),
    createMockDeps(),
    makeBumpDeps({
      runScript: (_cwd, _scriptPath, env) => {
        recorded.push(env);
        return Promise.resolve({ exitCode: 0, output: "" });
      },
    }),
    "",
    raw === undefined
      ? emptyEnv
      : envFrom({ VIBE_BUMP_QUARANTINE_HOURS: raw }),
  );
  return recorded[0]!["VIBE_BUMP_QUARANTINE_HOURS"]!;
}

Deno.test(
  "workOnIssueBumpDeps - zero hours does not disable the embargo",
  async () => {
    assertEquals(await quarantineHoursFor("0"), "24");
  },
);

Deno.test(
  "workOnIssueBumpDeps - a negative window falls back to the default",
  async () => {
    assertEquals(await quarantineHoursFor("-1"), "24");
  },
);

Deno.test(
  "workOnIssueBumpDeps - a non-numeric window falls back to the default",
  async () => {
    assertEquals(await quarantineHoursFor("off"), "24");
  },
);

Deno.test(
  "workOnIssueBumpDeps - a fractional window falls back to the default",
  async () => {
    // `parseInt("0.5")` is 0 — the same embargo-disabling value by another route.
    assertEquals(await quarantineHoursFor("0.5"), "24");
  },
);

Deno.test(
  "workOnIssueBumpDeps - trailing garbage falls back to the default (Issue #3659)",
  async () => {
    // `parseInt` stops at the first non-digit, so these used to parse as
    // 0 and 24 respectively rather than being rejected outright.
    assertEquals(await quarantineHoursFor("0abc"), "24");
    assertEquals(await quarantineHoursFor("24; rm -rf /"), "24");
    assertEquals(await quarantineHoursFor(" 48 "), "48");
  },
);

// =============================================================================
// Quarantine verification wiring (Issue #3659)
//
// The window was advisory — exported into a repo-supplied `bump-deps.sh`
// and never verified. These exercise the production `auditBumpedVersions`
// through a stubbed `git diff` and a fake clock, so no network is needed.
// =============================================================================

const AUDIT_NOW = new Date("2026-08-02T12:00:00Z");

/** Publish times keyed by `registry:name@version`. */
function makeAgeDeps(times: Record<string, string>): BumpAgeDeps {
  return {
    fetchPublishTime: (spec) =>
      Promise.resolve(times[`${spec.registry}:${spec.name}@${spec.version}`]),
    now: () => AUDIT_NOW,
  };
}

/** Worker deps whose `git diff` returns `diff` and everything else succeeds. */
function makeDepsWithDiff(diff: string) {
  return createMockDeps({
    git: {
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: {
            stdout: args[0] === "diff" ? diff : "",
            stderr: "",
            code: 0,
            timedOut: false,
          },
        }),
    },
  });
}

const FRESH_DIFF = `--- a/deno.json
+++ b/deno.json
+    "chalk": "npm:chalk@5.6.2"
`;

Deno.test(
  "createBumpDepsRuntimeDeps - blocks a version published inside the window",
  async () => {
    const bumpDeps = createBumpDepsRuntimeDeps(
      makeDepsWithDiff(FRESH_DIFF),
      makeAgeDeps({ "npm:chalk@5.6.2": "2026-08-02T11:00:00Z" }),
    );
    const result = await bumpDeps.auditBumpedVersions(
      "/tmp/repo",
      ["deno.json"],
      24,
    );
    assertEquals(result.ok, false);
    assertStringIncludes(result.reason, "chalk@5.6.2");
  },
);

Deno.test(
  "createBumpDepsRuntimeDeps - passes a version that has aged past the window",
  async () => {
    const bumpDeps = createBumpDepsRuntimeDeps(
      makeDepsWithDiff(FRESH_DIFF),
      makeAgeDeps({ "npm:chalk@5.6.2": "2026-07-01T00:00:00Z" }),
    );
    const result = await bumpDeps.auditBumpedVersions(
      "/tmp/repo",
      ["deno.json"],
      24,
    );
    assertEquals(result.ok, true);
    assertEquals(result.blocked, []);
  },
);

// Behaviour change (Issue #3951): this case previously asserted
// `ok: true` — an unreadable diff was reported as a honoured quarantine,
// which is the silent pass the issue closes. It now fails closed.
Deno.test(
  "createBumpDepsRuntimeDeps - an unreadable diff blocks the bump, and warns",
  async () => {
    const warnings: string[] = [];
    const deps = createMockDeps({
      logger: { warn: (msg: string) => warnings.push(msg) },
      git: {
        runGitCommand: () =>
          Promise.resolve({ ok: false as const, error: new Error("no HEAD") }),
      },
    });
    const bumpDeps = createBumpDepsRuntimeDeps(deps, makeAgeDeps({}));
    const result = await bumpDeps.auditBumpedVersions(
      "/tmp/repo",
      ["deno.json"],
      24,
    );
    assertEquals(result.ok, false);
    assertStringIncludes(result.reason, "could not be read");
    assertStringIncludes(result.reason, "no HEAD");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "refused");
  },
);

Deno.test(
  "createBumpDepsRuntimeDeps - a range specifier is verified, not skipped (Issue #3951)",
  async () => {
    const bumpDeps = createBumpDepsRuntimeDeps(
      makeDepsWithDiff(`--- a/deno.json
+++ b/deno.json
+    "@std/yaml": "jsr:@std/yaml@^1.9.9"
`),
      makeAgeDeps({ "jsr:@std/yaml@1.9.9": "2026-08-02T11:00:00Z" }),
    );
    const result = await bumpDeps.auditBumpedVersions(
      "/tmp/repo",
      ["deno.json"],
      24,
    );
    assertEquals(result.ok, false);
    assertStringIncludes(result.reason, "@std/yaml@1.9.9");
  },
);

Deno.test(
  "createBumpDepsRuntimeDeps - a non-JS ecosystem bump is refused (Issue #3951)",
  async () => {
    const warnings: string[] = [];
    const deps = createMockDeps({
      logger: { warn: (msg: string) => warnings.push(msg) },
      git: {
        runGitCommand: (args: string[]) =>
          Promise.resolve({
            ok: true as const,
            value: {
              stdout: args[0] === "diff"
                ? `--- a/Gemfile\n+++ b/Gemfile\n+gem "nokogiri", "1.99.0"\n`
                : "",
              stderr: "",
              code: 0,
              timedOut: false,
            },
          }),
      },
    });
    const bumpDeps = createBumpDepsRuntimeDeps(deps, makeAgeDeps({}));
    const result = await bumpDeps.auditBumpedVersions(
      "/tmp/repo",
      ["Gemfile"],
      24,
    );
    assertEquals(result.ok, false);
    assertEquals(result.unverifiable.length, 1);
    assertStringIncludes(result.reason, "RubyGems");
    assertStringIncludes(warnings.join(" "), "refused");
  },
);

Deno.test(
  "workOnIssueBumpDeps - records a quarantine rejection on state.bumpInfo",
  async () => {
    const state = makeState();
    await workOnIssueBumpDeps(
      makeContext(),
      state,
      createMockDeps(),
      makeBumpDeps({
        getModifiedFiles: () => Promise.resolve(["deno.json"]),
        auditBumpedVersions: () =>
          Promise.resolve({
            verdicts: [],
            blocked: [],
            indeterminate: [],
            unverifiable: [],
            ok: false,
            reason: "chalk@5.6.2 is only 1.0h old (< 24h quarantine).",
          }),
      }),
    );
    assertEquals(state.bumpInfo?.status, "rejected_by_quarantine");
    assertStringIncludes(state.bumpInfo?.rejectionReason ?? "", "chalk@5.6.2");
  },
);

Deno.test(
  "workOnIssueBumpDeps - an empty or unset window falls back to the default (Issue #3659)",
  async () => {
    assertEquals(await quarantineHoursFor(""), "24");
    assertEquals(await quarantineHoursFor(undefined), "24");
  },
);

Deno.test(
  "workOnIssueBumpDeps - a positive window is honoured unchanged",
  async () => {
    assertEquals(await quarantineHoursFor("1"), "1");
    assertEquals(await quarantineHoursFor("168"), "168");
  },
);

// =============================================================================
// Rejection diagnostics + streak escalation (Issue #207)
//
// The rejection used to log only the exit status, so a permanently broken
// `bump-deps.sh` was undiagnosable and silently disabled bumps for its repo.
// =============================================================================

/** Capture the phase's WARNING lines (message + rendered context). */
function makeLoggingDeps(
  warnings: string[],
  ghFn?: (args: string[]) => Promise<string>,
) {
  return createMockDeps({
    logger: {
      warn: (message: string, context?: Record<string, unknown>) => {
        warnings.push(
          context
            ? `${message} ${
              Object.entries(context).map(([k, v]) => `${k}=${v}`).join(" ")
            }`
            : message,
        );
      },
    },
    ...(ghFn ? { github: { runGhCommand: ghFn } } : {}),
  });
}

function rejectingBumpDeps(output: string, exitCode = 1): BumpDepsDeps {
  return makeBumpDeps({
    runScript: () => Promise.resolve({ exitCode, output }),
    getModifiedFiles: () => Promise.resolve(["deno.lock"]),
  });
}

Deno.test(
  "workOnIssueBumpDeps - logs the script's output tail on rejection",
  async () => {
    const warnings: string[] = [];
    await workOnIssueBumpDeps(
      makeContext(),
      makeState(),
      makeLoggingDeps(warnings),
      rejectingBumpDeps("deno outdated: failed\nERROR: deno is required\n"),
      "", // streak tracking disabled
    );

    const joined = warnings.join("\n");
    assertStringIncludes(joined, "script rejected the bump");
    assertStringIncludes(joined, "ERROR: deno is required");
  },
);

Deno.test(
  "workOnIssueBumpDeps - redacts secrets in the logged output tail",
  async () => {
    const warnings: string[] = [];
    await workOnIssueBumpDeps(
      makeContext(),
      makeState(),
      makeLoggingDeps(warnings),
      rejectingBumpDeps(`fatal: https://x:ghp_${"a".repeat(36)}@github.com`),
      "",
    );

    const joined = warnings.join("\n");
    assertStringIncludes(joined, "***REDACTED***");
    assertEquals(joined.includes("ghp_"), false);
  },
);

Deno.test(
  "workOnIssueBumpDeps - says so when a rejecting script printed nothing",
  async () => {
    const warnings: string[] = [];
    await workOnIssueBumpDeps(
      makeContext(),
      makeState(),
      makeLoggingDeps(warnings),
      rejectingBumpDeps(""),
      "",
    );
    assertStringIncludes(warnings.join("\n"), "produced no output");
  },
);

Deno.test(
  "workOnIssueBumpDeps - files one issue after three consecutive rejections",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "bump-phase-streak-" });
    try {
      const statePath = `${dir}/bump_script_failures.json`;
      const ghCalls: string[][] = [];
      const ghFn = (args: string[]): Promise<string> => {
        ghCalls.push(args);
        return Promise.resolve(
          args[1] === "create"
            ? "https://github.com/org/repo/issues/77\n"
            : "[]",
        );
      };
      const warnings: string[] = [];

      for (let run = 1; run <= 3; run++) {
        await workOnIssueBumpDeps(
          makeContext(),
          makeState(),
          makeLoggingDeps(warnings, ghFn),
          rejectingBumpDeps("ERROR: deno is required"),
          statePath,
        );
      }

      const creates = ghCalls.filter((args) => args[1] === "create");
      assertEquals(creates.length, 1, "exactly one issue for the streak");
      const create = creates[0]!;
      assertEquals(create[create.indexOf("--repo") + 1], "org/repo");
      assertStringIncludes(
        create[create.indexOf("--body") + 1] ?? "",
        "ERROR: deno is required",
      );
      assertStringIncludes(warnings.join("\n"), "filed a tracking issue");

      // A fourth rejection must not file again.
      await workOnIssueBumpDeps(
        makeContext(),
        makeState(),
        makeLoggingDeps(warnings, ghFn),
        rejectingBumpDeps("ERROR: deno is required"),
        statePath,
      );
      assertEquals(ghCalls.filter((args) => args[1] === "create").length, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "workOnIssueBumpDeps - a clean run clears the rejection streak",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "bump-phase-streak-" });
    try {
      const statePath = `${dir}/bump_script_failures.json`;
      const ghCalls: string[][] = [];
      const ghFn = (args: string[]): Promise<string> => {
        ghCalls.push(args);
        return Promise.resolve(args[1] === "create" ? "issues/77" : "[]");
      };
      const warnings: string[] = [];

      for (let run = 1; run <= 2; run++) {
        await workOnIssueBumpDeps(
          makeContext(),
          makeState(),
          makeLoggingDeps(warnings, ghFn),
          rejectingBumpDeps("transient registry error"),
          statePath,
        );
      }

      // Clean run — script exits 0 with no changes.
      await workOnIssueBumpDeps(
        makeContext(),
        makeState(),
        makeLoggingDeps(warnings, ghFn),
        makeBumpDeps(),
        statePath,
      );
      assertEquals(await loadBumpScriptStreaks(statePath), {});

      // The next rejection starts a fresh streak — no issue filed.
      await workOnIssueBumpDeps(
        makeContext(),
        makeState(),
        makeLoggingDeps(warnings, ghFn),
        rejectingBumpDeps("transient registry error"),
        statePath,
      );
      assertEquals(
        ghCalls.filter((args) => args[1] === "create").length,
        0,
        "a recovered script must not be reported as chronically broken",
      );
      assertEquals(
        (await loadBumpScriptStreaks(statePath))["org/repo"]?.count,
        1,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "workOnIssueBumpDeps - a quarantine rejection is not a script-failure streak",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "bump-phase-streak-" });
    try {
      const statePath = `${dir}/bump_script_failures.json`;
      await workOnIssueBumpDeps(
        makeContext(),
        makeState(),
        createMockDeps(),
        makeBumpDeps({
          getModifiedFiles: () => Promise.resolve(["deno.json"]),
          auditBumpedVersions: () =>
            Promise.resolve({
              verdicts: [],
              blocked: [],
              indeterminate: [],
              unverifiable: [],
              ok: false,
              reason: "chalk@5.6.2 is only 1.0h old (< 24h quarantine).",
            }),
        }),
        statePath,
      );
      assertEquals(await loadBumpScriptStreaks(statePath), {});
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
