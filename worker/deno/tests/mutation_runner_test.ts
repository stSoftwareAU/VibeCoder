/**
 * Unit tests for the mutation-check runner (Issue #3393), driven entirely
 * through fake seams: an in-memory filesystem and a scripted process runner.
 *
 * The cargo-mutants fixture follows the `mutants.out/outcomes.json` format in
 * the cargo-mutants book (https://mutants.rs/): a top-level `outcomes` array
 * whose entries carry `scenario` (`"Baseline"` or `{ "Mutant": {...} }`) and
 * `summary`, plus `total_mutants`. No local `cargo mutants` was available to
 * regenerate it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectMutationLanguage,
  type MutationRunnerSeams,
  type ProcessResult,
  runMutationCheck,
} from "../lib/mutation_runner.ts";

const REPO = "/repo";
const MODULE = "lib/m.ts";
const SOURCE =
  "export function f(a: boolean) {\n  if (a) {\n    return 1;\n  }\n  return 2;\n}\n";
const TEST_SRC =
  'import { f } from "../lib/m.ts";\nDeno.test("t", () => f(true));\n';
const DIFF =
  `diff --git a/${MODULE} b/${MODULE}\n--- a/${MODULE}\n+++ b/${MODULE}\n` +
  "@@ -0,0 +1,6 @@\n" +
  SOURCE.split("\n").slice(0, 6).map((l) => "+" + l).join("\n") + "\n";

interface Fake {
  seams: MutationRunnerSeams;
  files: Map<string, string>;
  calls: Array<{ cmd: string; args: string[]; timeoutMs: number }>;
  clock: { t: number };
}

function fake(
  files: Record<string, string>,
  run: (
    cmd: string,
    args: string[],
    files: Map<string, string>,
  ) => ProcessResult | Promise<ProcessResult>,
  tick = 0,
): Fake {
  const fs = new Map(Object.entries(files));
  const calls: Fake["calls"] = [];
  const clock = { t: 0 };
  const seams: MutationRunnerSeams = {
    runProcess: async (cmd, args, opts) => {
      calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
      const r = await run(cmd, args, fs);
      clock.t += tick;
      return r;
    },
    now: () => clock.t,
    readTextFile: (p) => {
      const v = fs.get(p);
      return v === undefined
        ? Promise.reject(new Error(`ENOENT ${p}`))
        : Promise.resolve(v);
    },
    writeTextFile: (p, d) => {
      fs.set(p, d);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(fs.has(p)),
    listTestFiles: () =>
      Promise.resolve(
        [...fs.keys()].filter((k) => k.endsWith("_test.ts")).map((k) =>
          k.slice(REPO.length + 1)
        ),
      ),
  };
  return { seams, files: fs, calls, clock };
}

const ok = (code = 0): ProcessResult => ({
  code,
  stdout: "",
  stderr: "",
  timedOut: false,
});

function denoFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`${REPO}/deno.json`]: "{}",
    [`${REPO}/${MODULE}`]: SOURCE,
    [`${REPO}/tests/m_test.ts`]: TEST_SRC,
    ...extra,
  };
}

/** Tests pass on the original source; `mutatedExit` is returned for any mutation. */
function scripted(mutatedExit: number) {
  return (_c: string, _a: string[], fs: Map<string, string>) =>
    ok(fs.get(`${REPO}/${MODULE}`) === SOURCE ? 0 : mutatedExit);
}

const input = (budgetSeconds = 300, mutantCap = 40) => ({
  repoPath: REPO,
  diff: DIFF,
  budgetSeconds,
  mutantCap,
});

// ---------------------------------------------------------------------------
// detectMutationLanguage
// ---------------------------------------------------------------------------

Deno.test("detectMutationLanguage - deno markers win over Cargo.toml", async () => {
  const f = fake(
    { [`${REPO}/Cargo.toml`]: "", [`${REPO}/deno.lock`]: "" },
    () => ok(),
  );
  assertEquals(await detectMutationLanguage(REPO, f.seams), "deno");
});

