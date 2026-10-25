/**
 * Facts flip verifier (Issues #4186 and #4187, part of #3875).
 *
 * For each tested entry in a summary-facts file, mutate the cited line span
 * and run only that entry's named test. The entry is verified when the named
 * test goes red under a mutant of those lines. A self-reported `flipWentRed`
 * is not evidence.
 *
 * Deno entries reuse `generateDenoMutantsDetailed` and the mutation runner's
 * seams: a green baseline, then each mutant written and restored in `finally`.
 * The named test is selected with `deno test --filter`. An unparsable mutant
 * is not a kill.
 *
 * Rust entries reuse `findCargoPackageDir`, `rustTestArgs` and
 * `namedRustTestOutcome`. Mutants come from `cargo mutants` (the runner's
 * existing Rust mutator), limited to a diff of the cited lines and to the
 * named test. This module does not generate Rust mutants of its own.
 *
 * An outcome is two-sided when its text says the claim holds both ways: it
 * contains `true/false` or `false/true` (spaces around the slash allowed), or
 * the whole word `both`. Such an entry is verified only when a negation mutant
 * and a boolean or return-swap mutant each turn the named test red. One of
 * those forcings missing is not checked. One of them staying green is refused.
 *
 * Anything other than a green baseline and a behavioural kill is not checked,
 * with its own reason: zero matched tests, a baseline failure, no viable
 * mutant, a missing tool, a timeout, or budget exhaustion. The budget is
 * `resolveMutationBudgetSeconds`. An entry not started when the deadline has
 * passed is `budget_exhausted`.
 *
 * Australian English spelling used throughout.
 */

import {
  DEFAULT_MUTANT_CAP,
  type DenoMutant,
  generateDenoMutantsDetailed,
  isDenoTestFile,
} from "./mutation_gate.ts";
import { resolveMutationBudgetSeconds } from "./mutation_check_invocation.ts";
import {
  allowListedCargoPackageName,
  confinePath,
  findCargoPackageDir,
  findDenoConfigDir,
  isParseFailure,
  type MutationRunnerSeams,
  type ProcessResult,
} from "./mutation_runner.ts";
import {
  namedRustTestOutcome,
  namedTestOutcome,
  rustTestArgs,
} from "./security_fix_discrimination.ts";
import type {
  BranchOutcomeEntry,
  SummaryFacts,
  TestedEntry,
} from "./summary_facts.ts";

export interface FactsFlipSeams extends MutationRunnerSeams {
  /** Checkout the facts' paths are relative to. */
  repoPath: string;
  /** Raw `mutation_check_budget_seconds`. Empty selects the default. */
  budgetRaw: string;
  warn(message: string, context?: Record<string, unknown>): void;
}

export type FlipStatus =
  | { kind: "verified" }
  | { kind: "refused"; message: string }
  | { kind: "not_checked"; reason: string };

/** One tested entry's verdict. `index` is into `branchOutcomes.entries`. */
export interface FactsFlipVerdict {
  index: number;
  verdict: FlipStatus;
}

const SPLIT_REASON =
  "two-sided outcome: cannot confirm both forcings; split the entry";

const TRUE_FALSE_PAIR = /true\s*\/\s*false|false\s*\/\s*true/i;
const BOTH_WORD = /\bboth\b/i;

/**
 * Whether `outcome` claims both directions of a condition.
 *
 * True when the text contains `true/false` or `false/true` (optional spaces
 * around the slash), or the whole word `both`. `bother` and a one-sided
 * `true` do not match.
 */
export function isTwoSidedOutcome(outcome: string): boolean {
  return TRUE_FALSE_PAIR.test(outcome) || BOTH_WORD.test(outcome);
}

function isTested(entry: BranchOutcomeEntry): entry is TestedEntry {
  return "test" in entry;
}

function isDenoTest(file: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) && isDenoTestFile(file);
}

