/**
 * Mutation-check runner (Issue #3393): the I/O half of the diff-scoped
 * mutation gate. Every side effect goes through {@link MutationRunnerSeams} so
 * tests can drive it with an in-memory filesystem and a fake process runner.
 *
 * Deno repositories are mutated by this module (see `generateDenoMutants`);
 * Rust repositories are delegated to `cargo mutants --in-diff`.
 *
 * Every path the runner writes is confined to the repository: the relative
 * path is normalised, its longest existing prefix is canonicalised through
 * `realPath` (so symlinks are resolved), and only a canonical path inside the
 * canonical repository root is read, written or restored (see
 * {@link confinePath}). A file that fails the check is skipped, never written.
 *
 * A Deno module is mutated and tested from the directory of its nearest
 * ancestor `deno.json` / `deno.jsonc` / `deno.lock` (the repository root, or a
 * nested project such as `worker/deno/`), so that project's own configuration
 * applies to the tests.
 *
 * Every child process runs with an allowlisted environment, never the
 * worker's own (see {@link defaultMutationRunnerSeams}).
 *
 * Known limit: a Deno module counts as covered only by tests that import it
 * directly, so a module exercised solely through another module's tests is
 * reported as having no importing test.
 *
 * Australian English spelling used throughout.
 */

import {
  DEFAULT_MUTANT_CAP,
  generateDenoMutantsDetailed,
  isDenoTestFile,
  type Mutant,
  type MutationCheckResult,
  type MutationLanguage,
  parseAddedLines,
} from "./mutation_gate.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";

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
    opts: {
      cwd: string;
      timeoutMs: number;
      /** Extra variables for the child, set after the allowlist is applied. */
      env?: Record<string, string>;
    },
  ): Promise<ProcessResult>;
  /** Milliseconds. */
  now(): number;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Canonical path with symlinks resolved; rejects when the path is absent. */
  realPath(path: string): Promise<string>;
  /** Recursively remove a directory; absent is not an error. */
  removeDir(path: string): Promise<void>;
  /** Repo-relative `*_test.ts` / `*.test.ts` paths. */
  listTestFiles(repoPath: string): Promise<string[]>;
  /** Create an empty temporary directory outside any repository. */
  makeTempDir(): Promise<string>;
}

export interface MutationRunInput {
  repoPath: string;
  diff: string;
  budgetSeconds: number;
  mutantCap?: number;
  jobs?: number;
  /**
   * The credentials this repository declared in `quality_credentials`
   * (Issues #573, #574), already resolved. They reach every child the runner
   * spawns, so tests that need them pass here as they do in the quality gate;
   * nothing else beyond the allowlist does.
   */
  credentialEnv?: Record<string, string>;
}

const DENO_MARKERS = ["deno.json", "deno.jsonc", "deno.lock"];
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/;
const RELATIVE_SPECIFIER = /["'](\.{1,2}\/[^"']*)["']/g;
const CARGO_MUTANTS_MISSING =
  "cargo-mutants is not installed; install it or set skip_mutation_check";

/**
 * Repo-relative directory of the nearest ancestor of `file` (itself included)
 * holding a Deno marker, `""` for the repository root, or null when none does.
 * A marker that resolves outside the repository does not count.
 */
