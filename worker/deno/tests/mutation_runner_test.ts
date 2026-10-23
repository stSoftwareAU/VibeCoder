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

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { assertLinearGrowth } from "./support/growth.ts";
import {
  confinePath,
  defaultMutationRunnerSeams,
  detectMutationLanguage,
  importsModule,
  mergeMutationResults,
  type MutationRunnerSeams,
  type ProcessResult,
  runMutationCheck,
} from "../lib/mutation_runner.ts";
import {
  evaluateMutationGate,
  type MutationCheckResult,
} from "../lib/mutation_gate.ts";
import { ALLOWED_ENV_NAMES } from "../lib/untrusted_command_env.ts";

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
  calls: Array<{
    cmd: string;
    args: string[];
    timeoutMs: number;
    cwd: string;
    env?: Record<string, string>;
  }>;
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
  let tempDirs = 0;
  const seams: MutationRunnerSeams = {
    runProcess: async (cmd, args, opts) => {
      calls.push({
        cmd,
        args,
        timeoutMs: opts.timeoutMs,
        cwd: opts.cwd,
        ...(opts.env === undefined ? {} : { env: opts.env }),
      });
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
    realPath: (p) => Promise.resolve(p),
    removeDir: (p) => {
      for (const k of [...fs.keys()]) {
        if (k.startsWith(`${p}/`)) fs.delete(k);
      }
      return Promise.resolve();
    },
    makeTempDir: () => Promise.resolve(`/tmp/vibe-mutation-${++tempDirs}`),
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
  assertEquals(f.calls[0]?.args, [
    "test",
    "--no-check",
    "-A",
    "tests/m_test.ts",
  ]);
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

// Captured from `deno test --no-check -A` 2.9.6 spawned with a piped stderr and
// a cleared environment, as the runner does: the `error` prefix is colour-coded.
const PARSE_ERROR_STDERR =
  "\u001b[0m\u001b[1m\u001b[31merror\u001b[0m: SyntaxError: Expression expected\n  |\n3 |     ;\n  |     ~\n    at file:///repo/lib/m.ts:3:5\n";

Deno.test("runMutationCheck deno - a mutant the parser rejects is unviable, not killed", async () => {
  const f = fake(
    denoFiles(),
    (_c, _a, fs) =>
      fs.get(`${REPO}/${MODULE}`) === SOURCE ? ok() : {
        code: 1,
        stdout: "\nok | 0 passed | 0 failed (0ms)\n",
        stderr: PARSE_ERROR_STDERR,
        timedOut: false,
      },
  );
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "completed", JSON.stringify(r));
  assertEquals(r.killed, 0);
  assertEquals(r.survivors, []);
  assert(r.total > 0);
});

Deno.test("runMutationCheck deno - a SyntaxError thrown inside a test still kills the mutant", async () => {
  // The same `error: SyntaxError:` text, but on stdout under a failed test
  // (stderr is `error: Test failed`): the tests ran and one went red.
  const f = fake(
    denoFiles(),
    (_c, _a, fs) =>
      fs.get(`${REPO}/${MODULE}`) === SOURCE ? ok() : {
        code: 1,
        stdout:
          "running 1 test from ./tests/m_test.ts\nt ... FAILED (1ms)\n\n ERRORS \n\nt => ./tests/m_test.ts:2:1\nerror: SyntaxError: Unexpected token\n",
        stderr: "error: Test failed\n",
        timedOut: false,
      },
  );
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "completed", JSON.stringify(r));
  assertEquals(r.killed, r.total);
  assert(r.total > 0);
});

Deno.test("runMutationCheck deno - the declared credentials reach every deno child", async () => {
  const f = fake(denoFiles(), scripted(1));
  const r = await runMutationCheck(
    { ...input(), credentialEnv: { AWS_ACCESS_KEY_ID: "declared" } },
    f.seams,
  );
  assert(r.kind === "completed");
  assert(f.calls.length > 1);
  for (const c of f.calls) {
    assertEquals(c.env, { AWS_ACCESS_KEY_ID: "declared" });
  }
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
  assertEquals(f.calls[0]?.args.slice(3).sort(), [
    "lib/m_test.ts",
    "tests/deep/x_test.ts",
  ]);
});

Deno.test("runMutationCheck deno - the mutant cap is global and a capped run is not a pass", async () => {
  const f = fake(denoFiles(), scripted(1));
  const r = await runMutationCheck(input(300, 2), f.seams);
  assert(r.kind === "budget_exhausted", JSON.stringify(r));
  assertEquals(r.limit, "mutant_cap");
  assertEquals(r.tested, 2);
  assert(r.total > 2, "total counts the candidates the cap dropped");
  assertEquals(r.killed, 2);
});

Deno.test("runMutationCheck deno - a line over the length limit is reported as untested, not passed", async () => {
  const long = `  const s = ${"a".repeat(450)}; if (a) { return 1; }`;
  const source =
    `export function f(a: boolean) {\n${long}\n  if (a) {\n    return 1;\n  }\n}\n`;
  const files = denoFiles({ [`${REPO}/${MODULE}`]: source });
  const diff =
    `--- a/${MODULE}\n+++ b/${MODULE}\n@@ -0,0 +1,3 @@\n+${long}\n+  if (a) {\n+    return 1;\n`;
  const f = fake(
    files,
    (_c, _a, fs) => ok(fs.get(`${REPO}/${MODULE}`) === source ? 0 : 1),
  );
  const r = await runMutationCheck({ ...input(), diff }, f.seams);
  assert(r.kind === "budget_exhausted", JSON.stringify(r));
  assertEquals(r.limit, "mutant_cap");
  assert(r.total > r.tested);
});

Deno.test("runMutationCheck deno - mutants run without the type-checker, so a type-invalid mutant is not killed by it", async () => {
  // Like `deno test`: a mutated file fails type-checking (exit 1) unless
  // --no-check is passed; the tests themselves are green either way.
  const f = fake(
    denoFiles(),
    (_c, args, fs) =>
      ok(
        fs.get(`${REPO}/${MODULE}`) !== SOURCE && !args.includes("--no-check")
          ? 1
          : 0,
      ),
  );
  const r = await runMutationCheck(input(), f.seams);
  assert(r.kind === "completed");
  assert(r.survivors.length > 0, "a type error must not read as a kill");
  assertEquals(r.killed, 0);
  assert(f.calls.every((c) => c.args.includes("--no-check")));
});

