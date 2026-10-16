/**
 * Tests for merge_summary_claim_check.ts (Issue #3617).
 *
 * The check reads the working tree, so the real-git tests build temporary
 * repositories: a PR branch whose summary claims a file the base branch has
 * already landed, then a merge of that base. The pure tests cover the claim
 * extraction, the description cap, the fenced recovery prompt and the gate's
 * outcomes with scripted checks and a scripted recovery turn.
 *
 * Uses Australian English throughout (behaviour, recognise, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildSummaryClaimRecoveryPrompt,
  checkMergedSummaryClaims,
  describeUnbackedClaims,
  extractClaimedPaths,
  gateMergedSummaryClaims,
  MAX_SUMMARIES_CHECKED,
  MAX_SUMMARY_CHARS,
  type MergeClaimGitRunner,
  type MergedSummaryClaimCheck,
  type SummaryClaimGateOutcome,
  type UnbackedClaim,
} from "../lib/merge_summary_claim_check.ts";
import { createPromptDelimiters } from "../lib/prompt_delimiter.ts";
import type { MergeConflictAgentOutcome } from "../lib/merge_conflict_agent.ts";
import type { Logger, Result } from "../types.ts";

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-12.md";

/** A summary whose sweep claims `docs/x.md` and whose change list names `lib/a.ts`. */
const SUMMARY_TEXT = [
  "# PR #12 — update the helper",
  "",
  "- **Docs sweep:** grep: `helper`; section: `docs/x.md#y`; updated: `docs/x.md`",
  "",
  "## Changes",
  "",
  "- `lib/a.ts` — adds the helper",
  "",
].join("\n");

const OLD_DOCS = "# X\n\nOld text.\n";
const NEW_DOCS = "# X\n\nNew text.\n";

/** A boundary id in the shape `generateBoundaryId` produces. */
const BOUNDARY_ID = "0123456789ab";

// ---------------------------------------------------------------------------
// Real-git helpers
// ---------------------------------------------------------------------------

const GIT_IDENTITY = [
  "-c",
  "user.name=Claim Test",
  "-c",
  "user.email=claim@test.invalid",
  "-c",
  "commit.gpgsign=false",
];

async function git(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args: [...GIT_IDENTITY, ...args],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** The runner the production gate uses, over the real git in `cwd`. */
function runnerFor(cwd: string): MergeClaimGitRunner {
  return (args) => git(cwd, args);
}

async function writeRepoFile(
  dir: string,
  path: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(`${dir}/${path}`.replace(/\/[^/]+$/, ""), {
    recursive: true,
  });
  await Deno.writeTextFile(`${dir}/${path}`, content);
}

async function commitAll(dir: string, message: string): Promise<void> {
  await gitOk(dir, ["add", "-A"]);
  await gitOk(dir, ["commit", "-q", "-m", message]);
}

/**
 * A repository with `main` at the original base, `origin/main` pointing at it,
 * and a `pr` branch checked out. On `pr` the branch changes `lib/a.ts` and
 * `docs/x.md` and adds the summary that claims both. `mainFiles` lands on the
 * base before the PR branch is cut, for tests that need a file on both sides.
 */
async function makePrFixture(
  mainFiles: Record<string, string> = {},
): Promise<{ dir: string; mainBefore: string }> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-summary-claim-" });
  await gitOk(dir, ["init", "-q", "-b", "main"]);
  await writeRepoFile(dir, "lib/a.ts", "export const a = 1;\n");
  await writeRepoFile(dir, "docs/x.md", OLD_DOCS);
  for (const [path, content] of Object.entries(mainFiles)) {
    await writeRepoFile(dir, path, content);
  }
  await commitAll(dir, "base");
  const mainBefore = await gitOk(dir, ["rev-parse", "HEAD"]);
  await gitOk(dir, ["update-ref", "refs/remotes/origin/main", mainBefore]);

  await gitOk(dir, ["checkout", "-q", "-b", "pr"]);
  await writeRepoFile(dir, "lib/a.ts", "export const a = 2;\n");
  await writeRepoFile(dir, "docs/x.md", NEW_DOCS);
  await writeRepoFile(dir, SUMMARY_PATH, SUMMARY_TEXT);
  await commitAll(dir, "pr change");
  return { dir, mainBefore };
}

/**
 * The base lands the same `docs/x.md` change on `main`, and `origin/main`
 * moves to it. The PR branch is checked out again afterwards.
 */
