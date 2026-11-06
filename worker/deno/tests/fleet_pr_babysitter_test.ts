import { classifyPrBaseChange } from "../lib/pr_base_change_guard.ts";

Deno.test("babysitter default heartbeat resolves its checkout revision", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const info = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(info.code, 0, new TextDecoder().decode(info.stderr));
    const denoDir = JSON.parse(new TextDecoder().decode(info.stdout)).denoDir;
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `
        import { recordBabysitterDeployment } from ${
          JSON.stringify(
            new URL("../commands/fleet_pr_babysitter.ts", import.meta.url).href,
          )
        };
        import { buildDefaultWorkerConfig } from ${
          JSON.stringify(
            new URL("../lib/config_defaults.ts", import.meta.url).href,
          )
        };
        await recordBabysitterDeployment(Deno.args[0], buildDefaultWorkerConfig());
      `,
        dir,
      ],
      clearEnv: true,
      env: { DENO_DIR: denoDir, PATH: Deno.env.get("PATH") ?? "", TMPDIR: dir },
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const heartbeat = JSON.parse(
      await Deno.readTextFile(`${dir}/deployment-health.json`),
    );
    assert(/^[a-f0-9]{40}(-dirty)?$/.test(heartbeat.codeRevision));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  enforceGhWriteAllowlist,
  isWriteRepoAllowed,
  isWriteRepoAllowlistActive,
  WriteRepoBlockedError,
} from "../lib/write_repo_allowlist.ts";
import { createLogger } from "../lib/logger.ts";
import {
  buildSummaryDigestMarker,
  prSummaryDigest,
  type SyncPrBodyDeps,
  syncPrBodyFromSummary,
  type SyncPrBodyInput,
} from "../lib/pr_body_sync.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { buildIdempotencyMarker, closingKeywordLine } from "../lib/pr_body.ts";
import {
  BABYSITTER_FILESYSTEM_KEY,
  BABYSITTER_PERMISSIONS_PROFILE,
  buildBabysitterSandboxArgs,
} from "../lib/fleet_babysitter_sandbox.ts";
import {
  applyPrBody,
  attemptKey,
  babysitterRtkInstruction,
  baseAlreadyMerged,
  buildRepairPrompt as buildPlatformRepairPrompt,
  cancelledRunsToRerun,
  cloneForRepair,
  type CloneForRepairDeps,
  defaultRemoteUrl,
  eligibleAuthor,
  finishBabysitterRepair,
  fix,
  loadConfigAndPublishDeployment,
  pendingPublicationStore,
  prBodyEditArgs,
  ProposalOverGoverningSummaryError,
  publishBabysitterDeployment,
  readAgentResponse,
  reason,
  recordBabysitterDeployment,
  recoverTemporaryClones,
  removeRepairDirs,
  requestedReviews,
  resumePendingPublication,
  runRepairs,
  serialiseOnMirror,
  spawnBabysitterAgent,
  syncBabysitterPrBodyBeforeDismissal,
  takePrBodyProposal,
  takeRepairPrBodyProposal,
  temporaryCloneRoot,
  validateAndCommit,
  waitForPushedHead,
  withBabysitterWriteScope,
} from "../commands/fleet_pr_babysitter.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { fingerprintWorkerReviewPolicy } from "../lib/pr_completion_report.ts";
import { escalationHostId } from "../lib/host_escalation.ts";

// Pin the macOS cases on every host; Linux cases pass their platform explicitly.
const buildRepairPrompt = (
  ...args: Parameters<typeof buildPlatformRepairPrompt>
) => {
  args[6] ??= "darwin";
  return buildPlatformRepairPrompt(...args);
};

/**
 * Run a platform-independent prompt rule against the macOS and the Linux
 * prompt; a failure names the platform whose prompt broke it.
 */
