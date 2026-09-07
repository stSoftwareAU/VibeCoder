/**
 * Tests for process_add_repo.ts — the add-repo orchestrating command
 * (Issue #2578).
 *
 * Covers all four outcomes with injected gh/fs deps and no real network:
 *   - happy path (valid title + accessible repo → added, wrappers seeded,
 *     comment + close);
 *   - already-monitored repo (comment notes "already present",
 *     wrappers reconciled, closed, no error);
 *   - unparseable title (explanatory comment, closed, no config change);
 *   - not_found / no_access (remediation comment + escalateToHuman applies
 *     needs-human; repo not added; no wrappers filed).
 *
 * Also covers the canonical label sync (Issue #2599): labels are synced
 * before wrapper seeding, and a sync failure is reported in the summary but
 * is non-fatal so onboarding still completes. The remaining setup syncs
 * (workflow, `.gitignore`, collaborator precheck) are still not invoked.
 */

import { assertEquals } from "@std/assert";
import {
  buildBranchProtectionLine,
  buildEscalationText,
  buildLabelSyncLine,
  buildSuccessComment,
  buildUnparseableComment,
  type EscalateArgs,
  processAddRepoCommand,
  type ProcessAddRepoData,
  type ProcessAddRepoDeps,
} from "../commands/process_add_repo.ts";
import type { AddRepoTargetStatus } from "../lib/add_repo.ts";
import type { CreateAllIdleTaskWrappersResult } from "../lib/create_all_idle_task_wrappers.ts";
import type { LabelSyncResult } from "../setup/label_sync.ts";
import type { SyncResult } from "../setup/branch_protection_sync.ts";
import type { RepoVisibility } from "../lib/repo_visibility.ts";
import type { Result, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const REPO = "stSoftwareAU/VibeCoder";
const TARGET = "stSoftwareAU/private-repo-11";
const ISSUE = 2578;

function config(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), needsHumanLabel: "needs-human" };
}

/** A recording gh runner that returns "" for every call. */
function recordingGh(): {
  fn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args: string[]) => {
      calls.push(args);
      return Promise.resolve("");
    },
  };
}

/** Run the command with the supplied test deps and return the data. */
async function run(
  deps: ProcessAddRepoDeps,
  args: Record<string, unknown> = {},
): Promise<{ success: boolean; data?: ProcessAddRepoData }> {
  const result = await processAddRepoCommand.execute(
    {
      repo: REPO,
      "issue-number": ISSUE,
      title: `add-repo: ${TARGET}`,
      __testDeps: deps,
      ...args,
    },
    config(),
  );
  return {
    success: result.success,
    data: result.data as ProcessAddRepoData | undefined,
  };
}

/** A successful label-sync stub so tests never reach the network. */
function okLabelSync(repo: string): Promise<LabelSyncResult> {
  return Promise.resolve({
    ok: true,
    repo,
    created: 16,
    updated: 0,
    skipped: 0,
    failures: 0,
    deprecated_removed: 0,
    dryRun: false,
  });
}

/** A successful branch-protection stub so tests never reach the network. */
function okBranchProtection(repo: string): Promise<SyncResult> {
  return Promise.resolve({
    repo,
    ok: true,
    changed: true,
    added: ["quality"],
    preserved: [],
    visibility: "public",
    branch: "main",
  });
}

// A deps object that fails loudly if any setup-sync runner is reached: the
// only runners provided are the high-level seams. Any real gh/fs call would
// throw because no low-level runner is wired. The label-sync and
// branch-protection seams default to success stubs so the canonical sync
// (Issue #2599) and branch-protection config (Issue #2589) never hit the
// network.
function baseDeps(overrides: Partial<ProcessAddRepoDeps>): ProcessAddRepoDeps {
  return {
    runCommand: () =>
      Promise.reject(new Error("runCommand should not be called")),
    syncLabelsFn: okLabelSync,
    configureBranchProtectionFn: okBranchProtection,
    ...overrides,
  };
}

