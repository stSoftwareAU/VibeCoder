/**
 * Tests for `lib/bump_deps.ts` (Issue #1613).
 *
 * Covers the three scenarios called out in the issue:
 *   1. Script absent → no-op.
 *   2. Script present, clean bump → committed.
 *   3. Script present, bump rejected by audits → reverted.
 *
 * Plus boundary cases: noop (script ran but modified nothing),
 * commit failure path, environment-variable propagation, and the
 * rejection-comment formatter.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildBumpCommitMessage,
  buildBumpRejectionComment,
  type BumpDepsDeps,
  type BumpInfo,
  DEFAULT_BUMP_QUARANTINE_HOURS,
  runBumpDeps,
} from "../lib/bump_deps.ts";
import type {
  BumpAgeAuditResult,
  BumpAgeVerdict,
} from "../lib/bump_age_audit.ts";
import type { Result } from "../types.ts";

/** An audit result with nothing to block. */
function passingAudit(): BumpAgeAuditResult {
  return {
    verdicts: [],
    blocked: [],
    indeterminate: [],
    unverifiable: [],
    ok: true,
    reason: "",
  };
}

// =============================================================================
// Helpers
// =============================================================================

interface RecordedRun {
  cwd: string;
  scriptPath: string;
  env: Record<string, string>;
}

interface RecordedCommit {
  cwd: string;
  files: string[];
  message: string;
}

interface RecordedRevert {
  cwd: string;
  files: string[];
}

function makeDeps(overrides: Partial<BumpDepsDeps> = {}): BumpDepsDeps {
  return {
    fileExists: () => Promise.resolve(true),
    runScript: () => Promise.resolve({ exitCode: 0, output: "" }),
    getModifiedFiles: () => Promise.resolve([]),
    revertWorkingTree: () => Promise.resolve(),
    getHeadSha: (): Promise<Result<string>> =>
      Promise.resolve({ ok: true, value: "deadbeef" }),
    commitFiles: (): Promise<Result<string>> =>
      Promise.resolve({ ok: true, value: "cafebabe" }),
    auditBumpedVersions: () => Promise.resolve(passingAudit()),
    ...overrides,
  };
}

// =============================================================================
// Status: absent
// =============================================================================

Deno.test("runBumpDeps - absent when bump-deps.sh is missing", async () => {
  let runScriptCalled = false;
  const result = await runBumpDeps(
    { repoPath: "/tmp/repo" },
    makeDeps({
      fileExists: () => Promise.resolve(false),
      runScript: () => {
        runScriptCalled = true;
        return Promise.resolve({ exitCode: 0, output: "" });
      },
    }),
  );
  assertEquals(result.status, "absent");
  assertEquals(result.files, []);
  assertEquals(result.output, "");
  assertEquals(
    runScriptCalled,
    false,
    "script must not be run when absent",
  );
});

// =============================================================================
// Status: noop (script ran, no files modified)
// =============================================================================

Deno.test(
  "runBumpDeps - noop when script exits 0 but modifies nothing",
  async () => {
    const commits: RecordedCommit[] = [];
    const result = await runBumpDeps(
      { repoPath: "/tmp/repo" },
      makeDeps({
        runScript: () =>
          Promise.resolve({ exitCode: 0, output: "Already on latest" }),
        getModifiedFiles: () => Promise.resolve([]),
        commitFiles: (cwd, files, message) => {
          commits.push({ cwd, files, message });
          return Promise.resolve({ ok: true, value: "should-not-happen" });
        },
      }),
    );
    assertEquals(result.status, "noop");
    assertEquals(result.files, []);
    assertEquals(result.output, "Already on latest");
    assertEquals(
      commits.length,
      0,
      "must not commit when nothing changed",
    );
  },
);

// =============================================================================
// Status: applied (clean bump, committed)
// =============================================================================

