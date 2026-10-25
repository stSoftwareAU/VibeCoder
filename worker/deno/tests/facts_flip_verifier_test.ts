/**
 * Facts flip verifier, Deno path (Issue #4186). Drives `verifyFactsFlips`
 * through injected mutation-runner seams and a tiny in-memory fixture. No
 * real `deno test` runs, and the fixture is not this repository's suite.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { generateDenoMutantsDetailed } from "../lib/mutation_gate.ts";
import {
  type FactsFlipSeams,
  type FactsFlipVerdict,
  isTwoSidedOutcome,
  verifyFactsFlips,
} from "../lib/facts_flip_verifier.ts";
import type { TestedEntry } from "../lib/summary_facts.ts";
import type {
  MutationRunnerSeams,
  ProcessResult,
} from "../lib/mutation_runner.ts";
import type { SummaryFacts } from "../lib/summary_facts.ts";

const REPO = "/repo";
const SOURCE_REL = "lib/m.ts";
const TEST_REL = "tests/m_test.ts";
const OTHER_TEST = "tests/other_test.ts";
const TEST_NAME = "pins the flag";

const SOURCE = [
  "export function f(a: boolean): boolean {",
  "  if (a) {",
  "    return true;",
  "  }",
  "  return false;",
  "}",
  "",
].join("\n");

const REFUSAL =
  `\`${SOURCE_REL}:2\`: no flip of this line turns \`${TEST_NAME}\` red; name a test that fails, or add one`;

const TWO_SIDED_REFUSAL =
  `\`${SOURCE_REL}:2\`: one forcing of this two-sided outcome leaves \`${TEST_NAME}\` green; name a test that fails both ways, or split the entry`;

const SPLIT_REASON =
  "two-sided outcome: cannot confirm both forcings; split the entry";

function passResult(): ProcessResult {
  return {
    code: 0,
    stdout: `${TEST_NAME} ... ok\n`,
    stderr: "",
    timedOut: false,
  };
}

function failResult(): ProcessResult {
  return {
    code: 1,
    stdout: `${TEST_NAME} ... FAILED\n`,
    stderr: "error: Test failed\n",
    timedOut: false,
  };
}

interface Harness {
  seams: FactsFlipSeams;
  files: Map<string, string>;
  calls: Array<{ cmd: string; args: string[]; cwd: string }>;
}

function harness(
  run: (
    cmd: string,
    args: string[],
    files: Map<string, string>,
  ) => ProcessResult | Promise<ProcessResult>,
  opts: {
    files?: Record<string, string>;
    budgetRaw?: string;
    now?: () => number;
    warn?: FactsFlipSeams["warn"];
  } = {},
): Harness {
  const files = new Map<string, string>(Object.entries({
    [`${REPO}/deno.json`]: "{}",
    [`${REPO}/${SOURCE_REL}`]: SOURCE,
    [`${REPO}/${TEST_REL}`]:
      `import { f } from "../lib/m.ts";\nDeno.test("${TEST_NAME}", () => f(true));\n`,
    [`${REPO}/${OTHER_TEST}`]: "Deno.test('other', () => {});\n",
    ...opts.files,
  }));
  const calls: Harness["calls"] = [];
  const runner: MutationRunnerSeams = {
    runProcess: async (cmd, args, procOpts) => {
      calls.push({ cmd, args, cwd: procOpts.cwd });
      return await run(cmd, args, files);
    },
    now: opts.now ?? (() => 0),
    readTextFile: (p) => {
      const v = files.get(p);
      return v === undefined
        ? Promise.reject(new Error(`ENOENT ${p}`))
        : Promise.resolve(v);
    },
    writeTextFile: (p, data) => {
      files.set(p, data);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
    realPath: (p) => Promise.resolve(p),
    removeDir: () => Promise.resolve(),
    makeTempDir: () => Promise.resolve("/tmp/flip-verifier"),
    listTestFiles: () => Promise.resolve([TEST_REL, OTHER_TEST]),
  };
  return {
    seams: {
      ...runner,
      repoPath: REPO,
      budgetRaw: opts.budgetRaw ?? "",
      warn: opts.warn ?? (() => {}),
    },
    files,
    calls,
  };
}

function tested(over: Partial<TestedEntry> = {}): TestedEntry {
  return {
    path: SOURCE_REL,
    line: 2,
    outcome: "returns early when the flag is set",
    test: TEST_REL,
    testName: TEST_NAME,
    flipWentRed: "the named test failed",
    ...over,
  };
}

function facts(
  entries: SummaryFacts["branchOutcomes"]["entries"],
): SummaryFacts {
  return { version: 1, branchOutcomes: { noneAdded: false, entries } };
}

function sourcePath(): string {
  return `${REPO}/${SOURCE_REL}`;
}

function denoArgs(): string[] {
  return ["test", "--no-check", "-A", "--filter", TEST_NAME, TEST_REL];
}

function assertNamedTestOnly(calls: Harness["calls"]): void {
  assert(calls.length > 0);
  for (const call of calls) {
    assertEquals(call.cmd, "deno");
    assertEquals(call.args, denoArgs());
    assertEquals(call.cwd, REPO);
    assert(!call.args.includes(SOURCE_REL));
    assert(!call.args.includes(OTHER_TEST));
    assert(call.args.includes("--filter"));
  }
}

async function verdicts(
  h: Harness,
  entries: SummaryFacts["branchOutcomes"]["entries"],
): Promise<FactsFlipVerdict[]> {
  return await verifyFactsFlips(facts(entries), h.seams);
}

Deno.test("isTwoSidedOutcome: true/false and the word both, not a look-alike", () => {
  assert(isTwoSidedOutcome("returns true/false"));
  assert(isTwoSidedOutcome("false/true either way"));
  assert(isTwoSidedOutcome("holds true / false"));
  assert(isTwoSidedOutcome("holds both ways"));
  assert(isTwoSidedOutcome("Both outcomes agree"));
  assert(!isTwoSidedOutcome("returns true"));
  assert(!isTwoSidedOutcome("a bother to compute"));
  assert(!isTwoSidedOutcome("the boolean flag"));
});

Deno.test("verifyFactsFlips: a mutant of the cited line that turns the named test red is verified", async () => {
  const written: string[] = [];
  const h = harness((_cmd, _args, files) => {
    const text = files.get(sourcePath()) ?? "";
    if (text !== SOURCE) written.push(text);
    return text === SOURCE ? passResult() : failResult();
  });
  const got = await verdicts(h, [tested()]);
  assertEquals(got, [{ index: 0, verdict: { kind: "verified" } }]);
  assertNamedTestOnly(h.calls);
  assertEquals(h.files.get(sourcePath()), SOURCE);
  const cited = generateDenoMutantsDetailed(SOURCE_REL, SOURCE, [2], 40);
  const elsewhere = generateDenoMutantsDetailed(SOURCE_REL, SOURCE, [5], 40);
  assert(cited.mutants.length > 0);
  assert(written.length > 0);
  assert(written.length <= cited.mutants.length);
  for (const text of written) {
    assert(cited.mutants.some((m) => m.mutatedSource === text));
    assert(elsewhere.mutants.every((m) => m.mutatedSource !== text));
  }
});

Deno.test("verifyFactsFlips: no mutant that turns the named test red is refused with the exact message", async () => {
  const h = harness(() => passResult());
  const got = await verdicts(h, [tested()]);
  assertEquals(got, [{
    index: 0,
    verdict: { kind: "refused", message: REFUSAL },
  }]);
  assertNamedTestOnly(h.calls);
  assertEquals(h.files.get(sourcePath()), SOURCE);
});

Deno.test("verifyFactsFlips: only the named test is filtered; another test file is never run", async () => {
  const h = harness((_cmd, _args, files) =>
    files.get(sourcePath()) === SOURCE ? passResult() : failResult()
  );
  await verdicts(h, [tested()]);
  assertNamedTestOnly(h.calls);
  assertEquals(
    h.calls.some((c) => c.args.join(" ").includes(OTHER_TEST)),
    false,
  );
  assert(
    h.calls.every((c) =>
      c.args.includes("--filter") && c.args.includes(TEST_NAME)
    ),
  );
});

Deno.test("verifyFactsFlips: a nested Deno project runs the test relative to that project", async () => {
  const rel = "worker/deno/lib/m.ts";
  const testRel = "worker/deno/tests/m_test.ts";
  const h = harness(
    (_cmd, _args, files) =>
      files.get(`${REPO}/${rel}`) === SOURCE ? passResult() : failResult(),
    {
      files: {
        [`${REPO}/worker/deno/deno.json`]: "{}",
        [`${REPO}/${rel}`]: SOURCE,
        [`${REPO}/${testRel}`]: "Deno.test('pins the flag', () => {});\n",
      },
    },
  );
  h.files.delete(`${REPO}/deno.json`);
  h.files.delete(`${REPO}/${SOURCE_REL}`);
  h.files.delete(`${REPO}/${TEST_REL}`);
  const got = await verdicts(h, [tested({ path: rel, test: testRel })]);
  assertEquals(got[0]?.verdict.kind, "verified");
  assertEquals(h.calls[0]?.cwd, `${REPO}/worker/deno`);
  assertEquals(h.calls[0]?.args, [
    "test",
    "--no-check",
    "-A",
    "--filter",
    TEST_NAME,
    "tests/m_test.ts",
  ]);
});

Deno.test("verifyFactsFlips: baseline failure is not_checked, and no mutant is applied", async () => {
  const h = harness(() => failResult());
  const got = await verdicts(h, [tested()]);
  assertEquals(got, [{
    index: 0,
    verdict: { kind: "not_checked", reason: "baseline_failure" },
  }]);
  assertEquals(h.calls.length, 1);
  assertEquals(h.files.get(sourcePath()), SOURCE);
});

Deno.test("verifyFactsFlips: zero matched tests is not_checked, never verified", async () => {
  const h = harness(() => ({
    code: 0,
    stdout: "ok | 0 passed | 0 failed | 1 filtered out\n",
    stderr: "",
    timedOut: false,
  }));
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "zero_matched_tests",
  });
});

Deno.test("verifyFactsFlips: a missing deno binary is not_checked, never verified", async () => {
  const h = harness(() => ({
    code: 127,
    stdout: "",
    stderr: "command not found: deno",
    timedOut: false,
  }));
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "missing_tool",
  });
});

Deno.test("verifyFactsFlips: a timed-out baseline is not_checked, never verified", async () => {
  const h = harness(() => ({
    code: 1,
    stdout: `${TEST_NAME} ... FAILED\n`,
    stderr: "",
    timedOut: true,
  }));
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, { kind: "not_checked", reason: "timeout" });
});

Deno.test("verifyFactsFlips: a comment line has no viable mutant", async () => {
  const h = harness(() => passResult(), {
    files: { [`${REPO}/${SOURCE_REL}`]: "// nothing to flip\n" },
  });
  const got = await verdicts(h, [tested({ line: 1 })]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "no_viable_mutant",
  });
  assertEquals(h.calls.length, 0);
});

Deno.test("verifyFactsFlips: an unparsable mutant is not a kill", async () => {
  const stderr =
    "\u001b[0m\u001b[1m\u001b[31merror\u001b[0m: SyntaxError: Expression expected\n";
  const h = harness((_cmd, _args, files) =>
    files.get(sourcePath()) === SOURCE
      ? passResult()
      : { code: 1, stdout: "", stderr, timedOut: false }
  );
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "no_viable_mutant",
  });
  assertEquals(h.files.get(sourcePath()), SOURCE);
});

Deno.test("verifyFactsFlips: an entry not started when the budget is spent is budget_exhausted", async () => {
  let t = 0;
  const h = harness((_cmd, _args, files) => {
    t += 600;
    return files.get(sourcePath()) === SOURCE ? passResult() : failResult();
  }, {
    budgetRaw: "1",
    now: () => t,
  });
  const got = await verdicts(h, [
    tested(),
    tested({ line: 5, outcome: "returns the other value" }),
  ]);
  assertEquals(got[0]?.verdict.kind, "verified");
  assertEquals(got[1], {
    index: 1,
    verdict: { kind: "not_checked", reason: "budget_exhausted" },
  });
});

Deno.test("verifyFactsFlips: the budget is read through resolveMutationBudgetSeconds", async () => {
  const warnings: string[] = [];
  let t = 0;
  const h = harness(() => passResult(), {
    budgetRaw: "nope",
    now: () => t,
    warn: (message: string) => warnings.push(message),
  });
  // A constant clock never exhausts; the invalid value must still be reported.
  t = 0;
  await verdicts(h, [tested()]);
  assertEquals(warnings.length, 1);
  assert(!warnings[0]!.startsWith("WARNING:"));
  assert(!warnings[0]!.includes("ERROR:"));
});

Deno.test("verifyFactsFlips: a two-sided entry is verified only when both forcings go red", async () => {
  const h = harness((_cmd, _args, files) =>
    files.get(sourcePath()) === SOURCE ? passResult() : failResult()
  );
  const got = await verdicts(h, [
    tested({
      line: 2,
      endLine: 3,
      outcome: "returns true/false",
    }),
  ]);
  assertEquals(got[0]?.verdict, { kind: "verified" });
});

Deno.test("verifyFactsFlips: a two-sided entry with one forcing is not_checked", async () => {
  const h = harness(() => failResult());
  const got = await verdicts(h, [
    tested({ outcome: "holds both ways" }),
  ]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: SPLIT_REASON,
  });
  assertEquals(h.calls.length, 0);
});

Deno.test("verifyFactsFlips: a two-sided entry with one forcing staying green is refused", async () => {
  const h = harness((_cmd, _args, files) => {
    const text = files.get(sourcePath()) ?? "";
    if (text === SOURCE) return passResult();
    if (text.includes("if (!(a))")) return failResult();
    return passResult();
  });
  const got = await verdicts(h, [
    tested({ line: 2, endLine: 3, outcome: "holds both ways" }),
  ]);
  assertEquals(got[0]?.verdict, {
    kind: "refused",
    message: TWO_SIDED_REFUSAL,
  });
  assertEquals(h.files.get(sourcePath()), SOURCE);
});

Deno.test("verifyFactsFlips: exempt entries are skipped", async () => {
  const h = harness((_cmd, _args, files) =>
    files.get(sourcePath()) === SOURCE ? passResult() : failResult()
  );
  const got = await verdicts(h, [
    {
      path: SOURCE_REL,
      line: 1,
      outcome: "a comment no test can reach",
      exempt: { kind: "untestable", reason: "comment only here" },
    },
    tested(),
  ]);
  assertEquals(got, [{ index: 1, verdict: { kind: "verified" } }]);
});

Deno.test("verifyFactsFlips: the cited file is restored when the test run throws", async () => {
  const h = harness((_cmd, _args, files) => {
    if (files.get(sourcePath()) !== SOURCE) {
      throw new Error("mutant run exploded");
    }
    return passResult();
  });
  await assertRejects(
    () => verdicts(h, [tested()]),
    Error,
    "mutant run exploded",
  );
  assertEquals(h.files.get(sourcePath()), SOURCE);
});

Deno.test("verifyFactsFlips: a test file that is not Deno or Rust is not_checked", async () => {
  const h = harness(() => passResult());
  const got = await verdicts(h, [tested({ test: "tests/m_test.py" })]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "unsupported_test",
  });
  assertEquals(h.calls.length, 0);
});

Deno.test("verifyFactsFlips: no Deno project and an escaping path are not_checked", async () => {
  const missing = harness(() => passResult());
  missing.files.delete(`${REPO}/deno.json`);
  const noProject = await verdicts(missing, [tested()]);
  assertEquals(noProject[0]?.verdict, {
    kind: "not_checked",
    reason: "no_deno_project",
  });

  const escaped = harness(() => passResult());
  const outside = await verdicts(escaped, [tested({ path: "../outside.ts" })]);
  assertEquals(outside[0]?.verdict, {
    kind: "not_checked",
    reason: "source_unreadable",
  });
  assertEquals(escaped.calls.length, 0);
});

Deno.test("verifyFactsFlips: mutants past the cap are not_checked, never refused or verified", async () => {
  const lines = ["export function f(a: boolean): number {"];
  for (let i = 0; i < 45; i++) lines.push("  if (a) { return 1; }");
  lines.push("  return 0;", "}", "");
  const many = lines.join("\n");
  const h = harness(() => passResult(), {
    files: { [`${REPO}/${SOURCE_REL}`]: many },
  });
  const got = await verdicts(h, [tested({ line: 2, endLine: 46 })]);
  assertEquals(got[0]?.verdict, { kind: "not_checked", reason: "mutant_cap" });
  assertEquals(h.files.get(sourcePath()), many);
});