Deno.test("happy path - valid title + accessible repo → added, seeded, closed", async () => {
  const gh = recordingGh();
  const written: Record<string, string> = {};
  const validateCalls: string[] = [];
  const wrapperCalls: string[] = [];

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: (r: string): Promise<Result<AddRepoTargetStatus, string>> => {
      validateCalls.push(r);
      return Promise.resolve({
        ok: true,
        value: { kind: "ok", visibility: "public" },
      });
    },
    addRepoFn: (r: string, _cp: string) => {
      written[r] = "added";
      return Promise.resolve({ ok: true, value: { added: true } });
    },
    createWrappersFn: (
      r: string,
    ): Promise<Result<CreateAllIdleTaskWrappersResult>> => {
      wrapperCalls.push(r);
      return Promise.resolve({
        ok: true,
        value: { created: ["security-scan", "best-practices"], skipped: [] },
      });
    },
  }));

  assertEquals(success, true);
  assertEquals(data?.outcome, "added");
  assertEquals(data?.repo, TARGET);
  assertEquals(data?.visibility, "public");
  assertEquals(validateCalls, [TARGET]);
  assertEquals(written[TARGET], "added");
  assertEquals(wrapperCalls, [TARGET]);

  // The issue was closed as completed with a summary comment.
  const close = gh.calls.find((c) => c[0] === "issue" && c[1] === "close");
  assertEquals(close?.includes("--reason"), true);
  assertEquals(close?.[close.indexOf("--reason") + 1], "completed");
  assertEquals(close?.includes("--comment"), true);
  const commentBody = close?.[close.indexOf("--comment") + 1] ?? "";
  assertEquals(commentBody.includes("added to the monitored list"), true);
});

Deno.test("already-monitored repo - notes already present, reconciles, closes", async () => {
  const gh = recordingGh();

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "ok", visibility: "private" } as AddRepoTargetStatus,
      }),
    // Idempotent add → already present.
    addRepoFn: () => Promise.resolve({ ok: true, value: { added: false } }),
    // Wrappers reconciled idempotently → all skipped.
    createWrappersFn: () =>
      Promise.resolve({
        ok: true,
        value: {
          created: [],
          skipped: ["security-scan", "best-practices", "test-audit"],
        },
      }),
  }));

  assertEquals(success, true);
  assertEquals(data?.outcome, "already_present");
  assertEquals(data?.visibility, "private");

  const close = gh.calls.find((c) => c[0] === "issue" && c[1] === "close");
  const commentBody = close?.[close.indexOf("--comment") + 1] ?? "";
  assertEquals(commentBody.includes("already present"), true);
});

Deno.test("unparseable title - explanatory comment, closed, no config change", async () => {
  const gh = recordingGh();
  let addCalled = false;
  let validateCalled = false;
  let wrapCalled = false;

  const result = await processAddRepoCommand.execute(
    {
      repo: REPO,
      "issue-number": ISSUE,
      title: "please add my repo",
      __testDeps: baseDeps({
        runGhCommand: gh.fn,
        validateFn: () => {
          validateCalled = true;
          return Promise.resolve({
            ok: true,
            value: { kind: "ok", visibility: "public" } as AddRepoTargetStatus,
          });
        },
        addRepoFn: () => {
          addCalled = true;
          return Promise.resolve({ ok: true, value: { added: true } });
        },
        createWrappersFn: () => {
          wrapCalled = true;
          return Promise.resolve({
            ok: true,
            value: { created: [], skipped: [] },
          });
        },
      }),
    },
    config(),
  );

  const data = result.data as ProcessAddRepoData;
  assertEquals(result.success, true);
  assertEquals(data.outcome, "unparseable");
  // No validation, no add, no wrappers.
  assertEquals(validateCalled, false);
  assertEquals(addCalled, false);
  assertEquals(wrapCalled, false);

  const close = gh.calls.find((c) => c[0] === "issue" && c[1] === "close");
  const commentBody = close?.[close.indexOf("--comment") + 1] ?? "";
  assertEquals(commentBody.includes("Could not parse"), true);
});

Deno.test("not_found - remediation comment + escalateToHuman, repo not added", async () => {
  const escalations: EscalateArgs[] = [];
  let addCalled = false;
  let wrapCalled = false;
  const gh = recordingGh();

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "not_found" } as AddRepoTargetStatus,
      }),
    resolveWorkerUserFn: () => Promise.resolve("vibe-bot"),
    escalateFn: (a: EscalateArgs) => {
      escalations.push(a);
      return Promise.resolve();
    },
    addRepoFn: () => {
      addCalled = true;
      return Promise.resolve({ ok: true, value: { added: true } });
    },
    createWrappersFn: () => {
      wrapCalled = true;
      return Promise.resolve({ ok: true, value: { created: [], skipped: [] } });
    },
  }));

  assertEquals(success, true);
  assertEquals(data?.outcome, "not_found");
  // Escalation fired exactly once with a remediation command.
  assertEquals(escalations.length, 1);
  assertEquals(escalations[0]!.issueNumber, ISSUE);
  assertEquals(
    escalations[0]!.nextStep.includes(
      `repos/${TARGET}/collaborators/vibe-bot -f permission=triage`,
    ),
    true,
  );
  // Repo not added, no wrappers, issue not closed.
  assertEquals(addCalled, false);
  assertEquals(wrapCalled, false);
  assertEquals(
    gh.calls.some((c) => c[0] === "issue" && c[1] === "close"),
    false,
  );
});