function forBothPlatforms(
  check: (
    build: (...args: Parameters<typeof buildRepairPrompt>) => string,
  ) => void,
): void {
  for (const platform of ["darwin", "linux"]) {
    try {
      check((...args) => {
        const [why, number, repo, rtk, mergedBase, failure] = args;
        return buildPlatformRepairPrompt(
          why,
          number,
          repo,
          rtk,
          mergedBase,
          failure,
          platform,
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${platform} prompt: ${message}`, { cause: error });
    }
  }
}

import { fenceUntrustedIssueText } from "../lib/prompt_delimiter.ts";

/** Run a real git command for fixtures and for the injected runner in clone tests. */
async function runGitForTest(
  args: string[],
  options: { cwd?: string; timeoutSeconds?: number } = {},
): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd: options.cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) {
    throw new Error(`git ${args[0]} failed: ${stderr || stdout}`);
  }
  return stdout;
}

function fixtureGit(args: string[], cwd: string): Promise<string> {
  return runGitForTest(
    [
      "-c",
      "user.name=Babysitter Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  );
}

async function commitFile(
  cwd: string,
  name: string,
  message: string,
): Promise<void> {
  await Deno.writeTextFile(`${cwd}/${name}`, `${message}\n`);
  await fixtureGit(["add", "-A"], cwd);
  await fixtureGit(["commit", "-q", "-m", message], cwd);
}

/** A local bare "upstream" with main (two commits) and feature (one more). */
async function makeUpstream(
  root: string,
): Promise<{ upstream: string; work: string }> {
  const work = `${root}/work`;
  const upstream = `${root}/upstream.git`;
  await Deno.mkdir(work);
  await fixtureGit(["init", "-q", "-b", "main"], work);
  await commitFile(work, "a.txt", "first");
  await commitFile(work, "b.txt", "second");
  await fixtureGit(["checkout", "-q", "-b", "feature"], work);
  await commitFile(work, "c.txt", "third");
  await fixtureGit(["checkout", "-q", "main"], work);
  await fixtureGit(["clone", "-q", "--bare", work, upstream], root);
  return { upstream, work };
}

async function withTempRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "babysitter-mirror-test-" });
  try {
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

const syncLogger = createLogger({
  host: "fleet-pr-babysitter-test",
  write: () => {},
});

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGitCommand(args, { cwd, timeoutSeconds: 10 });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(result.value.stderr || result.value.stdout);
  }
  return result.value.stdout.trim();
}

async function makeBabysitterSyncFixture(): Promise<{
  path: string;
  beforeSha: string;
  headSha: string;
  scratch: string;
}> {
  const path = await Deno.makeTempDir({ prefix: "babysitter-pr-body-" });
  await runGit(path, "init", "-q");
  await runGit(path, "config", "user.name", "test");
  await runGit(path, "config", "user.email", "test@example.invalid");
  await Deno.mkdir(`${path}/docs/archive/pr-summaries`, { recursive: true });
  const summaryPath = `${path}/docs/archive/pr-summaries/pr-summary-4637.md`;
  await Deno.writeTextFile(
    summaryPath,
    "## Summary\n\nOld summary. Part of #4637.\n",
  );
  await runGit(path, "add", ".");
  await runGit(path, "commit", "-m", "old summary");
  const beforeSha = await runGit(path, "rev-parse", "HEAD");
  await Deno.writeTextFile(
    summaryPath,
    "## Summary\n\nRepaired summary. Closes #4637.\n",
  );
  await runGit(path, "add", ".");
  await runGit(path, "commit", "-m", "repair summary");
  const headSha = await runGit(path, "rev-parse", "HEAD");
  const scratch = `${await Deno.realPath(path)}/.git/babysitter-scratch`;
  await Deno.mkdir(scratch);
  return { path, beforeSha, headSha, scratch };
}

function fakePrBodyService(
  options: {
    headSha: string;
    branch?: string;
    body: string;
    failEdit?: boolean;
    onEdit?: () => void;
  },
): { deps: SyncPrBodyDeps; getBody: () => string; edits: () => number } {
  let body = options.body;
  let editCount = 0;
  const deps: SyncPrBodyDeps = {
    runGhCommand: async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return JSON.stringify({
          body,
          files: [
            { path: "docs/archive/pr-summaries/pr-summary-4637.md" },
          ],
          headRefOid: options.headSha,
          headRefName: options.branch ?? "issue-4637-review-fix",
          closingIssuesReferences: [],
        });
      }
      if (args[0] === "pr" && args[1] === "edit") {
        editCount++;
        if (options.failEdit) {
          throw new Error("simulated body publication failure");
        }
        const bodyFile = args[args.indexOf("--body-file") + 1];
        if (!bodyFile) throw new Error("missing --body-file");
        body = await Deno.readTextFile(bodyFile);
        options.onEdit?.();
        return "";
      }
      throw new Error(`unexpected gh command: ${args.join(" ")}`);
    },
    // Issue #4712: the pushed head is `ls-remote`'d before publishing; the
    // fixture has no origin, so report the head the fake PR is at.
    runGitCommand: (args, gitOptions) =>
      args[0] === "ls-remote"
        ? Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: `${options.headSha}\trefs/heads/${
              options.branch ?? "issue-4637-review-fix"
            }\n`,
            stderr: "",
          },
        })
        : runGitCommand(args, gitOptions),
    logger: syncLogger,
  };
  return { deps, getBody: () => body, edits: () => editCount };
}

function babysitterBodySyncInput(
  path: string,
  beforeSha: string,
  branchName = "issue-4637-review-fix",
) {
  return {
    repo: "owner/repo",
    prNumber: 7,
    repoPath: path,
    beforeSha,
    workerName: "babysitter[bot]",
    githubUser: "babysitter[bot]",
    runId: "test-run",
    branchName,
  };
}

function cleanTreeFinishDeps(
  headSha: string,
  service: ReturnType<typeof fakePrBodyService>,
  dismiss: () => Promise<void>,
) {
  return {
    renewalFailed: () => false,
    runCommand: repairRunCommand({ headSha }),
    gh: service.deps.runGhCommand,
    syncBodyDeps: service.deps,
    dismiss,
  };
}

const staleMarkerlessBody = "## Summary\n\nOld summary. Part of #4637.\n";

async function cleanupFixture(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true });
}

Deno.test("a clean-tree babysitter retry repairs a marker-less stale body before dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
    });
    let dismissed = false;
    await syncBabysitterPrBodyBeforeDismissal(
      babysitterBodySyncInput(fixture.path, fixture.beforeSha),
      service.deps,
      () => {
        dismissed = true;
        return Promise.resolve();
      },
    );
    assertEquals(service.edits(), 1);
    assertStringIncludes(service.getBody(), "Repaired summary.");
    assertStringIncludes(service.getBody(), "Closes #4637");
    assertEquals(service.getBody().includes("Part of #4637"), false);
    assertEquals(dismissed, true);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("the production clean-tree completion path syncs before review dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const events: string[] = [];
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      {
        ...pr,
        number: 7,
        headRefName: "issue-4637-review-fix",
        headRefOid: fixture.headSha,
      },
      fixture.path,
      "babysitter[bot]",
      [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      cleanTreeFinishDeps(fixture.headSha, service, () => {
        events.push("dismiss");
        return Promise.resolve();
      }),
      { exchange: fixture.scratch },
    );
    assertEquals(service.edits(), 1);
    assertEquals(events, ["publish", "dismiss"]);
    assertStringIncludes(service.getBody(), "Closes #4637");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a marker-bearing body with a stale summary digest is rebuilt before dismissal, and a retry at the same head makes no second edit (Issue #4637)", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const events: string[] = [];
    const staleDigest = await prSummaryDigest(
      "## Summary\n\nOld summary. Part of #4637.\n",
    );
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: [
        staleMarkerlessBody.trimEnd(),
        "",
        buildSummaryDigestMarker(staleDigest),
        buildIdempotencyMarker(4637),
      ].join("\n"),
      onEdit: () => events.push("publish"),
    });
    const repair = () =>
      finishBabysitterRepair(
        "owner/repo",
        {
          ...pr,
          number: 7,
          headRefName: "issue-4637-review-fix",
          headRefOid: fixture.headSha,
        },
        fixture.path,
        "babysitter[bot]",
        [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
        cleanTreeFinishDeps(fixture.headSha, service, () => {
          events.push("dismiss");
          return Promise.resolve();
        }),
        { exchange: fixture.scratch },
      );
    await repair();
    assertEquals(events, ["publish", "dismiss"]);
    assertEquals(service.edits(), 1);
    assertStringIncludes(service.getBody(), "Repaired summary.");
    assertStringIncludes(service.getBody(), "Closes #4637");
    assertEquals(service.getBody().includes("Old summary."), false);
    assertEquals(
      service.getBody().includes(
        buildSummaryDigestMarker(
          await prSummaryDigest(
            "## Summary\n\nRepaired summary. Closes #4637.\n",
          ),
        ),
      ),
      true,
    );
    await repair();
    assertEquals(service.edits(), 1);
    assertEquals(events, ["publish", "dismiss", "dismiss"]);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a legacy worker body with no summary digest is rebuilt on a no-change retry, and a second retry makes no edit (Issue #4637)", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const events: string[] = [];
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: `${staleMarkerlessBody.trimEnd()}\n\n${
        buildIdempotencyMarker(4637)
      }`,
      onEdit: () => events.push("publish"),
    });
    const repair = () =>
      finishBabysitterRepair(
        "owner/repo",
        {
          ...pr,
          number: 7,
          headRefName: "issue-4637-review-fix",
          headRefOid: fixture.headSha,
        },
        fixture.path,
        "babysitter[bot]",
        [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
        cleanTreeFinishDeps(fixture.headSha, service, () => {
          events.push("dismiss");
          return Promise.resolve();
        }),
        { exchange: fixture.scratch },
      );
    await repair();
    assertEquals(events, ["publish", "dismiss"]);
    assertStringIncludes(service.getBody(), "Repaired summary.");
    assertEquals(service.getBody().includes("Old summary."), false);
    await repair();
    assertEquals(service.edits(), 1);
    assertEquals(events, ["publish", "dismiss", "dismiss"]);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a pushed fix syncs the legacy body from its original head before dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const events: string[] = [];
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      branch: "issue-4637-review-fix",
      body: `${staleMarkerlessBody}\n${buildIdempotencyMarker(4637)}`,
      onEdit: () => events.push("publish"),
    });
    const repairPr = {
      ...pr,
      number: 7,
      headRefName: "issue-4637-review-fix",
      headRefOid: fixture.beforeSha,
      reviewDecision: "CHANGES_REQUESTED",
    };
    const pushArgs: string[][] = [];
    await finishBabysitterRepair(
      "owner/repo",
      repairPr,
      fixture.path,
      "babysitter[bot]",
      [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      {
        renewalFailed: () => false,
        runCommand: async (command, args, cwd) => {
          if (command === "git" && args[0] === "status") return " M summary";
          if (command === "git" && args.includes("diff")) return "";
          if (command === "gh" && args[0] === "api") return "12345";
          if (command === "git" && args.includes("push")) {
            pushArgs.push(args);
            events.push("push");
            return "";
          }
          if (command === "git" && args[0] === "rev-parse") {
            return fixture.headSha;
          }
          if (
            command === "git" && (args[0] === "ls-tree" || args[0] === "show")
          ) {
            return await runGit(cwd!, ...args);
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
        readPr: async () => repairPr,
        gh: service.deps.runGhCommand,
        validateAndCommit: async () => {
          events.push("commit");
        },
        syncBodyDeps: service.deps,
        dismiss: async () => {
          events.push("dismiss");
        },
      },
      { exchange: fixture.scratch },
    );
    assertEquals(events, ["commit", "push", "publish", "dismiss"]);
    assert(pushArgs[0]?.some((arg) => arg.includes("issue-4637-review-fix")));
    assertStringIncludes(service.getBody(), "Closes #4637");
    assertEquals(service.getBody().includes("Part of #4637"), false);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a failed body publication keeps reviews open and a retry publishes before dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const serviceOptions = {
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
      failEdit: true,
    };
    const service = fakePrBodyService(serviceOptions);
    let dismissed = false;
    const repairPr = {
      ...pr,
      number: 7,
      headRefName: "issue-4637-review-fix",
      headRefOid: fixture.headSha,
    };
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPr,
          fixture.path,
          "babysitter[bot]",
          [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
          cleanTreeFinishDeps(fixture.headSha, service, () => {
            dismissed = true;
            return Promise.resolve();
          }),
          { exchange: fixture.scratch },
        ),
      Error,
      "simulated body publication failure",
    );
    assertEquals(dismissed, false);
    assertEquals(service.getBody(), staleMarkerlessBody);

    serviceOptions.failEdit = false;
    await finishBabysitterRepair(
      "owner/repo",
      repairPr,
      fixture.path,
      "babysitter[bot]",
      [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      cleanTreeFinishDeps(fixture.headSha, service, () => {
        dismissed = true;
        return Promise.resolve();
      }),
      { exchange: fixture.scratch },
    );
    assertEquals(service.edits(), 2);
    assertStringIncludes(service.getBody(), "Closes #4637");
    assertEquals(dismissed, true);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("an already-current PR body is harmless and does not need a second edit", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
    });
    const input = babysitterBodySyncInput(fixture.path, fixture.beforeSha);
    await syncBabysitterPrBodyBeforeDismissal(
      input,
      service.deps,
      async () => {},
    );
    const currentBody = service.getBody();
    await syncBabysitterPrBodyBeforeDismissal(
      input,
      service.deps,
      async () => {},
    );
    assertEquals(service.edits(), 1);
    assertEquals(service.getBody(), currentBody);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("an unrelated marker-less PR is not adopted and can still dismiss its review", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const unrelatedBody = "Human-authored description. Part of #4637.";
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      branch: "feature/unrelated",
      body: unrelatedBody,
    });
    let dismissed = false;
    await syncBabysitterPrBodyBeforeDismissal(
      babysitterBodySyncInput(
        fixture.path,
        fixture.beforeSha,
        "feature/unrelated",
      ),
      service.deps,
      () => {
        dismissed = true;
        return Promise.resolve();
      },
    );
    assertEquals(service.edits(), 0);
    assertEquals(service.getBody(), unrelatedBody);
    assertEquals(dismissed, true);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("Issue #4637: a pushed repair pins its body sync to the verified pushed head", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
    });
    const captured: SyncPrBodyInput[] = [];
    const syncBodyFn: typeof syncPrBodyFromSummary = async (input) => {
      captured.push(input);
      return {
        ok: true,
        value: { status: "skipped", reason: "body already current" },
      };
    };
    const repairPr = {
      ...pr,
      number: 7,
      headRefName: "issue-4637-review-fix",
      headRefOid: fixture.beforeSha,
      reviewDecision: "CHANGES_REQUESTED",
    };
    await finishBabysitterRepair(
      "owner/repo",
      repairPr,
      fixture.path,
      "babysitter[bot]",
      [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      {
        renewalFailed: () => false,
        runCommand: async (command, args) => {
          if (command === "git" && args[0] === "status") return " M summary";
          if (command === "git" && args.includes("diff")) return "";
          if (command === "gh" && args[0] === "api") return "12345";
          if (command === "git" && args.includes("push")) return "";
          if (command === "git" && args[0] === "rev-parse") {
            return fixture.headSha;
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
        readPr: async () => repairPr,
        gh: service.deps.runGhCommand,
        validateAndCommit: async () => {},
        syncBodyDeps: service.deps,
        syncBodyFn,
        dismiss: async () => {},
      },
      { exchange: fixture.scratch },
    );
    assertEquals(captured.length, 1);
    assertEquals(captured[0]?.committedHeadSha, fixture.headSha);
    assert(captured[0]?.committedHeadSha !== repairPr.headRefOid);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("Issue #4637: a no-change repair pins its body sync to the unchanged PR head", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
    });
    const captured: SyncPrBodyInput[] = [];
    const syncBodyFn: typeof syncPrBodyFromSummary = async (input) => {
      captured.push(input);
      return {
        ok: true,
        value: { status: "skipped", reason: "body already current" },
      };
    };
    const repairPr = {
      ...pr,
      number: 7,
      headRefName: "issue-4637-review-fix",
      headRefOid: fixture.headSha,
      reviewDecision: "CHANGES_REQUESTED",
    };
    await finishBabysitterRepair(
      "owner/repo",
      repairPr,
      fixture.path,
      "babysitter[bot]",
      [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      {
        renewalFailed: () => false,
        runCommand: async (command, args) => {
          if (command === "git" && args[0] === "status") return "";
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
        readPr: async () => repairPr,
        gh: service.deps.runGhCommand,
        syncBodyDeps: service.deps,
        syncBodyFn,
        dismiss: async () => {},
      },
      { exchange: fixture.scratch },
    );
    assertEquals(captured.length, 1);
    assertEquals(captured[0]?.committedHeadSha, fixture.headSha);
    assertEquals(captured[0]?.committedHeadSha, repairPr.headRefOid);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("Issue #4637: only an uncommitted-summary skip is harmless to the review dismissal", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
    });
    const input = {
      ...babysitterBodySyncInput(fixture.path, fixture.beforeSha),
      committedHeadSha: fixture.headSha,
    };
    const skipWith =
      (reason: string): typeof syncPrBodyFromSummary => async () => ({
        ok: true,
        value: { status: "skipped", reason },
      });

    let dismissed = false;
    await syncBabysitterPrBodyBeforeDismissal(
      input,
      service.deps,
      () => {
        dismissed = true;
        return Promise.resolve();
      },
      skipWith("summary not committed at the pushed head"),
    );
    assertEquals(dismissed, true);

    for (
      const reason of [
        "pushed head moved",
        "pushed head could not be verified",
        "checkout moved off the committed head",
      ]
    ) {
      dismissed = false;
      await assertRejects(
        () =>
          syncBabysitterPrBodyBeforeDismissal(
            input,
            service.deps,
            () => {
              dismissed = true;
              return Promise.resolve();
            },
            skipWith(reason),
          ),
        Error,
        reason,
      );
      assertEquals(dismissed, false);
    }
    assertEquals(service.edits(), 0);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("Issue #4637: the harmless body-sync skips each let the review dismissal run", async () => {
  const deps = fakePrBodyService({
    headSha: "0".repeat(40),
    body: staleMarkerlessBody,
  }).deps;
  for (
    const reason of [
      "summary unchanged",
      "summary file deleted",
      "body already current",
    ]
  ) {
    let dismissed = false;
    await syncBabysitterPrBodyBeforeDismissal(
      babysitterBodySyncInput("/unused-repo", "0".repeat(40)),
      deps,
      () => {
        dismissed = true;
        return Promise.resolve();
      },
      async () => ({ ok: true, value: { status: "skipped", reason } }),
    );
    assertEquals(dismissed, true, reason);
  }
});

Deno.test("Issue #4637: an unknown body-sync skip reason throws, and the reviews stay open", async () => {
  const deps = fakePrBodyService({
    headSha: "0".repeat(40),
    body: staleMarkerlessBody,
  }).deps;
  let dismissed = false;
  await assertRejects(
    () =>
      syncBabysitterPrBodyBeforeDismissal(
        babysitterBodySyncInput("/unused-repo", "0".repeat(40)),
        deps,
        () => {
          dismissed = true;
          return Promise.resolve();
        },
        async () => ({
          ok: true,
          value: { status: "skipped", reason: "an unrecognised reason" },
        }),
      ),
    Error,
    "an unrecognised reason",
  );
  assertEquals(dismissed, false);
});

Deno.test("Issue #4637: an uncommitted working-tree summary never reaches the adopted body", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: fixture.headSha,
      body: staleMarkerlessBody,
    });
    await Deno.writeTextFile(
      `${fixture.path}/docs/archive/pr-summaries/pr-summary-4637.md`,
      "## Summary\n\nUNCOMMITTED-MARKER-4637 rewritten. Closes #4637.\n",
    );
    let dismissed = false;
    await syncBabysitterPrBodyBeforeDismissal(
      {
        ...babysitterBodySyncInput(fixture.path, fixture.beforeSha),
        committedHeadSha: fixture.headSha,
      },
      service.deps,
      () => {
        dismissed = true;
        return Promise.resolve();
      },
    );
    assertEquals(service.edits(), 1);
    assertStringIncludes(service.getBody(), "Repaired summary.");
    assertEquals(
      service.getBody().includes("UNCOMMITTED-MARKER-4637"),
      false,
    );
    assertEquals(dismissed, true);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a stale repair checkout cannot dismiss reviews after body sync skips", async () => {
  const fixture = await makeBabysitterSyncFixture();
  try {
    const service = fakePrBodyService({
      headSha: "0000000000000000000000000000000000000000",
      body: staleMarkerlessBody,
    });
    let dismissed = false;
    await assertRejects(
      () =>
        syncBabysitterPrBodyBeforeDismissal(
          babysitterBodySyncInput(fixture.path, fixture.beforeSha),
          service.deps,
          () => {
            dismissed = true;
            return Promise.resolve();
          },
        ),
      Error,
      "checkout is not the PR head",
    );
    assertEquals(service.edits(), 0);
    assertEquals(dismissed, false);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

/**
 * The fake `runCommand` a repair's finish path needs. `git ls-tree` and
 * `git show` run for real in the fixture, so the summary comes from HEAD.
 */
function repairRunCommand(options: {
  headSha: string;
  changed?: boolean;
  events?: string[];
}) {
  return async (
    command: string,
    args: string[],
    cwd?: string,
  ): Promise<string> => {
    if (command === "git" && args[0] === "status") {
      return options.changed ? " M summary" : "";
    }
    if (command === "git" && args.includes("diff")) return "";
    if (command === "gh" && args[0] === "api") return "12345";
    if (command === "git" && args.includes("push")) {
      options.events?.push("push");
      return "";
    }
    if (command === "git" && args[0] === "rev-parse") return options.headSha;
    if (
      command === "git" && (args[0] === "ls-tree" || args[0] === "show") && cwd
    ) {
      return await runGit(cwd, ...args);
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

/**
 * A GitHub stand-in for a repair's reads and its description edit. Closing
 * references follow the body's closing keywords, plus any `stickyClosing`
 * issue GitHub keeps linked whatever the body says.
 */
function fakeRepairGitHub(options: {
  headRefOid: string;
  body: string;
  stickyClosing?: number[];
  failEdit?: boolean;
  onEdit?: () => void;
  /** The first `count` PR views report `head`, as GitHub lags a push. */
  staleHeadReads?: { head: string; count: number };
  /** The PR head once a description edit has landed. */
  headAfterEdit?: string;
  /** Stores a changed text in place of the description that was sent. */
  alterEdit?: (text: string) => string;
  /** Leaves `closingIssuesReferences` out of the PR view. */
  omitClosingIssues?: boolean;
}) {
  let body = options.body;
  let headRefOid = options.headRefOid;
  let edits = 0;
  let headReads = 0;
  const gh = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "view") {
      headReads++;
      const stale = options.staleHeadReads;
      const reportedHead = stale && headReads <= stale.count
        ? stale.head
        : headRefOid;
      const closing = [
        ...body.matchAll(
          /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi,
        ),
      ].map((match) => Number(match[1]));
      const numbers = [
        ...new Set([...closing, ...(options.stickyClosing ?? [])]),
      ];
      return JSON.stringify({
        headRefOid: reportedHead,
        body,
        ...(options.omitClosingIssues ? {} : {
          closingIssuesReferences: numbers.map((number) => ({
            number,
            repository: { name: "repo", owner: { login: "owner" } },
          })),
        }),
      });
    }
    if (args[0] === "pr" && args[1] === "edit") {
      edits++;
      if (options.failEdit) {
        throw new Error("simulated body publication failure");
      }
      const bodyFile = args[args.indexOf("--body-file") + 1];
      if (!bodyFile) throw new Error("missing --body-file");
      const sent = await Deno.readTextFile(bodyFile);
      body = options.alterEdit ? options.alterEdit(sent) : sent;
      if (options.headAfterEdit !== undefined) {
        headRefOid = options.headAfterEdit;
      }
      options.onEdit?.();
      return "";
    }
    throw new Error(`unexpected gh command: ${args.join(" ")}`);
  };
  return {
    gh,
    body: () => body,
    edits: () => edits,
    headReads: () => headReads,
  };
}

/**
 * A repository whose HEAD commits `summary` at `summaryPath`, by default the
 * canonical archive path for `issueNumber`.
 */
async function makeCommittedSummaryRepo(
  issueNumber: number,
  summary: string,
  summaryPath = `docs/archive/pr-summaries/pr-summary-${issueNumber}.md`,
): Promise<{ path: string; headSha: string; scratch: string }> {
  const path = await Deno.makeTempDir({ prefix: "babysitter-repair-" });
  await runGit(path, "init", "-q");
  await runGit(path, "config", "user.name", "test");
  await runGit(path, "config", "user.email", "test@example.invalid");
  await Deno.mkdir(`${path}/${summaryPath.replace(/\/[^/]*$/, "")}`, {
    recursive: true,
  });
  await Deno.writeTextFile(`${path}/${summaryPath}`, summary);
  await runGit(path, "add", ".");
  await runGit(path, "commit", "-q", "-m", "repair");
  const scratch = `${await Deno.realPath(path)}/.git/babysitter-scratch`;
  await Deno.mkdir(scratch);
  return { path, headSha: await runGit(path, "rev-parse", "HEAD"), scratch };
}

/** A summary that says it is only part of #issueNumber, with one unmet criterion. */
function partialSummary(
  issueNumber: number,
  status: "partial" | "missing" = "partial",
): string {
  return [
    "## Summary",
    "",
    `Part of #${issueNumber}.`,
    "",
    "## Acceptance Criteria",
    "",
    `- **${status}** — the closing criterion — reason: not finished`,
    "",
  ].join("\n");
}

/** A summary whose criteria are all met and which closes #issueNumber. */
function closingSummary(issueNumber: number): string {
  return [
    "## Summary",
    "",
    `Closes #${issueNumber}.`,
    "",
    "## Acceptance Criteria",
    "",
    "- **met** — the criterion — evidence: `deno task test:unit` — reviewer: met",
    "",
  ].join("\n");
}

/** A body sync that finds the body already current, so the repair's own publication is what runs. */
const skipSync: typeof syncPrBodyFromSummary = async () => ({
  ok: true,
  value: { status: "skipped", reason: "body already current" },
});

/**
 * A repair that pushed: the PR was at an older head, the fixture's head is the
 * pushed one, and GitHub's view already shows it (Issue #4637).
 */
function pushedRepair(
  fixture: { headSha: string },
  github: ReturnType<typeof fakeRepairGitHub>,
  events: string[],
) {
  const repairPr = {
    ...repairPrFor("1".repeat(40), 7),
    reviewDecision: "CHANGES_REQUESTED",
  };
  return {
    repairPr,
    deps: {
      ...repairFinishDeps({
        headSha: fixture.headSha,
        github,
        events,
        changed: true,
      }),
      readPr: async () => repairPr,
      validateAndCommit: async () => {},
      headWaitDelayMs: 0,
    },
  };
}

type RepairReviews = Parameters<typeof finishBabysitterRepair>[4];

function changesRequestedBy(): RepairReviews {
  return [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }];
}

function repairPrFor(headSha: string, number: number) {
  return {
    ...pr,
    number,
    headRefName: "issue-4674-fix",
    headRefOid: headSha,
  };
}

function repairFinishDeps(options: {
  headSha: string;
  github: ReturnType<typeof fakeRepairGitHub>;
  events: string[];
  changed?: boolean;
  syncFn?: typeof syncPrBodyFromSummary;
}) {
  return {
    renewalFailed: () => false,
    runCommand: repairRunCommand({
      headSha: options.headSha,
      changed: options.changed,
      events: options.events,
    }),
    gh: options.github.gh,
    syncBodyFn: options.syncFn ?? skipSync,
    dismiss: () => {
      options.events.push("dismiss");
      return Promise.resolve();
    },
  };
}

Deno.test("Issue #4716: a proposal that re-closes a partial issue is withheld, and reviews stay open while GitHub still links it", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      stickyClosing: [4674],
      onEdit: () => events.push("publish"),
    });
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPrFor(fixture.headSha, 7),
          fixture.path,
          "babysitter[bot]",
          changesRequestedBy(),
          repairFinishDeps({ headSha: fixture.headSha, github, events }),
          {
            exchange: fixture.scratch,
            pushedByEarlierRepair: true,
            proposal: "Rewritten.\n\nclose #4674\n\nThis does not close #4674",
          },
        ),
      Error,
      "still closes #4674",
    );
    assertEquals(events, ["publish"]);
    assertEquals(closingKeywordLine(github.body(), 4674), null);
    assertStringIncludes(github.body(), "Part of #4674");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("Issue #4716: a proposal that re-closes a missing issue is withheld, and its review is dismissed once GitHub shows it open", async () => {
  const fixture = await makeCommittedSummaryRepo(
    4674,
    partialSummary(4674, "missing"),
  );
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      repairPrFor(fixture.headSha, 7),
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      repairFinishDeps({ headSha: fixture.headSha, github, events }),
      {
        exchange: fixture.scratch,
        pushedByEarlierRepair: true,
        proposal: "Rewritten.\n\nFixes #4674",
      },
    );
    assertEquals(events, ["publish", "dismiss"]);
    assertEquals(closingKeywordLine(github.body(), 4674), null);
    assertStringIncludes(github.body(), "Part of #4674");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a proposal that omits a withheld issue gets Part of #N, not Closes #N", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      repairPrFor(fixture.headSha, 7),
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      repairFinishDeps({ headSha: fixture.headSha, github, events }),
      {
        exchange: fixture.scratch,
        pushedByEarlierRepair: true,
        proposal: "Rewritten description.",
      },
    );
    assertEquals(events, ["publish", "dismiss"]);
    assertStringIncludes(github.body(), "Part of #4674");
    assertEquals(closingKeywordLine(github.body(), 4674), null);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a proposal that omits a fully met issue gets Closes #N", async () => {
  const fixture = await makeCommittedSummaryRepo(4637, closingSummary(4637));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4637\n\n${buildIdempotencyMarker(4637)}`,
      onEdit: () => events.push("publish"),
    });
    const pushed = pushedRepair(fixture, github, events);
    await finishBabysitterRepair(
      "owner/repo",
      pushed.repairPr,
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      pushed.deps,
      { exchange: fixture.scratch, proposal: "Rewritten description." },
    );
    assertEquals(events, ["push", "publish", "dismiss"]);
    assertStringIncludes(github.body(), "Rewritten description.");
    assertStringIncludes(github.body(), "Closes #4637");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a fully met summary with no closing keyword keeps the close after a repair, with or without a proposal (Issue #4637)", async () => {
  const summary = closingSummary(4637).replace("Closes #4637.", "All done.");
  for (const proposal of [undefined, "Rewritten description."]) {
    const fixture = await makeCommittedSummaryRepo(4637, summary);
    try {
      const events: string[] = [];
      const github = fakeRepairGitHub({
        headRefOid: fixture.headSha,
        body: `Closes #4637\n\n${buildIdempotencyMarker(4637)}`,
        onEdit: () => events.push("publish"),
      });
      await finishBabysitterRepair(
        "owner/repo",
        repairPrFor(fixture.headSha, 7),
        fixture.path,
        "babysitter[bot]",
        changesRequestedBy(),
        repairFinishDeps({ headSha: fixture.headSha, github, events }),
        { exchange: fixture.scratch, pushedByEarlierRepair: true, proposal },
      );
      assertStringIncludes(github.body(), "Closes #4637");
      assertEquals(github.body().includes("Part of #4637"), false);
      assertEquals(events.at(-1), "dismiss");
      if (proposal === undefined) assertEquals(github.edits(), 0);
    } finally {
      await cleanupFixture(fixture.path);
    }
  }
});