Deno.test("detectMutationLanguage - Cargo.toml alone is rust, nothing is null", async () => {
  assertEquals(
    await detectMutationLanguage(
      REPO,
      fake({ [`${REPO}/Cargo.toml`]: "" }, () => ok()).seams,
    ),
    "rust",
  );
  assertEquals(
    await detectMutationLanguage(REPO, fake({}, () => ok()).seams),
    null,
  );
});

// ---------------------------------------------------------------------------
// runMutationCheck - not applicable
// ---------------------------------------------------------------------------

Deno.test("runMutationCheck - empty diff and unknown project are not applicable", async () => {
  const f = fake(denoFiles(), () => ok());
  assertEquals(
    (await runMutationCheck({ ...input(), diff: "  \n" }, f.seams)).kind,
    "not_applicable",
  );
  const g = fake({}, () => ok());
  assertEquals(
    (await runMutationCheck(input(), g.seams)).kind,
    "not_applicable",
  );
});

Deno.test("runMutationCheck - a diff touching only a test file is not applicable", async () => {
  const diff =
    "--- a/tests/m_test.ts\n+++ b/tests/m_test.ts\n@@ -0,0 +1 @@\n+return true;\n";
  const f = fake(denoFiles(), () => ok());
  assertEquals(
    (await runMutationCheck({ ...input(), diff }, f.seams)).kind,
    "not_applicable",
  );
});

// ---------------------------------------------------------------------------
// runMutationCheck - Deno
// ---------------------------------------------------------------------------

Deno.test("runMutationCheck deno - mutants that leave tests green survive", async () => {
  const f = fake(denoFiles(), scripted(0));
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "completed");
  assert(r.survivors.length > 0);
  assertEquals(r.killed, 0);
  assertEquals(r.total, r.survivors.length);
  assertEquals(r.survivors[0]?.file, MODULE);
});

Deno.test("runMutationCheck deno - mutants that turn tests red are killed", async () => {
  const f = fake(denoFiles(), scripted(1));
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "completed");
  assertEquals(r.survivors, []);
  assertEquals(r.killed, r.total);
  assert(r.total > 0);
  // First call is the baseline, then one per mutant; all pass the importing test only.
  assertEquals(f.calls.length, r.total + 1);
  assertEquals(f.calls[0]?.args, ["test", "-A", "tests/m_test.ts"]);
});

Deno.test("runMutationCheck deno - budget exhaustion is reported, not passed", async () => {
  const f = fake(denoFiles(), scripted(1), 40_000);
  const r = await runMutationCheck(input(100), f.seams);
  assert(r.kind === "budget_exhausted");
  assert(r.tested < r.total);
  assertEquals(r.budgetSeconds, 100);
  assertEquals(f.files.get(`${REPO}/${MODULE}`), SOURCE);
});

Deno.test("runMutationCheck deno - a timed-out mutant run counts as budget exhausted", async () => {
  const f = fake(
    denoFiles(),
    (_c, _a, fs) =>
      fs.get(`${REPO}/${MODULE}`) === SOURCE
        ? ok()
        : { ...ok(1), timedOut: true },
  );
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "budget_exhausted");
  assertEquals(r.tested, 0);
  assertEquals(f.files.get(`${REPO}/${MODULE}`), SOURCE);
});

Deno.test("runMutationCheck deno - failing baseline is an error and nothing is mutated", async () => {
  const f = fake(denoFiles(), () => ok(1));
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "error");
  assertStringIncludes(r.reason, "baseline tests fail");
  assertEquals(f.calls.length, 1);
});

Deno.test("runMutationCheck deno - original file is restored after the run", async () => {
  const f = fake(denoFiles(), scripted(0));
  await runMutationCheck(input(), f.seams);
  assertEquals(f.files.get(`${REPO}/${MODULE}`), SOURCE);
});