Deno.test(
  "runBumpDeps - applied: commits modified files and returns sha",
  async () => {
    const commits: RecordedCommit[] = [];
    const result = await runBumpDeps(
      { repoPath: "/tmp/repo", issueNumber: 1613 },
      makeDeps({
        runScript: () =>
          Promise.resolve({ exitCode: 0, output: "bumped 2 deps" }),
        getModifiedFiles: () =>
          Promise.resolve(["package.json", "package-lock.json"]),
        getHeadSha: () => Promise.resolve({ ok: true, value: "111aaa" }),
        commitFiles: (cwd, files, message) => {
          commits.push({ cwd, files, message });
          return Promise.resolve({ ok: true, value: "222bbb" });
        },
      }),
    );
    assertEquals(result.status, "applied");
    assertEquals(result.files, ["package.json", "package-lock.json"]);
    assertEquals(result.sha, "222bbb");
    assertEquals(result.beforeBumpSha, "111aaa");
    assertEquals(commits.length, 1);
    assertEquals(commits[0]!.cwd, "/tmp/repo");
    assertEquals(commits[0]!.files, ["package.json", "package-lock.json"]);
    assertStringIncludes(commits[0]!.message, "Issue #1613");
    assertStringIncludes(commits[0]!.message, "bump-deps.sh");
  },
);

// =============================================================================
// Status: rejected_by_script (script exited non-zero)
// =============================================================================

Deno.test(
  "runBumpDeps - rejected_by_script: reverts and reports reason",
  async () => {
    const reverts: RecordedRevert[] = [];
    const commits: RecordedCommit[] = [];
    const result = await runBumpDeps(
      { repoPath: "/tmp/repo" },
      makeDeps({
        runScript: () =>
          Promise.resolve({ exitCode: 7, output: "audit: dep XYZ flagged" }),
        getModifiedFiles: () => Promise.resolve(["package.json"]),
        revertWorkingTree: (cwd, files) => {
          reverts.push({ cwd, files });
          return Promise.resolve();
        },
        commitFiles: (cwd, files, message) => {
          commits.push({ cwd, files, message });
          return Promise.resolve({ ok: true, value: "nope" });
        },
      }),
    );
    assertEquals(result.status, "rejected_by_script");
    assertEquals(result.files, ["package.json"]);
    assertStringIncludes(result.output, "audit: dep XYZ flagged");
    assertStringIncludes(result.rejectionReason ?? "", "exited with status 7");
    assertEquals(reverts.length, 1);
    assertEquals(reverts[0]!.files, ["package.json"]);
    assertEquals(
      commits.length,
      0,
      "must not commit a rejected bump",
    );
  },
);

Deno.test(
  "runBumpDeps - rejected_by_script: skips revert when no files modified",
  async () => {
    const reverts: RecordedRevert[] = [];
    const result = await runBumpDeps(
      { repoPath: "/tmp/repo" },
      makeDeps({
        runScript: () =>
          Promise.resolve({ exitCode: 1, output: "early failure" }),
        getModifiedFiles: () => Promise.resolve([]),
        revertWorkingTree: (cwd, files) => {
          reverts.push({ cwd, files });
          return Promise.resolve();
        },
      }),
    );
    assertEquals(result.status, "rejected_by_script");
    assertEquals(result.files, []);
    assertEquals(reverts.length, 0, "no files to revert");
  },
);

// =============================================================================
// Commit failure path
// =============================================================================

Deno.test(
  "runBumpDeps - reverts when commit fails after successful script run",
  async () => {
    const reverts: RecordedRevert[] = [];
    const result = await runBumpDeps(
      { repoPath: "/tmp/repo" },
      makeDeps({
        runScript: () => Promise.resolve({ exitCode: 0, output: "bumped" }),
        getModifiedFiles: () => Promise.resolve(["go.mod", "go.sum"]),
        commitFiles: () =>
          Promise.resolve({
            ok: false,
            error: new Error("nothing staged"),
          }),
        revertWorkingTree: (cwd, files) => {
          reverts.push({ cwd, files });
          return Promise.resolve();
        },
      }),
    );
    assertEquals(result.status, "rejected_by_script");
    assertEquals(result.files, ["go.mod", "go.sum"]);
    assertStringIncludes(
      result.rejectionReason ?? "",
      "Could not commit bump",
    );
    assertEquals(reverts.length, 1);
    assertEquals(reverts[0]!.files, ["go.mod", "go.sum"]);
  },
);

// =============================================================================
// Environment-variable propagation
// =============================================================================