Deno.test("a missing criterion withholds the close at finish level and keeps another issue's reference (Issue #4716)", async () => {
  const fixture = await makeCommittedSummaryRepo(
    4674,
    partialSummary(4674, "missing"),
  );
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\nFixes #9\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      repairPrFor(fixture.headSha, 7),
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      repairFinishDeps({ headSha: fixture.headSha, github, events }),
      {
        exchange: fixture.scratch,
        pushedByEarlierRepair: true,
        proposal: "Rewritten. Closes #4674 and fixes #9.",
      },
    );
    assertEquals(events, ["publish", "dismiss"]);
    assertEquals(closingKeywordLine(github.body(), 4674), null);
    assertStringIncludes(github.body(), "Part of #4674");
    assertStringIncludes(github.body(), "ixes #9");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a head that moved before publication publishes nothing and keeps reviews open", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: "0".repeat(40),
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPrFor(fixture.headSha, 7),
          fixture.path,
          "babysitter[bot]",
          changesRequestedBy(),
          repairFinishDeps({ headSha: fixture.headSha, github, events }),
          { exchange: fixture.scratch, proposal: "Rewritten description." },
        ),
      Error,
      "head moved",
    );
    assertEquals(github.edits(), 0);
    assertEquals(events, []);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a failed description edit keeps reviews open, and a retry at the same head publishes and dismisses", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const githubOptions = {
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      failEdit: true,
      onEdit: () => events.push("publish"),
    };
    const github = fakeRepairGitHub(githubOptions);
    const finish = () =>
      finishBabysitterRepair(
        "owner/repo",
        repairPrFor(fixture.headSha, 7),
        fixture.path,
        "babysitter[bot]",
        changesRequestedBy(),
        repairFinishDeps({ headSha: fixture.headSha, github, events }),
        {
          exchange: fixture.scratch,
          pushedByEarlierRepair: true,
          proposal: "Rewritten description.",
        },
      );
    await assertRejects(
      finish,
      Error,
      "simulated body publication failure",
    );
    assertEquals(events, []);
    githubOptions.failEdit = false;
    // Each real repair gets a fresh runner-owned exchange directory.
    await Deno.remove(`${fixture.scratch}/pr-body.md`);
    await finish();
    assertEquals(events, ["publish", "dismiss"]);
    assertEquals(github.edits(), 2);
    assertStringIncludes(github.body(), "Part of #4674");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a retry at the same head with the description already current makes no second edit", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    const finish = () =>
      finishBabysitterRepair(
        "owner/repo",
        repairPrFor(fixture.headSha, 7),
        fixture.path,
        "babysitter[bot]",
        changesRequestedBy(),
        repairFinishDeps({ headSha: fixture.headSha, github, events }),
        {
          exchange: fixture.scratch,
          pushedByEarlierRepair: true,
          proposal: "Rewritten description.",
        },
      );
    await finish();
    const published = github.body();
    await finish();
    assertEquals(github.edits(), 1);
    assertEquals(github.body(), published);
    assertEquals(events, ["publish", "dismiss", "dismiss"]);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a repair with no code change withholds the close after the sync and dismisses last", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    const syncFn: typeof syncPrBodyFromSummary = async () => {
      events.push("sync");
      return {
        ok: true,
        value: { status: "skipped", reason: "body already current" },
      };
    };
    await finishBabysitterRepair(
      "owner/repo",
      repairPrFor(fixture.headSha, 7),
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      repairFinishDeps({ headSha: fixture.headSha, github, events, syncFn }),
      {
        exchange: fixture.scratch,
        pushedByEarlierRepair: true,
        proposal: "Rewritten.\n\nCloses #4674",
      },
    );
    assertEquals(events, ["sync", "publish", "dismiss"]);
    assertEquals(closingKeywordLine(github.body(), 4674), null);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("with nothing pushed, a proposal over a governing committed summary keeps the reviews open and leaves no pending record, and the same proposal is published once a push backs it (PR #4779 review)", async () => {
  const fixture = await makeCommittedSummaryRepo(4637, closingSummary(4637));
  const state = await Deno.makeTempDir({ prefix: "babysitter-state-" });
  try {
    const unsupported =
      "Rewritten. A fix and a regression test were added in this repair.";
    const live = `Part of #4637\n\n${buildIdempotencyMarker(4637)}`;
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: live,
      onEdit: () => events.push("publish"),
    });
    const reviews = changesRequestedBy();
    const publication = pendingPublicationStore(
      state,
      "owner/repo",
      7,
      reviews,
    );
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPrFor(fixture.headSha, 7),
          fixture.path,
          "babysitter[bot]",
          reviews,
          {
            ...repairFinishDeps({ headSha: fixture.headSha, github, events }),
            publication,
          },
          { exchange: fixture.scratch, proposal: unsupported },
        ),
      ProposalOverGoverningSummaryError,
      "change the committed summary to change the description",
    );
    assertEquals(github.edits(), 0);
    assertEquals(github.body(), live);
    assertEquals(events, []);
    assertEquals(await publication.load(fixture.headSha), undefined);

    const pushedEvents: string[] = [];
    const pushedGithub = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: live,
      onEdit: () => pushedEvents.push("publish"),
    });
    const pushed = pushedRepair(fixture, pushedGithub, pushedEvents);
    await finishBabysitterRepair(
      "owner/repo",
      pushed.repairPr,
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      pushed.deps,
      { exchange: fixture.scratch, proposal: unsupported },
    );
    assertStringIncludes(pushedGithub.body(), unsupported);
  } finally {
    await cleanupFixture(fixture.path);
    await cleanupFixture(state);
  }
});