Deno.test("no_access - escalates with triage remediation, repo not added", async () => {
  const escalations: EscalateArgs[] = [];
  const gh = recordingGh();

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "no_access" } as AddRepoTargetStatus,
      }),
    resolveWorkerUserFn: () => Promise.resolve("vibe-bot"),
    escalateFn: (a: EscalateArgs) => {
      escalations.push(a);
      return Promise.resolve();
    },
    addRepoFn: () =>
      Promise.reject(new Error("addRepoFn must not be called on no_access")),
    createWrappersFn: () =>
      Promise.reject(new Error("createWrappersFn must not be called")),
  }));

  assertEquals(success, true);
  assertEquals(data?.outcome, "no_access");
  assertEquals(escalations.length, 1);
  assertEquals(escalations[0]!.reason.includes("triage"), true);
});

Deno.test("transient validation error - leaves issue open, no escalation/close", async () => {
  const gh = recordingGh();
  let escalated = false;

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () => Promise.resolve({ ok: false, error: "gh api timed out" }),
    escalateFn: () => {
      escalated = true;
      return Promise.resolve();
    },
  }));

  assertEquals(success, false);
  assertEquals(data?.outcome, "error");
  assertEquals(escalated, false);
  assertEquals(gh.calls.some((c) => c[1] === "close"), false);
});

Deno.test("missing arguments are rejected", async () => {
  const noRepo = await processAddRepoCommand.execute(
    { "issue-number": ISSUE, title: `add-repo: ${TARGET}` },
    config(),
  );
  assertEquals(noRepo.success, false);

  const noIssue = await processAddRepoCommand.execute(
    { repo: REPO, title: `add-repo: ${TARGET}` },
    config(),
  );
  assertEquals(noIssue.success, false);
});

Deno.test("buildUnparseableComment names the form", () => {
  const body = buildUnparseableComment("garbage title");
  assertEquals(body.includes("add-repo: owner/repo"), true);
  assertEquals(body.includes("garbage title"), true);
});

Deno.test("buildSuccessComment reflects added vs already present", () => {
  const labels = { created: 16, updated: 0, failures: 0 };
  const branchProtection = {
    ok: true,
    changed: true,
    added: ["quality"],
    branch: "main",
  };
  const added = buildSuccessComment({
    repo: TARGET,
    added: true,
    visibility: "public",
    created: ["security-scan"],
    skipped: [],
    labels,
    branchProtection,
  });
  assertEquals(added.includes("was added to the monitored list"), true);
  assertEquals(added.includes("security-scan"), true);
  // Label-sync summary is surfaced in the comment (Issue #2599).
  assertEquals(added.includes("Canonical labels synced"), true);
  // Branch-protection summary is surfaced in the comment (Issue #2589).
  assertEquals(added.includes("Default-branch ruleset configured"), true);

  const present = buildSuccessComment({
    repo: TARGET,
    added: false,
    visibility: "private",
    created: [],
    skipped: ["best-practices"],
    labels,
    branchProtection,
  });
  assertEquals(present.includes("already present"), true);
  assertEquals(present.includes("best-practices"), true);
});

Deno.test("buildLabelSyncLine - success, failures, and error variants", () => {
  const ok = buildLabelSyncLine({ created: 16, updated: 0, failures: 0 });
  assertEquals(ok.includes("Canonical labels synced"), true);
  assertEquals(ok.includes("created 16"), true);

  const partial = buildLabelSyncLine({ created: 14, updated: 0, failures: 2 });
  assertEquals(partial.includes("2 failure(s)"), true);

  const errored = buildLabelSyncLine({
    created: 0,
    updated: 0,
    failures: 0,
    error: "gh exploded",
  });
  assertEquals(errored.includes("Canonical label sync failed"), true);
  assertEquals(errored.includes("gh exploded"), true);
});

