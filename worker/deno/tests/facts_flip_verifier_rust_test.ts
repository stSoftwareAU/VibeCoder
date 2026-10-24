/**
 * Facts flip verifier, Rust path (Issue #4187). Drives `verifyFactsFlips`
 * through injected cargo seams. No real `cargo test` runs.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type FactsFlipSeams,
  type FactsFlipVerdict,
  verifyFactsFlips,
} from "../lib/facts_flip_verifier.ts";
import { rustTestArgs } from "../lib/security_fix_discrimination.ts";
import type { TestedEntry } from "../lib/summary_facts.ts";
import type {
  MutationRunnerSeams,
  ProcessResult,
} from "../lib/mutation_runner.ts";
import type { SummaryFacts } from "../lib/summary_facts.ts";

const REPO = "/repo";
const SOURCE_REL = "src/lib.rs";
const TEST_REL = "tests/pins.rs";
const TEST_NAME = "pins_the_flag";
const OTHER_NAME = "unrelated_check";

const SOURCE = [
  "pub fn f(a: bool) -> bool {",
  "    if a {",
  "        return true;",
  "    }",
  "    false",
  "}",
  "",
].join("\n");

const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\n';

const REFUSAL =
  `\`${SOURCE_REL}:2\`: no flip of this line turns \`${TEST_NAME}\` red; name a test that fails, or add one`;

const TWO_SIDED_REFUSAL =
  `\`${SOURCE_REL}:2\`: one forcing of this two-sided outcome leaves \`${TEST_NAME}\` green; name a test that fails both ways, or split the entry`;

const SPLIT_REASON =
  "two-sided outcome: cannot confirm both forcings; split the entry";

function passCargo(): ProcessResult {
  return {
    code: 0,
    stdout: `test ${TEST_NAME} ... ok\n`,
    stderr: "",
    timedOut: false,
  };
}

function failCargo(): ProcessResult {
  return {
    code: 1,
    stdout: `test ${TEST_NAME} ... FAILED\n`,
    stderr: "",
    timedOut: false,
  };
}

function mutantOutcome(
  summary: string,
  line: number,
  name: string,
  replacement: string,
): unknown {
  return {
    scenario: {
      Mutant: {
        file: SOURCE_REL,
        span: { start: { line, column: 1 }, end: { line, column: 4 } },
        name,
        genre: "binary_operator",
        replacement,
        function: { function_name: "f" },
      },
    },
    summary,
  };
}

function outcomesJson(mutants: unknown[]): string {
  return JSON.stringify({
    outcomes: [
      { scenario: "Baseline", summary: "Success" },
      ...mutants,
    ],
    total_mutants: mutants.length,
  });
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
  } = {},
): Harness {
  const files = new Map<string, string>(Object.entries({
    [`${REPO}/Cargo.toml`]: CARGO,
    [`${REPO}/${SOURCE_REL}`]: SOURCE,
    [`${REPO}/${TEST_REL}`]: `#[test]\nfn ${TEST_NAME}() {}\n`,
    ...opts.files,
  }));
  const calls: Harness["calls"] = [];
  let temps = 0;
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
    removeDir: (p) => {
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${p}/`)) files.delete(key);
      }
      return Promise.resolve();
    },
    makeTempDir: () => Promise.resolve(`/tmp/flip-rust-${++temps}`),
    listTestFiles: () => Promise.resolve([]),
  };
  return {
    seams: {
      ...runner,
      repoPath: REPO,
      budgetRaw: opts.budgetRaw ?? "",
      warn: () => {},
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

async function verdicts(
  h: Harness,
  entries: SummaryFacts["branchOutcomes"]["entries"],
): Promise<FactsFlipVerdict[]> {
  return await verifyFactsFlips(facts(entries), h.seams);
}

function writeOutcomes(
  files: Map<string, string>,
  args: string[],
  body: string,
): void {
  const out = args[args.indexOf("--output") + 1];
  if (out === undefined) throw new Error("missing --output");
  files.set(`${out}/mutants.out/outcomes.json`, body);
}

/** Baseline passes; cargo mutants records `body` and exits `code`. */
function scripted(body: string, code = 0) {
  return (cmd: string, args: string[], files: Map<string, string>) => {
    if (cmd === "cargo" && args[0] === "test") return passCargo();
    if (cmd === "cargo" && args[0] === "mutants") {
      writeOutcomes(files, args, body);
      return { code, stdout: "", stderr: "", timedOut: false };
    }
    return {
      code: 127,
      stdout: "",
      stderr: `command not found: ${cmd}`,
      timedOut: false,
    };
  };
}