Deno.test("a pushed repair whose proposal only mentions a fully met issue still closes it (PR #4779 review)", async () => {
  const fixture = await makeCommittedSummaryRepo(4637, closingSummary(4637));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4637\n\n${buildIdempotencyMarker(4637)}`,
      onEdit: () => events.push("publish"),
    });
    const pushed = pushedRepair(fixture, github, events);
    await finishBabysitterRepair(
      "owner/repo",
      pushed.repairPr,
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      pushed.deps,
      {
        exchange: fixture.scratch,
        proposal: "Rewritten. This addresses the review on Issue #4637.",
      },
    );
    assertEquals(events, ["push", "publish", "dismiss"]);
    assertStringIncludes(github.body(), "addresses the review on Issue #4637");
    assertEquals(closingKeywordLine(github.body(), 4637), "Closes #4637");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("with nothing pushed and no committed summary, a proposal is published through the guard and never closes the issue (PR #4779 review)", async () => {
  // The only committed summary is for another issue, so #4674 has none.
  const fixture = await makeCommittedSummaryRepo(1, closingSummary(1));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      repairPrFor(fixture.headSha, 7),
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      repairFinishDeps({ headSha: fixture.headSha, github, events }),
      { exchange: fixture.scratch, proposal: "Rewritten.\n\nCloses #4674" },
    );
    assertEquals(events, ["publish", "dismiss"]);
    assertStringIncludes(github.body(), "Rewritten.");
    assertEquals(closingKeywordLine(github.body(), 4674), null);
    assertStringIncludes(github.body(), "Part of #4674");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a marker-less worker-branch PR with no committed summary never closes its issue, with or without a proposal (PR #4779 review)", async () => {
  const fixture = await makeCommittedSummaryRepo(1, closingSummary(1));
  try {
    for (
      const proposal of [
        undefined,
        "Rewritten. Part of #4674 and more.",
        "Rewritten. Closes #4674",
      ]
    ) {
      const events: string[] = [];
      const github = fakeRepairGitHub({
        headRefOid: fixture.headSha,
        body: "Closes #4674",
        onEdit: () => events.push("publish"),
      });
      await finishBabysitterRepair(
        "owner/repo",
        repairPrFor(fixture.headSha, 7),
        fixture.path,
        "babysitter[bot]",
        changesRequestedBy(),
        repairFinishDeps({ headSha: fixture.headSha, github, events }),
        { exchange: fixture.scratch, proposal },
      );
      assertEquals(events, ["publish", "dismiss"], String(proposal));
      assertEquals(closingKeywordLine(github.body(), 4674), null);
      assertStringIncludes(github.body(), "Part of #4674");
      await Deno.remove(`${fixture.scratch}/pr-body.md`);
    }
    // Positive control: a branch that names no issue is an unrelated PR, so its
    // own closing reference is left alone.
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: "Closes #4674",
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      { ...repairPrFor(fixture.headSha, 7), headRefName: "feature" },
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      repairFinishDeps({ headSha: fixture.headSha, github, events }),
      { exchange: fixture.scratch, proposal: "Rewritten." },
    );
    assertEquals(closingKeywordLine(github.body(), 4674), "Closes #4674");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a failed publication is resumed by the next scan without the agent, and the record is cleared (PR #4779 review)", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  const state = await Deno.makeTempDir({ prefix: "babysitter-state-" });
  try {
    const events: string[] = [];
    const githubOptions = {
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      failEdit: true,
      onEdit: () => events.push("publish"),
    };
    const github = fakeRepairGitHub(githubOptions);
    const reviews = changesRequestedBy();
    const publication = pendingPublicationStore(
      state,
      "owner/repo",
      7,
      reviews,
    );
    const deps = {
      ...repairFinishDeps({ headSha: fixture.headSha, github, events }),
      publication,
    };
    const repairPr = repairPrFor(fixture.headSha, 7);
    assertEquals(
      await resumePendingPublication({
        repo: "owner/repo",
        pr: repairPr,
        repoPath: fixture.path,
        login: "babysitter[bot]",
        reviews,
        deps,
        exchange: fixture.scratch,
      }),
      false,
    );
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPr,
          fixture.path,
          "babysitter[bot]",
          reviews,
          deps,
          {
            exchange: fixture.scratch,
            pushedByEarlierRepair: true,
            proposal: "Rewritten description.",
          },
        ),
      Error,
      "simulated body publication failure",
    );
    assertEquals(await publication.load(fixture.headSha), {
      proposal: "Rewritten description.",
      pushed: true,
    });
    assertEquals(events, []);

    githubOptions.failEdit = false;
    await Deno.remove(`${fixture.scratch}/pr-body.md`);
    assertEquals(
      await resumePendingPublication({
        repo: "owner/repo",
        pr: repairPr,
        repoPath: fixture.path,
        login: "babysitter[bot]",
        reviews,
        deps,
        exchange: fixture.scratch,
      }),
      true,
    );
    assertEquals(events, ["publish", "dismiss"]);
    assertStringIncludes(github.body(), "Part of #4674");
    assertEquals(await publication.load(fixture.headSha), undefined);
  } finally {
    await cleanupFixture(fixture.path);
    await cleanupFixture(state);
  }
});

Deno.test("a resumed publication for a pushed head still publishes the proposal that the push backs (PR #4779 review)", async () => {
  const fixture = await makeCommittedSummaryRepo(4637, closingSummary(4637));
  const state = await Deno.makeTempDir({ prefix: "babysitter-state-" });
  try {
    const events: string[] = [];
    const githubOptions = {
      headRefOid: fixture.headSha,
      body: `Part of #4637\n\n${buildIdempotencyMarker(4637)}`,
      failEdit: true,
      onEdit: () => events.push("publish"),
    };
    const github = fakeRepairGitHub(githubOptions);
    const reviews = changesRequestedBy();
    const publication = pendingPublicationStore(
      state,
      "owner/repo",
      7,
      reviews,
    );
    const pushed = pushedRepair(fixture, github, events);
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          pushed.repairPr,
          fixture.path,
          "babysitter[bot]",
          reviews,
          { ...pushed.deps, publication },
          { exchange: fixture.scratch, proposal: "Rewritten description." },
        ),
      Error,
      "simulated body publication failure",
    );
    assertEquals(await publication.load(fixture.headSha), {
      proposal: "Rewritten description.",
      pushed: true,
    });
    githubOptions.failEdit = false;
    await Deno.remove(`${fixture.scratch}/pr-body.md`);
    // The next scan sees the pushed head as the PR's own head.
    assertEquals(
      await resumePendingPublication({
        repo: "owner/repo",
        pr: repairPrFor(fixture.headSha, 7),
        repoPath: fixture.path,
        login: "babysitter[bot]",
        reviews,
        deps: {
          ...repairFinishDeps({ headSha: fixture.headSha, github, events }),
          publication,
        },
        exchange: fixture.scratch,
      }),
      true,
    );
    assertStringIncludes(github.body(), "Rewritten description.");
    assertStringIncludes(github.body(), "Closes #4637");
  } finally {
    await cleanupFixture(fixture.path);
    await cleanupFixture(state);
  }
});

/** An agent stand-in that, like the real one, is stopped by an existing attempt marker. */
Deno.test("a pending publication is kept per head and review, and a damaged record is ignored loudly (PR #4779 review)", async () => {
  const state = await Deno.makeTempDir({ prefix: "babysitter-state-" });
  try {
    const first = changesRequestedBy();
    const store = pendingPublicationStore(state, "owner/repo", 7, first);
    await store.save("a".repeat(40), { proposal: "x", pushed: true });
    assertEquals(await store.load("a".repeat(40)), {
      proposal: "x",
      pushed: true,
    });
    assertEquals(await store.load("b".repeat(40)), undefined);
    const newer = [{ ...first[0]!, id: 2 }];
    assertEquals(
      await pendingPublicationStore(state, "owner/repo", 7, newer).load(
        "a".repeat(40),
      ),
      undefined,
    );
    await store.clear("a".repeat(40));
    await store.clear("a".repeat(40));
    assertEquals(await store.load("a".repeat(40)), undefined);
    const file = `${state}/${
      attemptKey("owner/repo", 7, "c".repeat(40), first)
    }--publication.json`;
    for (const damaged of ["{", '{"pushed":"yes"}', "null"]) {
      await Deno.writeTextFile(file, damaged);
      assertEquals(await store.load("c".repeat(40)), undefined, damaged);
    }
  } finally {
    await cleanupFixture(state);
  }
});

Deno.test("a stale close left by an earlier proposal is withheld by the next repair, with no proposal", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      repairPrFor(fixture.headSha, 7),
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      repairFinishDeps({ headSha: fixture.headSha, github, events }),
      { exchange: fixture.scratch },
    );
    assertEquals(events, ["publish", "dismiss"]);
    assertEquals(closingKeywordLine(github.body(), 4674), null);
    assertStringIncludes(github.body(), "Part of #4674");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("the withholding evidence is the summary committed at the pushed head, never the working tree", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    // Uncommitted rewrites at both the canonical and the legacy path say the
    // issue is met; neither is evidence, so the committed partial summary wins.
    await Deno.writeTextFile(
      `${fixture.path}/docs/archive/pr-summaries/pr-summary-4674.md`,
      "## Summary\n\nCloses #4674.\n",
    );
    await Deno.mkdir(`${fixture.path}/docs`, { recursive: true });
    await Deno.writeTextFile(
      `${fixture.path}/docs/pr-summary-4674.md`,
      "## Summary\n\nCloses #4674.\n",
    );
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await finishBabysitterRepair(
      "owner/repo",
      repairPrFor(fixture.headSha, 7),
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      repairFinishDeps({ headSha: fixture.headSha, github, events }),
      {
        exchange: fixture.scratch,
        pushedByEarlierRepair: true,
        proposal: "Rewritten description.",
      },
    );
    assertEquals(events, ["publish", "dismiss"]);
    assertStringIncludes(github.body(), "Part of #4674");
    assertEquals(closingKeywordLine(github.body(), 4674), null);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a summary committed only at the legacy docs/pr-summary-N.md path at the head is found and governs the close", async () => {
  const fixture = await makeCommittedSummaryRepo(
    4637,
    closingSummary(4637),
    "docs/pr-summary-4637.md",
  );
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Part of #4637\n\n${buildIdempotencyMarker(4637)}`,
      onEdit: () => events.push("publish"),
    });
    const pushed = pushedRepair(fixture, github, events);
    await finishBabysitterRepair(
      "owner/repo",
      pushed.repairPr,
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      pushed.deps,
      { exchange: fixture.scratch, proposal: "Rewritten description." },
    );
    assertEquals(events, ["push", "publish", "dismiss"]);
    assertStringIncludes(github.body(), "Closes #4637");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a committed summary that cannot be read throws, and reviews stay open", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    // A commit the clone does not have: the committed read fails loudly.
    const missingSha = "1".repeat(40);
    const github = fakeRepairGitHub({
      headRefOid: missingSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPrFor(missingSha, 7),
          fixture.path,
          "babysitter[bot]",
          changesRequestedBy(),
          repairFinishDeps({ headSha: missingSha, github, events }),
          { exchange: fixture.scratch, proposal: "Rewritten description." },
        ),
      Error,
      "Failed to read PR summary",
    );
    assertEquals(github.edits(), 0);
    assertEquals(events, []);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a pushed head that GitHub's PR view reports late is waited for, then the repair publishes and dismisses", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const oldHead = "1".repeat(40);
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      staleHeadReads: { head: oldHead, count: 2 },
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    const repairPr = {
      ...repairPrFor(oldHead, 7),
      reviewDecision: "CHANGES_REQUESTED",
    };
    await finishBabysitterRepair(
      "owner/repo",
      repairPr,
      fixture.path,
      "babysitter[bot]",
      changesRequestedBy(),
      {
        ...repairFinishDeps({
          headSha: fixture.headSha,
          github,
          events,
          changed: true,
        }),
        readPr: async () => repairPr,
        validateAndCommit: async () => {},
        headWaitDelayMs: 0,
      },
      { exchange: fixture.scratch, proposal: "Rewritten description." },
    );
    assert(github.headReads() >= 3);
    assertEquals(events, ["push", "publish", "dismiss"]);
    assertStringIncludes(github.body(), "Part of #4674");
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a PR view that never reaches the pushed head throws before the sync, publishing nothing and dismissing nothing", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const oldHead = "1".repeat(40);
    const github = fakeRepairGitHub({
      headRefOid: oldHead,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    const repairPr = {
      ...repairPrFor(oldHead, 7),
      reviewDecision: "CHANGES_REQUESTED",
    };
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPr,
          fixture.path,
          "babysitter[bot]",
          changesRequestedBy(),
          {
            ...repairFinishDeps({
              headSha: fixture.headSha,
              github,
              events,
              changed: true,
            }),
            readPr: async () => repairPr,
            validateAndCommit: async () => {},
            headWaitDelayMs: 0,
          },
          { exchange: fixture.scratch, proposal: "Rewritten description." },
        ),
      Error,
      "PR head did not reach the pushed head",
    );
    assertEquals(github.edits(), 0);
    assertEquals(events, ["push"]);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a PR view that omits closingIssuesReferences is refused by name, and nothing is published or dismissed", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      omitClosingIssues: true,
      onEdit: () => events.push("publish"),
    });
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPrFor(fixture.headSha, 7),
          fixture.path,
          "babysitter[bot]",
          changesRequestedBy(),
          repairFinishDeps({ headSha: fixture.headSha, github, events }),
          { exchange: fixture.scratch, proposal: "Rewritten description." },
        ),
      Error,
      "closingIssuesReferences",
    );
    assertEquals(github.edits(), 0);
    assertEquals(events, []);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a head that moves after the description is published keeps reviews open", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      headAfterEdit: "2".repeat(40),
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      onEdit: () => events.push("publish"),
    });
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPrFor(fixture.headSha, 7),
          fixture.path,
          "babysitter[bot]",
          changesRequestedBy(),
          repairFinishDeps({ headSha: fixture.headSha, github, events }),
          {
            exchange: fixture.scratch,
            pushedByEarlierRepair: true,
            proposal: "Rewritten description.",
          },
        ),
      Error,
      "head moved",
    );
    assertEquals(github.edits(), 1);
    assertEquals(events, ["publish"]);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("a description GitHub does not show as published keeps reviews open", async () => {
  const fixture = await makeCommittedSummaryRepo(4674, partialSummary(4674));
  try {
    const events: string[] = [];
    const github = fakeRepairGitHub({
      headRefOid: fixture.headSha,
      body: `Closes #4674\n\n${buildIdempotencyMarker(4674)}`,
      alterEdit: (text) => `${text}\n\nEdited on GitHub.`,
      onEdit: () => events.push("publish"),
    });
    await assertRejects(
      () =>
        finishBabysitterRepair(
          "owner/repo",
          repairPrFor(fixture.headSha, 7),
          fixture.path,
          "babysitter[bot]",
          changesRequestedBy(),
          repairFinishDeps({ headSha: fixture.headSha, github, events }),
          {
            exchange: fixture.scratch,
            pushedByEarlierRepair: true,
            proposal: "Rewritten description.",
          },
        ),
      Error,
      "is not the one published",
    );
    assertEquals(github.edits(), 1);
    assertEquals(events, ["publish"]);
  } finally {
    await cleanupFixture(fixture.path);
  }
});

