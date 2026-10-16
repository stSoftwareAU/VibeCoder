/**
 * Independent security-fix verifier (Issue #3657): the prompt, the four-gate
 * verdict, the citation check and the could-not-run paths, against real git in
 * a temporary repository and a scripted model.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { RetryOptions, RunClaudeOptions } from "../lib/claude_runner.ts";
import type { ClaudeRunResult } from "../lib/claude_runner.ts";
import {
  defaultSecurityFixVerifierDeps,
  MAX_VERIFIER_DIFF_CHARS,
  PR_SUMMARY_DIR,
  runSecurityFixVerifier,
  SECURITY_FIX_VERIFIER_DISALLOWED_TOOLS,
  type SecurityFixVerifierDeps,
  type SecurityFixVerifierInput,
} from "../lib/security_fix_verifier.ts";
import { git, gitOk } from "./support/git_repo_fixture.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";

const SUMMARY_TEXT = "Summary: no bypass exists in this change.";
const CITED = "src/query.ts:2";

interface Fixture {
  repo: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

/**
 * A repo whose base has an unsafe query builder and whose branch escapes it
 * on line 2 of `src/query.ts`, with a PR summary the verifier must not read.
 */
async function makeRepo(): Promise<Fixture> {
  const repo = await Deno.makeTempDir({ prefix: "security-fix-verifier-" });
  const g = (args: string[]) => gitOk(args, repo);
  await g(["init", "--quiet", "-b", "main"]);
  await g(["config", "user.email", "t@example.com"]);
  await g(["config", "user.name", "T"]);
  await g(["config", "commit.gpgsign", "false"]);
  await Deno.mkdir(`${repo}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${repo}/src/query.ts`,
    "export function buildQuery(input: string): string {\n" +
      "  return `SELECT * FROM users WHERE name = '${input}'`;\n" +
      "}\n",
  );
  await g(["add", "."]);
  await g(["commit", "--quiet", "-m", "base"]);
  const baseSha = (await g(["rev-parse", "HEAD"])).trim();

  await g(["checkout", "--quiet", "-b", "fix-branch"]);
  await Deno.writeTextFile(
    `${repo}/src/query.ts`,
    "export function buildQuery(input: string): string {\n" +
      "  const escaped = input.replace(/'/g, \"''\");\n" +
      "  return `SELECT * FROM users WHERE name = '${escaped}'`;\n" +
      "}\n",
  );
  await Deno.mkdir(`${repo}/${PR_SUMMARY_DIR}`, { recursive: true });
  await Deno.writeTextFile(
    `${repo}/${PR_SUMMARY_DIR}/pr-summary-1.md`,
    `${SUMMARY_TEXT}\n`,
  );
  await g(["add", "."]);
  await g(["commit", "--quiet", "-m", "fix"]);
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

type Status = "pass" | "fail" | "skipped";

/** A gate answer as the model writes it. */
function gate(status: Status, citation: string | null = CITED) {
  return { status, citation, rationale: "checked in the code" };
}

/** A complete reply JSON with each gate answered as given. */
function reply(
  gates: {
    sink?: ReturnType<typeof gate>;
    reach?: ReturnType<typeof gate>;
    klass?: ReturnType<typeof gate>;
    sweep?: ReturnType<typeof gate>;
  } = {},
): string {
  return JSON.stringify({
    gates: {
      sink_mitigated: gates.sink ?? gate("pass"),
      reachability: gates.reach ?? gate("pass"),
      class_eliminated: gates.klass ?? gate("pass"),
      sweep_complete: gates.sweep ?? gate("pass"),
    },
  });
}

interface AskCall {
  options: RunClaudeOptions;
  retry?: RetryOptions;
  /** Whether the summary file was present in the clone while the model ran. */
  summaryPresent: boolean;
  /** Whether the clone's HEAD was the branch head while the model ran. */
  headSha: string;
}

/** A scripted model that records what it was asked and where it was run. */
function fakeAsk(script: {
  output?: string;
  timedOut?: boolean;
  fail?: string;
}) {
  const calls: AskCall[] = [];
  const ask: SecurityFixVerifierDeps["ask"] = async (options, retry) => {
    const cwd = options.cwd ?? "";
    calls.push({
      options,
      retry,
      summaryPresent: await exists(`${cwd}/${PR_SUMMARY_DIR}/pr-summary-1.md`),
      headSha: (await git(["rev-parse", "HEAD"], cwd)).stdout.trim(),
    });
    if (script.fail !== undefined) {
      return { ok: false as const, error: new Error(script.fail) };
    }
    return {
      ok: true as const,
      value: runResult({
        output: script.output ?? "",
        timedOut: script.timedOut ?? false,
      }),
    };
  };
  return { ask, calls };
}

/** The model call a test expects; throws when the model was never asked. */
function firstCall(calls: AskCall[]): AskCall {
  const call = calls[0];
  if (!call) throw new Error("the model was not asked");
  return call;
}

function makeDeps(
  ask: SecurityFixVerifierDeps["ask"],
  tmps: string[],
): SecurityFixVerifierDeps {
  return {
    ...defaultSecurityFixVerifierDeps,
    ask,
    makeTempDir: async () => {
      const d = await defaultSecurityFixVerifierDeps.makeTempDir();
      tmps.push(d);
      return d;
    },
  };
}

function inputFor(
  f: Fixture,
  over: Partial<SecurityFixVerifierInput> = {},
): SecurityFixVerifierInput {
  return {
    repo: "owner/repo",
    issueNumber: 3657,
    issueTitle: "SQL injection in buildQuery",
    findingBody: "buildQuery interpolates the input straight into the SQL.",
    repoPath: f.repo,
    baseRef: f.baseSha,
    timeoutSeconds: 60,
    logger: makeRecordingLogger().logger,
    ...over,
  };
}

async function checkoutState(repo: string) {
  return {
    head: (await git(["rev-parse", "HEAD"], repo)).stdout.trim(),
    status:
      (await git(["status", "--porcelain=v1", "--untracked-files=all"], repo))
        .stdout,
  };
}

// ---- verdicts ----------------------------------------------------------------

Deno.test("security-fix verifier: all four gates citing the head give FIXED", async () => {
  const f = await makeRepo();
  try {
    const tmps: string[] = [];
    const model = fakeAsk({ output: reply() });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, tmps),
    );
    assertEquals(result.verification.kind, "checked");
    if (result.verification.kind !== "checked") return;
    assertEquals(result.verification.verdict, "FIXED");
    assertEquals(result.verification.gates.sink_mitigated.status, "pass");
    assertEquals(result.verification.gates.sink_mitigated.citation, CITED);
    assert(result.run !== undefined);
    assertEquals(model.calls.length, 1);
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: a failed sink gate gives NOT_FIXED", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ output: reply({ sink: gate("fail") }) });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "checked");
    if (result.verification.kind !== "checked") return;
    assertEquals(result.verification.verdict, "NOT_FIXED");
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: a sink fix that misses the class gives PARTIAL", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ output: reply({ klass: gate("fail") }) });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "checked");
    if (result.verification.kind !== "checked") return;
    assertEquals(result.verification.verdict, "PARTIAL");
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: one skipped gate gives INCONCLUSIVE", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({
      output: reply({ sweep: gate("skipped", null) }),
    });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "checked");
    if (result.verification.kind !== "checked") return;
    assertEquals(result.verification.verdict, "INCONCLUSIVE");
    assertEquals(result.verification.gates.sweep_complete.status, "skipped");
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: a pass citing a missing file or a line past the end is demoted to skipped", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({
      output: reply({
        sink: gate("pass", "src/missing.ts:1"),
        sweep: gate("pass", "src/query.ts:99"),
      }),
    });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "checked");
    if (result.verification.kind !== "checked") return;
    assertEquals(result.verification.verdict, "INCONCLUSIVE");
    const sink = result.verification.gates.sink_mitigated;
    assertEquals(sink.status, "skipped");
    assertStringIncludes(sink.demotion ?? "", "does not exist at the head");
    const sweep = result.verification.gates.sweep_complete;
    assertEquals(sweep.status, "skipped");
    assertStringIncludes(sweep.demotion ?? "", "past the end");
  } finally {
    await f.cleanup();
  }
});

