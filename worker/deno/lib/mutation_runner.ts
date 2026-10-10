/**
 * Mutation-check runner (Issue #3393): the I/O half of the diff-scoped
 * mutation gate. Every side effect goes through {@link MutationRunnerSeams} so
 * tests can drive it with an in-memory filesystem and a fake process runner.
 *
 * Deno repositories are mutated by this module (see `generateDenoMutants`);
 * Rust repositories are delegated to `cargo mutants --in-diff`.
 *
 * Known limit: a Deno module counts as covered only by tests that import it
 * directly, so a module exercised solely through another module's tests is
 * reported as having no importing test.
 *
 * Australian English spelling used throughout.
 */

import {
  DEFAULT_MUTANT_CAP,
  generateDenoMutants,
  isDenoTestFile,
  type Mutant,
  type MutationCheckResult,
  type MutationLanguage,
  parseAddedLines,
} from "./mutation_gate.ts";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface MutationRunnerSeams {
  runProcess(
    cmd: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number },
  ): Promise<ProcessResult>;
  /** Milliseconds. */
  now(): number;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Repo-relative `*_test.ts` / `*.test.ts` paths. */
  listTestFiles(repoPath: string): Promise<string[]>;
}

export interface MutationRunInput {
  repoPath: string;
  diff: string;
  budgetSeconds: number;
  mutantCap?: number;
  jobs?: number;
}

const DENO_MARKERS = ["deno.json", "deno.jsonc", "deno.lock"];
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/;
const RELATIVE_SPECIFIER = /["'](\.{1,2}\/[^"']*)["']/g;
const CARGO_MUTANTS_MISSING =
  "cargo-mutants is not installed; install it or set skip_mutation_check";

/** Deno markers at the repo root win; otherwise `Cargo.toml` means Rust. */
export async function detectMutationLanguage(
  repoPath: string,
  seams: MutationRunnerSeams,
): Promise<MutationLanguage | null> {
  for (const marker of DENO_MARKERS) {
    if (await seams.exists(`${repoPath}/${marker}`)) return "deno";
  }
  if (await seams.exists(`${repoPath}/Cargo.toml`)) return "rust";
  return null;
}

export async function runMutationCheck(
  input: MutationRunInput,
  seams: MutationRunnerSeams,
): Promise<MutationCheckResult> {
  try {
    if (input.diff.trim() === "") {
      return { kind: "not_applicable", reason: "the diff is empty" };
    }
    const language = await detectMutationLanguage(input.repoPath, seams);
    if (language === null) {
      return {
        kind: "not_applicable",
        reason: "no Deno or Rust project found at the repository root",
      };
    }
    return language === "deno"
      ? await runDeno(input, seams)
      : await runRust(input, seams);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", reason: message };
  }
}

// ---------------------------------------------------------------------------
// Deno
// ---------------------------------------------------------------------------

function normalisePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

async function findImportingTests(
  module: string,
  testFiles: readonly string[],
  seams: MutationRunnerSeams,
  repoPath: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const test of testFiles) {
    const text = await seams.readTextFile(`${repoPath}/${test}`);
    const dir = dirOf(test);
    for (const m of text.matchAll(RELATIVE_SPECIFIER)) {
      const spec = m[1];
      if (spec === undefined) continue;
      if (normalisePath(`${dir}/${spec}`) === module) {
        found.push(test);
        break;
      }
    }
  }
  return found;
}

function safeRelativePath(p: string): boolean {
  return !p.startsWith("/") && !p.split("/").includes("..");
}

