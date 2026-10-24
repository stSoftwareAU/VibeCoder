/**
 * Unit tests for the local PR-summary gate check (Issue #3423).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitRunner } from "../lib/git_base_ref.ts";
import {
  formatReport,
  type GateReport,
  hasBlock,
  runPrSummaryCheck,
} from "../lib/pr_summary_check.ts";
import {
  type CliDeps,
  issueNumberFromSummaryPath,
  main,
  parseArgs,
  repoRelativePath,
} from "../lib/pr_summary_check_cli.ts";
import {
  BRANCH_OUTCOMES_MARKER,
  prSummaryFactsPath,
} from "../lib/pr_summary_facts.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import type {
  PrePrVerifierInput,
  PrePrVerifierResult,
} from "../lib/pre_pr_verifier.ts";

const ROOT = "/repo";
const TEST_PATH = "worker/deno/tests/foo_test.ts";

const GOOD_SUMMARY = [
  "## Summary",
  "",
  "Adds foo handling.",
  "",
  "**Docs sweep** — grep: `foo`; section: `docs/foo.md#foo`; updated; siblings: none — no existing set gained a member",
  "",
  "**Branch outcomes:**",
  `- \`worker/deno/lib/foo.ts:42\` — error — \`${TEST_PATH}::rejects bad\``,
  "",
].join("\n");

const NO_DOCS_SWEEP = GOOD_SUMMARY.split("\n").filter((l) =>
  !l.includes("Docs sweep")
).join("\n");

interface Call {
  args: string[];
  cwd?: string;
}

/** Fake git keyed on the subcommand; records every call. */
function fakeGit(opts: {
  diff?: { code: number; stdout: string; stderr: string } | "error";
  tests?: string[];
} = {}): { runGit: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runGit: GitRunner = (args, options) => {
    calls.push({ args, cwd: options?.cwd });
    const ok = (stdout = "", code = 0, stderr = "") =>
      Promise.resolve({ ok: true as const, value: { code, stdout, stderr } });
    if (args[0] === "rev-parse") return ok();
    if (args[0] === "diff") {
      if (opts.diff === "error") {
        return Promise.resolve({
          ok: false as const,
          error: new Error("spawn failed"),
        });
      }
      const d = opts.diff ??
        { code: 0, stdout: "worker/deno/lib/foo.ts\n", stderr: "" };
      return ok(d.stdout, d.code, d.stderr);
    }
    if (args.includes("ls-tree")) {
      return ok((opts.tests ?? [TEST_PATH]).join("\n") + "\n");
    }
    return ok();
  };
  return { runGit, calls };
}

/** Fake git on which no base ref resolves and the fetch fails. */
function unresolvableBaseGit(): { runGit: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runGit: GitRunner = (args, options) => {
    calls.push({ args, cwd: options?.cwd });
    return Promise.resolve({
      ok: true as const,
      value: { code: 128, stdout: "", stderr: "fatal: bad revision" },
    });
  };
  return { runGit, calls };
}

const ISSUE_WITH_CRITERIA = [
  "## Acceptance Criteria",
  "",
  "- [ ] foo is handled",
  "",
].join("\n");

function statusOf(reports: GateReport[], ref: string): string | undefined {
  return reports.find((r) => r.issueRef === ref)?.status;
}

async function run(
  summaryContent: string,
  extra: {
    issueBody?: string | null;
    issueLabels?: string | null;
    issueNumber?: number | null;
    repoRoot?: string;
  } = {},
  git = fakeGit(),
) {
  return await runPrSummaryCheck({
    summaryContent,
    issueNumber: extra.issueNumber ?? null,
    baseBranch: "main",
    issueBody: extra.issueBody ?? null,
    issueTitle: null,
    issueLabels: extra.issueLabels ?? null,
    runGit: git.runGit,
    repoRoot: extra.repoRoot ?? ROOT,
  });
}

/** A model reply with no verdict in it: the claim check reads it as not checked. */
const NO_VERDICT_REPLY = {
  ok: true as const,
  value: { output: "" },
};

/**
 * CLI deps with fakes for every seam. The model fakes default to a reply that
 * carries no verdict, so the default-on claim check never blocks on its own.
 */
