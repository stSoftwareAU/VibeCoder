/**
 * A fix pushed to an open PR carries its base in the same push, so CI runs
 * once per fix rather than once for the fix and again for the branch update
 * (owner rule 2026-11-03).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  commitAndPushPending,
  mergeBaseBeforePush,
  prBaseForSync,
} from "../lib/git_push.ts";
import {
  type CheckAnnotation,
  processSpellingFailure,
  type SpellingProcessorDeps,
} from "../lib/pr_spelling_processor.ts";
import {
  type ClaudeDeps,
  createMockDeps,
  type GitDeps,
} from "../lib/issue_worker_wiring.ts";
import { createPublicationGuard } from "../lib/publication_validation.ts";
import type { PushLineageOptions } from "../lib/git_push_recovery.ts";
import type { Logger } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Run git in `cwd`, returning trimmed stdout and failing the test on error. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    env: { GIT_CONFIG_NOSYSTEM: "1" },
  }).output();
  assert(
    out.success,
    `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
  );
  return new TextDecoder().decode(out.stdout).trim();
}

/**
 * An origin with `main` and a pushed `feature` branch, and a clone on
 * `feature`. `main` then moves on in origin through a second clone.
 */
async function behindPrBranch(baseFile = "base.txt"): Promise<{
  root: string;
  clone: string;
  advanceBase: (file: string, content: string) => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "vibe-base-sync-" });
  const origin = `${root}/origin.git`;
  const clone = `${root}/clone`;
  const other = `${root}/other`;
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "clone", "-q", origin, clone);
  for (const dir of [clone]) {
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.invalid");
    await git(dir, "config", "commit.gpgsign", "false");
  }
  await Deno.writeTextFile(`${clone}/shared.txt`, "original\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-q", "-m", "initial");
  await git(clone, "push", "-q", "origin", "main");
  await git(clone, "checkout", "-q", "-b", "feature");
  await Deno.writeTextFile(`${clone}/feature.txt`, "feature\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-q", "-m", "feature");
  await git(clone, "push", "-q", "-u", "origin", "feature");
  await git(root, "clone", "-q", origin, other);
  await git(other, "config", "user.name", "Other");
  await git(other, "config", "user.email", "other@example.invalid");
  await git(other, "config", "commit.gpgsign", "false");
  const advanceBase = async (file: string, content: string) => {
    await git(other, "checkout", "-q", "main");
    await git(other, "pull", "-q", "origin", "main");
    await Deno.writeTextFile(`${other}/${file}`, content);
    await git(other, "add", ".");
    await git(other, "commit", "-q", "-m", `base moved: ${file}`);
    await git(other, "push", "-q", "origin", "main");
  };
  await advanceBase(baseFile, "base\n");
  return { root, clone, advanceBase };
}