async function landBaseFix(dir: string): Promise<void> {
  await gitOk(dir, ["checkout", "-q", "main"]);
  await writeRepoFile(dir, "docs/x.md", NEW_DOCS);
  await commitAll(dir, "base lands the docs fix");
  await gitOk(dir, ["update-ref", "refs/remotes/origin/main", "main"]);
  await gitOk(dir, ["checkout", "-q", "pr"]);
}

/** Merge `origin/main`'s base into `pr`, as the merge-conflict pass does. */
async function mergeBase(dir: string): Promise<void> {
  await gitOk(dir, ["merge", "--no-edit", "main"]);
}

async function removeFixture(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

function makeSilentLogger(): Logger {
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

// ---------------------------------------------------------------------------
// checkMergedSummaryClaims over real git
// ---------------------------------------------------------------------------

Deno.test("checkMergedSummaryClaims - a claim the merged base already carries is false, the backed one is not (Issue #3617)", async () => {
  const { dir } = await makePrFixture();
  try {
    await landBaseFix(dir);
    await mergeBase(dir);

    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: "origin/main",
      runGit: runnerFor(dir),
    });

    assertEquals(check, {
      kind: "false-claims",
      summaries: [SUMMARY_PATH],
      unbacked: [{
        summaryPath: SUMMARY_PATH,
        path: "docs/x.md",
        source: "docs-sweep-updated",
      }],
    });
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - before the merge every claim is backed (Issue #3617 positive control)", async () => {
  const { dir, mainBefore } = await makePrFixture();
  try {
    // origin/main is still the original base, so the PR's own change is in the
    // diff and both claims are backed.
    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: mainBefore,
      runGit: runnerFor(dir),
    });

    assertEquals(check.kind, "clean");
    if (check.kind === "clean") {
      assertEquals(check.summaries, [SUMMARY_PATH]);
      assertEquals(check.claimsChecked, 2);
    }
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - rewriting the false claim out of the summary makes it clean (Issue #3617)", async () => {
  const { dir } = await makePrFixture();
  try {
    await landBaseFix(dir);
    await mergeBase(dir);

    // The working-tree rewrite is unstaged: the check reads the tree, not the
    // index, so the recovery turn's `git add` is not what makes this pass.
    await writeRepoFile(
      dir,
      SUMMARY_PATH,
      SUMMARY_TEXT.replace(
        "updated: `docs/x.md`",
        "updated: none — the base carries this",
      ),
    );

    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: "origin/main",
      runGit: runnerFor(dir),
    });

    assertEquals(check.kind, "clean");
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - a conflicted merge is checked on the staged resolution (Issue #3617)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-summary-claim-" });
  try {
    await gitOk(dir, ["init", "-q", "-b", "main"]);
    await writeRepoFile(dir, "lib/b.ts", "one\n");
    await writeRepoFile(dir, "docs/x.md", OLD_DOCS);
    await commitAll(dir, "base");
    await gitOk(dir, ["update-ref", "refs/remotes/origin/main", "main"]);

    await gitOk(dir, ["checkout", "-q", "-b", "pr"]);
    await writeRepoFile(dir, "lib/b.ts", "pr\n");
    await writeRepoFile(dir, "docs/x.md", NEW_DOCS);
    await writeRepoFile(
      dir,
      SUMMARY_PATH,
      [
        "- **Docs sweep:** grep: `helper`; section: `docs/x.md#y`; updated: `docs/x.md`",
        "",
        "## Changes",
        "",
        "- `lib/b.ts` — the PR's version",
        "",
      ].join("\n"),
    );
    await commitAll(dir, "pr change");

    await gitOk(dir, ["checkout", "-q", "main"]);
    await writeRepoFile(dir, "lib/b.ts", "main\n");
    await writeRepoFile(dir, "docs/x.md", NEW_DOCS);
    await commitAll(dir, "base change");
    await gitOk(dir, ["update-ref", "refs/remotes/origin/main", "main"]);
    await gitOk(dir, ["checkout", "-q", "pr"]);

    const conflicted = await git(dir, ["merge", "--no-edit", "main"]);
    assert(conflicted.code !== 0, "the merge was expected to conflict");

    // Resolve the conflict and stage it, as the agent does.
    await writeRepoFile(dir, "lib/b.ts", "resolved\n");
    await gitOk(dir, ["add", "lib/b.ts"]);

    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: "origin/main",
      runGit: runnerFor(dir),
    });

    // lib/b.ts differs from the base now, so its claim is backed; docs/x.md
    // is unchanged on both sides, so only its claim is false.
    assertEquals(check, {
      kind: "false-claims",
      summaries: [SUMMARY_PATH],
      unbacked: [{
        summaryPath: SUMMARY_PATH,
        path: "docs/x.md",
        source: "docs-sweep-updated",
      }],
    });
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - an untracked new file the summary claims is changed (Issue #3617)", async () => {
  const { dir, mainBefore } = await makePrFixture();
  try {
    // The new file is on disk only: neither committed nor staged.
    await writeRepoFile(dir, "lib/new.ts", "export const n = 1;\n");
    await writeRepoFile(
      dir,
      SUMMARY_PATH,
      `${SUMMARY_TEXT}- \`lib/new.ts\` — adds the new module\n`,
    );

    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: mainBefore,
      runGit: runnerFor(dir),
    });

    // Three claims, all backed: docs/x.md and lib/a.ts from the diff, and the
    // untracked lib/new.ts from `ls-files --others`.
    assertEquals(check.kind, "clean");
    if (check.kind === "clean") assertEquals(check.claimsChecked, 3);
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - no summary in the changed files is no-summary (Issue #3617)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-summary-claim-" });
  try {
    await gitOk(dir, ["init", "-q", "-b", "main"]);
    await writeRepoFile(dir, "lib/a.ts", "export const a = 1;\n");
    await commitAll(dir, "base");
    await gitOk(dir, ["update-ref", "refs/remotes/origin/main", "main"]);
    await gitOk(dir, ["checkout", "-q", "-b", "pr"]);
    await writeRepoFile(dir, "lib/a.ts", "export const a = 2;\n");
    await commitAll(dir, "pr change");

    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: "origin/main",
      runGit: runnerFor(dir),
    });

    assertEquals(check, { kind: "no-summary" });
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - a base ref git cannot resolve is not-checked, with git's cause (Issue #3617)", async () => {
  const { dir } = await makePrFixture();
  try {
    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: "origin/missing",
      runGit: runnerFor(dir),
    });

    assertEquals(check.kind, "not-checked");
    if (check.kind === "not-checked") {
      // Real git 2.47 prints: fatal: bad revision 'origin/missing'
      assertStringIncludes(
        check.reason,
        "git diff against origin/missing failed",
      );
      assertStringIncludes(check.reason, "bad revision 'origin/missing'");
    }
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - a base ref starting with '-' is refused without running git (Issue #3617)", async () => {
  const calls: string[][] = [];
  const check = await checkMergedSummaryClaims({
    workDir: "/nonexistent-claim-check",
    baseRef: "--output=/tmp/owned",
    runGit: (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  });

  assertEquals(check.kind, "not-checked");
  if (check.kind === "not-checked") {
    assertStringIncludes(check.reason, "is not a plausible git ref");
  }
  assertEquals(calls, []);
});

Deno.test("checkMergedSummaryClaims - a summary deleted on disk is skipped (Issue #3617)", async () => {
  const { dir, mainBefore } = await makePrFixture({
    "docs/archive/pr-summaries/pr-summary-11.md": SUMMARY_TEXT,
  });
  try {
    // Summary 11 is on the base; the PR branch deletes it from the tree.
    await gitOk(dir, [
      "rm",
      "-q",
      "docs/archive/pr-summaries/pr-summary-11.md",
    ]);
    await commitAll(dir, "drop summary 11");

    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: mainBefore,
      runGit: runnerFor(dir),
    });

    // Summary 11 is in the diff as deleted but has no file on disk, so it is
    // skipped; summary 12 is the only one checked.
    assertEquals(check.kind, "clean");
    if (check.kind === "clean") assertEquals(check.summaries, [SUMMARY_PATH]);
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - more than the cap of summaries is not-checked (Issue #3617)", async () => {
  const { dir, mainBefore } = await makePrFixture();
  try {
    // The fixture's own summary is the first changed file, so adding the cap
    // in full makes one more than the cap.
    const count = MAX_SUMMARIES_CHECKED + 1;
    for (let n = 1; n <= MAX_SUMMARIES_CHECKED; n++) {
      await writeRepoFile(
        dir,
        `docs/archive/pr-summaries/pr-summary-${100 + n}.md`,
        SUMMARY_TEXT,
      );
    }
    await commitAll(dir, "many summaries");

    const check = await checkMergedSummaryClaims({
      workDir: dir,
      baseRef: mainBefore,
      runGit: runnerFor(dir),
    });

    assertEquals(check.kind, "not-checked");
    if (check.kind === "not-checked") {
      assertStringIncludes(check.reason, `${count} PR summary files changed`);
    }
  } finally {
    await removeFixture(dir);
  }
});

Deno.test("checkMergedSummaryClaims - a runner that throws is not-checked, never an exception (Issue #3617)", async () => {
  const check = await checkMergedSummaryClaims({
    workDir: "/nonexistent-claim-check",
    baseRef: "origin/main",
    runGit: () => Promise.reject(new Error("spawn git ENOENT")),
  });

  assertEquals(check.kind, "not-checked");
  if (check.kind === "not-checked") {
    assertStringIncludes(check.reason, "spawn git ENOENT");
  }
});

Deno.test("checkMergedSummaryClaims - a failing git ls-files is not-checked, with git's cause (Issue #3617)", async () => {
  const check = await checkMergedSummaryClaims({
    workDir: "/nonexistent-claim-check",
    baseRef: "origin/main",
    runGit: (args) =>
      Promise.resolve(
        args[0] === "ls-files"
          ? {
            code: 128,
            stdout: "",
            stderr: "fatal: not a git repository\n",
          }
          : { code: 0, stdout: `${SUMMARY_PATH}\n`, stderr: "" },
      ),
  });

  assertEquals(check.kind, "not-checked");
  if (check.kind === "not-checked") {
    assertStringIncludes(check.reason, "not a git repository");
    assertStringIncludes(check.reason, "git ls-files failed");
  }
});

Deno.test("checkMergedSummaryClaims - a summary over the character cap is not-checked (Issue #3617)", async () => {
  const runGit = (args: string[]) =>
    Promise.resolve(
      args[0] === "ls-files"
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 0, stdout: `${SUMMARY_PATH}\n`, stderr: "" },
    );
  const sized = (chars: number) =>
    "# PR #12 — long summary\n".padEnd(chars, "x");

  const over = await checkMergedSummaryClaims({
    workDir: "/nonexistent-claim-check",
    baseRef: "origin/main",
    runGit,
    readFile: () => Promise.resolve(sized(MAX_SUMMARY_CHARS + 1)),
  });
  assertEquals(over.kind, "not-checked");
  if (over.kind === "not-checked") {
    assertStringIncludes(over.reason, SUMMARY_PATH);
    assertStringIncludes(over.reason, String(MAX_SUMMARY_CHARS));
  }

  // Positive control: exactly the cap is read and checked.
  const atCap = await checkMergedSummaryClaims({
    workDir: "/nonexistent-claim-check",
    baseRef: "origin/main",
    runGit,
    readFile: () => Promise.resolve(sized(MAX_SUMMARY_CHARS)),
  });
  assertEquals(atCap.kind, "clean");
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("extractClaimedPaths - sweep paths come first, then change-section paths, deduplicated by path (Issue #3617)", () => {
  const summary = [
    "- **Docs sweep:** grep: `x`; section: `docs/a.md#y`; updated: `docs/a.md`, `docs/b.md`",
    "",
    "## Changes",
    "",
    "- `lib/c.ts` — adds it",
    "- `docs/a.md` — also described here",
    "",
  ].join("\n");

  assertEquals(extractClaimedPaths(summary), [
    { path: "docs/a.md", source: "docs-sweep-updated" },
    { path: "docs/b.md", source: "docs-sweep-updated" },
    { path: "lib/c.ts", source: "change-section" },
  ]);
});

Deno.test("describeUnbackedClaims - names at most ten claims, then counts the rest (Issue #3617)", () => {
  const unbacked: UnbackedClaim[] = Array.from({ length: 12 }, (_, i) => ({
    summaryPath: SUMMARY_PATH,
    path: `docs/p${i + 1}.md`,
    source: i % 2 === 0 ? "docs-sweep-updated" : "change-section",
  }));

  const text = describeUnbackedClaims(unbacked);

  assertStringIncludes(text, "`docs/p10.md`");
  assert(!text.includes("`docs/p11.md`"), "the eleventh claim was named");
  assertStringIncludes(text, "and 2 more");
  assertStringIncludes(
    text,
    "(claimed in `" + SUMMARY_PATH + "`, after `updated:`)",
  );
  assertStringIncludes(
    text,
    "(claimed in `" + SUMMARY_PATH + "`, change list)",
  );
});

/** Assert every occurrence of `needle` in `prompt` sits between a fence pair. */
function assertFencedOnly(prompt: string, needle: string): void {
  const { untrustedStart, untrustedEnd } = createPromptDelimiters(BOUNDARY_ID);
  const regions: [number, number][] = [];
  let from = 0;
  for (;;) {
    const start = prompt.indexOf(untrustedStart, from);
    if (start < 0) break;
    const end = prompt.indexOf(untrustedEnd, start);
    assert(end >= 0, "a fence is never closed");
    regions.push([start, end]);
    from = end + untrustedEnd.length;
  }
  assert(regions.length >= 3, `expected three fences, found ${regions.length}`);

  let at = prompt.indexOf(needle);
  assert(at >= 0, `'${needle}' is not in the prompt`);
  while (at >= 0) {
    const inside = regions.some(([start, end]) => at > start && at < end);
    assert(inside, `'${needle}' appears outside a fence`);
    at = prompt.indexOf(needle, at + needle.length);
  }
}

Deno.test("buildSummaryClaimRecoveryPrompt - fences the base branch and the paths under the pinned boundary (Issue #3617)", () => {
  const prompt = buildSummaryClaimRecoveryPrompt({
    repo: "org/repo",
    prNumber: 12,
    baseBranch: "release/hostile-base-name",
    unbacked: [{
      summaryPath: SUMMARY_PATH,
      path: "docs/x.md",
      source: "docs-sweep-updated",
    }],
    boundaryId: BOUNDARY_ID,
  });

  assertStringIncludes(prompt, `BOUNDARY_${BOUNDARY_ID}`);
  assertFencedOnly(prompt, "release/hostile-base-name");
  assertFencedOnly(prompt, "docs/x.md");
  assertFencedOnly(prompt, SUMMARY_PATH);
  // The prose names the base only by reference.
  assertStringIncludes(prompt, "(named below)");
});

Deno.test("buildSummaryClaimRecoveryPrompt - refuses an empty claim list and a bad PR number (Issue #3617)", () => {
  assertThrows(() =>
    buildSummaryClaimRecoveryPrompt({
      repo: "org/repo",
      prNumber: 12,
      baseBranch: "main",
      unbacked: [],
    })
  );
  assertThrows(() =>
    buildSummaryClaimRecoveryPrompt({
      repo: "org/repo",
      prNumber: 0,
      baseBranch: "main",
      unbacked: [{
        summaryPath: SUMMARY_PATH,
        path: "docs/x.md",
        source: "docs-sweep-updated",
      }],
    })
  );
});

// ---------------------------------------------------------------------------
// gateMergedSummaryClaims with scripted checks and recovery turns
// ---------------------------------------------------------------------------

const FALSE_CLAIM: MergedSummaryClaimCheck = {
  kind: "false-claims",
  summaries: [SUMMARY_PATH],
  unbacked: [{
    summaryPath: SUMMARY_PATH,
    path: "docs/x.md",
    source: "docs-sweep-updated",
  }],
};

const CLEAN_CHECK: MergedSummaryClaimCheck = {
  kind: "clean",
  summaries: [SUMMARY_PATH],
  claimsChecked: 2,
};

/** A check that returns the scripted results in order, then the last one. */
function scriptedCheck(results: MergedSummaryClaimCheck[]) {
  let index = 0;
  return {
    check: () => {
      const result = results[Math.min(index, results.length - 1)]!;
      index++;
      return Promise.resolve(result);
    },
  };
}

/** A recovery turn that records each prompt and returns the scripted result. */
function recordingRecover(result: Result<MergeConflictAgentOutcome>) {
  const prompts: string[] = [];
  return {
    prompts,
    recover: (prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve(result);
    },
  };
}

const RAN_OK: Result<MergeConflictAgentOutcome> = {
  ok: true,
  value: { terminated: false },
};

async function gate(
  check: MergedSummaryClaimCheck[],
  recover: ReturnType<typeof recordingRecover>,
): Promise<SummaryClaimGateOutcome> {
  return await gateMergedSummaryClaims({
    repo: "org/repo",
    prNumber: 12,
    baseBranch: "main",
    check: scriptedCheck(check).check,
    recover: recover.recover,
    logger: makeSilentLogger(),
  });
}

function proceedNote(outcome: SummaryClaimGateOutcome): string {
  if (outcome.kind !== "proceed") {
    throw new Error(`expected proceed, got ${outcome.kind}`);
  }
  return outcome.note;
}

function refuseDetail(outcome: SummaryClaimGateOutcome): string {
  if (outcome.kind !== "refuse") {
    throw new Error(`expected refuse, got ${outcome.kind}`);
  }
  return outcome.detail;
}

Deno.test("gateMergedSummaryClaims - a clean summary proceeds with no recovery turn (Issue #3617)", async () => {
  const recover = recordingRecover(RAN_OK);
  const outcome = await gate([CLEAN_CHECK], recover);

  assertStringIncludes(proceedNote(outcome), "all present");
  assertEquals(recover.prompts.length, 0);
});

Deno.test("gateMergedSummaryClaims - a check that could not run proceeds with the reason noted (Issue #3617)", async () => {
  const recover = recordingRecover(RAN_OK);
  const outcome = await gate([{
    kind: "not-checked",
    reason: "git diff against origin/main failed: fatal: bad revision",
  }], recover);

  const note = proceedNote(outcome);
  assertStringIncludes(note, "not checked");
  assertStringIncludes(note, "bad revision");
  assertEquals(recover.prompts.length, 0);
});

Deno.test("gateMergedSummaryClaims - no summary proceeds with no note (Issue #3617)", async () => {
  const recover = recordingRecover(RAN_OK);
  const outcome = await gate([{ kind: "no-summary" }], recover);

  assertEquals(proceedNote(outcome), "");
  assertEquals(recover.prompts.length, 0);
});

Deno.test("gateMergedSummaryClaims - a false claim the recovery turn rewrites proceeds (Issue #3617)", async () => {
  const recover = recordingRecover(RAN_OK);
  const outcome = await gate([FALSE_CLAIM, CLEAN_CHECK], recover);

  assertStringIncludes(proceedNote(outcome), "the recovery turn rewrote it");
  assertEquals(recover.prompts.length, 1);
  assertStringIncludes(recover.prompts[0]!, "docs/x.md");
});

Deno.test("gateMergedSummaryClaims - a claim still false after the recovery turn refuses (Issue #3617)", async () => {
  const recover = recordingRecover(RAN_OK);
  const outcome = await gate([FALSE_CLAIM, FALSE_CLAIM], recover);

  const detail = refuseDetail(outcome);
  assertStringIncludes(detail, "after one recovery turn");
  assertStringIncludes(detail, "docs/x.md");
  assertEquals(recover.prompts.length, 1);
});

Deno.test("gateMergedSummaryClaims - a claim that cannot be checked again after the recovery turn refuses (Issue #3617)", async () => {
  const recover = recordingRecover(RAN_OK);
  const outcome = await gate([FALSE_CLAIM, {
    kind: "not-checked",
    reason: "git diff against origin/main failed: fatal: bad revision",
  }], recover);

  const detail = refuseDetail(outcome);
  assertStringIncludes(detail, "docs/x.md");
  assertStringIncludes(detail, "could not be checked again");
  assertStringIncludes(detail, "bad revision");
});

Deno.test("gateMergedSummaryClaims - a recovery turn that could not run refuses with its error (Issue #3617)", async () => {
  const recover = recordingRecover({
    ok: false,
    error: new Error("failed to build the merge-conflict prompt: boom"),
  });
  const outcome = await gate([FALSE_CLAIM], recover);

  const detail = refuseDetail(outcome);
  assertStringIncludes(detail, "could not run");
  assertStringIncludes(detail, "boom");
});

Deno.test("gateMergedSummaryClaims - a recovery turn the worker ended cuts the attempt short (Issue #3617)", async () => {
  const recover = recordingRecover({
    ok: true,
    value: { terminated: true },
  });
  const outcome = await gate([FALSE_CLAIM], recover);

  assertEquals(outcome, { kind: "cut-short" });
});

Deno.test("gateMergedSummaryClaims - a recovery turn the provider refused cuts the attempt short with the cause (Issue #3617)", async () => {
  const recover = recordingRecover({
    ok: true,
    value: { terminated: false, providerUnavailable: "402 payment required" },
  });
  const outcome = await gate([FALSE_CLAIM], recover);

  assertEquals(outcome, {
    kind: "cut-short",
    providerUnavailable: "402 payment required",
  });
});