Deno.test("failed clone is attempted once and preserves its original error", async () => {
  await withTempRoot(async (root) => {
    const calls: string[][] = [];
    const timeout = new Error("clone timed out");
    await assertRejects(
      () =>
        cloneForRepair("owner/repo", `${root}/clone`, {
          git: (args) => {
            calls.push(args);
            return Promise.reject(timeout);
          },
          remoteUrl: () => Promise.resolve("/tmp/upstream"),
          mirrorRoot: `${root}/mirrors`,
        }),
      Error,
      "clone timed out",
    );
    assertEquals(calls.filter((args) => args.includes("clone")).length, 1);
  });
});

Deno.test("first repair clones full history from a local mirror, with origin reset to GitHub", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const dir = `${root}/clone`;
    await cloneForRepair("owner/repo", dir, {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    assertEquals(
      await runGitForTest(["rev-list", "--count", "--all"], { cwd: dir }),
      await runGitForTest(["rev-list", "--count", "--all"], { cwd: upstream }),
    );
    await runGitForTest(["merge-base", "origin/main", "origin/feature"], {
      cwd: dir,
    });
    assertEquals(await exists(`${dir}/.git/objects/info/alternates`), false);
    assertEquals(
      await runGitForTest(["config", "remote.origin.url"], { cwd: dir }),
      upstream,
    );
    const mirror = `${mirrorRoot}/owner--repo.git`;
    assertEquals(
      await runGitForTest(["rev-parse", "--is-bare-repository"], {
        cwd: mirror,
      }),
      "true",
    );
  });
});

Deno.test("a later repair fetches into the mirror and clones from it, without a second bare clone", async () => {
  await withTempRoot(async (root) => {
    const { upstream, work } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const mirror = `${mirrorRoot}/owner--repo.git`;
    const calls: { args: string[]; cwd?: string }[] = [];
    const deps: CloneForRepairDeps = {
      git: (args, options) => {
        calls.push({ args, cwd: options?.cwd });
        return runGitForTest(args, options);
      },
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    await commitFile(work, "d.txt", "fourth");
    await fixtureGit(["push", "-q", upstream, "main"], work);
    const dir2 = `${root}/clone-2`;
    await cloneForRepair("owner/repo", dir2, deps);
    assertEquals(
      await runGitForTest(["log", "-1", "--format=%s", "origin/main"], {
        cwd: dir2,
      }),
      "fourth",
    );
    const fetchIndex = calls.findIndex((call) => call.args[0] === "fetch");
    assertEquals(calls[fetchIndex], {
      args: [
        "fetch",
        "--no-auto-maintenance",
        "--prune",
        upstream,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*",
      ],
      cwd: mirror,
    });
    assertEquals(calls[fetchIndex + 1], {
      args: [
        "-c",
        "maintenance.autoDetach=false",
        "-c",
        "gc.autoDetach=false",
        "maintenance",
        "run",
        "--auto",
      ],
      cwd: mirror,
    });
    assertEquals(calls[fetchIndex + 2]?.args.slice(0, 3), [
      "clone",
      "--no-checkout",
      "--no-hardlinks",
    ]);
    assertEquals(
      calls.filter((call) =>
        call.args[0] === "clone" && call.args[1] === "--bare"
      ).length,
      1,
    );
  });
});

Deno.test("a clone keeps its full history after the mirror is deleted", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const dir = `${root}/clone`;
    await cloneForRepair("owner/repo", dir, {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    await Deno.remove(`${mirrorRoot}/owner--repo.git`, { recursive: true });
    await runGitForTest(["fsck"], { cwd: dir });
    assertEquals(
      await runGitForTest(["rev-list", "--count", "--all"], { cwd: dir }),
      "3",
    );
  });
});

