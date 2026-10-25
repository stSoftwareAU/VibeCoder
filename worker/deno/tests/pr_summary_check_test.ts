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
} from "../lib/pr_summary_check_cli.ts";
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
    issueLabels: extra.issueLabels ?? null,
    runGit: git.runGit,
    repoRoot: extra.repoRoot ?? ROOT,
  });
}

function deps(summary: string | Error, git = fakeGit()) {
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
  };
  return { out, err, deps: cliDeps };
}

Deno.test("runPrSummaryCheck - well-formed summary passes the placeholder gate", async () => {
  const r = await run(GOOD_SUMMARY);
  assert(r.ok);
  assertEquals(statusOf(r.value, "#3124"), "passed");
  assertEquals(hasBlock(r.value), false);
});

Deno.test("main - well-formed summary exits 0", async () => {
  const d = deps(GOOD_SUMMARY);
  assertEquals(await main(["--base", "main", "s.md"], d.deps), 0);
  assertStringIncludes(d.out.join("\n"), "[PASSED] Result placeholders (#3124)");
});

Deno.test("runPrSummaryCheck - absent issue body and labels are not checked", async () => {
  const r = await run(GOOD_SUMMARY);
  assert(r.ok);
  assertEquals(statusOf(r.value, "#518"), "not_checked");
  assertEquals(statusOf(r.value, "#663"), "not_checked");
  assertEquals(statusOf(r.value, "#521"), "not_checked");
  const closure = r.value.find((g) => g.issueRef === "#518")!;
  assertEquals(closure.note, "no --issue-body-file given");
  assertEquals(
    r.value.find((g) => g.issueRef === "#521")!.note,
    "no --labels given",
  );
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

Deno.test("runPrSummaryCheck - every git call runs in the repo root", async () => {
  const git = fakeGit();
  const r = await run(GOOD_SUMMARY, {}, git);
  assert(r.ok);
  assert(git.calls.length > 0);
  assert(git.calls.every((c) => c.cwd === ROOT));
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
    labels: "bug,x",
  });
});

Deno.test("parseArgs - rejects missing base, missing or extra file, unknown flag, valueless flag", () => {
  assert(!parseArgs(["s.md"]).ok);
  assert(!parseArgs(["--base", "main"]).ok);
  assert(!parseArgs(["--base", "main", "a.md", "b.md"]).ok);
  assert(!parseArgs(["--base", "main", "--nope", "s.md"]).ok);
  assert(!parseArgs(["s.md", "--base"]).ok);
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
  assertEquals(statusOf(r.value, "#3124"), "passed");
});

Deno.test("runPrSummaryCheck - criteria in the issue body with no reviewer blocks block the review gate", async () => {
  const r = await run(GOOD_SUMMARY, { issueBody: ISSUE_WITH_CRITERIA });
  assert(r.ok);
  assertEquals(statusOf(r.value, "#663"), "blocked");
  assert(r.value.find((g) => g.issueRef === "#663")!.problems.length > 0);
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

Deno.test("issueNumberFromSummaryPath - reads the number from pr-summary-<N>.md only", () => {
  assertEquals(
    issueNumberFromSummaryPath("docs/archive/pr-summaries/pr-summary-77.md"),
    77,
  );
  assertEquals(issueNumberFromSummaryPath("pr-summary-5.md"), 5);
  assertEquals(issueNumberFromSummaryPath("summary.md"), null);
  assertEquals(issueNumberFromSummaryPath("pr-summary-5.facts.json"), null);
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

const RUN_ISSUE = 42;

function withPartOf(extra: string, issueNumber: number | null = RUN_ISSUE) {
  return run(`${GOOD_SUMMARY}\n${extra}`, { issueNumber });
}

function partOfProblem(
  reports: GateReport[],
): string {
  return reports.find((gate) => gate.issueRef === "#4126")?.problems.join(
    "\n",
  ) ?? "";
}

Deno.test("runPrSummaryCheck - Part of #N with no missing criterion blocks, because the append would close the issue (Issue #4126)", async () => {
  const r = await withPartOf("Part of #42. The issue stays open.");
  assert(r.ok);
  assertEquals(statusOf(r.value, "#4126"), "blocked");
  const problem = partOfProblem(r.value);
  assertStringIncludes(problem, "Part of #42");
  assertStringIncludes(problem, "Closes #42");
});

Deno.test("runPrSummaryCheck - Part of #N plus a negated close blocks and names that phrase (Issue #4126)", async () => {
  const doesNot = await withPartOf(
    "Part of #42.\n\nThis pull request does not close #42.",
  );
  assert(doesNot.ok);
  assertEquals(statusOf(doesNot.value, "#4126"), "blocked");
  assertStringIncludes(partOfProblem(doesNot.value), "does not close #42");

  const usedTo = await withPartOf(
    "Part of #42.\n\nIt is not declared complete or used to close #42.",
  );
  assert(usedTo.ok);
  assertEquals(statusOf(usedTo.value, "#4126"), "blocked");
  assertStringIncludes(
    partOfProblem(usedTo.value),
    "used to close #42",
  );

  const wrappedClose = await withPartOf(
    "Part of #42.\n\nThis change does not close\n#42.",
  );
  assert(wrappedClose.ok);
  assertEquals(statusOf(wrappedClose.value, "#4126"), "blocked");
  assertStringIncludes(partOfProblem(wrappedClose.value), "close #42");
});

Deno.test("runPrSummaryCheck - Part of #N with a parsed missing entry passes (Issue #4126)", async () => {
  const r = await withPartOf(
    [
      "Part of #42.",
      "",
      "## Acceptance Criteria",
      "",
      "- **missing** — the owner deploys the baseline — reviewer: missing — reason: not deployed yet",
    ].join("\n"),
  );
  assert(r.ok);
  assertEquals(statusOf(r.value, "#4126"), "passed");
});

Deno.test("runPrSummaryCheck - Part of another issue, a plain close, and a code-span mention pass (Issue #4126)", async () => {
  const other = await withPartOf("Part of #99. The parent stays open.");
  assert(other.ok);
  assertEquals(statusOf(other.value, "#4126"), "passed");

  const closes = await withPartOf("Closes #42.");
  assert(closes.ok);
  assertEquals(statusOf(closes.value, "#4126"), "passed");

  const spanned = await withPartOf(
    "The template says `Part of #42` in its example.",
  );
  assert(spanned.ok);
  assertEquals(statusOf(spanned.value, "#4126"), "passed");

  const closingInCode = await withPartOf(
    "Part of #42.\n\nThe example keyword is `Closes #42`.",
  );
  assert(closingInCode.ok);
  assertEquals(statusOf(closingInCode.value, "#4126"), "passed");

  const wrapped = await withPartOf("Part of\n#42 stays open.");
  assert(wrapped.ok);
  assertEquals(statusOf(wrapped.value, "#4126"), "blocked");

  const refs = await withPartOf("Refs #42. The issue stays open.");
  assert(refs.ok);
  assertEquals(statusOf(refs.value, "#4126"), "blocked");
  assertStringIncludes(partOfProblem(refs.value), "Refs #42");
});

Deno.test("runPrSummaryCheck - Part of still closes is not checked without an issue number (Issue #4126)", async () => {
  const r = await run(`${GOOD_SUMMARY}\nPart of #42.`);
  assert(r.ok);
  assertEquals(statusOf(r.value, "#4126"), "not_checked");
});