Deno.test("runMutationCheck deno - original file is restored when runProcess throws", async () => {
  let n = 0;
  const f = fake(denoFiles(), (_c, _a, fs) => {
    if (++n === 1) return ok(); // baseline
    assert(
      fs.get(`${REPO}/${MODULE}`) !== SOURCE,
      "file should be mutated during the run",
    );
    throw new Error("spawn exploded");
  });
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "error");
  assertStringIncludes(r.reason, "spawn exploded");
  assertEquals(f.files.get(`${REPO}/${MODULE}`), SOURCE);
});

Deno.test("runMutationCheck deno - a module no test imports has every mutant surviving", async () => {
  const files = denoFiles();
  files[`${REPO}/tests/m_test.ts`] = 'import { g } from "../lib/other.ts";\n';
  const f = fake(files, () => ok());
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "completed");
  assert(r.survivors.length > 0);
  assert(
    r.survivors.every((s) =>
      s.description.endsWith("(no test imports this module)")
    ),
  );
  assertEquals(f.calls.length, 0);
});

Deno.test("runMutationCheck deno - importing tests are matched through ./ and ../ specifiers", async () => {
  const files = denoFiles();
  delete files[`${REPO}/tests/m_test.ts`];
  files[`${REPO}/lib/m_test.ts`] = 'import { f } from "./m.ts";\n';
  files[`${REPO}/tests/deep/x_test.ts`] =
    'import { f } from "../../lib/m.ts";\n';
  const f = fake(files, scripted(1));
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "completed");
  assertEquals(f.calls[0]?.args.slice(2).sort(), [
    "lib/m_test.ts",
    "tests/deep/x_test.ts",
  ]);
});

Deno.test("runMutationCheck deno - the mutant cap is global", async () => {
  const f = fake(denoFiles(), scripted(1));
  const r = await runMutationCheck(input(300, 2), f.seams);
  assert(r.kind === "completed");
  assertEquals(r.total, 2);
});

// ---------------------------------------------------------------------------
// runMutationCheck - Rust
// ---------------------------------------------------------------------------

const RS_DIFF =
  "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -0,0 +1,3 @@\n+pub fn f() -> i32 {\n+    1\n+}\n";

function mutantOutcome(summary: string, line: number) {
  return {
    scenario: {
      Mutant: {
        package: "demo",
        file: "src/lib.rs",
        function: {
          function_name: "f",
          return_type: "-> i32",
          span: { start: { line: 1, column: 1 }, end: { line: 3, column: 2 } },
        },
        span: { start: { line, column: 5 }, end: { line, column: 6 } },
        replacement: "0",
        genre: "FnValue",
      },
    },
    summary,
    phase_results: [],
  };
}

function outcomesJson(summaries: Array<[string, number]>): string {
  return JSON.stringify({
    outcomes: [
      { scenario: "Baseline", summary: "Success", phase_results: [] },
      ...summaries.map(([s, l]) => mutantOutcome(s, l)),
    ],
    total_mutants: summaries.length,
    missed: summaries.filter(([s]) => s === "MissedMutant").length,
    caught: summaries.filter(([s]) => s === "CaughtMutant").length,
  });
}

function rustFake(outcomes: string | null, proc: ProcessResult) {
  const files: Record<string, string> = { [`${REPO}/Cargo.toml`]: "" };
  if (outcomes !== null) files[`${REPO}/mutants.out/outcomes.json`] = outcomes;
  return fake(files, () => proc);
}

const rsInput = { repoPath: REPO, diff: RS_DIFF, budgetSeconds: 60, jobs: 2 };