Deno.test(
  "runBumpDeps - propagates GH_TOKEN_HAS_WORKFLOW_SCOPE and VIBE_BUMP_QUARANTINE_HOURS",
  async () => {
    const recorded: RecordedRun[] = [];
    await runBumpDeps(
      {
        repoPath: "/tmp/repo",
        hasWorkflowScope: true,
        quarantineHours: 72,
      },
      makeDeps({
        runScript: (cwd, scriptPath, env) => {
          recorded.push({ cwd, scriptPath, env });
          return Promise.resolve({ exitCode: 0, output: "" });
        },
      }),
    );
    assertEquals(recorded.length, 1);
    assertEquals(recorded[0]!.cwd, "/tmp/repo");
    assertEquals(recorded[0]!.scriptPath, "/tmp/repo/bump-deps.sh");
    assertEquals(recorded[0]!.env["GH_TOKEN_HAS_WORKFLOW_SCOPE"], "true");
    assertEquals(recorded[0]!.env["VIBE_BUMP_QUARANTINE_HOURS"], "72");
  },
);

Deno.test(
  "runBumpDeps - defaults workflow scope to false and quarantine to 24h",
  async () => {
    const recorded: RecordedRun[] = [];
    await runBumpDeps(
      { repoPath: "/tmp/repo" },
      makeDeps({
        runScript: (cwd, scriptPath, env) => {
          recorded.push({ cwd, scriptPath, env });
          return Promise.resolve({ exitCode: 0, output: "" });
        },
      }),
    );
    assertEquals(recorded[0]!.env["GH_TOKEN_HAS_WORKFLOW_SCOPE"], "false");
    assertEquals(recorded[0]!.env["VIBE_BUMP_QUARANTINE_HOURS"], "24");
  },
);

// =============================================================================
// Quarantine verification (Issue #3659)
//
// The window used to be advisory: it was exported to a repo-supplied
// `bump-deps.sh` and never verified. These cover the verification of the
// versions the bump actually produced.
// =============================================================================

/** An audit result that blocks, with `reason`. */
function blockingAudit(reason: string): BumpAgeAuditResult {
  const verdict: BumpAgeVerdict = {
    specifier: { registry: "npm", name: "chalk", version: "5.6.2" },
    eligible: false,
    indeterminate: false,
    ageHours: 1,
    publishedAt: "2026-08-02T11:00:00Z",
    reason,
  };
  return {
    verdicts: [verdict],
    blocked: [verdict],
    indeterminate: [],
    unverifiable: [],
    ok: false,
    reason,
  };
}

Deno.test(
  "runBumpDeps - rejects and reverts a bump that ignored the quarantine window",
  async () => {
    const reverts: RecordedRevert[] = [];
    const commits: RecordedCommit[] = [];
    const result = await runBumpDeps(
      { repoPath: "/tmp/repo", quarantineHours: 24 },
      makeDeps({
        getModifiedFiles: () => Promise.resolve(["deno.json", "deno.lock"]),
        auditBumpedVersions: () =>
          Promise.resolve(blockingAudit("chalk@5.6.2 is only 1.0h old")),
        revertWorkingTree: (cwd, files) => {
          reverts.push({ cwd, files });
          return Promise.resolve();
        },
        commitFiles: (cwd, files, message) => {
          commits.push({ cwd, files, message });
          return Promise.resolve({ ok: true, value: "cafebabe" });
        },
      }),
    );
    assertEquals(result.status, "rejected_by_quarantine");
    assertEquals(result.files, ["deno.json", "deno.lock"]);
    assertStringIncludes(result.rejectionReason ?? "", "chalk@5.6.2");
    // The bump must never be committed once it fails the window.
    assertEquals(commits.length, 0);
    assertEquals(reverts.length, 1);
    assertEquals(reverts[0]!.files, ["deno.json", "deno.lock"]);
  },
);