export async function findDenoConfigDir(
  repoPath: string,
  file: string,
  seams: MutationRunnerSeams,
): Promise<string | null> {
  let dir = dirOf(normalisePath(file));
  for (;;) {
    for (const marker of DENO_MARKERS) {
      const abs = await confinePath(
        repoPath,
        dir === "" ? marker : `${dir}/${marker}`,
        seams,
      );
      if (abs !== null && await seams.exists(abs)) return dir;
    }
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

/**
 * Deno markers at the repo root win; then a changed non-test source file under
 * a nested Deno project (`worker/deno/deno.json`); otherwise a root
 * `Cargo.toml` means Rust.
 */
export async function detectMutationLanguage(
  repoPath: string,
  seams: MutationRunnerSeams,
  changedFiles: Iterable<string> = [],
): Promise<MutationLanguage | null> {
  for (const marker of DENO_MARKERS) {
    if (await seams.exists(`${repoPath}/${marker}`)) return "deno";
  }
  for (const file of changedFiles) {
    if (!isDenoSource(file)) continue;
    if (await findDenoConfigDir(repoPath, file, seams) !== null) return "deno";
  }
  if (await seams.exists(`${repoPath}/Cargo.toml`)) return "rust";
  return null;
}

function isDenoSource(file: string): boolean {
  return SOURCE_FILE.test(file) && !file.endsWith(".d.ts") &&
    !isDenoTestFile(file);
}

export async function runMutationCheck(
  input: MutationRunInput,
  seams: MutationRunnerSeams,
): Promise<MutationCheckResult> {
  try {
    if (input.diff.trim() === "") {
      return { kind: "not_applicable", reason: "the diff is empty" };
    }
    const language = await detectMutationLanguage(
      input.repoPath,
      seams,
      parseAddedLines(input.diff).keys(),
    );
    if (language === null) {
      return {
        kind: "not_applicable",
        reason: "no Deno project (deno.json, deno.jsonc or deno.lock) " +
          "above a changed source file and no Cargo.toml at the repository " +
          "root",
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

/**
 * Resolve `rel` under `repoPath` to a canonical path that is guaranteed to sit
 * inside the canonical repository root, or null when it does not.
 *
 * 1. Join and lexically normalise; a `..` that climbs above the root rejects.
 * 2. Canonicalise the longest existing prefix (resolving any symlink in it)
 *    and re-attach the not-yet-existing tail.
 * 3. Require the result to be inside the canonical repository root.
 */
export async function confinePath(
  repoPath: string,
  rel: string,
  seams: MutationRunnerSeams,
): Promise<string | null> {
  if (rel.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return null;
    } else parts.push(part);
  }
  const root = await seams.realPath(repoPath);
  const tail: string[] = [];
  let prefix = `${repoPath.replace(/\/+$/, "")}/${parts.join("/")}`
    .replace(/\/+$/, "");
  let canonical: string | null = null;
  while (prefix !== "") {
    try {
      canonical = await seams.realPath(prefix);
      break;
    } catch {
      tail.unshift(prefix.slice(prefix.lastIndexOf("/") + 1));
      prefix = dirOf(prefix);
    }
  }
  if (canonical === null) return null;
  const full = tail.length === 0 ? canonical : `${canonical}/${tail.join("/")}`;
  const rootDir = root.endsWith("/") ? root : `${root}/`;
  return full === root || full.startsWith(rootDir) ? full : null;
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
    if (importsModule(text, dirOf(test), module)) found.push(test);
  }
  return found;
}

/** Does `text` (in directory `dir`) import the repo-relative `module`? */
export function importsModule(
  text: string,
  dir: string,
  module: string,
): boolean {
  for (const m of text.matchAll(RELATIVE_SPECIFIER)) {
    const spec = m[1];
    if (spec === undefined) continue;
    if (normalisePath(`${dir}/${spec}`) === module) return true;
  }
  return false;
}

/**
 * `deno test` arguments for the mutation runs. `--no-check` is load-bearing:
 * a mutant (`return undefined;` in a `: boolean` function, a negated operand)
 * usually fails type-checking, and a non-zero exit from the type-checker would
 * be read as a test going red, so every such mutant would count as killed
 * whether or not a test pins the line. Run without the type-checker, the exit
 * code reflects only the tests' own verdict.
 */
function denoTestArgs(tests: readonly string[]): string[] {
  return ["test", "--no-check", "-A", ...tests];
}

/**
 * Did this `deno test` run fail because a module could not be parsed, rather
 * than because a test went red? A parse error aborts the module graph load, so
 * deno prints `error: SyntaxError: ...` on stderr before any test runs. A
 * `SyntaxError` thrown inside a test is printed on stdout, leaving stderr at
 * `error: Test failed`.
 */
export function isParseFailure(run: ProcessResult): boolean {
  return /^error: SyntaxError:/m.test(run.stderr);
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
  const modules: Array<{
    file: string;
    lines: number[];
    abs: string;
    configDir: string;
  }> = [];
  for (const [file, lines] of added) {
    if (!isDenoSource(file)) continue;
    const abs = await confinePath(repoPath, file, seams);
    if (abs === null || !(await seams.exists(abs))) continue;
    const configDir = await findDenoConfigDir(repoPath, file, seams);
    if (configDir === null) continue;
    modules.push({ file: normalisePath(file), lines, abs, configDir });
  }
  if (modules.length === 0) {
    return {
      kind: "not_applicable",
      reason: "the diff adds no lines to non-test Deno source files " +
        "inside a Deno project",
    };
  }

  const cap = input.mutantCap ?? DEFAULT_MUTANT_CAP;
  const originals = new Map<string, string>();
  const absFor = new Map<string, string>();
  const configDirFor = new Map<string, string>();
  const mutants: Array<
    ReturnType<typeof generateDenoMutantsDetailed>["mutants"][number]
  > = [];
  // Candidates the cap or the line-length limit kept from being tried.
  let dropped = 0;
  for (const mod of modules) {
    const source = await seams.readTextFile(mod.abs);
    originals.set(mod.file, source);
    absFor.set(mod.file, mod.abs);
    configDirFor.set(mod.file, mod.configDir);
    const generated = generateDenoMutantsDetailed(
      mod.file,
      source,
      mod.lines,
      Math.max(0, cap - mutants.length),
    );
    mutants.push(...generated.mutants);
    dropped += generated.dropped;
  }
  if (mutants.length === 0 && dropped === 0) {
    return {
      kind: "not_applicable",
      reason: "no mutable statements on the added lines",
    };
  }

  // Tests run from the module's own project directory, so that project's
  // deno.json (imports, tasks, permissions) applies.
  const testFiles = await seams.listTestFiles(repoPath);
  const testsFor = new Map<string, string[]>();
  for (const file of new Set(mutants.map((m) => m.file))) {
    const configDir = configDirFor.get(file) ?? "";
    const prefix = configDir === "" ? "" : `${configDir}/`;
    const inProject = testFiles.filter((t) => t.startsWith(prefix));
    const importing = await findImportingTests(
      file,
      inProject,
      seams,
      repoPath,
    );
    testsFor.set(file, importing.map((t) => t.slice(prefix.length)));
  }
  const cwdFor = (file: string) => {
    const configDir = configDirFor.get(file) ?? "";
    return configDir === "" ? repoPath : `${repoPath}/${configDir}`;
  };

  const survivors: Mutant[] = [];
  let killed = 0;
  let tested = 0;
  const total = mutants.length + dropped;
  const exhausted = (limit?: "mutant_cap"): MutationCheckResult => ({
    kind: "budget_exhausted",
    language: "deno",
    survivors,
    killed,
    tested,
    total,
    budgetSeconds,
    ...(limit === undefined ? {} : { limit }),
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

  const childEnv = input.credentialEnv === undefined
    ? {}
    : { env: input.credentialEnv };

  // Baseline: the importing tests must pass unmutated.
  const baselined = new Set<string>();
  for (const m of runnable) {
    const tests = testsFor.get(m.file) ?? [];
    const key = `${configDirFor.get(m.file) ?? ""}\n${tests.join("\n")}`;
    if (baselined.has(key)) continue;
    baselined.add(key);
    if (remaining() <= 0) return exhausted();
    const base = await seams.runProcess("deno", denoTestArgs(tests), {
      cwd: cwdFor(m.file),
      timeoutMs: remaining(),
      ...childEnv,
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
    const path = absFor.get(m.file);
    if (path === undefined) continue;
    const original = originals.get(m.file) ?? "";
    let result: ProcessResult;
    try {
      await seams.writeTextFile(path, m.mutatedSource);
      result = await seams.runProcess("deno", denoTestArgs(tests), {
        cwd: cwdFor(m.file),
        timeoutMs: remaining(),
        ...childEnv,
      });
    } finally {
      await seams.writeTextFile(path, original);
    }
    if (result.timedOut) return exhausted();
    tested++;
    // A mutant the parser rejects is unviable: no test ran, so it is neither
    // killed nor a survivor.
    if (result.code !== 0 && isParseFailure(result)) continue;
    if (result.code !== 0) killed++;
    else {
      survivors.push({
        file: m.file,
        line: m.line,
        description: m.description,
      });
    }
  }
  // A capped run is never a clean pass: candidates past the cap were not tried.
  if (dropped > 0) return exhausted("mutant_cap");
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

/** Cargo package names are restricted to this allow-list before use in argv. */
const PACKAGE_NAME = /^[A-Za-z0-9_-]+$/;

/** The `name = "..."` under `[package]` in a Cargo.toml, or null. */
function packageNameOf(toml: string): string | null {
  let section = "";
  for (const line of toml.split("\n")) {
    const header = /^\s*\[([^\]]*)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = (header[1] ?? "").trim();
      continue;
    }
    if (section !== "package") continue;
    const name = /^\s*name\s*=\s*"([^"]*)"/.exec(line);
    if (name) return name[1] ?? null;
  }
  return null;
}

/**
 * Distinct, allow-listed package names owning the changed `.rs` files: for
 * each file the nearest ancestor `Cargo.toml` with a `[package]` section.
 */
async function touchedPackages(
  repoPath: string,
  files: Iterable<string>,
  seams: MutationRunnerSeams,
): Promise<string[]> {
  const names = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".rs")) continue;
    let dir = dirOf(file);
    for (;;) {
      const manifest = dir === "" ? "Cargo.toml" : `${dir}/Cargo.toml`;
      const abs = await confinePath(repoPath, manifest, seams);
      if (abs !== null && await seams.exists(abs)) {
        const name = packageNameOf(await seams.readTextFile(abs));
        if (name !== null) {
          if (PACKAGE_NAME.test(name)) names.add(name);
          break;
        }
      }
      if (dir === "") break;
      dir = dirOf(dir);
    }
  }
  return [...names];
}

async function runRust(
  input: MutationRunInput,
  seams: MutationRunnerSeams,
): Promise<MutationCheckResult> {
  const { repoPath } = input;
  const added = parseAddedLines(input.diff);
  if (![...added.keys()].some((f) => f.endsWith(".rs"))) {
    return {
      kind: "not_applicable",
      reason: "the diff adds no lines to Rust source files",
    };
  }
  const diffPath = await confinePath(
    repoPath,
    "target/vibe-mutation-check.diff",
    seams,
  );
  if (diffPath === null) {
    return {
      kind: "error",
      reason: "target/vibe-mutation-check.diff resolves outside the " +
        "repository (is target a symlink?); refusing to write it",
    };
  }
  const packages = await touchedPackages(repoPath, added.keys(), seams);
  // cargo-mutants writes `mutants.out/` (outcomes, logs, diffs, lock) under
  // `--output`. Pointing that at a fresh directory outside the repository
  // keeps it out of the working tree (a recovery commit runs `git add -A`)
  // and means a stale copy can never be read as this run's.
  const outDir = await seams.makeTempDir();
  try {
    return await runCargoMutants(input, seams, diffPath, packages, outDir);
  } finally {
    await seams.removeDir(outDir);
  }
}

async function runCargoMutants(
  input: MutationRunInput,
  seams: MutationRunnerSeams,
  diffPath: string,
  packages: readonly string[],
  outDir: string,
): Promise<MutationCheckResult> {
  const { repoPath, budgetSeconds } = input;
  await seams.writeTextFile(diffPath, input.diff);
  const jobs = input.jobs ??
    Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 2));
  const proc = await seams.runProcess(
    "cargo",
    [
      "mutants",
      ...packages.flatMap((p) => ["--package", p]),
      "--in-diff",
      diffPath,
      "--output",
      outDir,
      "--no-shuffle",
      "--jobs",
      String(jobs),
    ],
    {
      cwd: repoPath,
      timeoutMs: budgetSeconds * 1000,
      ...(input.credentialEnv === undefined
        ? {}
        : { env: input.credentialEnv }),
    },
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

  const outcomesPath = `${outDir}/mutants.out/outcomes.json`;
  let text: string | null = null;
  if (await seams.exists(outcomesPath)) {
    text = await seams.readTextFile(outcomesPath);
  }
  const parsed = text === null ? null : parseOutcomes(text);

  if (proc.timedOut || (proc.code === 3 && parsed === null)) {
    if (parsed === null) {
      if (proc.timedOut) {
        // Out of budget before the clean build and baseline test run finished,
        // so no outcomes were written: report it honestly as an untried run
        // (a warning), as the Deno baseline timeout is, not as an error.
        return {
          kind: "budget_exhausted",
          language: "rust",
          survivors: [],
          killed: 0,
          tested: 0,
          total: 0,
          budgetSeconds,
        };
      }
      return {
        kind: "error",
        reason: "cargo mutants exited with timeouts and wrote no parseable " +
          "mutants.out/outcomes.json; cannot judge mutants",
      };
    }
    return {
      kind: "budget_exhausted",
      language: "rust",
      survivors: parsed.survivors,
      killed: parsed.killed,
      tested: parsed.tested,
      total: parsed.total,
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

/**
 * Real seams: `Deno.Command` with kill-on-timeout, real clock and filesystem.
 *
 * The mutation gate runs repository code (`deno test -A`, `cargo mutants`'s
 * build scripts and tests) after the agent has written tests, so a child never
 * inherits the worker's environment: it gets
 * {@link buildUntrustedCommandEnv}'s allowlist with `clearEnv`, the same
 * control every other repository-controlled spawn uses (Issue #572). The
 * credentials the repository declared come in as `opts.env` and are applied as
 * `overrides`, as the quality gate does (Issues #573, #574).
 */
export function defaultMutationRunnerSeams(
  /** Environment the allowlist is applied to; tests only. Default: the worker's. */
  envSource?: Record<string, string>,
): MutationRunnerSeams {
  return {
    async runProcess(cmd, args, opts) {
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(cmd, {
          args,
          cwd: opts.cwd,
          env: buildUntrustedCommandEnv({
            ...(envSource === undefined ? {} : { source: envSource }),
            ...(opts.env === undefined ? {} : { overrides: opts.env }),
          }),
          clearEnv: true,
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
    realPath: (path) => Deno.realPath(path),
    async removeDir(path) {
      try {
        await Deno.remove(path, { recursive: true });
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    },
    makeTempDir: () => Deno.makeTempDir({ prefix: "vibe-mutation-" }),
    async listTestFiles(repoPath) {
      const out: string[] = [];
      await walkTests(repoPath, "", out);
      return out.sort();
    },
  };
}