function assertNamedCargoOnly(calls: Harness["calls"]): void {
  assertEquals(calls.length >= 1, true);
  const expected = rustTestArgs(TEST_REL, TEST_NAME);
  assertEquals(calls[0]?.cmd, "cargo");
  assertEquals(calls[0]?.args, expected);
  assertEquals(calls[0]?.cwd, REPO);
  for (const call of calls) {
    assertEquals(call.cmd, "cargo");
    assert(call.args.includes(TEST_NAME));
    assert(!call.args.includes(OTHER_NAME));
    assert(!call.args.includes("--workspace"));
  }
  const mutants = calls.filter((c) => c.args[0] === "mutants");
  for (const call of mutants) {
    const split = call.args.indexOf("--");
    assert(split > 0);
    const forwarded = call.args.slice(split + 1);
    assertEquals(forwarded, expected.slice(1));
    assert(forwarded.includes("--test"));
    assert(forwarded.includes("pins"));
    assertEquals(forwarded.filter((a) => a === TEST_NAME).length, 1);
  }
}

const CAUGHT = outcomesJson([
  mutantOutcome("CaughtMutant", 2, "replace == with !=", "!="),
]);

Deno.test("verifyFactsFlips rust: a caught mutant of the cited line is verified", async () => {
  const h = harness(scripted(CAUGHT, 2));
  const got = await verdicts(h, [tested()]);
  assertEquals(got, [{ index: 0, verdict: { kind: "verified" } }]);
  assertNamedCargoOnly(h.calls);
  assertEquals(h.files.get(`${REPO}/${SOURCE_REL}`), SOURCE);
});

Deno.test("verifyFactsFlips rust: only the named test is passed to cargo", async () => {
  const h = harness(scripted(CAUGHT));
  await verdicts(h, [tested()]);
  assertNamedCargoOnly(h.calls);
  assertEquals(
    h.calls.some((c) => c.args[0] === "test" && !c.args.includes(TEST_NAME)),
    false,
  );
});

Deno.test("verifyFactsFlips rust: a mutant that stays green is refused with the exact message", async () => {
  const h = harness(scripted(
    outcomesJson([
      mutantOutcome("MissedMutant", 2, "replace == with !=", "!="),
    ]),
    2,
  ));
  const got = await verdicts(h, [tested()]);
  assertEquals(got, [{
    index: 0,
    verdict: { kind: "refused", message: REFUSAL },
  }]);
  assertEquals(h.files.get(`${REPO}/${SOURCE_REL}`), SOURCE);
});

Deno.test("verifyFactsFlips rust: a catch on another line is not a kill", async () => {
  const h = harness(scripted(outcomesJson([
    mutantOutcome("CaughtMutant", 9, "replace == with !=", "!="),
  ])));
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "no_viable_mutant",
  });
});

Deno.test("verifyFactsFlips rust: missing cargo, zero matches and a baseline failure are distinct", async () => {
  const missing = harness(() => ({
    code: 127,
    stdout: "",
    stderr: "command not found: cargo",
    timedOut: false,
  }));
  assertEquals((await verdicts(missing, [tested()]))[0]?.verdict, {
    kind: "not_checked",
    reason: "missing_tool",
  });
  assertEquals(missing.calls.length, 1);

  const none = harness(() => ({
    code: 0,
    stdout:
      "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
    stderr: "",
    timedOut: false,
  }));
  assertEquals((await verdicts(none, [tested()]))[0]?.verdict, {
    kind: "not_checked",
    reason: "zero_matched_tests",
  });
  assertEquals(none.calls.length, 1);

  const red = harness(() => failCargo());
  assertEquals((await verdicts(red, [tested()]))[0]?.verdict, {
    kind: "not_checked",
    reason: "baseline_failure",
  });
  assertEquals(red.calls.length, 1);
});

