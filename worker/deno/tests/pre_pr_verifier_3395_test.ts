/**
 * Pre-PR verifier (Issue #3395): the brief renderer, the reply parser, the
 * prompt builder and the disposable-checkout run, against real git in
 * temporary directories and a scripted model.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { ClaudeRunResult } from "../lib/claude_runner.ts";
import {
  buildPrePrVerifierGateComment,
  buildPrePrVerifierPrompt,
  defaultPrePrVerifierDeps,
  parseReviewReply,
  PRE_PR_VERIFIER_COMMENT_HEADING,
  prePrVerifierBlocked,
  prePrVerifierBlockReason,
  type PrePrVerifierDeps,
  type PrePrVerifierInput,
  renderReviewBrief,
  type ReviewBriefFields,
  runPrePrVerifier,
} from "../lib/pre_pr_verifier.ts";
import { git, gitOk } from "./support/git_repo_fixture.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";

const TEMPLATE = await Deno.readTextFile(
  new URL("../../../prompts/pr_review_brief/prompt.md", import.meta.url),
);

const FIELDS: ReviewBriefFields = {
  REVIEW_CONTEXT: "CTX-VALUE",
  NO_TEST_ADDED_NOTE: "NOTE-VALUE",
  TEST_CHANGES: "TESTS-VALUE",
  PREVIOUS_FINDINGS: "PREV-VALUE",
};

Deno.test("renderReviewBrief fills all four fields and strips the leading comment", () => {
  const out = renderReviewBrief(TEMPLATE, FIELDS);
  for (const v of Object.values(FIELDS)) assertStringIncludes(out, v);
  assert(!out.includes("<!--"));
  assert(!out.includes("{{"));
  assert(out.indexOf("CTX-VALUE") < out.indexOf("TESTS-VALUE"));
});

Deno.test("renderReviewBrief never re-expands a value that contains a placeholder", () => {
  const out = renderReviewBrief(TEMPLATE, {
    ...FIELDS,
    REVIEW_CONTEXT: "see {{TEST_CHANGES}} here",
  });
  assertStringIncludes(out, "see {{TEST_CHANGES}} here");
});

Deno.test("renderReviewBrief throws on an unknown placeholder", () => {
  assertThrows(
    () => renderReviewBrief("{{NOPE}}", FIELDS),
    Error,
    "NOPE",
  );
});

Deno.test("parseReviewReply accepts the reply JSON wrapped in prose and rejects the rest", () => {
  const r = parseReviewReply(
    'Here you go:\n{"summary":"ok","findings":[{"file":"a.ts","line":1,"problem":"p"}],"testChanges":"none"}\nThanks',
  );
  assertEquals(r.summary, "ok");
  assertEquals(r.findings.length, 1);
  assertEquals(r.testChangeNotes, []);
  assertEquals(r.unrelatedIssues, []);
  assertThrows(() => parseReviewReply("no json"));
  assertThrows(() => parseReviewReply('{"summary":"ok","testChanges":"none"}'));
  assertThrows(() =>
    parseReviewReply('{"summary":"ok","findings":[],"testChanges":"maybe"}')
  );
});

Deno.test("parseReviewReply caps unrelatedIssues at three and drops malformed ones", () => {
  const good = (n: number) => ({ title: `t${n}`, body: `b${n}` });
  const r = parseReviewReply(JSON.stringify({
    summary: "ok",
    findings: [],
    testChanges: "none",
    unrelatedIssues: [
      { title: "", body: "x" },
      { title: "x", body: "  " },
      "junk",
      good(1),
      good(2),
      good(3),
      good(4),
    ],
  }));
  assertEquals(r.unrelatedIssues.map((i) => i.title), ["t1", "t2", "t3"]);
});

// ---- runPrePrVerifier against real git ------------------------------------

interface Fixture {
  repo: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

async function makeRepo(): Promise<Fixture> {
  const repo = await Deno.makeTempDir({ prefix: "pre-pr-3395-repo-" });
  const g = (args: string[]) => gitOk(args, repo);
  await g(["init", "--quiet", "-b", "main"]);
  await g(["config", "user.email", "t@example.com"]);
  await g(["config", "user.name", "T"]);
  await g(["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${repo}/a.ts`, "export const a = 1;\n");
  await g(["add", "."]);
  await g(["commit", "--quiet", "-m", "base"]);
  const baseSha = (await g(["rev-parse", "HEAD"])).trim();
  await g(["checkout", "--quiet", "-b", "feature"]);
  await Deno.writeTextFile(`${repo}/a.ts`, "export const a = 2;\n");
  await g(["commit", "--quiet", "-am", "head"]);
  const headSha = (await g(["rev-parse", "HEAD"])).trim();
  return {
    repo,
    baseSha,
    headSha,
    cleanup: () => Deno.remove(repo, { recursive: true }),
  };
}

const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

function runResult(over: Partial<ClaudeRunResult>): ClaudeRunResult {
  return {
    exitCode: 0,
    output: "",
    timedOut: false,
    ...over,
  } as unknown as ClaudeRunResult;
}

const REPLY_FINDING = JSON.stringify({
  summary: "one problem",
  findings: [{ file: "a.ts", line: 1, problem: "wrong", fix: "right" }],
  testChanges: "none",
});
const REPLY_CLEAN = JSON.stringify({
  summary: "fine",
  findings: [],
  testChanges: "none",
});

function makeDeps(
  ask: PrePrVerifierDeps["ask"],
  tmps: string[],
): PrePrVerifierDeps {
  return {
    ...defaultPrePrVerifierDeps,
    ask,
    loadBrief: () => Promise.resolve({ ok: true, value: TEMPLATE }),
    makeTempDir: async () => {
      const d = await defaultPrePrVerifierDeps.makeTempDir();
      tmps.push(d);
      return d;
    },
  };
}

function okRun(over: Partial<ClaudeRunResult>) {
  return { ok: true as const, value: runResult(over) };
}

function inputFor(
  f: Fixture,
  over: Partial<PrePrVerifierInput> = {},
): PrePrVerifierInput {
  return {
    repo: "owner/repo",
    issueNumber: 3395,
    issueTitle: "Title",
    issueBody: "Body",
    repoPath: f.repo,
    baseRef: f.baseSha,
    summaryPath: "docs/archive/pr-summaries/pr-summary-3395.md",
    summaryContent: "# Summary\nClaims.\n",
    changedFiles: ["a.ts"],
    timeoutSeconds: 60,
    logger: makeRecordingLogger().logger,
    ...over,
  };
}

Deno.test("runPrePrVerifier runs the brief in a disposable, remote-less checkout and reports findings", async () => {
  const f = await makeRepo();
  const tmps: string[] = [];
  try {
    let seen = false;
    const deps = makeDeps(async (o) => {
      seen = true;
      const cwd = o.cwd!;
      assert(cwd !== f.repo);
      assertEquals((await gitOk(["remote"], cwd)).trim(), "");
      assertEquals((await gitOk(["rev-parse", "HEAD"], cwd)).trim(), f.headSha);
      assertEquals(
        await Deno.readTextFile(
          `${cwd}/docs/archive/pr-summaries/pr-summary-3395.md`,
        ),
        "# Summary\nClaims.\n",
      );
      assert(o.disallowedTools!.includes("Bash(gh:*)"));
      assert(o.disallowedTools!.includes("Bash(git push:*)"));
      assertStringIncludes(o.prompt, "Reply with only this JSON:");
      assertStringIncludes(o.prompt, "disposable checkout");
      assert(!o.prompt.includes("{{"));
      return okRun({ output: `Review:\n${REPLY_FINDING}` });
    }, tmps);
    const result = await runPrePrVerifier(inputFor(f), deps);
    assert(seen);
    assertEquals(result.status, "checked");
    assert(prePrVerifierBlocked(result));
    assertEquals(tmps.length, 1);
    assert(!(await exists(tmps[0]!)));
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a clean reply is checked and not blocked", async () => {
  const f = await makeRepo();
  try {
    const result = await runPrePrVerifier(
      inputFor(f),
      makeDeps(() => Promise.resolve(okRun({ output: REPLY_CLEAN })), []),
    );
    assertEquals(result.status, "checked");
    assert(!prePrVerifierBlocked(result));
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a failed run is not_checked and the disposable directory is removed", async () => {
  const f = await makeRepo();
  const tmps: string[] = [];
  try {
    const result = await runPrePrVerifier(
      inputFor(f),
      makeDeps(
        () => Promise.resolve({ ok: false as const, error: new Error("boom") }),
        tmps,
      ),
    );
    assertEquals(result.status, "not_checked");
    assert(!prePrVerifierBlocked(result));
    assertEquals(tmps.length, 1);
    assert(!(await exists(tmps[0]!)));
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a malformed reply is not_checked", async () => {
  const f = await makeRepo();
  try {
    const result = await runPrePrVerifier(
      inputFor(f),
      makeDeps(() => Promise.resolve(okRun({ output: "looks fine" })), []),
    );
    assertEquals(result.status, "not_checked");
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a timeout is not_checked even with a parseable reply", async () => {
  const f = await makeRepo();
  try {
    const result = await runPrePrVerifier(
      inputFor(f),
      makeDeps(
        () => Promise.resolve(okRun({ output: REPLY_CLEAN, timedOut: true })),
        [],
      ),
    );
    assertEquals(result.status, "not_checked");
  } finally {
    await f.cleanup();
  }
});

Deno.test("parseReviewReply rejects a malformed finding and normalises line and fix", () => {
  const wrap = (findings: string) =>
    `{"summary":"s","findings":${findings},"testChanges":"none"}`;
  assertThrows(() => parseReviewReply(wrap('["oops"]')));
  assertThrows(() => parseReviewReply(wrap("[null]")));
  assertThrows(() => parseReviewReply(wrap('[{"file":"a.ts","line":1}]')));
  assertThrows(() =>
    parseReviewReply(wrap('[{"file":"","line":1,"problem":"p"}]'))
  );
  assertThrows(() => parseReviewReply(wrap('[{"line":1,"problem":"p"}]')));
  assertEquals(
    parseReviewReply(wrap('[{"file":"a.ts","line":"12","problem":"p"}]'))
      .findings,
    [{ file: "a.ts", line: 12, problem: "p" }],
  );
  assertEquals(
    parseReviewReply(wrap('[{"file":"a.ts","line":"x","problem":"p","fix":3}]'))
      .findings,
    [{ file: "a.ts", line: 0, problem: "p" }],
  );
  const valid = { file: "a.ts", line: 4, problem: "p", fix: "f" };
  assertEquals(parseReviewReply(wrap(JSON.stringify([valid]))).findings, [
    valid,
  ]);
});

Deno.test("runPrePrVerifier: an issue checkout that cannot be re-read after the run is a blocking finding", async () => {
  const f = await makeRepo();
  try {
    let snapshots = 0;
    const deps: PrePrVerifierDeps = {
      ...makeDeps(
        () => Promise.resolve(okRun({ output: REPLY_CLEAN })),
        [],
      ),
      runGit: async (args, cwd) => {
        if (cwd === f.repo && args[0] === "status" && ++snapshots === 2) {
          return null;
        }
        return await defaultPrePrVerifierDeps.runGit(args, cwd);
      },
    };
    const result = await runPrePrVerifier(inputFor(f), deps);
    assertEquals(snapshots, 2);
    assertEquals(result.status, "checked");
    assert(prePrVerifierBlocked(result));
    if (result.status === "checked") {
      assertEquals(result.review.findings[0]?.file, "(issue checkout)");
      assertStringIncludes(
        result.review.findings[0]!.problem,
        "Could not re-read the issue checkout",
      );
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a change to the issue checkout surfaces as a blocking finding", async () => {
  const f = await makeRepo();
  try {
    const result = await runPrePrVerifier(
      inputFor(f),
      makeDeps(async () => {
        await Deno.writeTextFile(`${f.repo}/stray.txt`, "oops\n");
        return okRun({ output: REPLY_CLEAN });
      }, []),
    );
    assertEquals(result.status, "checked");
    assert(prePrVerifierBlocked(result));
    if (result.status === "checked") {
      const finding = result.review.findings.find((x) =>
        x.file === "(issue checkout)"
      );
      assert(finding);
      assertStringIncludes(finding.problem, "stray.txt");
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a summary path that escapes the checkout is not_checked and nothing is asked", async () => {
  const f = await makeRepo();
  try {
    let asked = false;
    const deps = makeDeps(() => {
      asked = true;
      return Promise.resolve(okRun({ output: REPLY_CLEAN }));
    }, []);
    for (
      const summaryPath of ["../escape.md", "docs/../../escape.md", "/etc/x.md"]
    ) {
      const result = await runPrePrVerifier(inputFor(f, { summaryPath }), deps);
      assertEquals(result.status, "not_checked");
    }
    assert(!asked);
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a base ref that does not resolve is not_checked", async () => {
  const f = await makeRepo();
  try {
    let asked = false;
    const result = await runPrePrVerifier(
      inputFor(f, { baseRef: "origin/does-not-exist" }),
      makeDeps(() => {
        asked = true;
        return Promise.resolve(okRun({ output: REPLY_CLEAN }));
      }, []),
    );
    assertEquals(result.status, "not_checked");
    assert(!asked);
    // The issue checkout is untouched.
    assertEquals((await git(["status", "--porcelain"], f.repo)).stdout, "");
  } finally {
    await f.cleanup();
  }
});

// ---- comment, reason, prompt ----------------------------------------------

Deno.test("gate comment and block reason name the findings", () => {
  const review = parseReviewReply(JSON.stringify({
    summary: "two problems",
    findings: [
      { file: "x.ts", line: 7, problem: "multi\nline problem", fix: "do y" },
      { file: "z.ts", line: 9, problem: "other" },
    ],
    testChanges: "none",
  }));
  const comment = buildPrePrVerifierGateComment(review);
  assertStringIncludes(comment, PRE_PR_VERIFIER_COMMENT_HEADING);
  assertStringIncludes(comment, "`x.ts:7`");
  assertStringIncludes(comment, "`z.ts:9`");
  assertStringIncludes(comment, "Procedure:");
  const reason = prePrVerifierBlockReason(review);
  assertStringIncludes(reason, "2 blocking finding(s)");
  assertStringIncludes(reason, "x.ts:7 — multi line problem");
  assert(!reason.includes("\n"));
});

const PROMPT_BASE = {
  template: TEMPLATE,
  repo: "owner/repo",
  issueNumber: 3395,
  issueTitle: "Title",
  issueBody: "ISSUE-BODY-TEXT",
  checkoutPath: "/tmp/x/checkout",
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  summaryPath: "docs/archive/pr-summaries/pr-summary-3395.md",
  boundaryId: "0123456789ab",
};
const NO_TEST_NOTE = "The change touches code but adds no test";

Deno.test("buildPrePrVerifierPrompt fences the issue body as untrusted", () => {
  const p = buildPrePrVerifierPrompt({
    ...PROMPT_BASE,
    changedFiles: ["a.ts"],
  });
  const body = p.indexOf("ISSUE-BODY-TEXT");
  const start = p.indexOf("BOUNDARY_0123456789ab");
  assert(start >= 0 && start < body);
  assert(p.indexOf("BOUNDARY_0123456789ab", body) > body);
  assertStringIncludes(p, "Handling Untrusted Content");
});

Deno.test("buildPrePrVerifierPrompt adds the no-test note only when code changed without a test", () => {
  assertStringIncludes(
    buildPrePrVerifierPrompt({ ...PROMPT_BASE, changedFiles: ["a.ts"] }),
    NO_TEST_NOTE,
  );
  const withTest = buildPrePrVerifierPrompt({
    ...PROMPT_BASE,
    changedFiles: ["a.ts", "tests/a_test.ts"],
  });
  assert(!withTest.includes(NO_TEST_NOTE));
  assertStringIncludes(withTest, "tests/a_test.ts");
  const docsOnly = buildPrePrVerifierPrompt({
    ...PROMPT_BASE,
    changedFiles: ["docs/x.md"],
  });
  assert(!docsOnly.includes(NO_TEST_NOTE));
  assertStringIncludes(docsOnly, "the diff touches no test file");
  assertStringIncludes(
    buildPrePrVerifierPrompt({ ...PROMPT_BASE, changedFiles: null }),
    "every test file",
  );
});

Deno.test("buildPrePrVerifierPrompt rejects a non-positive issue number", () => {
  for (const issueNumber of [0, -1, NaN]) {
    assertThrows(() =>
      buildPrePrVerifierPrompt({
        ...PROMPT_BASE,
        issueNumber,
        changedFiles: [],
      })
    );
  }
});

// ---- runPrePrVerifier: every "could not run" branch is not_checked ---------

function askCounter(tmps: string[] = []) {
  const state = { calls: 0 };
  const deps = makeDeps(() => {
    state.calls++;
    return Promise.resolve(okRun({ output: REPLY_CLEAN }));
  }, tmps);
  return { state, deps };
}

function notCheckedReason(
  result: Awaited<ReturnType<typeof runPrePrVerifier>>,
): string {
  assertEquals(result.status, "not_checked");
  return result.status === "not_checked" ? result.reason : "";
}

Deno.test("runPrePrVerifier: an unavailable review brief is not_checked and nothing is asked", async () => {
  const f = await makeRepo();
  try {
    const { state, deps } = askCounter();
    const result = await runPrePrVerifier(inputFor(f), {
      ...deps,
      loadBrief: () =>
        Promise.resolve({ ok: false as const, error: new Error("no brief") }),
    });
    assertStringIncludes(notCheckedReason(result), "review brief unavailable");
    assertEquals(state.calls, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: an unresolvable HEAD is not_checked and nothing is asked", async () => {
  const f = await makeRepo();
  const plain = await Deno.makeTempDir({ prefix: "pre-pr-3395-plain-" });
  try {
    const { state, deps } = askCounter();
    const result = await runPrePrVerifier(
      inputFor(f, { repoPath: plain }),
      deps,
    );
    assertStringIncludes(notCheckedReason(result), "cannot resolve HEAD");
    assertEquals(state.calls, 0);
  } finally {
    await Deno.remove(plain, { recursive: true });
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a checkout that cannot be snapshotted beforehand is not_checked", async () => {
  const f = await makeRepo();
  try {
    const { state, deps } = askCounter();
    let statuses = 0;
    const result = await runPrePrVerifier(inputFor(f), {
      ...deps,
      runGit: (args, cwd) =>
        args[0] === "status" && ++statuses === 1
          ? Promise.resolve(null)
          : defaultPrePrVerifierDeps.runGit(args, cwd),
    });
    assertStringIncludes(notCheckedReason(result), "cannot snapshot");
    assertEquals(state.calls, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a disposable directory that cannot be created is not_checked", async () => {
  const f = await makeRepo();
  try {
    const { state, deps } = askCounter();
    const result = await runPrePrVerifier(inputFor(f), {
      ...deps,
      makeTempDir: () => Promise.reject(new Error("disk full")),
    });
    const reason = notCheckedReason(result);
    assertStringIncludes(reason, "disposable directory");
    assertStringIncludes(reason, "disk full");
    assertEquals(state.calls, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a failed preparation git step is not_checked and the directory is removed", async () => {
  const f = await makeRepo();
  const tmps: string[] = [];
  try {
    const { state, deps } = askCounter(tmps);
    const removed: string[] = [];
    const result = await runPrePrVerifier(inputFor(f), {
      ...deps,
      runGit: (args, cwd) =>
        args[0] === "clone"
          ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" })
          : defaultPrePrVerifierDeps.runGit(args, cwd),
      removeDir: async (p) => {
        removed.push(p);
        await defaultPrePrVerifierDeps.removeDir(p);
      },
    });
    const reason = notCheckedReason(result);
    assertStringIncludes(reason, "git clone");
    assertStringIncludes(reason, "boom");
    assertEquals(state.calls, 0);
    assertEquals(tmps.length, 1);
    assertEquals(removed, tmps);
    assert(!(await exists(tmps[0]!)));
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a throw during setup is not_checked and the directory is removed", async () => {
  const f = await makeRepo();
  const tmps: string[] = [];
  try {
    const deps = makeDeps(() => {
      throw new Error("ask exploded");
    }, tmps);
    const result = await runPrePrVerifier(inputFor(f), deps);
    const reason = notCheckedReason(result);
    assertStringIncludes(reason, "verifier setup failed");
    assertStringIncludes(reason, "ask exploded");
    assertEquals(tmps.length, 1);
    assert(!(await exists(tmps[0]!)));
  } finally {
    await f.cleanup();
  }
});

Deno.test("runPrePrVerifier: a removeDir failure does not lose the result", async () => {
  const f = await makeRepo();
  const tmps: string[] = [];
  try {
    const { deps } = askCounter(tmps);
    const result = await runPrePrVerifier(inputFor(f), {
      ...deps,
      removeDir: async (p) => {
        await defaultPrePrVerifierDeps.removeDir(p);
        throw new Error("cannot remove");
      },
    });
    assertEquals(result.status, "checked");
    assert(!prePrVerifierBlocked(result));
  } finally {
    await f.cleanup();
  }
});