Deno.test("runMutationCheck deno - a nested deno.json project runs its tests from its own directory", async () => {
  const mod = "worker/deno/lib/m.ts";
  const files: Record<string, string> = {
    [`${REPO}/worker/deno/deno.json`]: "{}",
    [`${REPO}/${mod}`]: SOURCE,
    [`${REPO}/worker/deno/tests/m_test.ts`]: TEST_SRC,
    // A same-named test outside the project must not be run from inside it.
    [`${REPO}/other/tests/m_test.ts`]:
      'import { f } from "../../worker/deno/lib/m.ts";\n',
  };
  const diff = DIFF.replaceAll(MODULE, mod);
  const f = fake(
    files,
    (_c, _a, fs) => ok(fs.get(`${REPO}/${mod}`) === SOURCE ? 0 : 1),
  );
  const r = await runMutationCheck({ ...input(), diff }, f.seams);
  assert(r.kind === "completed", JSON.stringify(r));
  assert(r.killed > 0);
  assertEquals(await detectMutationLanguage(REPO, f.seams, [mod]), "deno");
  assertEquals(await detectMutationLanguage(REPO, f.seams, []), null);
  const seen = new Set(
    f.calls.map((c) => JSON.stringify([c.cwd, c.args.slice(3)])),
  );
  assertEquals([...seen], [
    JSON.stringify([`${REPO}/worker/deno`, ["tests/m_test.ts"]]),
  ]);
});

Deno.test("runMutationCheck deno - a changed file with no deno config above it is skipped, one with a config is mutated", async () => {
  const files = denoFiles();
  delete files[`${REPO}/deno.json`];
  files[`${REPO}/pkg/deno.json`] = "{}";
  files[`${REPO}/pkg/lib/m.ts`] = SOURCE;
  files[`${REPO}/pkg/tests/m_test.ts`] = TEST_SRC;
  const diff = DIFF + DIFF.replaceAll(MODULE, "pkg/lib/m.ts");
  const f = fake(files, scripted(0));
  const r = await runMutationCheck({ ...input(), diff }, f.seams);
  assert(r.kind === "completed", JSON.stringify(r));
  assert(r.survivors.length > 0);
  assert(
    r.survivors.every((s) => s.file === "pkg/lib/m.ts"),
    JSON.stringify(r.survivors),
  );
  // The unconfigured module is never rewritten.
  assertEquals(f.files.get(`${REPO}/${MODULE}`), SOURCE);
});