// ---- could not run ------------------------------------------------------------

Deno.test("security-fix verifier: a model run that fails is not checked", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ fail: "spawn refused" });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "not_checked");
    if (result.verification.kind !== "not_checked") return;
    assertStringIncludes(
      result.verification.reason,
      "verifier run failed: spawn refused",
    );
    assertEquals(result.run, undefined);
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: a timed-out model run is not checked", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ timedOut: true, output: reply() });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification, {
      kind: "not_checked",
      reason: "verifier timed out",
    });
    assert(result.run !== undefined);
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: an unparseable reply is not checked", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ output: "I think it is probably fixed." });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "not_checked");
    if (result.verification.kind !== "not_checked") return;
    assertStringIncludes(
      result.verification.reason,
      "verifier reply was not usable",
    );
    assert(result.run !== undefined);
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: an unresolvable base ref is not checked and runs no model", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ output: reply() });
    const result = await runSecurityFixVerifier(
      inputFor(f, { baseRef: "refs/heads/no-such-branch" }),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "not_checked");
    if (result.verification.kind !== "not_checked") return;
    assertStringIncludes(
      result.verification.reason,
      "cannot resolve base ref",
    );
    assertEquals(model.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: an empty diff (head equals base) is not checked and runs no model", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ output: reply() });
    const result = await runSecurityFixVerifier(
      inputFor(f, { baseRef: f.headSha }),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification, {
      kind: "not_checked",
      reason: "the branch diff is empty, so there is no fix to verify",
    });
    assertEquals(model.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: a diff over the cap is not checked and runs no model", async () => {
  const f = await makeRepo();
  try {
    await Deno.writeTextFile(
      `${f.repo}/big.txt`,
      "x".repeat(MAX_VERIFIER_DIFF_CHARS),
    );
    await gitOk(["add", "."], f.repo);
    await gitOk(["commit", "--quiet", "-m", "big"], f.repo);
    const model = fakeAsk({ output: reply() });
    const result = await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "not_checked");
    if (result.verification.kind !== "not_checked") return;
    assertStringIncludes(
      result.verification.reason,
      `over the ${MAX_VERIFIER_DIFF_CHARS} the verifier reads`,
    );
    assertEquals(model.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

// ---- what the model is given, and where it runs -------------------------------

Deno.test("security-fix verifier: the prompt carries the finding and the diff but never the PR summary", async () => {
  const f = await makeRepo();
  try {
    const tmps: string[] = [];
    const model = fakeAsk({ output: reply() });
    const issueState = await checkoutState(f.repo);
    await runSecurityFixVerifier(
      inputFor(f),
      makeDeps(model.ask, tmps),
    );
    assertEquals(model.calls.length, 1);
    const prompt = firstCall(model.calls).options.prompt;
    assertStringIncludes(prompt, "buildQuery interpolates the input");
    assertStringIncludes(prompt, "SQL injection in buildQuery");
    assertStringIncludes(prompt, "const escaped = input.replace");
    assert(!prompt.includes(SUMMARY_TEXT), "the PR summary reached the model");
    assert(!prompt.includes("no bypass exists"));
    assertEquals(firstCall(model.calls).summaryPresent, false);

    const options = firstCall(model.calls).options;
    for (const tool of ["Bash", "Edit", "Write"]) {
      assert(
        options.disallowedTools?.includes(tool),
        `${tool} is not disallowed`,
      );
    }
    assertEquals(
      options.disallowedTools,
      [...SECURITY_FIX_VERIFIER_DISALLOWED_TOOLS],
    );

    // The model ran in a clone, not the issue checkout, and the clone is gone.
    const cwd = options.cwd ?? "";
    assert(cwd !== f.repo, "the model ran in the issue checkout");
    assertEquals(firstCall(model.calls).headSha, f.headSha);
    assertEquals(await exists(cwd), false);
    for (const tmp of tmps) assertEquals(await exists(tmp), false);

    // The issue checkout is untouched.
    assertEquals(await checkoutState(f.repo), issueState);
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: the model timeout is capped and maxRetries is passed through", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ output: reply() });
    await runSecurityFixVerifier(
      inputFor(f, { timeoutSeconds: 99_999, maxRetries: 2 }),
      makeDeps(model.ask, []),
    );
    assertEquals(firstCall(model.calls).options.timeoutSeconds, 1800);
    assertEquals(firstCall(model.calls).retry, { maxRetries: 2 });
  } finally {
    await f.cleanup();
  }
});

Deno.test("security-fix verifier: an invalid issue number is not checked", async () => {
  const f = await makeRepo();
  try {
    const model = fakeAsk({ output: reply() });
    const result = await runSecurityFixVerifier(
      inputFor(f, { issueNumber: 0 }),
      makeDeps(model.ask, []),
    );
    assertEquals(result.verification.kind, "not_checked");
    assertEquals(model.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});