Deno.test("runMutationCheck rust - a missed mutant is a survivor", async () => {
  const f = rustFake(
    outcomesJson([["MissedMutant", 2], ["CaughtMutant", 2], ["Unviable", 2]]),
    ok(2),
  );
  const r = await runMutationCheck(rsInput, f.seams);
  assert(r.kind === "completed");
  assertEquals(r.language, "rust");
  assertEquals(r.survivors.length, 1);
  assertEquals(r.survivors[0]?.file, "src/lib.rs");
  assertEquals(r.survivors[0]?.line, 2);
  assertStringIncludes(r.survivors[0]?.description ?? "", "FnValue");
  assertEquals(r.killed, 1);
  assertEquals(r.total, 3);
  assertEquals(f.calls[0]?.args, [
    "mutants",
    "--in-diff",
    `${REPO}/target/vibe-mutation-check.diff`,
    "--no-shuffle",
    "--jobs",
    "2",
  ]);
  assertEquals(f.files.get(`${REPO}/target/vibe-mutation-check.diff`), RS_DIFF);
});

Deno.test("runMutationCheck rust - caught and timed-out mutants are killed", async () => {
  const f = rustFake(
    outcomesJson([["CaughtMutant", 2], ["Timeout", 3]]),
    ok(3),
  );
  const r = await runMutationCheck(rsInput, f.seams);
  assert(r.kind === "completed");
  assertEquals(r.survivors, []);
  assertEquals(r.killed, 2);
});

Deno.test("runMutationCheck rust - missing cargo-mutants is an error", async () => {
  for (
    const proc of [{
      code: 127,
      stdout: "",
      stderr: "command not found: cargo",
      timedOut: false,
    }, {
      code: 101,
      stdout: "",
      stderr: "error: no such command: `mutants`",
      timedOut: false,
    }]
  ) {
    const r = await runMutationCheck(rsInput, rustFake(null, proc).seams);
    assert(r.kind === "error");
    assertStringIncludes(r.reason, "cargo-mutants is not installed");
  }
});

Deno.test("runMutationCheck rust - baseline failure and usage errors are errors", async () => {
  for (const code of [1, 4]) {
    const r = await runMutationCheck(
      rsInput,
      rustFake(outcomesJson([]), ok(code)).seams,
    );
    assert(r.kind === "error", `exit ${code}`);
  }
});

Deno.test("runMutationCheck rust - a timed-out run is budget exhausted with partial outcomes", async () => {
  const proc = { code: 137, stdout: "", stderr: "", timedOut: true };
  const partial = JSON.stringify({
    outcomes: [
      mutantOutcome("MissedMutant", 2),
      mutantOutcome("CaughtMutant", 2),
    ],
    total_mutants: 9,
  });
  const r = await runMutationCheck(rsInput, rustFake(partial, proc).seams);
  assert(r.kind === "budget_exhausted");
  assertEquals([
    r.survivors.length,
    r.killed,
    r.tested,
    r.total,
    r.budgetSeconds,
  ], [1, 1, 2, 9, 60]);
  const none = await runMutationCheck(rsInput, rustFake(null, proc).seams);
  assert(none.kind === "budget_exhausted");
  assertEquals(none.tested, 0);
});

Deno.test("runMutationCheck rust - unparseable outcomes.json fails closed", async () => {
  for (const garbage of ["not json {", "{}", '{"outcomes": [42]}']) {
    const r = await runMutationCheck(rsInput, rustFake(garbage, ok(0)).seams);
    assert(r.kind === "error", garbage);
  }
});

Deno.test("runMutationCheck rust - a diff with no Rust lines is not applicable", async () => {
  const f = rustFake(null, ok());
  const r = await runMutationCheck({
    ...rsInput,
    diff: "--- a/README.md\n+++ b/README.md\n@@ -0,0 +1 @@\n+hi\n",
  }, f.seams);
  assertEquals(r.kind, "not_applicable");
});

Deno.test("runMutationCheck - never throws, even when a seam rejects", async () => {
  const f = fake(denoFiles(), () => ok());
  f.seams.exists = () => Promise.reject(new Error("disk gone"));
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "error");
  assertStringIncludes(r.reason, "disk gone");
});