function deps(
  summary: string | Error,
  git = fakeGit(),
  model: {
    askModel?: CliDeps["askModel"];
    runVerifier?: CliDeps["runVerifier"];
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const cliDeps: CliDeps = {
    readTextFile: (_p: string) =>
      summary instanceof Error
        ? Promise.reject(summary)
        : Promise.resolve(summary),
    runGit: git.runGit,
    repoRoot: () => Promise.resolve({ ok: true as const, value: ROOT }),
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => err.push(l),
    cwd: () => ROOT,
    askModel: model.askModel ?? (() => Promise.resolve(NO_VERDICT_REPLY)),
    runVerifier: model.runVerifier ??
      (() => Promise.reject(new Error("the verifier was not expected to run"))),
  };
  return { out, err, deps: cliDeps };
}

Deno.test("runPrSummaryCheck - well-formed summary passes docs sweep and branch outcomes", async () => {
  const r = await run(GOOD_SUMMARY);
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3073"), "passed");
  assertEquals(statusOf(r.value, "#3147"), "passed");
  assertEquals(statusOf(r.value, "#3124"), "passed");
  assertEquals(hasBlock(r.value), false);
});

Deno.test("main - well-formed summary exits 0", async () => {
  const d = deps(GOOD_SUMMARY);
  assertEquals(await main(["--base", "main", "s.md"], d.deps), 0);
  assertStringIncludes(d.out.join("\n"), "[PASSED] Docs sweep (#3073)");
});

Deno.test("runPrSummaryCheck - missing Docs sweep line blocks and main exits 1", async () => {
  const r = await run(NO_DOCS_SWEEP);
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3073"), "blocked");
  const d = deps(NO_DOCS_SWEEP);
  assertEquals(await main(["--base", "main", "s.md"], d.deps), 1);
  assertStringIncludes(d.out.join("\n"), "[BLOCKED] Docs sweep");
});

Deno.test("runPrSummaryCheck - absent issue body and labels are not checked", async () => {
  const r = await run(GOOD_SUMMARY);
  assert(r.ok);
  assertEquals(statusOf(r.value, "#518"), "not_checked");
  assertEquals(statusOf(r.value, "#663"), "not_checked");
  assertEquals(statusOf(r.value, "#521"), "not_checked");
  assertEquals(statusOf(r.value, "#3257"), "not_checked");
  const closure = r.value.find((g) => g.issueRef === "#518")!;
  assertEquals(closure.note, "no --issue-body-file given");
  assertEquals(
    r.value.find((g) => g.issueRef === "#521")!.note,
    "no --labels given",
  );
});

Deno.test("runPrSummaryCheck - claim check is not checked even with all inputs", async () => {
  const r = await run(GOOD_SUMMARY, {
    issueBody: "No criteria here.",
    issueLabels: "enhancement",
  });
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3257"), "not_checked");
  assertEquals(statusOf(r.value, "#521"), "not_applicable");
});

Deno.test("runPrSummaryCheck - bug label without a Reproduction block blocks", async () => {
  const r = await run(GOOD_SUMMARY, { issueLabels: "bug" });
  assert(r.ok);
  assertEquals(statusOf(r.value, "#521"), "blocked");
});

Deno.test("runPrSummaryCheck - a placeholder token blocks the placeholder gate", async () => {
  const r = await run(GOOD_SUMMARY + "\nQuality: QUALITY_RESULT_PLACEHOLDER\n");
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3124"), "blocked");
  const gate = r.value.find((g) => g.issueRef === "#3124")!;
  assertStringIncludes(gate.problems[0]!, "QUALITY_RESULT_PLACEHOLDER");
});

Deno.test("runPrSummaryCheck - git diff failure is an error, and main exits 2", async () => {
  const failing = { code: 128, stdout: "", stderr: "fatal: bad revision" };
  const r = await run(GOOD_SUMMARY, {}, fakeGit({ diff: failing }));
  assert(!r.ok);
  assertStringIncludes(r.error.message, "fatal: bad revision");

  const runnerError = await run(GOOD_SUMMARY, {}, fakeGit({ diff: "error" }));
  assert(!runnerError.ok);

  const d = deps(GOOD_SUMMARY, fakeGit({ diff: failing }));
  assertEquals(await main(["--base", "main", "s.md"], d.deps), 2);
  assertStringIncludes(d.err.join("\n"), "fatal: bad revision");
});

Deno.test("runPrSummaryCheck - every git call, ls-tree included, runs in the repo root", async () => {
  const git = fakeGit();
  const r = await run(GOOD_SUMMARY, {}, git);
  assert(r.ok);
  const lsTree = git.calls.filter((c) => c.args.includes("ls-tree"));
  assertEquals(lsTree.length, 1);
  assert(git.calls.every((c) => c.cwd === ROOT));
});

Deno.test("runPrSummaryCheck - a named test absent at HEAD blocks branch outcomes", async () => {
  const r = await run(GOOD_SUMMARY, {}, fakeGit({ tests: [] }));
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3147"), "blocked");
});

Deno.test("formatReport - states blocked count and that not-checked is not a pass", () => {
  const text = formatReport([
    { gate: "A", issueRef: "#1", status: "blocked", problems: ["bad"] },
    {
      gate: "B",
      issueRef: "#2",
      status: "not_checked",
      problems: [],
      note: "n",
    },
  ]);
  assertStringIncludes(text, "[BLOCKED] A (#1)");
  assertStringIncludes(text, "    - bad");
  assertStringIncludes(text, "1 gate(s) blocked");
  assertStringIncludes(text, "not a pass");
});

Deno.test("parseArgs - accepts all flags and one summary file", () => {
  const r = parseArgs([
    "--base",
    "main",
    "--issue-body-file",
    "i.md",
    "--labels",
    "bug,x",
    "s.md",
  ]);
  assert(r.ok);
  assertEquals(r.value, {
    summaryFile: "s.md",
    baseBranch: "main",
    issueBodyFile: "i.md",
    issueTitle: null,
    labels: "bug,x",
    claimCheck: true,
    verifier: false,
  });
});

Deno.test("parseArgs - the claim check is on by default and --no-claim-check turns it off (Issue #4234)", () => {
  const on = parseArgs(["--base", "main", "s.md"]);
  assert(on.ok);
  assertEquals(on.value.claimCheck, true);
  const explicit = parseArgs(["--base", "main", "--claim-check", "s.md"]);
  assert(explicit.ok);
  assertEquals(explicit.value.claimCheck, true);
  const off = parseArgs(["--base", "main", "--no-claim-check", "s.md"]);
  assert(off.ok);
  assertEquals(off.value.claimCheck, false);
  assert(
    !parseArgs(["--base", "main", "--claim-check", "--no-claim-check", "s.md"])
      .ok,
  );
});

Deno.test("parseArgs - --verifier is opt-in and --issue-title takes a value (Issue #4234)", () => {
  const plain = parseArgs(["--base", "main", "s.md"]);
  assert(plain.ok);
  assertEquals(plain.value.verifier, false);
  const verified = parseArgs(["--base", "main", "--verifier", "s.md"]);
  assert(verified.ok);
  assertEquals(verified.value.verifier, true);
  const titled = parseArgs([
    "--base",
    "main",
    "--issue-title",
    "Fix x",
    "s.md",
  ]);
  assert(titled.ok);
  assertEquals(titled.value.issueTitle, "Fix x");
  assert(!parseArgs(["--base", "main", "s.md", "--issue-title"]).ok);
});

Deno.test("parseArgs - rejects missing base, missing or extra file, unknown flag, valueless flag", () => {
  assert(!parseArgs(["s.md"]).ok);
  assert(!parseArgs(["--base", "main"]).ok);
  assert(!parseArgs(["--base", "main", "a.md", "b.md"]).ok);
  assert(!parseArgs(["--base", "main", "--nope", "s.md"]).ok);
  assert(!parseArgs(["s.md", "--base"]).ok);
});

Deno.test("repoRelativePath - names the summary by its path under the repo root, or null outside it", () => {
  assertEquals(repoRelativePath("s.md", "/repo", "/repo"), "s.md");
  assertEquals(
    repoRelativePath(
      "../../docs/archive/pr-summaries/pr-summary-7.md",
      "/repo",
      "/repo/worker/deno",
    ),
    "docs/archive/pr-summaries/pr-summary-7.md",
  );
  assertEquals(
    repoRelativePath("/repo/docs/x.md", "/repo", "/elsewhere"),
    "docs/x.md",
  );
  assertEquals(
    repoRelativePath("../../x.md", "/repo", "/repo/worker/deno"),
    "x.md",
  );
  assertEquals(repoRelativePath("/other/x.md", "/repo", "/repo"), null);
  assertEquals(repoRelativePath("../x.md", "/repo", "/repo"), null);
});

Deno.test("main - the claim check runs by default with the real model wiring's settings (Issue #4234)", async () => {
  const calls: Array<Parameters<CliDeps["askModel"]>> = [];
  const d = deps(GOOD_SUMMARY, fakeGit(), {
    askModel: (options, retry) => {
      calls.push([options, retry]);
      return Promise.resolve(NO_VERDICT_REPLY);
    },
  });
  assertEquals(
    await main(["--base", "main", "docs/pr-summary-77.md"], d.deps),
    0,
  );
  assertEquals(calls.length, 1);
  const [options, retry] = calls[0]!;
  assertEquals(options.phase, "issue");
  assertEquals(options.issueNumber, 77);
  assertEquals(options.cwd, ROOT);
  assertEquals(retry, { maxRetries: OPERATIONAL_DEFAULTS.maxRateLimitRetries });
  assertStringIncludes(options.prompt, "docs/pr-summary-77.md");
  assertStringIncludes(
    d.out.join("\n"),
    "[NOT_CHECKED] Summary claim check (#3257)",
  );
});

Deno.test("main - --no-claim-check never calls the model and reports the claim check not checked (Issue #4234)", async () => {
  let asked = 0;
  const d = deps(GOOD_SUMMARY, fakeGit(), {
    askModel: () => {
      asked++;
      return Promise.resolve(NO_VERDICT_REPLY);
    },
  });
  assertEquals(
    await main(
      ["--base", "main", "--no-claim-check", "docs/pr-summary-77.md"],
      d.deps,
    ),
    0,
  );
  assertEquals(asked, 0);
  const text = d.out.join("\n");
  assertStringIncludes(text, "[NOT_CHECKED] Summary claim check (#3257)");
  assertStringIncludes(text, "not a pass");
});

Deno.test("main - the verifier is opt-in and a verifier block exits 1 (Issue #4234)", async () => {
  const runs: PrePrVerifierInput[] = [];
  const blocking: PrePrVerifierResult = {
    status: "checked",
    review: {
      summary: "",
      findings: [{
        file: "worker/deno/lib/foo.ts",
        line: 3,
        problem: "wrong",
      }],
      testChanges: "none",
      testChangeNotes: [],
      unrelatedIssues: [],
      checklist: [],
      closure: [],
    },
  };
  const d = deps(GOOD_SUMMARY, fakeGit(), {
    runVerifier: (input) => {
      runs.push(input);
      return Promise.resolve(blocking);
    },
  });
  assertEquals(
    await main([
      "--base",
      "main",
      "--verifier",
      "--no-claim-check",
      "docs/pr-summary-77.md",
    ], d.deps),
    1,
  );
  assertEquals(runs.length, 1);
  assertEquals(runs[0]!.issueNumber, 77);
  assertEquals(runs[0]!.summaryPath, "docs/pr-summary-77.md");
  assertStringIncludes(d.out.join("\n"), "[BLOCKED] Pre-PR verifier (#3395)");

  const off = deps(GOOD_SUMMARY);
  assertEquals(
    await main(["--base", "main", "docs/pr-summary-77.md"], off.deps),
    0,
  );
  assertStringIncludes(
    off.out.join("\n"),
    "[NOT_CHECKED] Pre-PR verifier (#3395)",
  );
});

Deno.test("main - a summary outside the repo root, or with no issue number, is not checked by the model checks (Issue #4234)", async () => {
  let asked = 0;
  const d = deps(GOOD_SUMMARY, fakeGit(), {
    askModel: () => {
      asked++;
      return Promise.resolve(NO_VERDICT_REPLY);
    },
  });
  assertEquals(await main(["--base", "main", "s.md"], d.deps), 0);
  assertEquals(asked, 0);
  assertStringIncludes(d.out.join("\n"), "no issue number");
});

Deno.test("main - bad args and an unreadable summary exit 2", async () => {
  const bad = deps(GOOD_SUMMARY);
  assertEquals(await main(["s.md"], bad.deps), 2);
  assertStringIncludes(bad.err.join("\n"), "--base is required");

  const unreadable = deps(new Error("no such file"));
  assertEquals(await main(["--base", "main", "s.md"], unreadable.deps), 2);
  assertStringIncludes(unreadable.err.join("\n"), "no such file");
});

Deno.test("runPrSummaryCheck - an unresolvable base ref is an error, and main exits 2", async () => {
  const git = unresolvableBaseGit();
  const r = await run(GOOD_SUMMARY, {}, git);
  assert(!r.ok);
  assertStringIncludes(r.error.message, "not resolvable");
  assert(!git.calls.some((c) => c.args[0] === "diff"));

  const d = deps(GOOD_SUMMARY, unresolvableBaseGit());
  assertEquals(await main(["--base", "main", "s.md"], d.deps), 2);
  assertStringIncludes(d.err.join("\n"), "not resolvable");
  assertEquals(d.out.length, 0);
});

Deno.test("runPrSummaryCheck - criteria in the issue body with no closure block blocks the closure gate", async () => {
  const r = await run(GOOD_SUMMARY, { issueBody: ISSUE_WITH_CRITERIA });
  assert(r.ok);
  assertEquals(statusOf(r.value, "#518"), "blocked");
  assert(r.value.find((g) => g.issueRef === "#518")!.problems.length > 0);
  assertEquals(statusOf(r.value, "#3073"), "passed");
  assertEquals(statusOf(r.value, "#3147"), "passed");
  assertEquals(statusOf(r.value, "#3124"), "passed");
});

Deno.test("runPrSummaryCheck - criteria in the issue body with no reviewer blocks block the review gate", async () => {
  const r = await run(GOOD_SUMMARY, { issueBody: ISSUE_WITH_CRITERIA });
  assert(r.ok);
  assertEquals(statusOf(r.value, "#663"), "blocked");
  assert(r.value.find((g) => g.issueRef === "#663")!.problems.length > 0);
  assertEquals(statusOf(r.value, "#3073"), "passed");
  assertEquals(statusOf(r.value, "#3147"), "passed");
  assertEquals(statusOf(r.value, "#3124"), "passed");
});

Deno.test("main - a repository root failure exits 2 and names the repository root", async () => {
  const d = deps(GOOD_SUMMARY);
  d.deps.repoRoot = () =>
    Promise.resolve({ ok: false as const, error: new Error("not a git repo") });
  assertEquals(await main(["--base", "main", "s.md"], d.deps), 2);
  const stderr = d.err.join("\n");
  assertStringIncludes(stderr, "repository root");
  assertStringIncludes(stderr, "not a git repo");
  assertEquals(d.out.length, 0);
});

// --- Branch outcomes facts file (Issue #3535) -------------------------------

const FACTS_ISSUE = 77;
const VALID_FACTS = JSON.stringify({
  version: 1,
  branchOutcomes: {
    noneAdded: false,
    entries: [{
      path: "worker/deno/lib/foo.ts",
      line: 42,
      outcome: "error",
      test: TEST_PATH,
      testName: "rejects bad",
      flipWentRed: "went red when the guard was removed",
    }],
  },
});
const MARKER_ONLY_SUMMARY = GOOD_SUMMARY.replace(
  /\*\*Branch outcomes:\*\*\n- [^\n]*\n/,
  `${BRANCH_OUTCOMES_MARKER}\n`,
);

/** Run with a repo root holding the given facts file (none when undefined). */
async function runWithFacts(summary: string, facts?: string) {
  const dir = await Deno.makeTempDir();
  try {
    if (facts !== undefined) {
      await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/${prSummaryFactsPath(FACTS_ISSUE)}`,
        facts,
      );
    }
    return await run(summary, { issueNumber: FACTS_ISSUE, repoRoot: dir });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("runPrSummaryCheck - a marker-only summary with a valid facts file passes branch outcomes", async () => {
  assert(!MARKER_ONLY_SUMMARY.includes("**Branch outcomes:**"));
  assertStringIncludes(MARKER_ONLY_SUMMARY, BRANCH_OUTCOMES_MARKER);
  const r = await runWithFacts(MARKER_ONLY_SUMMARY, VALID_FACTS);
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3147"), "passed");
  assertEquals(hasBlock(r.value), false);
});

Deno.test("runPrSummaryCheck - the same marker-only summary without a facts file blocks", async () => {
  const r = await runWithFacts(MARKER_ONLY_SUMMARY);
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3147"), "blocked");
});

Deno.test("runPrSummaryCheck - an invalid facts file blocks and names the file", async () => {
  const r = await runWithFacts(MARKER_ONLY_SUMMARY, "{ not json");
  assert(r.ok);
  const report = r.value.find((g) => g.issueRef === "#3147")!;
  assertEquals(report.status, "blocked");
  assertStringIncludes(report.problems.join("\n"), "is invalid");
  assertStringIncludes(
    report.problems.join("\n"),
    prSummaryFactsPath(FACTS_ISSUE),
  );
});

Deno.test("runPrSummaryCheck - authoritative facts replace a legacy list (Issue #3979)", async () => {
  // GOOD_SUMMARY is itself valid, so only the facts-plus-prose rule can block.
  const alone = await runWithFacts(GOOD_SUMMARY);
  assert(alone.ok);
  assertEquals(statusOf(alone.value, "#3147"), "passed");

  const legacy = GOOD_SUMMARY.replace(
    TEST_PATH,
    "worker/deno/tests/stale_test.ts",
  );
  const stale = await runWithFacts(legacy);
  assert(stale.ok);
  assertEquals(statusOf(stale.value, "#3147"), "blocked");
  const r = await runWithFacts(legacy, VALID_FACTS);
  assert(r.ok);
  const report = r.value.find((g) => g.issueRef === "#3147")!;
  assertEquals(report.status, "passed");
  assertEquals(report.problems, []);
});

Deno.test("runPrSummaryCheck - a facts file is ignored when the summary name carries no issue number", async () => {
  const r = await run(MARKER_ONLY_SUMMARY, { issueNumber: null });
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3147"), "blocked");
});

Deno.test("issueNumberFromSummaryPath - reads the number from pr-summary-<N>.md only", () => {
  assertEquals(
    issueNumberFromSummaryPath("docs/archive/pr-summaries/pr-summary-77.md"),
    77,
  );
  assertEquals(issueNumberFromSummaryPath("pr-summary-5.md"), 5);
  assertEquals(issueNumberFromSummaryPath("summary.md"), null);
  assertEquals(issueNumberFromSummaryPath("pr-summary-5.facts.json"), null);
});

Deno.test("main - reads the facts file named by the summary path", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/${prSummaryFactsPath(FACTS_ISSUE)}`,
      VALID_FACTS,
    );
    const d = deps(MARKER_ONLY_SUMMARY);
    d.deps.repoRoot = () => Promise.resolve({ ok: true as const, value: dir });
    const code = await main(
      ["--base", "main", `x/pr-summary-${FACTS_ISSUE}.md`],
      d.deps,
    );
    assertEquals(code, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrSummaryCheck - scrubbed markers block even inside Mermaid or code spans", async () => {
  for (
    const suffix of [
      "\n```mermaid\nsequenceDiagram\nA--․>>B: hello\n```",
      "\n`<․!-- hidden --․>`",
    ]
  ) {
    const r = await run(GOOD_SUMMARY + suffix);
    assert(r.ok);
    assertEquals(statusOf(r.value, "#3710"), "blocked");
    assertStringIncludes(
      r.value.find((g) => g.issueRef === "#3710")!.problems[0]!,
      "U+2024",
    );
  }
  const clean = await run(
    GOOD_SUMMARY +
      "\n<!-- hidden -->\n```mermaid\nsequenceDiagram\nA-->>B: hello\n```\n",
  );
  assert(clean.ok);
  assertEquals(statusOf(clean.value, "#3710"), "passed");
});

Deno.test("runPrSummaryCheck - ambiguous outcome ownership names the blocker (Issue #3979)", async () => {
  const result = await runWithFacts(
    `${MARKER_ONLY_SUMMARY}\n${BRANCH_OUTCOMES_MARKER}`,
    VALID_FACTS,
  );
  assert(result.ok);
  const report = result.value.find((gate) => gate.issueRef === "#3147")!;
  assertEquals(report.status, "blocked");
  assertStringIncludes(report.problems.join("\n"), "ambiguous");
});
