/**
 * Tests for `pr_body_sync.ts` — refreshing a PR's body from a rewritten
 * summary on a review-fix run (Issue #3089).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assemblePrBody,
  type SyncPrBodyDeps,
  syncPrBodyFromSummary,
} from "../lib/pr_body_sync.ts";
import { WORKER_PR_MARKER_PREFIX } from "../lib/pr_body.ts";
import { MILESTONE_CHILD_BUMP_NOTE } from "../lib/bump_deps.ts";
import type {
  GitCommandOptions,
  GitCommandOutput,
} from "../lib/git_timeout.ts";
import type { Logger, Result } from "../types.ts";

const noop = () => {};
const logger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  skipReason: noop,
  timing: noop,
  scanSummary: noop,
  workerSummary: noop,
};

const REPO = "owner/repo";
const PR_NUMBER = 7;
const ISSUE_NUMBER = 42;
const BEFORE_SHA = "beforesha0000000000000000000000000000000";
const HEAD_SHA = "headsha00000000000000000000000000000000";

function marker(issueNumber: number): string {
  return `${WORKER_PR_MARKER_PREFIX}${issueNumber} -->`;
}

async function makeRepo(opts: { withSummary?: boolean } = {}): Promise<string> {
  const root = await Deno.makeTempDir();
  if (opts.withSummary ?? true) {
    await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/archive/pr-summaries/pr-summary-${ISSUE_NUMBER}.md`,
      `## Summary\n\nRewritten summary text. Closes #${ISSUE_NUMBER}.\n`,
    );
  }
  return root;
}

interface GhCall {
  args: string[];
  bodyFileContent?: string;
}

/** Records every `gh` call; captures `--body-file` content before cleanup. */
function stubGh(ghCalls: GhCall[], opts: { throwOnEdit?: boolean } = {}) {
  return async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "edit") {
      const idx = args.indexOf("--body-file");
      let bodyFileContent: string | undefined;
      const bodyFilePath = idx !== -1 ? args[idx + 1] : undefined;
      if (bodyFilePath) {
        bodyFileContent = await Deno.readTextFile(bodyFilePath);
      }
      ghCalls.push({ args, bodyFileContent });
      if (opts.throwOnEdit) {
        throw new Error("gh pr edit failed");
      }
      return "";
    }
    ghCalls.push({ args });
    return "";
  };
}

interface GitStubOptions {
  diffChanged?: boolean;
  diffFails?: boolean;
  headSha?: string;
}

function stubGit(gitCalls: string[][], opts: GitStubOptions = {}) {
  return (
    args: string[],
    _options?: GitCommandOptions,
  ): Promise<Result<GitCommandOutput>> => {
    gitCalls.push(args);
    if (args[0] === "diff") {
      if (opts.diffFails) {
        return Promise.resolve({
          ok: false,
          error: new Error("git diff boom"),
        });
      }
      const summaryPath = args[args.length - 1] ?? "";
      return Promise.resolve({
        ok: true,
        value: {
          code: 0,
          stdout: (opts.diffChanged ?? true) ? summaryPath : "",
          stderr: "",
        },
      });
    }
    if (args[0] === "rev-parse") {
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: `${opts.headSha ?? HEAD_SHA}\n`, stderr: "" },
      });
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

function baseBody(issueNumber: number): string {
  return `## Summary\n\nOriginal summary. Closes #${issueNumber}.\n\n---\n\n` +
    `🤖 Processed by: old-worker\n${marker(issueNumber)}`;
}

function viewJson(body: string, files: string[] = []): string {
  return JSON.stringify({ body, files: files.map((path) => ({ path })) });
}

// --- assemblePrBody -------------------------------------------------------

Deno.test("assemblePrBody - uses the summary content when present", () => {
  const body = assemblePrBody({
    summaryContent: "## Summary\n\nDid the thing. Closes #42.",
    issueNumber: 42,
    extraSections: "",
    footer: "\n---\n\nfooter",
  });
  assertStringIncludes(body, "Did the thing.");
  assertStringIncludes(body, "footer");
  assertStringIncludes(body, marker(42));
});

Deno.test("assemblePrBody - falls back to a minimal body when the summary is empty", () => {
  const body = assemblePrBody({
    summaryContent: "",
    issueNumber: 42,
    extraSections: "",
    footer: "",
  });
  assertStringIncludes(body, "## Summary");
  assertStringIncludes(body, "Closes #42.");
});

Deno.test("assemblePrBody - appends a closing keyword when the summary lacks one", () => {
  const body = assemblePrBody({
    summaryContent: "## Summary\n\nDid the thing, no closing keyword here.",
    issueNumber: 42,
    extraSections: "",
    footer: "",
  });
  assertStringIncludes(body, "Closes #42");
});