Deno.test("happy path - syncs canonical labels before seeding wrappers", async () => {
  const gh = recordingGh();
  const order: string[] = [];

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "ok", visibility: "public" } as AddRepoTargetStatus,
      }),
    addRepoFn: () => Promise.resolve({ ok: true, value: { added: true } }),
    syncLabelsFn: (r: string) => {
      order.push("labels");
      return Promise.resolve({
        ok: true,
        repo: r,
        created: 16,
        updated: 0,
        skipped: 0,
        failures: 0,
        deprecated_removed: 0,
        dryRun: false,
      });
    },
    createWrappersFn: () => {
      order.push("wrappers");
      return Promise.resolve({
        ok: true,
        value: { created: ["security-scan"], skipped: [] },
      });
    },
  }));

  assertEquals(success, true);
  assertEquals(data?.labels, { created: 16, updated: 0, failures: 0 });
  // Labels are synced before wrappers so `idle-task` exists first.
  assertEquals(order, ["labels", "wrappers"]);

  const close = gh.calls.find((c) => c[0] === "issue" && c[1] === "close");
  const commentBody = close?.[close.indexOf("--comment") + 1] ?? "";
  assertEquals(commentBody.includes("Canonical labels synced"), true);
});

Deno.test("label sync failure is non-fatal - onboarding still completes", async () => {
  const gh = recordingGh();
  let wrapCalled = false;

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "ok", visibility: "public" } as AddRepoTargetStatus,
      }),
    addRepoFn: () => Promise.resolve({ ok: true, value: { added: true } }),
    // The sync throws — must be caught and reported, not propagated.
    syncLabelsFn: () => Promise.reject(new Error("network down")),
    createWrappersFn: () => {
      wrapCalled = true;
      return Promise.resolve({
        ok: true,
        value: { created: ["security-scan"], skipped: [] },
      });
    },
  }));

  // Onboarding still succeeds and closes the issue.
  assertEquals(success, true);
  assertEquals(data?.outcome, "added");
  assertEquals(wrapCalled, true);
  assertEquals(data?.labels?.error, "network down");

  const close = gh.calls.find((c) => c[0] === "issue" && c[1] === "close");
  const commentBody = close?.[close.indexOf("--comment") + 1] ?? "";
  // The failure is reported in the summary, not swallowed.
  assertEquals(commentBody.includes("Canonical label sync failed"), true);
  assertEquals(commentBody.includes("network down"), true);
});

Deno.test("partial label sync failures are reported but non-fatal", async () => {
  const gh = recordingGh();

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "ok", visibility: "public" } as AddRepoTargetStatus,
      }),
    addRepoFn: () => Promise.resolve({ ok: true, value: { added: true } }),
    syncLabelsFn: (r: string) =>
      Promise.resolve({
        ok: false,
        repo: r,
        created: 14,
        updated: 0,
        skipped: 0,
        failures: 2,
        deprecated_removed: 0,
        dryRun: false,
      }),
    createWrappersFn: () =>
      Promise.resolve({
        ok: true,
        value: { created: ["security-scan"], skipped: [] },
      }),
  }));

  assertEquals(success, true);
  assertEquals(data?.labels, { created: 14, updated: 0, failures: 2 });

  const close = gh.calls.find((c) => c[0] === "issue" && c[1] === "close");
  const commentBody = close?.[close.indexOf("--comment") + 1] ?? "";
  assertEquals(commentBody.includes("2 failure(s)"), true);
});

Deno.test("branch protection is configured after the repo is added (Issue #2589)", async () => {
  const gh = recordingGh();
  const order: string[] = [];
  const bpCalls: Array<{ repo: string; visibility: RepoVisibility }> = [];

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "ok", visibility: "private" } as AddRepoTargetStatus,
      }),
    addRepoFn: () => {
      order.push("add");
      return Promise.resolve({ ok: true, value: { added: true } });
    },
    configureBranchProtectionFn: (r: string, vis: RepoVisibility) => {
      order.push("branch-protection");
      bpCalls.push({ repo: r, visibility: vis });
      return Promise.resolve({
        repo: r,
        ok: true,
        changed: true,
        added: ["quality"],
        preserved: [],
        visibility: vis,
        branch: "main",
      });
    },
    createWrappersFn: () => {
      order.push("wrappers");
      return Promise.resolve({
        ok: true,
        value: { created: ["security-scan"], skipped: [] },
      });
    },
  }));

  assertEquals(success, true);
  // The configurator was invoked once, after the repo was appended, with the
  // visibility resolved during validation (so the required-check selection is
  // visibility-aware).
  assertEquals(bpCalls, [{ repo: TARGET, visibility: "private" }]);
  assertEquals(order, ["add", "branch-protection", "wrappers"]);
  assertEquals(data?.branchProtection?.ok, true);
  assertEquals(data?.branchProtection?.changed, true);
  assertEquals(data?.branchProtection?.added, ["quality"]);

  // The branch-protection outcome is surfaced in the closing comment.
  const close = gh.calls.find((c) => c[0] === "issue" && c[1] === "close");
  const commentBody = close?.[close.indexOf("--comment") + 1] ?? "";
  assertEquals(
    commentBody.includes("Default-branch ruleset configured"),
    true,
  );
});