Deno.test("a fix on a branch behind its base is pushed with the base merged in, in one push", async () => {
  const { root, clone } = await behindPrBranch();
  try {
    const startedAt = await git(clone, "rev-parse", "HEAD");
    await Deno.writeTextFile(`${clone}/feature.txt`, "feature, fixed\n");
    const result = await commitAndPushPending(
      "feature",
      "Fix CI failure",
      {
        cwd: clone,
        expectedAncestor: startedAt,
        syncBaseBranch: "main",
      } as PushLineageOptions,
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value.finalUnpushedCount, 0);

    const pushed = await git(clone, "ls-remote", "origin", "feature");
    const pushedHead = pushed.split(/\s+/)[0]!;
    assertEquals(pushedHead, await git(clone, "rev-parse", "HEAD"));
    // The pushed head has both the fix and the moved base.
    await git(clone, "fetch", "-q", "origin", "main");
    await git(
      clone,
      "merge-base",
      "--is-ancestor",
      "origin/main",
      pushedHead,
    );
    assertEquals(await git(clone, "show", `${pushedHead}:base.txt`), "base");
    assertEquals(
      await git(clone, "show", `${pushedHead}:feature.txt`),
      "feature, fixed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a pass with nothing to push does not push a branch update on its own", async () => {
  const { root, clone } = await behindPrBranch();
  try {
    const before = await git(clone, "rev-parse", "HEAD");
    assertEquals(
      await mergeBaseBeforePush("feature", "main", { cwd: clone }),
      undefined,
    );
    assertEquals(await git(clone, "rev-parse", "HEAD"), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a conflicting base is not merged; the fix is left for the conflict lane", async () => {
  const { root, clone, advanceBase } = await behindPrBranch();
  try {
    await advanceBase("feature.txt", "base edits the same line\n");
    await Deno.writeTextFile(`${clone}/feature.txt`, "feature, fixed\n");
    await git(clone, "commit", "-q", "-am", "fix");
    const head = await git(clone, "rev-parse", "HEAD");
    const outcome = await mergeBaseBeforePush("feature", "main", {
      cwd: clone,
    });
    assertEquals(outcome?.kind, "declined");
    assertEquals(await git(clone, "rev-parse", "HEAD"), head);
    assertEquals(await git(clone, "status", "--porcelain"), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the PR base is the known one, else read from GitHub, else unknown", async () => {
  const never = () => Promise.reject(new Error("gh must not run"));
  assertEquals(await prBaseForSync("Develop", "o/r", 1, never), "Develop");
  assertEquals(
    await prBaseForSync(undefined, "o/r", 1, () => Promise.resolve("main\n")),
    "main",
  );
  const warnings: string[] = [];
  assertEquals(
    await prBaseForSync(
      undefined,
      "o/r",
      1,
      () => Promise.reject(new Error("offline")),
      (message) => warnings.push(message),
    ),
    undefined,
  );
  assertEquals(warnings.length, 1);
});

function silentLogger(): Logger {
  const noop = () => {};
  return {
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
}

Deno.test("a spelling fix asks for its PR's base to be merged in before the push", async () => {
  const pushOptions: PushLineageOptions[] = [];
  const annotations: CheckAnnotation[] = [
    { path: "src/main.ts", start_line: 10, message: "Unknown word: colour" },
  ];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed spelling", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    },
    github: {
      runGhCommand: (args: string[]) =>
        Promise.resolve(args.includes("baseRefName") ? "Develop" : ""),
    },
    git: {
      commitAndPushPending: ((
        _branch: string,
        _message: string,
        options: PushLineageOptions,
      ) => {
        pushOptions.push(options);
        return Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        });
      }) as unknown as GitDeps["commitAndPushPending"],
    },
  });
  const processorDeps: SpellingProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: silentLogger(),
    deps,
    workDir: "/tmp/test",
    workRoot: "/tmp/test-work-root",
    verifyPushFn: () =>
      Promise.resolve({
        landed: true,
        localSha: "f".repeat(40),
        remoteSha: "f".repeat(40),
        reason: "verified in test",
      }),
  };
  const result = await processSpellingFailure({
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    checkRunId: "12345",
    checkName: "cspell",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  }, processorDeps);
  assert(result.ok);
  assert(pushOptions.length >= 1);
  assertEquals(pushOptions[0]!.syncBaseBranch, "Develop");
});

Deno.test("the merged head is validated before it is pushed; a verdict on the pre-merge head does not stand in for it (Issue #4625)", async () => {
  const { root, clone } = await behindPrBranch();
  try {
    const startedAt = await git(clone, "rev-parse", "HEAD");
    await Deno.writeTextFile(`${clone}/feature.txt`, "feature, fixed\n");
    const seen: Array<{ head: string; hasBase: boolean }> = [];
    const guard = createPublicationGuard({
      cwd: clone,
      repo: "owner/repo",
      branchName: "feature",
      validate: async (request) => {
        const head = await git(request.cwd, "rev-parse", "HEAD");
        const hasBase = await Deno.stat(`${request.cwd}/base.txt`).then(
          () => true,
          () => false,
        );
        seen.push({ head, hasBase });
        // The gate passes the fix alone and rejects it once the base is in.
        return hasBase
          ? { status: "failed", head, output: "BROKEN AFTER MERGE" }
          : { status: "passed", head, gate: "absent" };
      },
    });
    const result = await commitAndPushPending(
      "feature",
      "Fix CI failure",
      {
        cwd: clone,
        expectedAncestor: startedAt,
        syncBaseBranch: "main",
      } as PushLineageOptions,
      false,
      undefined,
      undefined,
      undefined,
      guard,
    );
    assertEquals(seen.map((s) => s.hasBase), [false, true]);
    assertEquals(seen[1]!.head, await git(clone, "rev-parse", "HEAD"));
    assert(!result.ok, "a merged head the gate rejects must not be pushed");
    assert(result.error.message.includes("BROKEN AFTER MERGE"));
    const remote = (await git(clone, "ls-remote", "origin", "feature"))
      .split(/\s+/)[0]!;
    assertEquals(remote, startedAt, "origin must not have moved");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