async function runDeno(
  input: MutationRunInput,
  seams: MutationRunnerSeams,
): Promise<MutationCheckResult> {
  const { repoPath, budgetSeconds } = input;
  const start = seams.now();
  const budgetMs = budgetSeconds * 1000;
  const remaining = () => budgetMs - (seams.now() - start);

  const added = parseAddedLines(input.diff);
  const modules: Array<{ file: string; lines: number[] }> = [];
  for (const [file, lines] of added) {
    if (
      !SOURCE_FILE.test(file) || file.endsWith(".d.ts") ||
      isDenoTestFile(file) || !safeRelativePath(file)
    ) continue;
    if (!(await seams.exists(`${repoPath}/${file}`))) continue;
    modules.push({ file, lines });
  }
  if (modules.length === 0) {
    return {
      kind: "not_applicable",
      reason: "the diff adds no lines to non-test Deno source files",
    };
  }

  const cap = input.mutantCap ?? DEFAULT_MUTANT_CAP;
  const originals = new Map<string, string>();
  const mutants: Array<ReturnType<typeof generateDenoMutants>[number]> = [];
  for (const mod of modules) {
    const room = cap - mutants.length;
    if (room <= 0) break;
    const source = await seams.readTextFile(`${repoPath}/${mod.file}`);
    originals.set(mod.file, source);
    mutants.push(...generateDenoMutants(mod.file, source, mod.lines, room));
  }
  if (mutants.length === 0) {
    return {
      kind: "not_applicable",
      reason: "no mutable statements on the added lines",
    };
  }

  const testFiles = await seams.listTestFiles(repoPath);
  const testsFor = new Map<string, string[]>();
  for (const file of new Set(mutants.map((m) => m.file))) {
    testsFor.set(
      file,
      await findImportingTests(file, testFiles, seams, repoPath),
    );
  }

  const survivors: Mutant[] = [];
  let killed = 0;
  let tested = 0;
  const total = mutants.length;
  const exhausted = (): MutationCheckResult => ({
    kind: "budget_exhausted",
    language: "deno",
    survivors,
    killed,
    tested,
    total,
    budgetSeconds,
  });

  // Mutants of modules no test imports cannot be killed.
  const runnable: typeof mutants = [];
  for (const m of mutants) {
    if ((testsFor.get(m.file) ?? []).length === 0) {
      survivors.push({
        file: m.file,
        line: m.line,
        description: `${m.description} (no test imports this module)`,
      });
      tested++;
    } else runnable.push(m);
  }

  // Baseline: the importing tests must pass unmutated.
  const baselined = new Set<string>();
  for (const m of runnable) {
    const tests = testsFor.get(m.file) ?? [];
    const key = tests.join("\n");
    if (baselined.has(key)) continue;
    baselined.add(key);
    if (remaining() <= 0) return exhausted();
    const base = await seams.runProcess("deno", ["test", "-A", ...tests], {
      cwd: repoPath,
      timeoutMs: remaining(),
    });
    if (base.timedOut) return exhausted();
    if (base.code !== 0) {
      return {
        kind: "error",
        reason: `baseline tests fail before mutation (${
          tests.join(", ")
        }); cannot judge mutants`,
      };
    }
  }

  for (const m of runnable) {
    if (remaining() <= 0) return exhausted();
    const tests = testsFor.get(m.file) ?? [];
    const path = `${repoPath}/${m.file}`;
    const original = originals.get(m.file) ?? "";
    let result: ProcessResult;
    try {
      await seams.writeTextFile(path, m.mutatedSource);
      result = await seams.runProcess("deno", ["test", "-A", ...tests], {
        cwd: repoPath,
        timeoutMs: remaining(),
      });
    } finally {
      await seams.writeTextFile(path, original);
    }
    if (result.timedOut) return exhausted();
    tested++;
    if (result.code !== 0) killed++;
    else {
      survivors.push({
        file: m.file,
        line: m.line,
        description: m.description,
      });
    }
  }
  return { kind: "completed", language: "deno", survivors, killed, total };
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

interface ParsedOutcomes {
  survivors: Mutant[];
  killed: number;
  tested: number;
  total: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

/**
 * Parse cargo-mutants `mutants.out/outcomes.json`. Relies on:
 * `outcomes[].scenario.Mutant.{file, span.start.line, name?, genre?,
 * replacement?, function.function_name?}` and `outcomes[].summary`
 * (`CaughtMutant` | `MissedMutant` | `Timeout` | `Unviable`); `scenario` is
 * the string `"Baseline"` for the baseline run. `total_mutants` is used when
 * present. Returns null when the shape is not recognised.
 */
function parseOutcomes(text: string): ParsedOutcomes | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const root = asRecord(data);
  if (!root || !Array.isArray(root.outcomes)) return null;
  const survivors: Mutant[] = [];
  let killed = 0;
  let tested = 0;
  let count = 0;
  for (const o of root.outcomes) {
    const outcome = asRecord(o);
    if (!outcome) return null;
    const scenario = asRecord(outcome.scenario);
    if (!scenario) continue; // "Baseline"
    const mutant = asRecord(scenario.Mutant);
    if (!mutant) continue;
    count++;
    const summary = outcome.summary;
    if (summary === "Unviable") {
      tested++;
      continue;
    }
    if (summary === "CaughtMutant" || summary === "Timeout") {
      killed++;
      tested++;
      continue;
    }
    if (summary !== "MissedMutant") continue;
    tested++;
    const line = Number(asRecord(asRecord(mutant.span)?.start)?.line);
    const file = typeof mutant.file === "string" ? mutant.file : null;
    if (file === null || !Number.isFinite(line)) return null;
    survivors.push({ file, line, description: describeRustMutant(mutant) });
  }
  const total = typeof root.total_mutants === "number"
    ? root.total_mutants
    : count;
  return { survivors, killed, tested, total };
}

function describeRustMutant(m: Record<string, unknown>): string {
  if (typeof m.name === "string" && m.name !== "") return m.name;
  const fn = asRecord(m.function)?.function_name;
  const parts = [
    typeof m.genre === "string" ? m.genre : "mutation",
    typeof fn === "string" ? `in ${fn}` : "",
    typeof m.replacement === "string" ? `with ${m.replacement}` : "",
  ];
  return parts.filter((p) => p !== "").join(" ");
}

async function runRust(
  input: MutationRunInput,
  seams: MutationRunnerSeams,
): Promise<MutationCheckResult> {
  const { repoPath, budgetSeconds } = input;
  const added = parseAddedLines(input.diff);
  if (![...added.keys()].some((f) => f.endsWith(".rs"))) {
    return {
      kind: "not_applicable",
      reason: "the diff adds no lines to Rust source files",
    };
  }
  const diffPath = `${repoPath}/target/vibe-mutation-check.diff`;
  await seams.writeTextFile(diffPath, input.diff);
  const jobs = input.jobs ??
    Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 2));
  const proc = await seams.runProcess(
    "cargo",
    [
      "mutants",
      "--in-diff",
      diffPath,
      "--no-shuffle",
      "--jobs",
      String(jobs),
    ],
    { cwd: repoPath, timeoutMs: budgetSeconds * 1000 },
  );

  if (
    !proc.timedOut &&
    (proc.code === 127 || /no such command: `?mutants/i.test(proc.stderr))
  ) {
    return { kind: "error", reason: CARGO_MUTANTS_MISSING };
  }
  if (!proc.timedOut && ![0, 2, 3].includes(proc.code)) {
    const why = proc.code === 4
      ? "baseline tests fail before mutation"
      : `cargo mutants exited with code ${proc.code}`;
    return { kind: "error", reason: `${why}; cannot judge mutants` };
  }

  const outcomesPath = `${repoPath}/mutants.out/outcomes.json`;
  let text: string | null = null;
  if (await seams.exists(outcomesPath)) {
    text = await seams.readTextFile(outcomesPath);
  }
  const parsed = text === null ? null : parseOutcomes(text);

  if (proc.timedOut) {
    return {
      kind: "budget_exhausted",
      language: "rust",
      survivors: parsed?.survivors ?? [],
      killed: parsed?.killed ?? 0,
      tested: parsed?.tested ?? 0,
      total: parsed?.total ?? 0,
      budgetSeconds,
    };
  }
  if (parsed === null) {
    if (text === null && proc.code === 0 && /no mutants/i.test(proc.stdout)) {
      return {
        kind: "not_applicable",
        reason: "cargo-mutants found no mutants on the changed lines",
      };
    }
    return {
      kind: "error",
      reason: text === null
        ? "cargo mutants wrote no outcomes.json"
        : "could not parse mutants.out/outcomes.json",
    };
  }
  return {
    kind: "completed",
    language: "rust",
    survivors: parsed.survivors,
    killed: parsed.killed,
    total: parsed.total,
  };
}

// ---------------------------------------------------------------------------
// Real seams
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "target"]);
const TEST_FILE = /(?:_test|\.test)\.(?:ts|tsx|js|mjs)$/;

async function walkTests(
  root: string,
  rel: string,
  out: string[],
): Promise<void> {
  const dir = rel === "" ? root : `${root}/${rel}`;
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isSymlink) continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory) {
      if (!SKIP_DIRS.has(entry.name)) await walkTests(root, childRel, out);
    } else if (entry.isFile && TEST_FILE.test(entry.name)) {
      out.push(childRel);
    }
  }
}

/** Real seams: `Deno.Command` with kill-on-timeout, real clock and filesystem. */
export function defaultMutationRunnerSeams(): MutationRunnerSeams {
  return {
    async runProcess(cmd, args, opts) {
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(cmd, {
          args,
          cwd: opts.cwd,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return {
            code: 127,
            stdout: "",
            stderr: `command not found: ${cmd}`,
            timedOut: false,
          };
        }
        throw err;
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch { /* already exited */ }
      }, Math.max(1, opts.timeoutMs));
      try {
        const out = await child.output();
        const dec = new TextDecoder();
        return {
          code: out.code,
          stdout: dec.decode(out.stdout),
          stderr: dec.decode(out.stderr),
          timedOut,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    now: () => Date.now(),
    readTextFile: (path) => Deno.readTextFile(path),
    async writeTextFile(path, data) {
      const slash = path.lastIndexOf("/");
      if (slash > 0) {
        await Deno.mkdir(path.slice(0, slash), { recursive: true });
      }
      await Deno.writeTextFile(path, data);
    },
    async exists(path) {
      try {
        await Deno.stat(path);
        return true;
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return false;
        throw err;
      }
    },
    async listTestFiles(repoPath) {
      const out: string[] = [];
      await walkTests(repoPath, "", out);
      return out.sort();
    },
  };
}