Deno.test("branch protection failure is non-fatal and reported (Issue #2589)", async () => {
  const gh = recordingGh();
  let wrapCalled = false;

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "ok", visibility: "public" } as AddRepoTargetStatus,
      }),
    addRepoFn: () => Promise.resolve({ ok: true, value: { added: true } }),
    // The configurator reports a failure — must be recorded, not propagated.
    configureBranchProtectionFn: (r: string) =>
      Promise.resolve({
        repo: r,
        ok: false,
        changed: false,
        added: [],
        preserved: [],
        error: "403 admin rights required",
      }),
    createWrappersFn: () => {
      wrapCalled = true;
      return Promise.resolve({
        ok: true,
        value: { created: ["security-scan"], skipped: [] },
      });
    },
  }));

  // Onboarding still succeeds and seeds wrappers despite the protection failure.
  assertEquals(success, true);
  assertEquals(data?.outcome, "added");
  assertEquals(wrapCalled, true);
  assertEquals(data?.branchProtection?.ok, false);
  assertEquals(data?.branchProtection?.error, "403 admin rights required");

  const close = gh.calls.find((c) => c[0] === "issue" && c[1] === "close");
  const commentBody = close?.[close.indexOf("--comment") + 1] ?? "";
  // The failure is reported in the summary, not swallowed.
  assertEquals(
    commentBody.includes("Branch enforcement could not be configured"),
    true,
  );
  assertEquals(commentBody.includes("403 admin rights required"), true);
});

Deno.test("branch protection that throws is caught and reported (Issue #2589)", async () => {
  const gh = recordingGh();

  const { success, data } = await run(baseDeps({
    runGhCommand: gh.fn,
    validateFn: () =>
      Promise.resolve({
        ok: true,
        value: { kind: "ok", visibility: "public" } as AddRepoTargetStatus,
      }),
    addRepoFn: () => Promise.resolve({ ok: true, value: { added: true } }),
    configureBranchProtectionFn: () =>
      Promise.reject(new Error("network down")),
    createWrappersFn: () =>
      Promise.resolve({
        ok: true,
        value: { created: ["security-scan"], skipped: [] },
      }),
  }));

  assertEquals(success, true);
  assertEquals(data?.branchProtection?.ok, false);
  assertEquals(data?.branchProtection?.error, "network down");
});

Deno.test("buildBranchProtectionLine - configured, no-change, and failure variants", () => {
  const configured = buildBranchProtectionLine({
    ok: true,
    changed: true,
    added: ["quality", "spelling"],
    branch: "main",
  });
  assertEquals(
    configured.includes("Default-branch ruleset configured"),
    true,
  );
  assertEquals(configured.includes("main"), true);
  assertEquals(configured.includes("quality, spelling"), true);

  const noChange = buildBranchProtectionLine({
    ok: true,
    changed: false,
    added: [],
    branch: "main",
  });
  assertEquals(noChange.includes("already in place"), true);

  const failed = buildBranchProtectionLine({
    ok: false,
    changed: false,
    added: [],
    error: "403 admin rights required",
  });
  assertEquals(
    failed.includes("Branch enforcement could not be configured"),
    true,
  );

  // A direct-push data repo never gets a ruleset (Issue #4356) — the line
  // says so rather than claiming one is "already in place".
  const directPush = buildBranchProtectionLine({
    ok: true,
    changed: false,
    added: [],
    branch: "Develop",
    skipped: "direct-push-branch",
    detail:
      '3493677 "Refresh of history" reached Develop without a merged pull request',
  });
  assertEquals(directPush.includes("not applied"), true);
  assertEquals(directPush.includes("takes direct pushes"), true);
  assertEquals(directPush.includes("3493677"), true);
  assertEquals(directPush.includes("already in place"), false);

  const optedOut = buildBranchProtectionLine({
    ok: true,
    changed: false,
    added: [],
    skipped: "opted-out",
  });
  assertEquals(optedOut.includes("opted out"), true);
  assertEquals(failed.includes("403 admin rights required"), true);
});

Deno.test("buildEscalationText embeds the triage grant command", () => {
  const nf = buildEscalationText("not_found", TARGET, "vibe-bot");
  assertEquals(
    nf.nextStep.includes(
      `gh api -X PUT repos/${TARGET}/collaborators/vibe-bot -f permission=triage`,
    ),
    true,
  );
  assertEquals(nf.reason.includes("could not be found"), true);

  const na = buildEscalationText("no_access", TARGET, "vibe-bot");
  assertEquals(na.reason.includes("triage"), true);
});