// --- syncPrBodyFromSummary -------------------------------------------------

Deno.test("sync - summary changed: edits the PR once with the refreshed body", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            viewJson(baseBody(ISSUE_NUMBER), ["src/a.ts"]),
          );
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.value, {
        status: "updated",
        issueNumber: ISSUE_NUMBER,
      });
    }
    assertEquals(ghCalls.length, 1);
    const editCall = ghCalls[0];
    assert(editCall, "expected one gh call to have been recorded");
    assertEquals(editCall.args[0], "pr");
    assertEquals(editCall.args[1], "edit");
    const newBody = editCall.bodyFileContent ?? "";
    assertStringIncludes(newBody, "Rewritten summary text.");
    assertStringIncludes(newBody, marker(ISSUE_NUMBER));
    assertStringIncludes(newBody, "Processed by:");
    assertStringIncludes(newBody, `Closes #${ISSUE_NUMBER}`);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - summary unchanged: skips without editing", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(baseBody(ISSUE_NUMBER)));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: false }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "summary unchanged",
      });
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - no worker marker: skips without editing or diffing", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            viewJson("## Summary\n\nA PR nobody authored with the worker."),
          );
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "no worker marker",
      });
    }
    assertEquals(ghCalls.length, 0);
    assertEquals(gitCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - no before-push SHA: skips without editing", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(baseBody(ISSUE_NUMBER)));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: undefined,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "no before-push sha",
      });
    }
    assertEquals(ghCalls.length, 0);
    assertEquals(gitCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - gh pr edit throws: returns an error Result", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            viewJson(baseBody(ISSUE_NUMBER), ["src/a.ts"]),
          );
        }
        return stubGh(ghCalls, { throwOnEdit: true })(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "Failed to update PR");
    }
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - git diff fails: returns an error Result", async () => {
  const repoPath = await makeRepo();
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(baseBody(ISSUE_NUMBER)));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffFails: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "Failed to diff");
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - carries over the milestone section and bump-skip note from the existing body", async () => {
  const repoPath = await makeRepo();
  try {
    const existingBody =
      `## Summary\n\nOriginal summary. Closes #${ISSUE_NUMBER}.\n\n` +
      `\n## Milestone\nPart of milestone "Great Milestone" (branch \`milestone/great\`).\n\n` +
      `\n${MILESTONE_CHILD_BUMP_NOTE}\n\n---\n\n🤖 Processed by: old-worker\n${
        marker(ISSUE_NUMBER)
      }`;

    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(existingBody));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "updated",
        issueNumber: ISSUE_NUMBER,
      });
    }
    const editCall = ghCalls[0];
    assert(editCall, "expected one gh call to have been recorded");
    const newBody = editCall.bodyFileContent ?? "";
    assertStringIncludes(newBody, "Great Milestone");
    assertStringIncludes(newBody, MILESTONE_CHILD_BUMP_NOTE);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("sync - empty repoPath: returns an error without calling gh", async () => {
  const ghCalls: GhCall[] = [];
  const gitCalls: string[][] = [];
  const deps: SyncPrBodyDeps = {
    runGhCommand: stubGh(ghCalls),
    runGitCommand: stubGit(gitCalls),
    logger,
  };

  const result = await syncPrBodyFromSummary(
    {
      repo: REPO,
      prNumber: PR_NUMBER,
      repoPath: "",
      beforeSha: BEFORE_SHA,
      workerName: "worker-a",
      githubUser: "ghuser",
    },
    deps,
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, `PR #${PR_NUMBER}`);
    assertStringIncludes(result.error.message, "No checkout path");
  }
  assertEquals(ghCalls.length, 0);
});

Deno.test("sync - summary file deleted: skips without editing", async () => {
  const repoPath = await makeRepo({ withSummary: false });
  try {
    const ghCalls: GhCall[] = [];
    const gitCalls: string[][] = [];
    const deps: SyncPrBodyDeps = {
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(viewJson(baseBody(ISSUE_NUMBER)));
        }
        return stubGh(ghCalls)(args);
      },
      runGitCommand: stubGit(gitCalls, { diffChanged: true }),
      logger,
    };

    const result = await syncPrBodyFromSummary(
      {
        repo: REPO,
        prNumber: PR_NUMBER,
        repoPath,
        beforeSha: BEFORE_SHA,
        workerName: "worker-a",
        githubUser: "ghuser",
      },
      deps,
    );

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value, {
        status: "skipped",
        reason: "summary file deleted",
      });
    }
    assertEquals(ghCalls.length, 0);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});