Deno.test("runMutationCheck deno - added lines with nothing to mutate are not applicable", async () => {
  const diff =
    `--- a/${MODULE}\n+++ b/${MODULE}\n@@ -0,0 +1 @@\n+// a comment\n`;
  const f = fake(
    denoFiles({ [`${REPO}/${MODULE}`]: "// a comment\n" }),
    () => ok(),
  );
  const r = await runMutationCheck({ ...input(), diff }, f.seams);
  assert(r.kind === "not_applicable", JSON.stringify(r));
  assertStringIncludes(r.reason, "no mutable statements");
  assertEquals(f.calls.length, 0);
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

/** Like cargo-mutants, write `mutants.out/` under the `--output` directory. */
function writeOutcomes(
  fs: Map<string, string>,
  args: string[],
  outcomes: string,
): void {
  const out = args[args.indexOf("--output") + 1];
  assert(out !== undefined && args.includes("--output"), "missing --output");
  fs.set(`${out}/mutants.out/outcomes.json`, outcomes);
}

/** `outcomes` is written by the fake cargo run itself, as the real one does. */
function rustFake(outcomes: string | null, proc: ProcessResult) {
  return fake({ [`${REPO}/Cargo.toml`]: "" }, (_c, args, fs) => {
    if (outcomes !== null) writeOutcomes(fs, args, outcomes);
    return proc;
  });
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
    "--output",
    "/tmp/vibe-mutation-1",
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
});

Deno.test("runMutationCheck rust - a timeout before any outcomes is budget exhausted, not an error", async () => {
  // cargo-mutants writes outcomes.json only after its clean build and baseline
  // test run, so a run killed before then leaves none. That is an untried run
  // (a warning), like the Deno baseline timeout, never a blocking error.
  const proc = { code: 137, stdout: "", stderr: "", timedOut: true };
  for (const outcomes of [null, "not json"]) {
    const r = await runMutationCheck(rsInput, rustFake(outcomes, proc).seams);
    assert(r.kind === "budget_exhausted", JSON.stringify(r));
    assertEquals(r.language, "rust");
    assertEquals(r.survivors, []);
    assertEquals([r.killed, r.tested, r.budgetSeconds], [0, 0, 60]);
  }
});

Deno.test("runMutationCheck rust - exit 3 (mutant timeouts) with no outcomes still fails closed", async () => {
  const proc = { code: 3, stdout: "", stderr: "", timedOut: false };
  for (const outcomes of [null, "not json"]) {
    const r = await runMutationCheck(rsInput, rustFake(outcomes, proc).seams);
    assert(r.kind === "error", JSON.stringify(r));
    assertStringIncludes(r.reason, "no parseable");
  }
});

Deno.test("runMutationCheck rust - the declared credentials reach cargo", async () => {
  const f = rustFake(outcomesJson([]), ok(0));
  await runMutationCheck(
    { ...rsInput, credentialEnv: { AWS_ACCESS_KEY_ID: "declared" } },
    f.seams,
  );
  const out = outputDirOf(f.calls[0]?.args ?? []);
  assertEquals(f.calls[0]?.env, { AWS_ACCESS_KEY_ID: "declared", TMPDIR: out });
  const none = rustFake(outcomesJson([]), ok(0));
  await runMutationCheck(rsInput, none.seams);
  assertEquals(none.calls[0]?.env, {
    TMPDIR: outputDirOf(none.calls[0]?.args ?? []),
  });
});

function outputDirOf(args: string[]): string {
  return args[args.indexOf("--output") + 1] ?? "";
}

Deno.test("runMutationCheck rust - cargo-mutants' scratch copy lives under the removed output directory", async () => {
  // A killed run can leave its `cargo-mutants-*.tmp` behind; with TMPDIR inside
  // --output, removing --output removes it. A caller-declared TMPDIR cannot win.
  const f = rustFake(outcomesJson([]), ok(0));
  await runMutationCheck(
    { ...rsInput, credentialEnv: { TMPDIR: "/elsewhere" } },
    f.seams,
  );
  const out = outputDirOf(f.calls[0]?.args ?? []);
  assert(out !== "");
  assertEquals(f.calls[0]?.env?.TMPDIR, out);
});

Deno.test("runMutationCheck rust - no mutants on the changed lines (logged on stderr, exit 0) is not applicable", async () => {
  // cargo-mutants 27.1.0 logs "No mutants to filter" via tracing to stderr and
  // exits 0 before creating any output directory.
  for (
    const proc of [
      { ...ok(0), stderr: " INFO No mutants to filter\n" },
      { ...ok(0), stdout: "No mutants to filter\n" },
    ]
  ) {
    const r = await runMutationCheck(rsInput, rustFake(null, proc).seams);
    assert(r.kind === "not_applicable", JSON.stringify(r));
  }
});

Deno.test("runMutationCheck rust - exit 0 with no outcomes and no no-mutants message is still an error", async () => {
  const r = await runMutationCheck(rsInput, rustFake(null, ok(0)).seams);
  assert(r.kind === "error", JSON.stringify(r));
  assertStringIncludes(r.reason, "no outcomes.json");
});

Deno.test("runMutationCheck rust - a stale outcomes.json in the repo is neither read nor deleted", async () => {
  const stale = outcomesJson([["MissedMutant", 2]]);
  const f = rustFake(null, ok(0)); // cargo writes nothing this time
  f.files.set(`${REPO}/mutants.out/outcomes.json`, stale);
  const r = await runMutationCheck(rsInput, f.seams);
  assert(r.kind === "error", JSON.stringify(r));
  assertEquals(f.files.get(`${REPO}/mutants.out/outcomes.json`), stale);
});

Deno.test("runMutationCheck rust - mutants.out lands outside the repo and is removed", async () => {
  for (const proc of [ok(2), ok(1)]) {
    const f = rustFake(outcomesJson([["MissedMutant", 2]]), proc);
    await runMutationCheck(rsInput, f.seams);
    const argv = f.calls[0]?.args ?? [];
    const out = argv[argv.indexOf("--output") + 1] ?? "";
    assert(out !== "" && !out.startsWith(`${REPO}/`), `output ${out}`);
    // Nothing of cargo-mutants' output is left in the working tree...
    assertEquals(
      [...f.files.keys()].filter((k) => k.includes("mutants.out")),
      [],
    );
    // ...and its temporary home is gone, on success and on error alike.
    assertEquals([...f.files.keys()].filter((k) => k.startsWith(out)), []);
  }
});

Deno.test("runMutationCheck rust - only packages the diff touches are passed via --package", async () => {
  const f = fake({
    [`${REPO}/Cargo.toml`]:
      '[workspace]\nmembers = ["crates/a", "crates/b", "crates/evil"]\n',
    [`${REPO}/crates/a/Cargo.toml`]:
      '[package] # a\nname = "crate-a"\nversion = "0.1.0"\n\n[dependencies]\nname = "x"\n',
    [`${REPO}/crates/b/Cargo.toml`]: '[package]\nname = "crate_b"\n',
    [`${REPO}/crates/evil/Cargo.toml`]: '[package]\nname = "x; rm -rf /"\n',
  }, (_c, args, fs) => {
    // Cargo "writes" fresh outcomes during the run.
    writeOutcomes(fs, args, outcomesJson([]));
    return ok(0);
  });
  const diff = "--- a/crates/a/src/lib.rs\n+++ b/crates/a/src/lib.rs\n" +
    "@@ -0,0 +1 @@\n+pub fn f() {}\n" +
    "--- a/crates/evil/src/lib.rs\n+++ b/crates/evil/src/lib.rs\n" +
    "@@ -0,0 +1 @@\n+pub fn g() {}\n";
  await runMutationCheck({ ...rsInput, diff }, f.seams);
  const argv = f.calls[0]?.args ?? [];
  const pkgs = argv.flatMap((a, i) => a === "--package" ? [argv[i + 1]] : []);
  assertEquals(pkgs, ["crate-a"]);
  assertEquals(argv.includes("crate_b"), false);
});

Deno.test("runMutationCheck rust - no package manifest means no --package argument", async () => {
  const f = rustFake(null, ok(0));
  await runMutationCheck(rsInput, f.seams);
  assertEquals(f.calls[0]?.args.includes("--package"), false);
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

// ---------------------------------------------------------------------------
// Path confinement (real temp dirs and real symlinks)
// ---------------------------------------------------------------------------

async function realRepo(
  run: (repo: string, outside: string) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "mut-repo-" });
  const outside = await Deno.makeTempDir({ prefix: "mut-outside-" });
  try {
    await run(repo, outside);
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
}

/** Real seams that record every write path and never run a process. */
function realSeams(writes: string[]): MutationRunnerSeams {
  const real = defaultMutationRunnerSeams();
  return {
    ...real,
    writeTextFile: (p, d) => {
      writes.push(p);
      return real.writeTextFile(p, d);
    },
    runProcess: () => Promise.resolve(ok(0)),
  };
}

const diffFor = (file: string) =>
  `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,6 @@\n` +
  SOURCE.split("\n").slice(0, 6).map((l) => "+" + l).join("\n") + "\n";

async function denoEscape(
  file: string,
  setup: (repo: string, outside: string) => Promise<void>,
): Promise<void> {
  await realRepo(async (repo, outside) => {
    await Deno.writeTextFile(`${repo}/deno.json`, "{}");
    await Deno.writeTextFile(`${outside}/file.ts`, SOURCE);
    // A test that imports the module, so a mutant would be written if allowed.
    await Deno.mkdir(`${repo}/tests`);
    await Deno.writeTextFile(
      `${repo}/tests/m_test.ts`,
      `import { f } from "../${file.replace(/^.*\.\.\//, "")}";\nf(true);\n`,
    );
    await setup(repo, outside);
    const writes: string[] = [];
    const r = await runMutationCheck({
      repoPath: repo,
      diff: diffFor(file),
      budgetSeconds: 60,
    }, realSeams(writes));
    assertEquals(r.kind, "not_applicable", JSON.stringify(r));
    assertEquals(writes, []);
    assertEquals(await Deno.readTextFile(`${outside}/file.ts`), SOURCE);
  });
}

Deno.test("confinePath - rejects a climb out of the repo, accepts one that stays in", async () => {
  await realRepo(async (repo, outside) => {
    const seams = defaultMutationRunnerSeams();
    const real = await Deno.realPath(repo);
    await Deno.symlink(outside, `${repo}/link`);
    assertEquals(await confinePath(repo, "../x.ts", seams), null);
    assertEquals(await confinePath(repo, "a/../../x.ts", seams), null);
    assertEquals(await confinePath(repo, "/etc/passwd", seams), null);
    assertEquals(await confinePath(repo, "link/x.ts", seams), null);
    assertEquals(
      await confinePath(repo, "a/../b/x.ts", seams),
      `${real}/b/x.ts`,
    );
  });
});

Deno.test("confinement - a ../ diff path is never written", async () => {
  const parent = await Deno.makeTempDir({ prefix: "mut-parent-" });
  try {
    const repo = `${parent}/repo`;
    await Deno.mkdir(repo);
    await Deno.writeTextFile(`${repo}/deno.json`, "{}");
    await Deno.writeTextFile(`${parent}/outside.ts`, "ORIGINAL");
    const writes: string[] = [];
    const r = await runMutationCheck({
      repoPath: repo,
      diff: diffFor("../outside.ts"),
      budgetSeconds: 60,
    }, realSeams(writes));
    assertEquals(r.kind, "not_applicable", JSON.stringify(r));
    assertEquals(writes, []);
    assertEquals(await Deno.readTextFile(`${parent}/outside.ts`), "ORIGINAL");
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("confinement - missing/../link/file.ts through an escaping symlink is never written", async () => {
  await denoEscape("missing/../link/file.ts", async (repo, outside) => {
    await Deno.symlink(outside, `${repo}/link`);
  });
});

Deno.test("confinement - a direct symlinked directory path is never written", async () => {
  await denoEscape("link/file.ts", async (repo, outside) => {
    await Deno.symlink(outside, `${repo}/link`);
  });
});

Deno.test("confinement - a symlinked file escaping the repo is never written", async () => {
  await denoEscape("file.ts", async (repo, outside) => {
    await Deno.symlink(`${outside}/file.ts`, `${repo}/file.ts`);
  });
});

Deno.test("confinement - a normal in-repo path is still mutated", async () => {
  await realRepo(async (repo) => {
    await Deno.writeTextFile(`${repo}/deno.json`, "{}");
    await Deno.mkdir(`${repo}/lib`);
    await Deno.mkdir(`${repo}/tests`);
    await Deno.writeTextFile(`${repo}/lib/m.ts`, SOURCE);
    await Deno.writeTextFile(`${repo}/tests/m_test.ts`, TEST_SRC);
    const writes: string[] = [];
    const real = await Deno.realPath(repo);
    const r = await runMutationCheck({
      repoPath: repo,
      diff: DIFF,
      budgetSeconds: 60,
    }, realSeams(writes));
    assertEquals(r.kind, "completed", JSON.stringify(r));
    assert(writes.length > 0);
    assert(writes.every((w) => w === `${real}/lib/m.ts`), writes.join(","));
    assertEquals(await Deno.readTextFile(`${repo}/lib/m.ts`), SOURCE);
  });
});

Deno.test("confinement rust - a target symlink to outside writes nothing there and errors", async () => {
  await realRepo(async (repo, outside) => {
    await Deno.writeTextFile(`${repo}/Cargo.toml`, "");
    await Deno.symlink(outside, `${repo}/target`);
    const writes: string[] = [];
    const r = await runMutationCheck({
      repoPath: repo,
      diff: RS_DIFF,
      budgetSeconds: 60,
      jobs: 1,
    }, realSeams(writes));
    assert(r.kind === "error", JSON.stringify(r));
    assertStringIncludes(r.reason, "outside the");
    assertEquals(writes, []);
    assertEquals([...Deno.readDirSync(outside)].length, 0);
  });
});

Deno.test("confinement rust - a normal target directory receives the diff", async () => {
  await realRepo(async (repo) => {
    await Deno.writeTextFile(`${repo}/Cargo.toml`, "");
    const writes: string[] = [];
    await runMutationCheck({
      repoPath: repo,
      diff: RS_DIFF,
      budgetSeconds: 60,
      jobs: 1,
    }, realSeams(writes));
    assertEquals(writes.length, 1);
    assertEquals(
      await Deno.readTextFile(`${repo}/target/vibe-mutation-check.diff`),
      RS_DIFF,
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile input to the specifier scan
// ---------------------------------------------------------------------------

Deno.test("importsModule - hostile unclosed-specifier text scans in linear time", () => {
  const shapes: Array<[string, (chars: number) => string]> = [
    ["repeated './", (n) => "'./".repeat(Math.ceil(n / 3))],
    ["quote then unclosed ./", (n) => '"' + "./".repeat(Math.ceil(n / 2))],
  ];
  for (const [label, build] of shapes) {
    const found = assertLinearGrowth(
      label,
      build,
      (text) => importsModule(text, "tests", "lib/m.ts"),
      { baseChars: 12_500, sizeFactor: 4 },
    );
    assertEquals(found, false);
  }
  assertEquals(
    importsModule("import '../lib/m.ts'", "tests", "lib/m.ts"),
    true,
  );
});

// ---------------------------------------------------------------------------
// Child environment (Issue #572: repository code never sees worker credentials)
// ---------------------------------------------------------------------------

Deno.test("defaultMutationRunnerSeams runProcess - the child gets the allowlisted environment, not the worker's", async () => {
  const source: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    GH_TOKEN: "ghp_mutation_runner_test_secret",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth_mutation_runner_test_secret",
    AWS_SECRET_ACCESS_KEY: "aws_mutation_runner_test_secret",
    VIBE_MUTATION_TEST_PLAIN: "plain_mutation_runner_test_value",
  };
  const r = await defaultMutationRunnerSeams(source).runProcess("env", [], {
    cwd: Deno.cwd(),
    timeoutMs: 20_000,
  });
  assertEquals(r.code, 0, r.stderr);
  const names = r.stdout.split("\n").filter((l) => l !== "").map((l) =>
    l.split("=")[0] ?? ""
  );
  for (
    const name of [
      "GH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
    ]
  ) {
    assertEquals(names.includes(name), false, `${name} reached the child`);
  }
  assertEquals(r.stdout.includes("_mutation_runner_test_secret"), false);
  assert(names.includes("PATH"));
  // Nothing outside the allowlist: not the planted variable, and not whatever
  // this test process itself inherited (clearEnv).
  const allowed = new Set(ALLOWED_ENV_NAMES);
  assertEquals(names.filter((n) => !allowed.has(n)), []);
});

Deno.test("defaultMutationRunnerSeams runProcess - a declared credential reaches the child and an undeclared one does not", async () => {
  const source: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    UNDECLARED_API_TOKEN: "undeclared_mutation_runner_test_secret",
  };
  const r = await defaultMutationRunnerSeams(source).runProcess("env", [], {
    cwd: Deno.cwd(),
    timeoutMs: 20_000,
    env: { DECLARED_API_TOKEN: "declared_mutation_runner_test_value" },
  });
  assertEquals(r.code, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert(
    lines.includes("DECLARED_API_TOKEN=declared_mutation_runner_test_value"),
  );
  assertEquals(r.stdout.includes("UNDECLARED_API_TOKEN"), false);
});

// ---------------------------------------------------------------------------
// Budget expiry: SIGTERM first, SIGKILL only after a grace period
// ---------------------------------------------------------------------------

const SH_ENV = { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };

Deno.test("defaultMutationRunnerSeams runProcess - a timeout sends SIGTERM first so the child can clean up", async () => {
  // The child traps SIGTERM and writes its marker, as cargo-mutants stops its
  // process groups and removes its scratch copy; SIGKILL would not let it.
  const r = await defaultMutationRunnerSeams(SH_ENV, 20_000).runProcess(
    "sh",
    [
      "-c",
      'trap "echo cleaned-up; exit 0" TERM; echo ready; while :; do :; done',
    ],
    { cwd: Deno.cwd(), timeoutMs: 500 },
  );
  assertEquals(r.timedOut, true);
  assertStringIncludes(r.stdout, "cleaned-up");
  assertEquals(r.code, 0);
});

Deno.test("defaultMutationRunnerSeams runProcess - a child that ignores SIGTERM is SIGKILLed after the grace period", async () => {
  const r = await defaultMutationRunnerSeams(SH_ENV, 100).runProcess(
    "sh",
    ["-c", 'trap "" TERM; echo ready; while :; do :; done'],
    { cwd: Deno.cwd(), timeoutMs: 500 },
  );
  assertEquals(r.timedOut, true);
  assertEquals(r.code, 137);
});

// ---------------------------------------------------------------------------
// Shell scripts (changed .sh files, mutated on a shared budget)
// ---------------------------------------------------------------------------

const SCRIPT = "scripts/run.sh";
const SCRIPT_PATH = `${REPO}/${SCRIPT}`;
/** One export, so its mutants sit on line 1. */
const SH = "export FOO=bar\n";
/** A shell test whose text names the script by its repo-relative path. */
const SH_TEST = `bash ${SCRIPT}\n`;

/** A unified diff that adds the lines of `body` to `file` from line 1. */
function shellDiff(file: string, body: string): string {
  const lines = body.split("\n").filter((l) => l !== "");
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => "+" + l).join("\n") + "\n";
}

const SH_DIFF = shellDiff(SCRIPT, "export FOO=bar");

/** A fake that also lists shell and bats test files, as the real seams do. */
function shellFake(
  files: Record<string, string>,
  run: Parameters<typeof fake>[1],
  tick = 0,
): Fake {
  const f = fake(files, run, tick);
  f.seams.listShellTestFiles = () =>
    Promise.resolve(
      [...f.files.keys()]
        .filter((k) => k.startsWith(`${REPO}/tests/`) && /\.(sh|bats)$/.test(k))
        .map((k) => k.slice(REPO.length + 1)),
    );
  return f;
}

/** A shell-only repository: a script and a shell test that names it. */
const shellFiles = (extra: Record<string, string> = {}) => ({
  [SCRIPT_PATH]: SH,
  [`${REPO}/tests/run_test.sh`]: SH_TEST,
  ...extra,
});

const shellInput = (diff: string) => ({ ...input(), diff });

/**
 * Fails only while the script is mutated, so every mutant is killed. The
 * `bash -n` parse check passes: these fixture mutants all parse.
 */
const killedWhenMutated = (
  _c: string,
  args: string[],
  fs: Map<string, string>,
) => args[0] === "-n" ? ok(0) : ok(fs.get(SCRIPT_PATH) === SH ? 0 : 1);

/** Asserts the result kind and narrows to it. */
function asKind<K extends MutationCheckResult["kind"]>(
  r: MutationCheckResult,
  kind: K,
): Extract<MutationCheckResult, { kind: K }> {
  assertEquals(r.kind, kind, JSON.stringify(r));
  return r as Extract<MutationCheckResult, { kind: K }>;
}

Deno.test("runMutationCheck shell - a changed .sh in a Deno repo gets shell mutants and takes its language from the primary", async () => {
  const f = shellFake(
    denoFiles({ [SCRIPT_PATH]: SH, [`${REPO}/tests/run_test.sh`]: SH_TEST }),
    () => ok(0),
  );
  const r = await runMutationCheck(
    { ...input(), diff: DIFF + SH_DIFF },
    f.seams,
  );
  const c = asKind(r, "completed");
  assertEquals(c.language, "deno");
  assert(
    c.survivors.some((s) => s.file === SCRIPT),
    JSON.stringify(c.survivors),
  );
  assert(f.calls.some((call) => call.cmd === "bash"), "shell test not run");
});

Deno.test("runMutationCheck shell - the shell pass draws on the same budget clock as the Deno pass", async () => {
  const f = shellFake(
    denoFiles({ [SCRIPT_PATH]: SH, [`${REPO}/tests/run_test.sh`]: SH_TEST }),
    () => ok(0),
    1000,
  );
  const r = await runMutationCheck(
    { ...input(), diff: DIFF + SH_DIFF },
    f.seams,
  );
  assertEquals(r.kind, "completed", JSON.stringify(r));
  assert(f.calls.some((call) => call.cmd === "bash"), "shell test not run");
  // Each call starts where the previous one left the shared clock, so the
  // timeouts fall strictly from one call to the next across both passes.
  for (let i = 1; i < f.calls.length; i++) {
    assert(
      f.calls[i]!.timeoutMs < f.calls[i - 1]!.timeoutMs,
      `call ${i} timeout ${f.calls[i]!.timeoutMs} not below ${
        f.calls[i - 1]!.timeoutMs
      }`,
    );
  }
});

/** A case clause: pattern lines, bodies and `;;` terminators. */
const SH_CASE =
  "case $1 in\n  a|b)\n    export FOO=bar\n    ;;\n  *)\n    export BAZ=qux\n    ;;\nesac\n";

Deno.test("runMutationCheck shell - a mutant bash -n rejects is unviable, not killed, and parseable siblings are still killed", async () => {
  // The case-pattern deletion is no longer generated (see mutation_gate_test),
  // so the mutant that bash -n rejects here is the line 3 deletion, standing in
  // for a case-branch mutant. Its stderr is the bash syntax error shape.
  const f = shellFake(
    shellFiles({ [SCRIPT_PATH]: SH_CASE }),
    (_c, args, fs) => {
      const text = fs.get(SCRIPT_PATH) ?? "";
      if (args[0] === "-n") {
        return text.split("\n")[2] === "    :"
          ? {
            code: 2,
            stdout: "",
            stderr:
              `${SCRIPT_PATH}: line 3: syntax error near unexpected token \`;;'\n`,
            timedOut: false,
          }
          : ok(0);
      }
      return ok(text === SH_CASE ? 0 : 1);
    },
  );
  const r = await runMutationCheck(
    shellInput(shellDiff(SCRIPT, SH_CASE)),
    f.seams,
  );
  const c = asKind(r, "completed");
  assertEquals(c.survivors, []);
  // Four mutants: a deletion and a guard on each export line. The rejected
  // deletion is unviable, so three are killed.
  assertEquals(c.total, 4);
  assertEquals(c.killed, 3);
  const bashN = f.calls.filter((call) =>
    call.cmd === "bash" && call.args[0] === "-n"
  );
  const testRuns = f.calls.filter((call) =>
    call.cmd === "bash" && call.args[0] !== "-n"
  );
  assertEquals(bashN.length, 4);
  // One baseline run, then one test run per parseable mutant; the rejected
  // mutant runs no tests.
  assertEquals(testRuns.length, 4);
});

Deno.test("runMutationCheck shell - a surviving export deletion mutant blocks the gate until a matching exempt entry is added", async () => {
  const f = shellFake(shellFiles(), () => ok(0));
  const r = await runMutationCheck(shellInput(SH_DIFF), f.seams);
  asKind(r, "completed");
  const blocked = evaluateMutationGate(r, "");
  assertEquals(blocked.blocked, true);
  assert(
    blocked.survivors.some((s) =>
      s.file === SCRIPT && s.line === 1 && s.description === "deleted statement"
    ),
    JSON.stringify(blocked.survivors),
  );
  const summary =
    "`scripts/run.sh:1` exempt (untestable): only exports a variable";
  const unblocked = evaluateMutationGate(r, summary);
  assertEquals(unblocked.blocked, false, unblocked.reason);
  assert(
    unblocked.exempted.some((s) =>
      s.file === SCRIPT && s.line === 1 && s.description === "deleted statement"
    ),
    JSON.stringify(unblocked.exempted),
  );
});

Deno.test("runMutationCheck shell - a test that runs the script with bash kills its mutants", async () => {
  const f = shellFake(shellFiles(), killedWhenMutated);
  const c = asKind(
    await runMutationCheck(shellInput(SH_DIFF), f.seams),
    "completed",
  );
  assertEquals(c.survivors, []);
  assert(c.killed > 0, JSON.stringify(c));
  assert(
    f.calls.some((call) =>
      call.cmd === "bash" && call.args[0] === "tests/run_test.sh"
    ),
    "bash did not run the named test",
  );
});

Deno.test("runMutationCheck shell - a Deno test naming the script by basename kills its mutants", async () => {
  const f = shellFake(
    {
      [SCRIPT_PATH]: SH,
      [`${REPO}/tests/n_test.ts`]: 'Deno.test("n", () => run("run.sh"));\n',
    },
    killedWhenMutated,
  );
  const c = asKind(
    await runMutationCheck(shellInput(SH_DIFF), f.seams),
    "completed",
  );
  assertEquals(c.survivors, []);
  assert(c.killed > 0, JSON.stringify(c));
  assert(
    f.calls.some((call) =>
      call.cmd === "deno" && call.args.includes("tests/n_test.ts")
    ),
    "deno did not run the named test",
  );
});

Deno.test("runMutationCheck shell - a bats test that names the script kills its mutants", async () => {
  const f = shellFake(
    { [SCRIPT_PATH]: SH, [`${REPO}/tests/run.bats`]: SH_TEST },
    killedWhenMutated,
  );
  const c = asKind(
    await runMutationCheck(shellInput(SH_DIFF), f.seams),
    "completed",
  );
  assertEquals(c.survivors, []);
  assert(c.killed > 0, JSON.stringify(c));
  assert(
    f.calls.some((call) =>
      call.cmd === "bats" && call.args[0] === "tests/run.bats"
    ),
    "bats did not run the named test",
  );
});

Deno.test("runMutationCheck shell - a script no test runs is not_checked, its mutants never run, and the gate blocks", async () => {
  const f = shellFake(
    { [SCRIPT_PATH]: SH, [`${REPO}/tests/other_test.sh`]: "echo hi\n" },
    () => ok(0),
  );
  const r = await runMutationCheck(shellInput(SH_DIFF), f.seams);
  const nc = asKind(r, "not_checked");
  assertStringIncludes(nc.reason, `no test runs ${SCRIPT} (searched for`);
  assertEquals(f.calls.length, 0, "no process may run for an uncovered script");
  assertEquals(f.files.get(SCRIPT_PATH), SH);
  const verdict = evaluateMutationGate(r, "");
  assertEquals(verdict.blocked, true);
  assertStringIncludes(verdict.reason, "not checked");
});

Deno.test("runMutationCheck shell - a covered script's survivors are named when another script is not_checked", async () => {
  const other = "scripts/other.sh";
  const f = shellFake(
    shellFiles({ [`${REPO}/${other}`]: "export BAR=baz\n" }),
    () => ok(0),
  );
  const r = await runMutationCheck(
    shellInput(SH_DIFF + shellDiff(other, "export BAR=baz")),
    f.seams,
  );
  const nc = asKind(r, "not_checked");
  assertStringIncludes(nc.reason, `no test runs ${other}`);
  assertStringIncludes(nc.reason, `also `);
  assertStringIncludes(nc.reason, `${SCRIPT}:1 deleted statement`);
  assert(
    f.calls.some((call) => call.cmd === "bash"),
    "the covered script's mutants did not run",
  );
  const verdict = evaluateMutationGate(r, "");
  assertEquals(verdict.blocked, true);
  assertStringIncludes(verdict.reason, "not checked");
});

Deno.test("runMutationCheck shell - a baseline failure is an error and the script is left unchanged", async () => {
  const f = shellFake(shellFiles(), () => ok(1));
  const e = asKind(
    await runMutationCheck(shellInput(SH_DIFF), f.seams),
    "error",
  );
  assertStringIncludes(e.reason, "baseline tests fail before mutation");
  assertEquals(f.files.get(SCRIPT_PATH), SH);
});

Deno.test("runMutationCheck shell - a baseline timeout is budget_exhausted with nothing tested", async () => {
  const f = shellFake(shellFiles(), () => ({
    code: 1,
    stdout: "",
    stderr: "",
    timedOut: true,
  }));
  const b = asKind(
    await runMutationCheck(shellInput(SH_DIFF), f.seams),
    "budget_exhausted",
  );
  assertEquals(b.tested, 0);
  assertEquals(f.files.get(SCRIPT_PATH), SH);
});

Deno.test("runMutationCheck shell - a comment-only change is not_applicable and runs nothing", async () => {
  const f = shellFake(
    shellFiles({ [SCRIPT_PATH]: "# just a note\n" }),
    () => ok(0),
  );
  const n = asKind(
    await runMutationCheck(
      shellInput(shellDiff(SCRIPT, "# just a note")),
      f.seams,
    ),
    "not_applicable",
  );
  assertStringIncludes(n.reason, "no mutable statements");
  assertEquals(f.calls.length, 0);
});

Deno.test("runMutationCheck shell - Deno sources and Rust files are never treated as shell scripts", async () => {
  const body = "#!/bin/sh\nexport X=1\n";
  const f = shellFake(
    {
      [`${REPO}/tools/gen.sh.ts`]: body,
      [`${REPO}/src/x.rs`]: body,
    },
    () => ok(0),
  );
  const diff = shellDiff("tools/gen.sh.ts", "#!/bin/sh\nexport X=1") +
    shellDiff("src/x.rs", "#!/bin/sh\nexport X=1");
  const n = asKind(
    await runMutationCheck(shellInput(diff), f.seams),
    "not_applicable",
  );
  assert(!n.reason.includes("shell"), n.reason);
  assertEquals(f.calls.length, 0);
});

Deno.test("runMutationCheck shell - a script reached through a symlink out of the repo is refused", async () => {
  await realRepo(async (repo, outside) => {
    await Deno.writeTextFile(`${outside}/run.sh`, SH);
    await Deno.symlink(outside, `${repo}/link`);
    await Deno.mkdir(`${repo}/tests`);
    await Deno.writeTextFile(`${repo}/tests/run_test.sh`, "bash link/run.sh\n");
    const writes: string[] = [];
    const r = await runMutationCheck({
      repoPath: repo,
      diff: shellDiff("link/run.sh", "export FOO=bar"),
      budgetSeconds: 60,
    }, realSeams(writes));
    asKind(r, "not_applicable");
    assertEquals(writes, []);
    assertEquals(await Deno.readTextFile(`${outside}/run.sh`), SH);
  });
});

Deno.test("runMutationCheck shell - the original script is restored when runProcess throws", async () => {
  const f = shellFake(shellFiles(), (_c, _a, fs) => {
    if (fs.get(SCRIPT_PATH) !== SH) throw new Error("runner blew up");
    return ok(0);
  });
  const e = asKind(
    await runMutationCheck(shellInput(SH_DIFF), f.seams),
    "error",
  );
  assertEquals(e.reason, "runner blew up");
  assertEquals(f.files.get(SCRIPT_PATH), SH);
});

Deno.test("runMutationCheck shell - the original script is restored when a mutant times out", async () => {
  const f = shellFake(
    shellFiles(),
    (_c, _a, fs) =>
      fs.get(SCRIPT_PATH) === SH ? ok(0) : {
        code: 1,
        stdout: "",
        stderr: "",
        timedOut: true,
      },
  );
  asKind(
    await runMutationCheck(shellInput(SH_DIFF), f.seams),
    "budget_exhausted",
  );
  assertEquals(f.files.get(SCRIPT_PATH), SH);
});

// ---------------------------------------------------------------------------
// mergeMutationResults
// ---------------------------------------------------------------------------

Deno.test("mergeMutationResults - the more severe kind wins whichever side it is on", () => {
  const ranked: MutationCheckResult[] = [
    { kind: "error", reason: "boom" },
    { kind: "not_checked", language: "shell", reason: "no test runs x" },
    {
      kind: "budget_exhausted",
      language: "deno",
      survivors: [],
      killed: 0,
      tested: 0,
      total: 1,
      budgetSeconds: 1,
    },
    {
      kind: "completed",
      language: "deno",
      survivors: [],
      killed: 1,
      total: 1,
    },
    { kind: "not_applicable", reason: "skip" },
  ];
  for (const [i, hi] of ranked.entries()) {
    for (const lo of ranked.slice(i + 1)) {
      assertEquals(
        mergeMutationResults(lo, hi).kind,
        hi.kind,
        `${lo.kind} then ${hi.kind}`,
      );
      assertEquals(
        mergeMutationResults(hi, lo).kind,
        hi.kind,
        `${hi.kind} then ${lo.kind}`,
      );
    }
  }
});

Deno.test("mergeMutationResults - a tie keeps the primary's language, budget and limit", () => {
  const primary: MutationCheckResult = {
    kind: "budget_exhausted",
    language: "deno",
    survivors: [],
    killed: 0,
    tested: 0,
    total: 1,
    budgetSeconds: 10,
    limit: "mutant_cap",
  };
  const secondary: MutationCheckResult = {
    kind: "budget_exhausted",
    language: "shell",
    survivors: [],
    killed: 0,
    tested: 0,
    total: 2,
    budgetSeconds: 20,
  };
  assertEquals(mergeMutationResults(primary, secondary), {
    kind: "budget_exhausted",
    language: "deno",
    survivors: [],
    killed: 0,
    tested: 0,
    total: 3,
    budgetSeconds: 10,
    limit: "mutant_cap",
  });
  assertEquals(
    mergeMutationResults(
      { kind: "not_checked", language: "deno", reason: "a" },
      { kind: "not_checked", language: "shell", reason: "b" },
    ),
    { kind: "not_checked", language: "deno", reason: "a; b" },
  );
});

Deno.test("mergeMutationResults - survivors are concatenated in order and counts are summed", () => {
  const a: MutationCheckResult = {
    kind: "completed",
    language: "deno",
    survivors: [{
      file: "lib/a.ts",
      line: 1,
      description: "deleted statement",
    }],
    killed: 2,
    total: 3,
  };
  const b: MutationCheckResult = {
    kind: "completed",
    language: "shell",
    survivors: [{
      file: "scripts/b.sh",
      line: 4,
      description: "deleted statement",
    }],
    killed: 1,
    total: 4,
  };
  assertEquals(mergeMutationResults(a, b), {
    kind: "completed",
    language: "deno",
    survivors: [
      { file: "lib/a.ts", line: 1, description: "deleted statement" },
      { file: "scripts/b.sh", line: 4, description: "deleted statement" },
    ],
    killed: 3,
    total: 7,
  });
});

Deno.test("mergeMutationResults - reasons are joined with '; '", () => {
  assertEquals(
    mergeMutationResults(
      { kind: "error", reason: "one" },
      { kind: "error", reason: "two" },
    ),
    { kind: "error", reason: "one; two" },
  );
});

Deno.test("mergeMutationResults - throws when neither side carries a language", () => {
  const bare = {
    kind: "completed",
    survivors: [],
    killed: 0,
    total: 0,
  } as unknown as MutationCheckResult;
  assertThrows(
    () => mergeMutationResults(bare, bare),
    Error,
    "a merged mutation result needs a language",
  );
});

Deno.test("mergeMutationResults - a not_checked result folds in at most ten survivors", () => {
  const survivors = Array.from({ length: 12 }, (_, i) => ({
    file: SCRIPT,
    line: i + 1,
    description: "deleted statement",
  }));
  const merged = mergeMutationResults(
    { kind: "not_checked", language: "shell", reason: "no test runs a.sh" },
    {
      kind: "completed",
      language: "shell",
      survivors,
      killed: 0,
      total: 12,
    },
  );
  assertEquals(merged.kind, "not_checked");
  const reason = merged.kind === "not_checked" ? merged.reason : "";
  assertStringIncludes(reason, "also 12 surviving mutant(s)");
  assertStringIncludes(reason, `${SCRIPT}:10 deleted statement`);
  assertEquals(reason.split(`${SCRIPT}:`).length - 1, 10, reason);
  assertEquals(reason.includes(`${SCRIPT}:11 `), false, reason);
});

Deno.test("defaultMutationRunnerSeams listShellTestFiles - finds shell tests, skips other files and skipped dirs, sorted", async () => {
  const repo = await Deno.makeTempDir({ prefix: "mut-shell-tests-" });
  try {
    await Deno.mkdir(`${repo}/scripts/tests`, { recursive: true });
    await Deno.mkdir(`${repo}/node_modules/x`, { recursive: true });
    for (
      const f of [
        "scripts/tests/b_test.sh",
        "scripts/a.bats",
        "scripts/run.sh",
        "scripts/lib_test.ts",
        "node_modules/x/c_test.sh",
      ]
    ) {
      await Deno.writeTextFile(`${repo}/${f}`, "");
    }
    const list = defaultMutationRunnerSeams().listShellTestFiles;
    assert(list !== undefined, "the real seams list shell tests");
    assertEquals(await list(repo), [
      "scripts/a.bats",
      "scripts/tests/b_test.sh",
    ]);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("runMutationCheck shell - an extensionless file is a script only when its shebang names sh or bash", async () => {
  const sh = "#!/usr/bin/env bash\nexport X=1\n";
  const py = "#!/usr/bin/env python3\nprint(1)\n";
  const f = shellFake(
    { [`${REPO}/bin/tool`]: sh, [`${REPO}/bin/other`]: py },
    () => ok(0),
  );
  const asShell = asKind(
    await runMutationCheck(
      shellInput(shellDiff("bin/tool", sh.trimEnd())),
      f.seams,
    ),
    "not_checked",
  );
  assertStringIncludes(asShell.reason, "bin/tool");
  asKind(
    await runMutationCheck(
      shellInput(shellDiff("bin/other", py.trimEnd())),
      f.seams,
    ),
    "not_applicable",
  );
  assertEquals(f.calls.length, 0);
});