function normalise(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function relativeTo(dir: string, file: string): string | null {
  const normalised = normalise(file);
  if (dir === "") return normalised;
  const prefix = `${dir}/`;
  if (!normalised.startsWith(prefix)) return null;
  return normalised.slice(prefix.length);
}

function citedLines(entry: TestedEntry): number[] {
  const end = entry.endLine ?? entry.line;
  if (end < entry.line) {
    throw new Error(
      `${entry.path}: endLine ${end} is less than line ${entry.line}`,
    );
  }
  const lines: number[] = [];
  for (let n = entry.line; n <= end; n++) lines.push(n);
  return lines;
}

function refusalMessage(entry: TestedEntry): string {
  return `\`${entry.path}:${entry.line}\`: no flip of this line turns \`${entry.testName}\` red; name a test that fails, or add one`;
}

function twoSidedRefusal(entry: TestedEntry): string {
  return `\`${entry.path}:${entry.line}\`: one forcing of this two-sided outcome leaves \`${entry.testName}\` green; name a test that fails both ways, or split the entry`;
}

function notChecked(reason: string): { kind: "not_checked"; reason: string } {
  return { kind: "not_checked", reason };
}

function isMissingTool(res: ProcessResult): boolean {
  return res.code === 127 || /command not found/i.test(res.stderr);
}

/** Negation, or a boolean / return swap. Other mutant kinds are neither. */
function forcingOf(description: string): "negation" | "swap" | null {
  if (
    description === "negated if condition" ||
    description === "negated ternary condition"
  ) return "negation";
  if (
    description.startsWith("swapped ") ||
    description.startsWith("replaced return value")
  ) return "swap";
  return null;
}

function denoFilterArgs(testName: string, relTest: string): string[] {
  return ["test", "--no-check", "-A", "--filter", testName, relTest];
}

type MutantClass =
  | { kind: "kill" }
  | { kind: "green" }
  | { kind: "unviable" }
  | { kind: "not_checked"; reason: string };

/**
 * A kill is the named test reported FAILED. A parse error, a missing tool, a
 * timeout, or a run that never reports the test is not a kill.
 */
function classifyMutant(res: ProcessResult, testName: string): MutantClass {
  if (res.timedOut) return notChecked("timeout");
  if (isMissingTool(res)) return notChecked("missing_tool");
  if (isParseFailure(res)) return { kind: "unviable" };
  const outcome = namedTestOutcome(res.stdout, testName);
  if (outcome === "fail") return { kind: "kill" };
  if (outcome === "pass") return { kind: "green" };
  return { kind: "unviable" };
}

function classifyBaseline(
  res: ProcessResult,
  testName: string,
): FlipStatus | null {
  if (res.timedOut) return notChecked("timeout");
  if (isMissingTool(res)) return notChecked("missing_tool");
  const outcome = namedTestOutcome(res.stdout, testName);
  if (outcome === "fail") return notChecked("baseline_failure");
  if (outcome === null) return notChecked("zero_matched_tests");
  return null;
}

async function runMutant(
  seams: FactsFlipSeams,
  abs: string,
  original: string,
  mutated: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  let result: ProcessResult;
  try {
    await seams.writeTextFile(abs, mutated);
    result = await seams.runProcess("deno", args, { cwd, timeoutMs });
  } finally {
    await seams.writeTextFile(abs, original);
  }
  return result;
}

type ForcingOutcome = "killed" | "green" | "unviable";

async function runForcing(
  mutants: readonly DenoMutant[],
  seams: FactsFlipSeams,
  abs: string,
  original: string,
  args: string[],
  cwd: string,
  testName: string,
  remaining: () => number,
): Promise<ForcingOutcome | FlipStatus> {
  let sawGreen = false;
  for (const mutant of mutants) {
    const timeoutMs = remaining();
    if (timeoutMs <= 0) return notChecked("budget_exhausted");
    const res = await runMutant(
      seams,
      abs,
      original,
      mutant.mutatedSource,
      args,
      cwd,
      timeoutMs,
    );
    const classified = classifyMutant(res, testName);
    if (classified.kind === "not_checked") return classified;
    if (classified.kind === "kill") return "killed";
    if (classified.kind === "green") sawGreen = true;
  }
  return sawGreen ? "green" : "unviable";
}

function finishTwoSided(
  entry: TestedEntry,
  negation: ForcingOutcome,
  swap: ForcingOutcome,
  dropped: number,
): FlipStatus {
  if (negation === "killed" && swap === "killed") return { kind: "verified" };
  if (negation === "unviable" || swap === "unviable") {
    if (negation === "unviable" && swap === "unviable" && dropped > 0) {
      return notChecked("mutant_cap");
    }
    if (negation === "unviable" && swap === "unviable") {
      return notChecked("no_viable_mutant");
    }
    return notChecked(SPLIT_REASON);
  }
  if (dropped > 0) return notChecked("mutant_cap");
  if (negation === "killed" || swap === "killed") {
    return { kind: "refused", message: twoSidedRefusal(entry) };
  }
  return { kind: "refused", message: refusalMessage(entry) };
}

async function verifyDenoEntry(
  entry: TestedEntry,
  seams: FactsFlipSeams,
  remaining: () => number,
): Promise<FlipStatus> {
  const configDir = await findDenoConfigDir(seams.repoPath, entry.test, seams);
  if (configDir === null) return notChecked("no_deno_project");
  const relTest = relativeTo(configDir, entry.test);
  if (relTest === null || relTest === "") return notChecked("no_deno_project");

  const abs = await confinePath(seams.repoPath, entry.path, seams);
  if (abs === null) return notChecked("source_unreadable");
  let source: string;
  try {
    source = await seams.readTextFile(abs);
  } catch {
    return notChecked("source_unreadable");
  }

  const generated = generateDenoMutantsDetailed(
    entry.path,
    source,
    citedLines(entry),
    DEFAULT_MUTANT_CAP,
  );
  if (generated.mutants.length === 0) {
    return notChecked(
      generated.dropped > 0 ? "mutant_cap" : "no_viable_mutant",
    );
  }

  const twoSided = isTwoSidedOutcome(entry.outcome);
  const negation = generated.mutants.filter((m) =>
    forcingOf(m.description) === "negation"
  );
  const swap = generated.mutants.filter((m) =>
    forcingOf(m.description) === "swap"
  );
  if (twoSided && (negation.length === 0 || swap.length === 0)) {
    return notChecked(SPLIT_REASON);
  }

  const cwd = configDir === ""
    ? seams.repoPath
    : `${seams.repoPath}/${configDir}`;
  const args = denoFilterArgs(entry.testName, relTest);
  const timeoutMs = remaining();
  if (timeoutMs <= 0) return notChecked("budget_exhausted");
  const baseline = await seams.runProcess("deno", args, { cwd, timeoutMs });
  const baselineStatus = classifyBaseline(baseline, entry.testName);
  if (baselineStatus !== null) return baselineStatus;

  if (twoSided) {
    const neg = await runForcing(
      negation,
      seams,
      abs,
      source,
      args,
      cwd,
      entry.testName,
      remaining,
    );
    if (typeof neg !== "string") return neg;
    const swapped = await runForcing(
      swap,
      seams,
      abs,
      source,
      args,
      cwd,
      entry.testName,
      remaining,
    );
    if (typeof swapped !== "string") return swapped;
    return finishTwoSided(entry, neg, swapped, generated.dropped);
  }

  let sawGreen = false;
  for (const mutant of generated.mutants) {
    const budget = remaining();
    if (budget <= 0) return notChecked("budget_exhausted");
    const res = await runMutant(
      seams,
      abs,
      source,
      mutant.mutatedSource,
      args,
      cwd,
      budget,
    );
    const classified = classifyMutant(res, entry.testName);
    if (classified.kind === "not_checked") return classified;
    if (classified.kind === "kill") return { kind: "verified" };
    if (classified.kind === "green") sawGreen = true;
  }
  if (generated.dropped > 0) return notChecked("mutant_cap");
  if (sawGreen) return { kind: "refused", message: refusalMessage(entry) };
  return notChecked("no_viable_mutant");
}

interface RustMutantView {
  file: string;
  line: number;
  name: string;
  genre: string;
  replacement: string;
  summary: "CaughtMutant" | "MissedMutant" | "Unviable" | "Timeout";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Mutants in cargo-mutants `outcomes.json`. The field names are the ones
 * `parseOutcomes` in `mutation_runner.ts` already reads. Null when the
 * document is not that shape.
 */
function parseRustMutants(text: string): RustMutantView[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const root = asRecord(data);
  if (!root || !Array.isArray(root.outcomes)) return null;
  const out: RustMutantView[] = [];
  const summaries = ["CaughtMutant", "MissedMutant", "Unviable", "Timeout"];
  for (const item of root.outcomes) {
    const outcome = asRecord(item);
    if (!outcome) return null;
    if (typeof outcome.scenario === "string") continue;
    const scenario = asRecord(outcome.scenario);
    if (!scenario) return null;
    const mutant = asRecord(scenario.Mutant);
    if (!mutant) continue;
    const summary = outcome.summary;
    if (typeof summary !== "string" || !summaries.includes(summary)) continue;
    const line = Number(asRecord(asRecord(mutant.span)?.start)?.line);
    const file = typeof mutant.file === "string" ? mutant.file : null;
    if (file === null || !Number.isFinite(line)) return null;
    out.push({
      file,
      line,
      name: typeof mutant.name === "string" ? mutant.name : "",
      genre: typeof mutant.genre === "string" ? mutant.genre : "",
      replacement: typeof mutant.replacement === "string"
        ? mutant.replacement
        : "",
      summary: summary as RustMutantView["summary"],
    });
  }
  return out;
}

/** A condition flip, or a boolean / return swap, in a cargo-mutants name. */
function rustForcing(mutant: RustMutantView): "negation" | "swap" | null {
  const replacement = mutant.replacement.trim();
  if (replacement === "true" || replacement === "false") return "swap";
  if (/\breturn\b/i.test(mutant.name) || /\breturn\b/i.test(mutant.genre)) {
    return "swap";
  }
  if (
    replacement === "!" || replacement === "!=" || replacement === "==" ||
    replacement === "&&" || replacement === "||" ||
    /==|!=|&&|\|\|/.test(mutant.name) || /\bnegate\b/i.test(mutant.name)
  ) return "negation";
  return null;
}

function inSpan(line: number, entry: TestedEntry): boolean {
  const end = entry.endLine ?? entry.line;
  return line >= entry.line && line <= end;
}

function citedDiff(
  relFile: string,
  source: string,
  start: number,
  end: number,
): string {
  const lines = source.split("\n");
  const added: string[] = [];
  for (let n = start; n <= end; n++) {
    let line = lines[n - 1] ?? "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    added.push(`+${line}`);
  }
  return [
    `diff --git a/${relFile} b/${relFile}`,
    `--- a/${relFile}`,
    `+++ b/${relFile}`,
    `@@ -${start},0 +${start},${added.length} @@`,
    ...added,
    "",
  ].join("\n");
}

function classifyRustBaseline(
  res: ProcessResult,
  testName: string,
): FlipStatus | null {
  if (res.timedOut) return notChecked("timeout");
  if (isMissingTool(res)) return notChecked("missing_tool");
  const outcome = namedRustTestOutcome(res.stdout, testName);
  if (outcome === "fail") return notChecked("baseline_failure");
  if (outcome === null) return notChecked("zero_matched_tests");
  return null;
}

function rustForcingResult(
  group: readonly RustMutantView[],
): ForcingOutcome | FlipStatus {
  if (group.some((m) => m.summary === "CaughtMutant")) return "killed";
  if (group.some((m) => m.summary === "Timeout")) return notChecked("timeout");
  if (group.some((m) => m.summary === "MissedMutant")) return "green";
  return "unviable";
}

function judgeRust(
  entry: TestedEntry,
  mutants: readonly RustMutantView[],
): FlipStatus {
  const cited = mutants.filter((m) =>
    normalise(m.file) === normalise(entry.path) && inSpan(m.line, entry)
  );
  if (!isTwoSidedOutcome(entry.outcome)) {
    if (cited.some((m) => m.summary === "CaughtMutant")) {
      return { kind: "verified" };
    }
    if (cited.some((m) => m.summary === "Timeout")) {
      return notChecked("timeout");
    }
    if (cited.some((m) => m.summary === "MissedMutant")) {
      return { kind: "refused", message: refusalMessage(entry) };
    }
    return notChecked("no_viable_mutant");
  }
  const negation = cited.filter((m) => rustForcing(m) === "negation");
  const swap = cited.filter((m) => rustForcing(m) === "swap");
  if (negation.length === 0 || swap.length === 0) {
    return notChecked(SPLIT_REASON);
  }
  const neg = rustForcingResult(negation);
  if (typeof neg !== "string") return neg;
  const swapped = rustForcingResult(swap);
  if (typeof swapped !== "string") return swapped;
  return finishTwoSided(entry, neg, swapped, 0);
}

async function cargoPackage(
  seams: FactsFlipSeams,
  file: string,
): Promise<{ dir: string; name: string } | null> {
  const dir = await findCargoPackageDir(seams.repoPath, file, seams);
  if (dir === null) return null;
  const manifest = dir === "" ? "Cargo.toml" : `${dir}/Cargo.toml`;
  const abs = await confinePath(seams.repoPath, manifest, seams);
  if (abs === null) return null;
  let toml: string;
  try {
    toml = await seams.readTextFile(abs);
  } catch {
    return null;
  }
  const name = allowListedCargoPackageName(toml);
  if (name === null) return null;
  return { dir, name };
}

const CARGO_MUTANTS_MISSING = /no such command: `?mutants/i;

async function verifyRustEntry(
  entry: TestedEntry,
  seams: FactsFlipSeams,
  remaining: () => number,
): Promise<FlipStatus> {
  const testPkg = await cargoPackage(seams, entry.test);
  const sourcePkg = await cargoPackage(seams, entry.path);
  if (
    testPkg === null || sourcePkg === null || testPkg.dir !== sourcePkg.dir
  ) {
    return notChecked("no_cargo_package");
  }
  const relTest = relativeTo(testPkg.dir, entry.test);
  if (relTest === null || relTest === "") return notChecked("no_cargo_package");

  const abs = await confinePath(seams.repoPath, entry.path, seams);
  if (abs === null) return notChecked("source_unreadable");
  let source: string;
  try {
    source = await seams.readTextFile(abs);
  } catch {
    return notChecked("source_unreadable");
  }

  const cwd = testPkg.dir === ""
    ? seams.repoPath
    : `${seams.repoPath}/${testPkg.dir}`;
  const testArgs = rustTestArgs(relTest, entry.testName);
  const baselineBudget = remaining();
  if (baselineBudget <= 0) return notChecked("budget_exhausted");
  const baseline = await seams.runProcess("cargo", testArgs, {
    cwd,
    timeoutMs: baselineBudget,
  });
  const baselineStatus = classifyRustBaseline(baseline, entry.testName);
  if (baselineStatus !== null) return baselineStatus;

  const outDir = await seams.makeTempDir();
  try {
    const mutantBudget = remaining();
    if (mutantBudget <= 0) return notChecked("budget_exhausted");
    const repoSource = normalise(entry.path);
    const diffPath = `${outDir}/cited.diff`;
    await seams.writeTextFile(
      diffPath,
      citedDiff(
        repoSource,
        source,
        entry.line,
        entry.endLine ?? entry.line,
      ),
    );
    const proc = await seams.runProcess(
      "cargo",
      [
        "mutants",
        "--package",
        testPkg.name,
        "--file",
        repoSource,
        "--in-diff",
        diffPath,
        "--output",
        outDir,
        "--no-shuffle",
        "--jobs",
        "1",
        "--",
        ...testArgs.slice(1),
      ],
      {
        cwd: seams.repoPath,
        timeoutMs: mutantBudget,
        env: { TMPDIR: outDir },
      },
    );
    if (proc.timedOut) return notChecked("timeout");
    if (proc.code === 127 || CARGO_MUTANTS_MISSING.test(proc.stderr)) {
      return notChecked("missing_tool");
    }
    if (proc.code === 4) return notChecked("baseline_failure");
    if (![0, 2, 3].includes(proc.code)) {
      return notChecked("cargo_mutants_failed");
    }
    const outcomesPath = `${outDir}/mutants.out/outcomes.json`;
    let text: string | null = null;
    if (await seams.exists(outcomesPath)) {
      text = await seams.readTextFile(outcomesPath);
    }
    if (
      text === null && proc.code === 0 &&
      /no mutants/i.test(`${proc.stdout}\n${proc.stderr}`)
    ) {
      return notChecked("no_viable_mutant");
    }
    if (text === null) return notChecked("outcomes_unreadable");
    const parsed = parseRustMutants(text);
    if (parsed === null) return notChecked("outcomes_unreadable");
    return judgeRust(entry, parsed);
  } finally {
    await seams.removeDir(outDir);
  }
}

async function verifyTested(
  entry: TestedEntry,
  seams: FactsFlipSeams,
  remaining: () => number,
): Promise<FlipStatus> {
  if (entry.test.endsWith(".rs") || entry.path.endsWith(".rs")) {
    if (!entry.test.endsWith(".rs") || !entry.path.endsWith(".rs")) {
      return notChecked("unsupported_test");
    }
    return await verifyRustEntry(entry, seams, remaining);
  }
  if (!isDenoTest(entry.test)) return notChecked("unsupported_test");
  return await verifyDenoEntry(entry, seams, remaining);
}

/**
 * One verdict per tested entry, in entry order. Exempt entries are skipped.
 * A `refused` message names the cited line and the test that stayed green.
 */
export async function verifyFactsFlips(
  facts: SummaryFacts,
  seams: FactsFlipSeams,
): Promise<FactsFlipVerdict[]> {
  const budgetSeconds = resolveMutationBudgetSeconds(
    seams.budgetRaw,
    seams.warn,
  );
  const start = seams.now();
  const remaining = () => budgetSeconds * 1000 - (seams.now() - start);
  const out: FactsFlipVerdict[] = [];
  for (const [index, entry] of facts.branchOutcomes.entries.entries()) {
    if (!isTested(entry)) continue;
    if (remaining() <= 0) {
      out.push({ index, verdict: notChecked("budget_exhausted") });
      continue;
    }
    out.push({
      index,
      verdict: await verifyTested(entry, seams, remaining),
    });
  }
  return out;
}