/** Every regular file under a directory, found recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) found.push(...await filesUnder(path));
    else if (entry.isFile) found.push(path);
  }
  return found;
}

Deno.test("the clone copies its objects, so no object file is hardlinked to the mirror", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const mirror = `${mirrorRoot}/owner--repo.git`;
    const dir = `${root}/clone`;
    await cloneForRepair("owner/repo", dir, {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    const mirrorObjects = await filesUnder(`${mirror}/objects`);
    assert(
      mirrorObjects.length > 0,
      "the mirror holds no object files to compare",
    );
    const cloneObjects = await filesUnder(`${dir}/.git/objects`);
    assert(cloneObjects.length > 0, "the clone holds no object files to check");
    for (const file of cloneObjects) {
      assertEquals((await Deno.stat(file)).nlink, 1, `${file} is hardlinked`);
    }
  });
});

Deno.test("a failed fetch keeps git's cause and leaves the mirror in place", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const mirror = `${mirrorRoot}/owner--repo.git`;
    const deps: CloneForRepairDeps = {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    await Deno.rename(upstream, `${root}/upstream-moved.git`);
    await assertRejects(
      () => cloneForRepair("owner/repo", `${root}/clone-2`, deps),
      Error,
      "does not appear to be a git repository",
    );
    assert(await exists(mirror));
  });
});

Deno.test("a repository name that is not owner/name is refused before any git runs", async () => {
  await withTempRoot(async (root) => {
    const calls: string[][] = [];
    await assertRejects(
      () =>
        cloneForRepair("../x", `${root}/clone`, {
          git: (args) => {
            calls.push(args);
            return Promise.resolve("");
          },
          remoteUrl: () => Promise.resolve("/tmp/upstream"),
          mirrorRoot: `${root}/mirrors`,
        }),
      Error,
      "Invalid repository",
    );
    assertEquals(calls, []);
  });
});

Deno.test("concurrent repairs of one repo never mutate its mirror at the same time", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const calls: string[] = [];
    const deps: CloneForRepairDeps = {
      git: async (args, options) => {
        if (
          args[0] === "fetch" || (args[0] === "clone" && args[1] === "--bare")
        ) calls.push("mirror");
        if (args[0] === "remote") calls.push("set-url");
        return await runGitForTest(args, options);
      },
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot: `${root}/mirrors`,
    };
    await Promise.all([
      cloneForRepair("owner/repo", `${root}/clone-a`, deps),
      cloneForRepair("owner/repo", `${root}/clone-b`, deps),
    ]);
    assertEquals(calls, ["mirror", "set-url", "mirror", "set-url"]);
    for (const dir of [`${root}/clone-a`, `${root}/clone-b`]) {
      assertEquals(
        await runGitForTest(["rev-list", "--count", "--all"], { cwd: dir }),
        "3",
      );
    }
  });
});

Deno.test("babysitter deployment heartbeat stores host, revision and policy fingerprint", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const split = buildDefaultWorkerConfig();
    split.issueExecutorSplit = true;
    const unsplit = buildDefaultWorkerConfig();
    unsplit.issueExecutorSplit = false;

    await recordBabysitterDeployment(
      dir,
      split,
      "abcdef0123456789",
      "2026-11-02T00:00:00.000Z",
    );
    const first = JSON.parse(
      await Deno.readTextFile(`${dir}/deployment-health.json`),
    );
    assertEquals(first.component, "babysitter");
    assertEquals(first.hostId, escalationHostId());
    assertEquals(first.codeRevision, "abcdef0123456789");
    assertEquals(first.observedAt, "2026-11-02T00:00:00.000Z");
    assertEquals(
      first.policyFingerprint,
      await fingerprintWorkerReviewPolicy(split),
      "the heartbeat carries the fingerprint of the split config's review policy",
    );

    await recordBabysitterDeployment(
      dir,
      unsplit,
      "abcdef0123456789",
      "2026-11-02T00:00:01.000Z",
    );
    const second = JSON.parse(
      await Deno.readTextFile(`${dir}/deployment-health.json`),
    );
    assertEquals(
      second.policyFingerprint,
      await fingerprintWorkerReviewPolicy(unsplit),
      "the heartbeat carries the fingerprint of the unsplit config's review policy",
    );
    assert(
      first.policyFingerprint !== second.policyFingerprint,
      "a change to issueExecutorSplit changes the heartbeat's policy fingerprint",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitter deployment heartbeat publishes, returns true and logs nothing on success", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const logged: string[] = [];
    const published = await publishBabysitterDeployment(
      `${dir}/state`,
      buildDefaultWorkerConfig(),
      (message) => logged.push(message),
    );
    assertEquals(published, true);
    assertEquals(logged, []);
    const record = JSON.parse(
      await Deno.readTextFile(`${dir}/state/deployment-health.json`),
    );
    assertEquals(record.component, "babysitter");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("each babysitter pass loads its config from the given path and stamps the heartbeat with it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const config = buildDefaultWorkerConfig();
    const paths: string[] = [];
    const loaded = await loadConfigAndPublishDeployment(
      "/tmp/some-config.json",
      `${dir}/state`,
      (path) => {
        paths.push(path);
        return Promise.resolve(config);
      },
    );
    assertEquals(paths, ["/tmp/some-config.json"]);
    assertEquals(loaded, config);
    const record = JSON.parse(
      await Deno.readTextFile(`${dir}/state/deployment-health.json`),
    );
    assertEquals(record.component, "babysitter");
    assertEquals(
      record.policyFingerprint,
      await fingerprintWorkerReviewPolicy(config),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitter deployment heartbeat that cannot be written returns false and logs its cause, without throwing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // A state directory under a regular file cannot be created, so the
    // heartbeat write fails and the babysitter must carry on.
    const blocker = `${dir}/not-a-directory`;
    await Deno.writeTextFile(blocker, "x\n");
    const logged: string[] = [];
    const published = await publishBabysitterDeployment(
      `${blocker}/state`,
      buildDefaultWorkerConfig(),
      (message) => logged.push(message),
    );
    assertEquals(published, false);
    assertEquals(logged.length, 1);
    const prefix = "[babysitter] deployment heartbeat not recorded: ";
    const line = logged[0] ?? "";
    assert(line.startsWith(prefix), line);
    assert(
      line.length > prefix.length,
      "the log names the cause after the prefix",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitter supplies RTK guidance only when its probe succeeds", async () => {
  const present: Parameters<typeof babysitterRtkInstruction>[0] = async () => ({
    ok: true,
    value: {
      success: true,
      code: 0,
      stdout: "rtk 1",
      stderr: "",
      timedOut: false,
    },
  });
  const absent: Parameters<typeof babysitterRtkInstruction>[0] = async () => ({
    ok: false,
    error: new Error("missing"),
  });
  const instructions = await babysitterRtkInstruction(present);
  assert(instructions.includes("each command in a chain"));
  assert(instructions.includes("rtk recall"));
  assertEquals(await babysitterRtkInstruction(absent), "");
});

const pr = {
  state: "OPEN",
  number: 1,
  title: "fix",
  author: { login: "fleet" },
  headRefName: "feature",
  headRefOid: "abc",
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
};

import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";

for (const decision of ["REVIEW_REQUIRED", "APPROVED"]) {
  Deno.test(`babysitter behind anchor uses strict readiness: ${decision}`, async () => {
    const f = strictRefreshFixture();
    f.state.decision = decision;
    const initial = { ...pr, headRefOid: f.head, mergeStateStatus: "BEHIND" };
    let updated = false;
    const gh = async (args: string[]) => {
      if (
        args[0] === "pr" && args[1] === "view" &&
        args.at(-1)?.includes("statusCheckRollup")
      ) {
        return JSON.stringify({
          ...initial,
          headRefOid: updated ? "d".repeat(40) : f.head,
        });
      }
      if (args.includes("PUT")) {
        // The anchor's repair lock must be gone, while shared ownership remains.
        assertEquals(
          f.comments.some((row) =>
            row.body.includes("<!-- BRANCH_UPDATE_LOCK:")
          ),
          false,
        );
        assertEquals(
          f.comments.some((row) =>
            row.body.includes("<!-- BASE_REFRESH_OWNER_4613:")
          ),
          true,
        );
        updated = true;
      }
      return await f.gh(args);
    };
    await fix(
      "owner/repo",
      initial,
      ["VibeCoderST"],
      "VibeCoderST",
      { appId: "1", installationId: "1", privateKeyPath: "/unused" },
      "/unused",
      gh,
      undefined,
      3,
      { armAutoMerge: async () => {} },
    );
    assertEquals(updated, decision === "APPROVED");
    assertEquals(
      f.calls.filter((args) => args.includes("PUT")).length,
      decision === "APPROVED" ? 1 : 0,
    );
  });
}
Deno.test("author filter permits an explicit PR without widening fleet scans", () => {
  assert(eligibleAuthor("VibeCoderST", ["vibecoderst"], false));
  assert(!eligibleAuthor("human", ["VibeCoderST"], false));
  assert(eligibleAuthor("human", ["VibeCoderST"], true));
});

Deno.test("babysitter selects only conflicts and failed CI", () => {
  assertEquals(reason(pr), null);
  assertEquals(
    reason({
      ...pr,
      mergeStateStatus: "BEHIND",
      statusCheckRollup: [{ status: "IN_PROGRESS" }],
    }),
    "branch behind base",
  );
  assertEquals(
    reason({ ...pr, mergeStateStatus: "BEHIND" }),
    "branch behind base",
  );
  assertEquals(
    reason({ ...pr, reviewDecision: "CHANGES_REQUESTED" }),
    "requested review changes",
  );
  assertEquals(reason({ ...pr, mergeable: "CONFLICTING" }), "merge conflict");
  assertEquals(
    reason({ ...pr, statusCheckRollup: [{ conclusion: "FAILURE" }] }),
    "failed CI",
  );
  assertEquals(
    reason({ ...pr, statusCheckRollup: [{ conclusion: "CANCELLED" }] }),
    null,
  );
  assertEquals(
    reason({ ...pr, state: "CLOSED", mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, isDraft: true, mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, isCrossRepository: true, mergeable: "CONFLICTING" }),
    null,
  );
  assertEquals(
    reason({ ...pr, statusCheckRollup: null, mergeable: "CONFLICTING" }),
    null,
  );
});

Deno.test("cleanup removes abandoned clones but preserves live and unrelated directories", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dead = `${root}/fleet-pr-babysitter-99999999-abcdef`;
    const live = `${root}/fleet-pr-babysitter-${Deno.pid}-abcdef`;
    const unrelated = `${root}/fleet-pr-babysitter-unrelated`;
    for (const path of [dead, live, unrelated]) await Deno.mkdir(path);
    await recoverTemporaryClones(root);
    const names = (await Array.fromAsync(Deno.readDir(root))).map((entry) =>
      entry.name
    );
    assertEquals(
      names.sort(),
      [
        `fleet-pr-babysitter-${Deno.pid}-abcdef`,
        "fleet-pr-babysitter-unrelated",
      ].sort(),
    );
    assert((await Deno.stat(live)).isDirectory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("babysitter stages resolved merge files and refuses conflict markers", async () => {
  const dir = await Deno.makeTempDir();
  const git = async (...args: string[]) =>
    await new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
  try {
    assert((await git("init")).success);
    assert((await git("config", "user.name", "Test")).success);
    assert((await git("config", "user.email", "test@example.invalid")).success);
    await Deno.writeTextFile(`${dir}/file.txt`, "original\n");
    assert((await git("add", ".")).success);
    assert((await git("commit", "-m", "initial")).success);
    assert((await git("checkout", "-b", "other")).success);
    await Deno.writeTextFile(`${dir}/file.txt`, "other\n");
    assert((await git("commit", "-am", "other")).success);
    assert((await git("checkout", "-")).success);
    await Deno.writeTextFile(`${dir}/file.txt`, "feature\n");
    assert((await git("commit", "-am", "feature")).success);
    assert(!(await git("merge", "--no-commit", "other")).success);
    await assertRejects(
      () =>
        validateAndCommit(dir, 123, { login: "test-app[bot]", id: "12345" }, {
          home: dir,
        }),
      Error,
      "git failed",
    );
    await Deno.writeTextFile(`${dir}/file.txt`, "feature and other\n");
    await validateAndCommit(dir, 123, { login: "test-app[bot]", id: "12345" }, {
      home: dir,
    });
    assert((await git("diff", "--quiet", "HEAD")).success);
    assert((await git("rev-parse", "HEAD^2")).success);
    const author = await new Deno.Command("git", {
      args: ["show", "-s", "--format=%an <%ae>", "HEAD"],
      cwd: dir,
    }).output();
    assertEquals(
      new TextDecoder().decode(author.stdout).trim(),
      "test-app[bot] <12345+test-app[bot]@users.noreply.github.com>",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repairs run in parallel within the limit and failures do not block others", async () => {
  let active = 0;
  let peak = 0;
  const completed: number[] = [];
  const tasks = [0, 1, 2].map((id) => ({
    key: String(id),
    version: "head",
    run: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      completed.push(id);
      if (id === 0) throw new Error("repair failed");
    },
  }));
  await assertRejects(() => runRepairs(tasks, 2), AggregateError);
  assertEquals(peak, 2);
  assertEquals(completed.sort(), [0, 1, 2]);
});

Deno.test("only each reviewer's current changes request remains actionable", () => {
  assertEquals(
    requestedReviews([
      { id: 1, state: "CHANGES_REQUESTED", user: { login: "alice" } },
      { id: 2, state: "COMMENTED", user: { login: "alice" } },
      { id: 3, state: "CHANGES_REQUESTED", user: { login: "bob" } },
      { id: 4, state: "APPROVED", user: { login: "BOB" } },
    ]).map((review) => review.id),
    [1],
  );
});

Deno.test("long repairs do not prevent new PR discovery", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => release = resolve);
  const completed: string[] = [];
  let scans = 0;
  const first = {
    key: "one",
    version: "a",
    run: async () => {
      await waiting;
      completed.push("one");
    },
  };
  const second = {
    key: "two",
    version: "a",
    run: async () => {
      completed.push("two");
      release();
    },
  };
  await runRepairs([first], 2, () => {
    scans++;
    return Promise.resolve([first, second]);
  }, 5);
  assertEquals(completed, ["two", "one"]);
  assertEquals(scans, 1);
});

Deno.test("runRepairs allows an unchanged task version to retry after cooldown", async () => {
  let releaseBlocker!: () => void;
  const blockerWait = new Promise<void>((resolve) => releaseBlocker = resolve);
  let repairAttempts = 0;
  let scans = 0;
  const repair = {
    key: "owner/repo#7",
    version: "same-head:failed CI",
    run: async () => {
      repairAttempts++;
    },
  };
  const blocker = {
    key: "owner/repo#8",
    version: "other",
    run: async () => await blockerWait,
  };
  await runRepairs([repair, blocker], 2, () => {
    scans++;
    if (scans === 1) return Promise.resolve([repair]);
    releaseBlocker();
    return Promise.resolve([]);
  }, 1);
  assertEquals(repairAttempts, 2);
});

Deno.test("review dismissal waits for GitHub to report the pushed head", async () => {
  let reads = 0;
  assertEquals(
    await waitForPushedHead(
      () => Promise.resolve(++reads < 3 ? "old" : "new"),
      "new",
      4,
      1,
    ),
    true,
  );
  assertEquals(
    await waitForPushedHead(() => Promise.resolve("other"), "new", 2, 1),
    false,
  );
});

Deno.test("parallel babysitter repairs restrict writes to their own repository", async () => {
  const results = await Promise.all(
    ["org/one", "org/two"].map((repo) =>
      withBabysitterWriteScope(repo, async () => {
        await Promise.resolve();
        assert(isWriteRepoAllowlistActive());
        assert(isWriteRepoAllowed(repo));
        assert(!isWriteRepoAllowed(repo === "org/one" ? "org/two" : "org/one"));
        await enforceGhWriteAllowlist([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/1/comments`,
          "-f",
          "body=lock",
        ]);
        await assertRejects(() =>
          enforceGhWriteAllowlist([
            "api",
            "-X",
            "PUT",
            "repos/org/unrelated/pulls/1/update-branch",
          ]), WriteRepoBlockedError);
        return repo;
      })
    ),
  );
  assertEquals(results, ["org/one", "org/two"]);
});

Deno.test("codex agent gets its own read-only token instead of the runner's GH_TOKEN", () => {
  const runnerToken = "runner-write-token";
  const agentToken = "agent-read-only-token";
  const scratch = "/tmp/babysitter-scratch";
  const dir = "/tmp/babysitter-clone";
  const responseFile = "/tmp/babysitter-exchange/response";
  const prompt = "Fix conflicts on PR #1";
  const protectedPaths = [
    "/home/u/.vibe-coder/fleet-pr-babysitter",
    "/home/u/.vibe-coder/fleet-pr-babysitter.private-key.pem",
  ];
  const calls: {
    executable: string;
    options: Deno.CommandOptions & { timeoutMs: number };
  }[] = [];
  spawnBabysitterAgent(
    {
      dir,
      scratch,
      prompt,
      agentToken,
      protectedPaths,
      codex: "/home/u/.vibe-coder/codex/0.164.0-aarch64-apple-darwin/codex",
      responseFile,
    },
    (executable, options) => {
      calls.push({ executable, options });
      return {} as unknown as Deno.ChildProcess;
    },
  );
  const [call] = calls;
  assert(call);
  assertEquals(
    call.executable,
    "/home/u/.vibe-coder/codex/0.164.0-aarch64-apple-darwin/codex",
  );
  const env = call.options.env as Record<string, string>;
  assertEquals(env.GH_TOKEN, agentToken);
  assert(env.GH_TOKEN !== runnerToken);
  assertEquals(env, {
    TMPDIR: scratch,
    XDG_CACHE_HOME: scratch,
    GH_TOKEN: agentToken,
    GH_CONFIG_DIR: `${scratch}/gh-config`,
    VIBE_AUDIT_DISABLED: "1",
  });
  assertEquals(call.options.timeoutMs, 90 * 60_000);
  assertEquals(call.options.args, [
    "exec",
    "-c",
    'approval_policy="never"',
    ...buildBabysitterSandboxArgs({ dir, scratch, protectedPaths }),
    "--cd",
    dir,
    "--output-last-message",
    responseFile,
    prompt,
  ]);
  assertEquals(call.options.stdin, "null");
  assertEquals(call.options.stdout, "inherit");
  assertEquals(call.options.stderr, "piped");
});

Deno.test("codex agent is not given the workspace-write sandbox and cannot read the credential paths", () => {
  const keyPath = "/home/u/.vibe-coder/fleet-pr-babysitter.private-key.pem";
  const protectedPaths = [
    "/home/u/.vibe-coder/fleet-pr-babysitter",
    keyPath,
  ];
  const calls: string[][] = [];
  spawnBabysitterAgent(
    {
      dir: "/tmp/babysitter-clone",
      scratch: "/tmp/babysitter-scratch",
      prompt: "Fix conflicts on PR #1",
      agentToken: "agent-read-only-token",
      protectedPaths,
      codex: "codex",
      responseFile: "/tmp/babysitter-exchange/response",
    },
    (_executable, options) => {
      calls.push(options.args as string[]);
      return {} as unknown as Deno.ChildProcess;
    },
  );
  const [args] = calls;
  assert(args);
  assert(!args.includes("--sandbox"));
  assert(!args.includes("workspace-write"));
  assert(
    args.includes(`default_permissions="${BABYSITTER_PERMISSIONS_PROFILE}"`),
  );
  for (const path of protectedPaths) {
    assert(
      args.some((arg) =>
        arg.startsWith(`${BABYSITTER_FILESYSTEM_KEY}={ `) &&
        arg.includes(`${JSON.stringify(path)} = "none"`)
      ),
      `missing none override for ${path}`,
    );
    assert(
      !args.some((arg) =>
        arg.includes(`${JSON.stringify(path)} = "read"`) ||
        arg.includes(`${JSON.stringify(path)} = "write"`)
      ),
      `credential path ${path} is readable or writable`,
    );
  }
  assert(protectedPaths.includes(keyPath));
});

Deno.test("codex agent refuses to start without protected credential paths", () => {
  let spawned = false;
  assertThrows(
    () =>
      spawnBabysitterAgent(
        {
          dir: "/tmp/babysitter-clone",
          scratch: "/tmp/babysitter-scratch",
          prompt: "Fix conflicts on PR #1",
          agentToken: "agent-read-only-token",
          protectedPaths: [],
          codex: "codex",
          responseFile: "/tmp/babysitter-exchange/response",
        },
        () => {
          spawned = true;
          return {} as unknown as Deno.ChildProcess;
        },
      ),
    Error,
  );
  assertEquals(spawned, false);
});

Deno.test("codex agent refuses a response file inside the clone or scratch directory", () => {
  for (
    const responseFile of [
      "/tmp/babysitter-clone/response",
      "/tmp/babysitter-clone",
      "/tmp/babysitter-scratch/response",
      "/tmp/babysitter-scratch",
    ]
  ) {
    let spawned = false;
    assertThrows(
      () =>
        spawnBabysitterAgent(
          {
            dir: "/tmp/babysitter-clone",
            scratch: "/tmp/babysitter-scratch",
            prompt: "Fix conflicts on PR #1",
            agentToken: "agent-read-only-token",
            protectedPaths: ["/home/u/.vibe-coder/fleet-pr-babysitter"],
            codex: "codex",
            responseFile,
          },
          () => {
            spawned = true;
            return {} as unknown as Deno.ChildProcess;
          },
        ),
      Error,
      "writable path",
    );
    assertEquals(spawned, false, `spawned with ${responseFile}`);
  }
});

Deno.test("codex agent refuses a relative response file and does not spawn", () => {
  let spawned = false;
  assertThrows(
    () =>
      spawnBabysitterAgent(
        {
          dir: "/tmp/babysitter-clone",
          scratch: "/tmp/babysitter-scratch",
          prompt: "Fix conflicts on PR #1",
          agentToken: "agent-read-only-token",
          protectedPaths: ["/home/u/.vibe-coder/fleet-pr-babysitter"],
          codex: "codex",
          responseFile: "response",
        },
        () => {
          spawned = true;
          return {} as unknown as Deno.ChildProcess;
        },
      ),
    Error,
    "not absolute",
  );
  assertEquals(spawned, false);
});

// Shift left (Issue #4610): a babysitter push that CI then rejects costs a CI
// run and another repair. Every repair re-runs the relevant local checks
// before it reports ready.
Deno.test("a CI repair must reproduce the failing step locally and see it pass before reporting ready", () => {
  forBothPlatforms((build) => {
    const prompt = build("failed CI", 5016, "owner/repo", "");
    assertStringIncludes(prompt, "same command the workflow runs");
    assertStringIncludes(prompt, "confirm it passes before");
    assertStringIncludes(prompt, "quality.sh");
    assert(!prompt.includes("GitHub CI runs those checks"));
  });
});

Deno.test("a review repair runs the local checks covering the changed files", () => {
  forBothPlatforms((build) => {
    const prompt = build(
      "requested review changes",
      1,
      "owner/repo",
      "",
    );
    assertStringIncludes(prompt, "formatter, linter, type or compile check");
    assertStringIncludes(prompt, "confirm they pass before");
  });
});

Deno.test("a conflict repair still checks the packages it touched, not the whole suite", () => {
  forBothPlatforms((build) => {
    const prompt = build("merge conflict", 1, "owner/repo", "");
    assertStringIncludes(prompt, "formatter, linter, type or compile check");
    assertStringIncludes(prompt, "full regression suite");
    assertStringIncludes(prompt, "BABYSITTER_READY");
  });
});

// Owner rule 2026-11-01: the babysitter honours needs-human.
Deno.test("a PR labelled needs-human is never a babysitter candidate", () => {
  const pr = {
    state: "OPEN",
    number: 1,
    title: "t",
    author: { login: "fleet" },
    headRefName: "h",
    headRefOid: "a",
    baseRefName: "main",
    isCrossRepository: false,
    isDraft: false,
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    reviewDecision: null,
    statusCheckRollup: [{ conclusion: "FAILURE" }],
    labels: [{ name: "needs-human" }],
  };
  assertEquals(reason(pr), null);
  assertEquals(reason({ ...pr, labels: [] }), "merge conflict");
});

// Issue #4671: a new review on an attempted head is new input, not a repeat.
Deno.test("a new change request on an attempted head gets its own attempt", () => {
  const review = (id: number) => ({
    id,
    state: "CHANGES_REQUESTED",
    user: { login: "reviewer[bot]" },
  });
  const first = attemptKey("owner/repo", 7, "abc", [review(10)]);
  assertEquals(first, attemptKey("owner/repo", 7, "abc", [review(10)]));
  assert(
    first !== attemptKey("owner/repo", 7, "abc", [review(10), review(12)]),
  );
  assertEquals(
    attemptKey("owner/repo", 7, "abc", [review(12), review(10)]),
    attemptKey("owner/repo", 7, "abc", [review(10), review(12)]),
  );
  assertEquals(attemptKey("owner/repo", 7, "abc", []), "owner--repo--7--abc");
});

// Issue #4668: a review asking for a description change could never be met,
// because the agent may not edit the PR; the runner applies its proposal.
Deno.test("a review repair may propose a PR description for the runner to apply", () => {
  forBothPlatforms((build) => {
    const prompt = build(
      "requested review changes",
      1,
      "owner/repo",
      "",
    );
    assertStringIncludes(prompt, ".babysitter-pr-body");
  });
});

Deno.test("the proposed PR description is taken out of the clone before commit", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/.babysitter-pr-body`, "New body\n");
    assertEquals(await takePrBodyProposal(dir), "New body");
    await assertRejects(
      () => Deno.stat(`${dir}/.babysitter-pr-body`),
      Deno.errors.NotFound,
    );
    assertEquals(await takePrBodyProposal(dir), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the proposal is returned as written, and the guard restores closing references", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(
      `${dir}/.babysitter-pr-body`,
      "Rewritten summary. Fixes #12",
    );
    assertEquals(
      await takePrBodyProposal(dir),
      "Rewritten summary. Fixes #12",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a runner repair may replace the first PR description proposal", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/.babysitter-pr-body`, "Retry proposal");
    // The proposal is returned as written: closing references are restored by
    // the description guard, not by the proposal reader (main's behaviour).
    assertEquals(
      await takeRepairPrBodyProposal(dir, "First proposal"),
      "Retry proposal",
    );
    assertEquals(
      await takeRepairPrBodyProposal(dir, "First proposal"),
      "First proposal",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an empty PR description proposal is not applied, and an oversized one is rejected at intake", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/.babysitter-pr-body`, "  \n");
    assertEquals(await takePrBodyProposal(dir), undefined);
    await Deno.writeTextFile(`${dir}/.babysitter-pr-body`, "x".repeat(65_537));
    await assertRejects(
      () => takePrBodyProposal(dir),
      Error,
      "65536",
    );
    await assertRejects(
      () => Deno.stat(`${dir}/.babysitter-pr-body`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Issue #4731: the agent writes the proposal into the clone, so a planted link,
// FIFO or oversized file must be refused before anything is published.
Deno.test("a PR description proposal that is a symlink to a secret is refused without being read", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    const dir = `${base}/clone`;
    await Deno.mkdir(dir);
    await Deno.writeTextFile(`${base}/secret.txt`, "SECRET-TOKEN-4731");
    await Deno.symlink(`${base}/secret.txt`, `${dir}/.babysitter-pr-body`);
    const error = await assertRejects(
      () => takePrBodyProposal(dir),
      Error,
      "refused unsafe agent output",
    );
    assert(!error.message.includes("SECRET-TOKEN-4731"));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a PR description proposal that is a FIFO is refused rather than waited on", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    const dir = `${base}/clone`;
    await Deno.mkdir(dir);
    const made = await new Deno.Command("mkfifo", {
      args: [`${dir}/.babysitter-pr-body`],
    }).output();
    assert(made.success, "mkfifo created the FIFO");
    await assertRejects(
      () => takePrBodyProposal(dir),
      Error,
      "refused unsafe agent output",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a PR description proposal over the byte bound is refused before it is read", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    const dir = `${base}/clone`;
    await Deno.mkdir(dir);
    await Deno.writeTextFile(
      `${dir}/.babysitter-pr-body`,
      "x".repeat(65_536 * 4 + 1),
    );
    await assertRejects(
      () => takePrBodyProposal(dir),
      Error,
      "refused unsafe agent output",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// Issue #4731: the Codex final message is read from the runner's exchange
// directory through the same hardened reader.
Deno.test("the agent's completion response is read from the exchange directory", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(
      `${base}/response`,
      "Done.\nBABYSITTER_READY",
    );
    assertEquals(await readAgentResponse(base), "Done.\nBABYSITTER_READY");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a missing completion response is reported as not written", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    await assertRejects(
      () => readAgentResponse(base),
      Error,
      "did not write its completion response",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a completion response that is a symlink to a secret is refused", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    const exchange = `${base}/exchange`;
    await Deno.mkdir(exchange);
    await Deno.writeTextFile(`${base}/secret.txt`, "SECRET-TOKEN-4731");
    await Deno.symlink(`${base}/secret.txt`, `${exchange}/response`);
    const error = await assertRejects(
      () => readAgentResponse(exchange),
      Error,
      "refused unsafe agent output",
    );
    assert(!error.message.includes("did not write"));
    assert(!error.message.includes("SECRET-TOKEN-4731"));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("an oversized completion response is refused", async () => {
  const base = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${base}/response`, "x".repeat(1_048_577));
    await assertRejects(
      () => readAgentResponse(base),
      Error,
      "refused unsafe agent output",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// Issue #4677: CI is the gate, so a check this host cannot run is reported,
// not a reason to discard an otherwise complete repair.
// Issue #4674: the runner owns the quality gate when Codex cannot launch a browser.
Deno.test("a check the host cannot run is named, and agent browser limits hand the local gate to the runner", () => {
  for (
    const why of ["failed CI", "requested review changes", "merge conflict"]
  ) {
    const prompt = buildRepairPrompt(why, 1, "owner/repo", "");
    assertStringIncludes(prompt, "name it in your final response");
    assertStringIncludes(
      prompt,
      "Do not attempt browser checks yourself when the Codex sandbox cannot launch Chromium",
    );
    assertStringIncludes(
      prompt,
      "When the target repository has quality.sh, the runner executes it after you finish",
    );
    assertStringIncludes(
      prompt,
      "BABYSITTER_READY means your changes are ready for runner validation",
    );
    // Issue #4677: an unrunnable check still does not discard a complete fix.
    for (
      const text of [
        prompt,
        buildRepairPrompt(why, 1, "owner/repo", "", undefined, "boom"),
      ]
    ) {
      assertStringIncludes(
        text,
        "does not by itself withhold BABYSITTER_READY when the rest of the fix is complete",
      );
    }
    assertStringIncludes(
      prompt,
      "A runner check failure is returned for repair before any commit or push",
    );
  }
});

Deno.test("runner check failure is fenced into the next repair prompt", () => {
  const failure = fenceUntrustedIssueText(
    "Chromium assertion failed: panel clipped",
    "Runner-owned validation output:",
  ).join("\n");
  const prompt = buildRepairPrompt(
    "requested review changes",
    4674,
    "owner/repo",
    "",
    undefined,
    failure,
  );
  assertStringIncludes(prompt, "runner's isolated quality.sh check failed");
  assertStringIncludes(prompt, "Runner-owned validation output:");
  assertStringIncludes(prompt, "Chromium assertion failed: panel clipped");
  assertStringIncludes(prompt, "UNTRUSTED USER CONTENT BOUNDARY_");
});

// Issue #4677: a resolved conflict was discarded over unrelated verifier
// findings (VibeCoder#4675); other feedback is out of a conflict's scope.
Deno.test("other open feedback does not withhold readiness from a resolved conflict", () => {
  forBothPlatforms((build) => {
    const prompt = build("merge conflict", 1, "owner/repo", "");
    assertStringIncludes(
      prompt,
      "Other open feedback (reviews, verifier or bot comments) is out of scope for a conflict repair and does not withhold BABYSITTER_READY",
    );
  });
});

// Issue #4684: cancelled CI is re-run, not handed to an agent to "fix".
Deno.test("only a head whose runs were cancelled and none failed is re-run", () => {
  const r = (id: number, status: string, conclusion: string | null) => ({
    id,
    status,
    conclusion,
  });
  assertEquals(
    cancelledRunsToRerun([
      r(1, "completed", "success"),
      r(2, "completed", "cancelled"),
      r(3, "completed", "cancelled"),
    ]),
    [2, 3],
  );
  assertEquals(
    cancelledRunsToRerun([
      r(1, "completed", "failure"),
      r(2, "completed", "cancelled"),
    ]),
    [],
  );
  assertEquals(
    cancelledRunsToRerun([
      r(1, "in_progress", null),
      r(2, "completed", "cancelled"),
    ]),
    [],
  );
  assertEquals(cancelledRunsToRerun([r(1, "completed", "success")]), []);
  assertEquals(cancelledRunsToRerun([]), []);
});

// Issue #4704: the description update went out as a raw PATCH with
// `-F body=@file`, which the base-change guard cannot read and so refuses.
Deno.test("the PR description update is not mistaken for a base change", () => {
  const args = prBodyEditArgs("owner/repo", 7, "/tmp/scratch/pr-body.md");
  assertEquals(classifyPrBaseChange(args, () => "New description"), undefined);
  // The route it replaces, for contrast: the guard fails closed on it.
  assertEquals(
    classifyPrBaseChange(
      [
        "api",
        "-X",
        "PATCH",
        "repos/owner/repo/pulls/7",
        "-F",
        "body=@/tmp/scratch/pr-body.md",
      ],
      () => "New description",
    )?.newBase,
    null,
  );
});

Deno.test("the PR description update passes the write allowlist for its repo only", async () => {
  await withBabysitterWriteScope("owner/repo", async () => {
    await enforceGhWriteAllowlist(
      prBodyEditArgs("owner/repo", 7, "/tmp/scratch/pr-body.md"),
    );
    await assertRejects(
      () =>
        enforceGhWriteAllowlist(
          prBodyEditArgs("other/repo", 7, "/tmp/scratch/pr-body.md"),
        ),
      WriteRepoBlockedError,
    );
  });
});

// Issue #4731: the PR description is staged in the runner-owned exchange
// directory, which the agent cannot write, and applied from there.
Deno.test("applyPrBody stages the body in the exchange at mode 0600 and edits from it", async () => {
  const exchange = await Deno.realPath(await Deno.makeTempDir());
  try {
    const calls: string[][] = [];
    await applyPrBody("owner/repo", 7, "New description", exchange, (args) => {
      calls.push(args);
      return Promise.resolve(undefined);
    });
    const file = `${exchange}/pr-body.md`;
    assertEquals(await Deno.readTextFile(file), "New description");
    assertEquals(((await Deno.stat(file)).mode ?? 0) & 0o777, 0o600);
    assertEquals(calls, [prBodyEditArgs("owner/repo", 7, file)]);
  } finally {
    await Deno.remove(exchange, { recursive: true });
  }
});

Deno.test("applyPrBody refuses a symlink planted at the body path and never edits", async () => {
  const exchange = await Deno.realPath(await Deno.makeTempDir());
  const victimDir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const victim = `${victimDir}/victim.txt`;
    await Deno.writeTextFile(victim, "original");
    await Deno.symlink(victim, `${exchange}/pr-body.md`);
    let edited = false;
    await assertRejects(() =>
      applyPrBody("owner/repo", 7, "agent-controlled body", exchange, () => {
        edited = true;
        return Promise.resolve(undefined);
      })
    );
    assertEquals(await Deno.readTextFile(victim), "original");
    assertEquals(edited, false);
  } finally {
    await Deno.remove(exchange, { recursive: true });
    await Deno.remove(victimDir, { recursive: true });
  }
});

Deno.test("applyPrBody edits from the exchange, not from the agent's scratch directory", async () => {
  const exchange = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  try {
    const calls: string[][] = [];
    await applyPrBody("owner/repo", 7, "body", exchange, (args) => {
      calls.push(args);
      return Promise.resolve(undefined);
    });
    const bodyFile = calls[0]!.at(-1)!;
    assertEquals(bodyFile, `${exchange}/pr-body.md`);
    assert(!bodyFile.startsWith(`${scratch}/`));
  } finally {
    await Deno.remove(exchange, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
});

// Issue #4677: GRQ-AutoTrader#5056 was held twice by a macOS-only failure in
// a test the repair never touched; CI on the base is the arbiter.
Deno.test("a host-only failure in an unrelated check is named, not a blocker", () => {
  forBothPlatforms((build) => {
    for (
      const why of ["failed CI", "requested review changes", "merge conflict"]
    ) {
      const prompt = build(why, 1, "owner/repo", "");
      assertStringIncludes(
        prompt,
        "unrelated to the files you changed and passes in CI on the base branch",
      );
    }
  });
});

// Issue #4694: a check that reads commit history cannot see the uncommitted
// fix the agent is forbidden to commit (VibeCoder#4675, #4687).
Deno.test("a check that reads commit history does not withhold readiness", () => {
  forBothPlatforms((build) => {
    for (
      const why of ["failed CI", "requested review changes", "merge conflict"]
    ) {
      const prompt = build(why, 1, "owner/repo", "");
      assertStringIncludes(prompt, "reads commit history");
    }
  });
});

// Issue #4717: a CI repair fixed the failing checks, then held back over the
// verifier's unrelated findings; a later review repair handles reviews.
Deno.test("other open feedback does not withhold readiness from a CI repair", () => {
  forBothPlatforms((build) => {
    const prompt = build("failed CI", 1, "owner/repo", "");
    assertStringIncludes(
      prompt,
      "Other open feedback (reviews, verifier or bot comments) is out of scope for a CI repair",
    );
  });
});

// Issue #4713: a code fix left VibeCoder's archived PR summary stale, so CI's
// freshness gate failed and a second session existed only to refresh it.
Deno.test("repair prompt applies the shared evidence policy to test replacements", () => {
  for (
    const why of ["failed CI", "requested review changes", "merge conflict"]
  ) {
    const prompt = buildRepairPrompt(why, 1, "owner/repo", "");
    assertStringIncludes(
      prompt,
      "Never remove, skip or weaken tests just to make a check pass",
    );
    assertStringIncludes(prompt, "CODING-STANDARDS.md TDD rule 3");
    assertStringIncludes(prompt, "obsolete behaviour");
    assertStringIncludes(prompt, "remaining behaviour");
    assertStringIncludes(prompt, "path::test in the PR summary");
  }
});

Deno.test("a repair updates a CI-checked per-PR summary in the same fix", () => {
  forBothPlatforms((build) => {
    for (
      const why of ["failed CI", "requested review changes", "merge conflict"]
    ) {
      const prompt = build(why, 1, "owner/repo", "");
      assertStringIncludes(prompt, "per-PR summary");
      assertStringIncludes(prompt, "in the same fix");
    }
  });
});

// Issue #4720: GRQ-AutoTrader#5066's conflict stopped for an owner because the
// base had deliberately retired behaviour the PR used; the base already
// carries that decision, and conflicts are never handed to a human.
Deno.test("a conflict where the base retired behaviour follows the base, not a human", () => {
  forBothPlatforms((build) => {
    const prompt = build("merge conflict", 1, "owner/repo", "");
    assertStringIncludes(prompt, "deliberately removed or replaced behaviour");
    assertStringIncludes(prompt, "follow the base");
    assertStringIncludes(prompt, "never leave a conflict for a human");
  });
});

// Issue #4710: a clone still being written by the agent's leftover test
// processes could not be removed, and the error from `finally` replaced the
// repair's real outcome. Clean-up warns and leaves it for a later pass.
Deno.test("repair clean-up warns instead of throwing, and still removes the rest", async () => {
  const removed: string[] = [];
  const warnings: string[] = [];
  await removeRepairDirs(
    ["/tmp/clone", undefined, "/tmp/scratch"],
    (path) => {
      if (path === "/tmp/clone") {
        return Promise.reject(new Error("Directory not empty (os error 66)"));
      }
      removed.push(path);
      return Promise.resolve();
    },
    (message) => warnings.push(message),
  );
  assertEquals(removed, ["/tmp/scratch"]);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "WARNING");
  assertStringIncludes(warnings[0]!, "/tmp/clone");
  assertStringIncludes(warnings[0]!, "Directory not empty");
});

for (const why of ["failed CI", "requested review changes", "merge conflict"]) {
  Deno.test(`Linux ${why} prompt keeps local validation`, () => {
    const prompt = buildRepairPrompt(
      why,
      1,
      "owner/repo",
      "",
      undefined,
      undefined,
      "linux",
    );
    assertStringIncludes(
      prompt,
      "Also run the checks in the repository\u0027s local gate",
    );
    assertStringIncludes(
      prompt,
      "does not by itself withhold BABYSITTER_READY",
    );
    assertStringIncludes(
      prompt,
      "A required check this host cannot run is named but does not by itself withhold BABYSITTER_READY",
    );
    assertStringIncludes(
      prompt,
      "CI runs unavailable checks on the pushed head",
    );
    assertEquals(prompt.includes("the runner executes it"), false);
    assertEquals(prompt.includes("the runner owns the final"), false);
    assertEquals(
      prompt.includes("leave the browser check to runner validation"),
      false,
    );
  });
}
// Issue #4728: the agent ran `printenv GH_TOKEN`, putting its own token in a
// tool result. Every repair kind is told never to print credentials.
Deno.test("a repair never prints environment variables or credentials", () => {
  forBothPlatforms((build) => {
    for (
      const why of ["failed CI", "requested review changes", "merge conflict"]
    ) {
      const prompt = build(why, 1, "owner/repo", "");
      assertStringIncludes(prompt, "Never print, echo or log");
      assertStringIncludes(prompt, "gh auth status");
    }
  });
});

Deno.test("defaultRemoteUrl follows gh's git_protocol, falling back to https with a warning", async () => {
  const asked: string[][] = [];
  const answer = (protocol: string) => (args: string[]) => {
    asked.push(args);
    return Promise.resolve(protocol);
  };
  assertEquals(
    await defaultRemoteUrl("owner/repo", answer("ssh\n")),
    "git@github.com:owner/repo.git",
  );
  assertEquals(asked, [["config", "get", "git_protocol", "-h", "github.com"]]);
  assertEquals(
    await defaultRemoteUrl("owner/repo", answer("https\n")),
    "https://github.com/owner/repo.git",
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    assertEquals(
      await defaultRemoteUrl(
        "owner/repo",
        () => Promise.reject(new Error("gh is not logged in")),
      ),
      "https://github.com/owner/repo.git",
    );
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "gh is not logged in");
});

Deno.test("host-specific gh protocol takes precedence over the global protocol", async () => {
  const gh = (args: string[]) =>
    Promise.resolve(args.includes("-h") ? "ssh\n" : "https\n");
  assertEquals(
    await defaultRemoteUrl("owner/repo", gh),
    "git@github.com:owner/repo.git",
  );
});

Deno.test("an existing mirror fetches from the newly resolved URL", async () => {
  await withTempRoot(async (root) => {
    const { upstream, work } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    const deps: CloneForRepairDeps = {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    const mirror = `${mirrorRoot}/owner--repo.git`;
    await runGitForTest(["remote", "set-url", "origin", `${root}/stale.git`], {
      cwd: mirror,
    });
    await commitFile(work, "new.txt", "new history");
    await fixtureGit(["push", "-q", upstream, "main"], work);
    await cloneForRepair("owner/repo", `${root}/clone-2`, deps);
    assertEquals(
      await runGitForTest(["rev-parse", "main"], { cwd: `${root}/clone-2` }),
      await runGitForTest(["rev-parse", "main"], { cwd: upstream }),
    );
    assertEquals(
      await runGitForTest(["config", "remote.origin.url"], {
        cwd: `${root}/clone-2`,
      }),
      upstream,
    );
  });
});

Deno.test("a later repair prunes deleted branches and fetches new tags into the clone", async () => {
  await withTempRoot(async (root) => {
    const { upstream, work } = await makeUpstream(root);
    const deps: CloneForRepairDeps = {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot: `${root}/mirrors`,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    await fixtureGit(["push", "-q", upstream, "--delete", "feature"], work);
    // A tag on a commit no branch reaches is only fetched by the tag refspec.
    await fixtureGit(["checkout", "-q", "--detach", "main"], work);
    await commitFile(work, "e.txt", "tagged only");
    await fixtureGit(["tag", "v1"], work);
    await fixtureGit(["push", "-q", upstream, "v1"], work);
    const dir2 = `${root}/clone-2`;
    await cloneForRepair("owner/repo", dir2, deps);
    const branches = await runGitForTest(
      ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
      { cwd: dir2 },
    );
    assert(!branches.includes("origin/feature"), branches);
    assertEquals(
      await runGitForTest(["tag", "--list"], { cwd: dir2 }),
      "v1",
    );
  });
});

Deno.test("a stale partial download is cleared before the first download", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/mirrors`;
    await Deno.mkdir(`${mirrorRoot}/owner--repo.git.tmp/objects`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${mirrorRoot}/owner--repo.git.tmp/objects/stale`,
      "left by an interrupted download",
    );
    await cloneForRepair("owner/repo", `${root}/clone`, {
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    assertEquals(await exists(`${mirrorRoot}/owner--repo.git.tmp`), false);
    assertEquals(
      await runGitForTest(["rev-list", "--count", "--all"], {
        cwd: `${root}/clone`,
      }),
      "3",
    );
  });
});

Deno.test("the mirror root exists before the bare clone starts", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const mirrorRoot = `${root}/not/yet/created`;
    await cloneForRepair("owner/repo", `${root}/clone`, {
      git: async (args, options) => {
        if (args[0] === "clone" && args[1] === "--bare") {
          assert(
            await exists(mirrorRoot),
            "the mirror root must exist before the bare clone",
          );
        }
        return runGitForTest(args, options);
      },
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot,
    });
    assert(await exists(`${mirrorRoot}/owner--repo.git`));
  });
});

Deno.test("every network git call is bounded by the 30-minute clone timeout", async () => {
  await withTempRoot(async (root) => {
    const { upstream } = await makeUpstream(root);
    const calls: { args: string[]; timeoutSeconds?: number }[] = [];
    const deps: CloneForRepairDeps = {
      git: (args, options) => {
        calls.push({ args, timeoutSeconds: options?.timeoutSeconds });
        return runGitForTest(args, options);
      },
      remoteUrl: () => Promise.resolve(upstream),
      mirrorRoot: `${root}/mirrors`,
    };
    await cloneForRepair("owner/repo", `${root}/clone-1`, deps);
    await cloneForRepair("owner/repo", `${root}/clone-2`, deps);
    const timed = calls.filter((call) =>
      ["clone", "fetch"].includes(call.args[0]!)
    );
    // Bare clone, local clone, fetch, local clone.
    assertEquals(timed.length, 4);
    for (const call of timed) {
      assertEquals(call.timeoutSeconds, 30 * 60, call.args.join(" "));
    }
  });
});

Deno.test("a call that arrives while another is queued still waits for the running work", async () => {
  const starts: string[] = [];
  const a = Promise.withResolvers<void>();
  const b = Promise.withResolvers<void>();
  const first = serialiseOnMirror("test-mirror", async () => {
    starts.push("a");
    await a.promise;
  });
  const second = serialiseOnMirror("test-mirror", async () => {
    starts.push("b");
    await b.promise;
  });
  await Promise.resolve();
  assertEquals(starts, ["a"]);
  a.resolve();
  await first;
  await Promise.resolve();
  assertEquals(starts, ["a", "b"]);
  const third = serialiseOnMirror("test-mirror", () => {
    starts.push("c");
    return Promise.resolve();
  });
  await Promise.resolve();
  assertEquals(starts, ["a", "b"]);
  b.resolve();
  await Promise.all([second, third]);
  assertEquals(starts, ["a", "b", "c"]);
});

// Issue #4739: GitHub flagged GRQ-AutoTrader#5082 as conflicting although its
// base was already an ancestor of the head; the agent had nothing to resolve.
Deno.test("a base already merged into the head is detected, a newer base is not", async () => {
  const dir = await Deno.makeTempDir();
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", { args, cwd: dir }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
  };
  try {
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.com");
    await git("commit", "-q", "--allow-empty", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "-b", "feature");
    await git("commit", "-q", "--allow-empty", "-m", "feature");
    assertEquals(await baseAlreadyMerged(dir, "main"), true);

    await git("checkout", "-q", "main");
    await git("commit", "-q", "--allow-empty", "-m", "newer base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "feature");
    assertEquals(await baseAlreadyMerged(dir, "main"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("default git classifies mirror fetch timeout and clone disk exhaustion", async () => {
  for (const existing of [false, true]) {
    await withTempRoot(async (root) => {
      const mirrorRoot = `${root}/mirrors`;
      if (existing) {
        await Deno.mkdir(`${mirrorRoot}/owner--repo.git`, { recursive: true });
      }
      const stderr = existing
        ? "TIMEOUT: git fetch --no-auto-maintenance --prune /tmp/upstream timed out after 1800s (Issue #619)"
        : "Cloning into bare repository /tmp/mirror...\nfatal: write error: No space left on device";
      try {
        await cloneForRepair("owner/repo", `${root}/clone`, {
          mirrorRoot,
          remoteUrl: () => Promise.resolve("/tmp/upstream"),
          runGit: () => Promise.resolve({ success: false, stdout: "", stderr }),
        });
        throw new Error("expected failure");
      } catch (error) {
        assertEquals(
          (error as { blockerClass: string }).blockerClass,
          existing ? "infrastructure" : "capability",
        );
      }
    });
  }
});

Deno.test("temporaryCloneRoot - an unset or empty TMPDIR falls back to /tmp", () => {
  assertEquals(temporaryCloneRoot("/var/scratch"), "/var/scratch");
  assertEquals(temporaryCloneRoot(undefined), "/tmp");
  assertEquals(temporaryCloneRoot(""), "/tmp");
});