Deno.test("verifyFactsFlips rust: a missing cargo-mutants command is not_checked", async () => {
  const h = harness((_cmd, args) => {
    if (args[0] === "test") return passCargo();
    return {
      code: 101,
      stdout: "",
      stderr: "error: no such command: `mutants`\n",
      timedOut: false,
    };
  });
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "missing_tool",
  });
  assertEquals(h.files.get(`${REPO}/${SOURCE_REL}`), SOURCE);
});

Deno.test("verifyFactsFlips rust: an unviable mutant is not a kill", async () => {
  const h = harness(scripted(outcomesJson([
    mutantOutcome("Unviable", 2, "replace == with !=", "!="),
  ])));
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "no_viable_mutant",
  });
});

Deno.test("verifyFactsFlips rust: no mutants is not_checked", async () => {
  const h = harness((_cmd, args) => {
    if (args[0] === "test") return passCargo();
    return {
      code: 0,
      stdout: "",
      stderr: "No mutants to filter\n",
      timedOut: false,
    };
  });
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "no_viable_mutant",
  });
});

Deno.test("verifyFactsFlips rust: a timed-out cargo run is not_checked, never verified", async () => {
  const h = harness(() => ({
    code: 1,
    stdout: `test ${TEST_NAME} ... FAILED\n`,
    stderr: "",
    timedOut: true,
  }));
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, { kind: "not_checked", reason: "timeout" });
});

Deno.test("verifyFactsFlips rust: an entry not started when the budget is spent is budget_exhausted", async () => {
  let t = 0;
  const h = harness((cmd, args, files) => {
    t += 600;
    return scripted(CAUGHT)(cmd, args, files);
  }, { budgetRaw: "1", now: () => t });
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

Deno.test("verifyFactsFlips rust: no Cargo package is not_checked", async () => {
  const h = harness(scripted(CAUGHT));
  h.files.delete(`${REPO}/Cargo.toml`);
  const got = await verdicts(h, [tested()]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: "no_cargo_package",
  });
  assertEquals(h.calls.length, 0);
});

Deno.test("verifyFactsFlips rust: a two-sided entry is verified only when both forcings go red", async () => {
  const h = harness(scripted(outcomesJson([
    mutantOutcome("CaughtMutant", 2, "replace == with !=", "!="),
    mutantOutcome("CaughtMutant", 3, "replace true with false", "false"),
  ])));
  const got = await verdicts(h, [
    tested({ line: 2, endLine: 3, outcome: "returns true/false" }),
  ]);
  assertEquals(got[0]?.verdict, { kind: "verified" });
});

Deno.test("verifyFactsFlips rust: a two-sided entry with one forcing is not_checked", async () => {
  const h = harness(scripted(outcomesJson([
    mutantOutcome("CaughtMutant", 2, "replace == with !=", "!="),
  ])));
  const got = await verdicts(h, [
    tested({ outcome: "holds both ways" }),
  ]);
  assertEquals(got[0]?.verdict, {
    kind: "not_checked",
    reason: SPLIT_REASON,
  });
});

Deno.test("verifyFactsFlips rust: a two-sided entry with one forcing staying green is refused", async () => {
  const h = harness(scripted(
    outcomesJson([
      mutantOutcome("CaughtMutant", 2, "replace == with !=", "!="),
      mutantOutcome("MissedMutant", 3, "replace true with false", "false"),
    ]),
    2,
  ));
  const got = await verdicts(h, [
    tested({ line: 2, endLine: 3, outcome: "holds both ways" }),
  ]);
  assertEquals(got[0]?.verdict, {
    kind: "refused",
    message: TWO_SIDED_REFUSAL,
  });
});