Deno.test(
  "runBumpDeps - commits a bump whose versions clear the window",
  async () => {
    const audited: Array<{ files: string[]; hours: number }> = [];
    const result = await runBumpDeps(
      { repoPath: "/tmp/repo", quarantineHours: 72 },
      makeDeps({
        getModifiedFiles: () => Promise.resolve(["deno.json"]),
        auditBumpedVersions: (_cwd, files, hours) => {
          audited.push({ files, hours });
          return Promise.resolve(passingAudit());
        },
      }),
    );
    assertEquals(result.status, "applied");
    // The audit sees the same window that was exported to the script.
    assertEquals(audited, [{ files: ["deno.json"], hours: 72 }]);
  },
);

Deno.test(
  "runBumpDeps - a no-op bump is not audited",
  async () => {
    let audits = 0;
    const result = await runBumpDeps(
      { repoPath: "/tmp/repo" },
      makeDeps({
        getModifiedFiles: () => Promise.resolve([]),
        auditBumpedVersions: () => {
          audits++;
          return Promise.resolve(passingAudit());
        },
      }),
    );
    assertEquals(result.status, "noop");
    assertEquals(audits, 0);
  },
);

Deno.test(
  "runBumpDeps - audits against the default window when none is supplied",
  async () => {
    const hours: number[] = [];
    await runBumpDeps(
      { repoPath: "/tmp/repo" },
      makeDeps({
        getModifiedFiles: () => Promise.resolve(["package.json"]),
        auditBumpedVersions: (_cwd, _files, h) => {
          hours.push(h);
          return Promise.resolve(passingAudit());
        },
      }),
    );
    assertEquals(hours, [DEFAULT_BUMP_QUARANTINE_HOURS]);
  },
);

Deno.test(
  "buildBumpRejectionComment - distinguishes quarantine rejection",
  () => {
    const info: BumpInfo = {
      status: "rejected_by_quarantine",
      files: ["deno.json"],
      output: "",
      rejectionReason: "chalk@5.6.2 is only 1.0h old (< 24h quarantine).",
    };
    const comment = buildBumpRejectionComment(info);
    assertStringIncludes(comment, "quarantine");
    assertStringIncludes(comment, "deno.json");
    assertStringIncludes(comment, "chalk@5.6.2");
  },
);

// =============================================================================
// Rejection-comment formatter
// =============================================================================

Deno.test(
  "buildBumpRejectionComment - empty for non-rejected statuses",
  () => {
    const cases: BumpInfo["status"][] = ["absent", "noop", "applied"];
    for (const status of cases) {
      const info: BumpInfo = { status, files: [], output: "" };
      assertEquals(
        buildBumpRejectionComment(info),
        "",
        `expected empty comment for status ${status}`,
      );
    }
  },
);

Deno.test(
  "buildBumpRejectionComment - mentions files and reason on script rejection",
  () => {
    const info: BumpInfo = {
      status: "rejected_by_script",
      files: ["package.json"],
      output: "audit: dep XYZ flagged",
      rejectionReason: "`bump-deps.sh` exited with status 7 — bump reverted.",
    };
    const comment = buildBumpRejectionComment(info);
    assertStringIncludes(comment, "rejected by `bump-deps.sh`");
    assertStringIncludes(comment, "package.json");
    assertStringIncludes(comment, "exited with status 7");
    assertStringIncludes(comment, "audit: dep XYZ flagged");
  },
);

Deno.test(
  "buildBumpRejectionComment - distinguishes audit rejection",
  () => {
    const info: BumpInfo = {
      status: "rejected_by_audit",
      files: ["go.mod"],
      output: "",
      rejectionReason: "Quality gate passed only without the bump.",
    };
    const comment = buildBumpRejectionComment(info);
    assertStringIncludes(comment, "rejected by quality audit");
    assertStringIncludes(comment, "go.mod");
    assertStringIncludes(comment, "Quality gate passed only without the bump.");
  },
);

// =============================================================================
// Commit-message helper
// =============================================================================

Deno.test("buildBumpCommitMessage - includes issue number when supplied", () => {
  assertEquals(
    buildBumpCommitMessage(1613),
    "chore: bump dependencies via bump-deps.sh (Issue #1613)",
  );
});

Deno.test("buildBumpCommitMessage - omits issue when undefined", () => {
  assertEquals(
    buildBumpCommitMessage(),
    "chore: bump dependencies via bump-deps.sh",
  );
});
