/**
 * Coverage carry-over runner (Issue #3795): the I/O half of the coverage
 * carry-over gate. Every side effect goes through {@link MutationRunnerSeams}
 * so tests can drive it with an in-memory filesystem and a scripted process
 * runner.
 *
 * The base versions of the removed or edited Deno tests run under line
 * coverage in a detached git worktree at the merge base. The production lines
 * they reached are mapped through the diff to head; each one still present and
 * unchanged at head is carried over, and every carried line that no head test
 * reaches is reported. The worktree and all temporary files live outside the
 * repository and are removed on the way out.
 *
 * The head side runs in two steps, so its cost follows what is left to check:
 * first the head versions of the edited tests that still exist, then, only for
 * the files that still have an unreached carried line, the tests that import
 * that file directly, one carried file at a time in its own batch, recomputing
 * what is left after each batch so a file reached by an earlier batch is
 * skipped.
 *
 * Known limit: beyond the edited tests, the head side counts only tests that
 * import a module directly. A line reached only indirectly (through another
 * module) is reported uncovered, and can be exempted.
 *
 * Confinement: test and module paths are repo-relative and resolved through
 * {@link findDenoConfigDir}, which confines them to the repository (symlinks
 * resolved). Coverage records are kept only when their path sits under the
 * canonical worktree or repository root. Child processes get the same
 * allowlisted environment as the mutation runner (see
 * `defaultMutationRunnerSeams`).
 *
 * Australian English spelling used throughout.
 */

import {
  type CarriedLine,
  type CoverageCarryOverResult,
  mapLine,
  parseFileHunks,
  parseLcov,
  removedOrEditedTestFiles,
  removesRustTestLines,
} from "./coverage_carryover_gate.ts";
import { isDenoTestFile } from "./mutation_gate.ts";
import {
  findDenoConfigDir,
  importsModule,
  type MutationRunnerSeams,
  type ProcessResult,
} from "./mutation_runner.ts";

export interface CoverageCarryOverInput {
  repoPath: string;
  /** The PR's base ref; the check runs at its merge base with HEAD. */
  base: string;
  /** `git diff --unified=0 --no-renames <base>...HEAD` output. */
  diff: string;
  budgetSeconds: number;
  /**
   * Credentials the repository declared (as in the mutation runner). They reach
   * the `deno test` children only.
   */
  credentialEnv?: Record<string, string>;
}

/** Each git call; git time is not counted against the test budget. */
const GIT_TIMEOUT_MS = 120_000;
const RUST_NEEDS_LLVM_COV =
  "Rust coverage carry-over needs cargo-llvm-cov, which the worker container does not install";
const NO_DENO_TESTS =
  "the diff removes no lines from an existing Deno test file";
const NO_DENO_PROJECT =
  "no Deno project above the edited or removed test files";
/** Deno's SGR colour codes, which it prints even when stderr is a pipe. */
// deno-lint-ignore no-control-regex
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** Repo-relative file -> line -> hit count. */
type Coverage = Map<string, Map<number, number>>;

/** Throws nothing: any failure becomes an `error` result, as runMutationCheck does. */
export async function runCoverageCarryOverCheck(
  input: CoverageCarryOverInput,
  seams: MutationRunnerSeams,
): Promise<CoverageCarryOverResult> {
  try {
    return await runCheck(input, seams);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", reason: message };
  }
}

async function runCheck(
  input: CoverageCarryOverInput,
  seams: MutationRunnerSeams,
): Promise<CoverageCarryOverResult> {
  const tests = removedOrEditedTestFiles(input.diff);
  if (tests.length === 0) {
    return {
      kind: "not_applicable",
      reason: removesRustTestLines(input.diff)
        ? RUST_NEEDS_LLVM_COV
        : NO_DENO_TESTS,
    };
  }
  const start = seams.now();
  const budgetMs = input.budgetSeconds * 1000;
  const remaining = () => budgetMs - (seams.now() - start);

  const mergeBase = await git(seams, input.repoPath, [
    "merge-base",
    input.base,
    "HEAD",
  ]);
  if (mergeBase.code !== 0 || mergeBase.timedOut) {
    return {
      kind: "error",
      reason: `git merge-base failed: ${cause(mergeBase, false)}`,
    };
  }
  const sha = mergeBase.stdout.trim();

  const tmp = await seams.makeTempDir();
  const worktree = `${tmp}/base`;
  try {
    const add = await git(seams, input.repoPath, [
      "worktree",
      "add",
      "--detach",
      worktree,
      sha,
    ]);
    if (add.code !== 0 || add.timedOut) {
      return {
        kind: "error",
        reason: `git worktree add failed: ${cause(add, false)}`,
      };
    }
    return await carryOver(input, seams, { tests, tmp, worktree, remaining });
  } finally {
    await cleanUp(seams, input.repoPath, worktree, tmp);
  }
}

interface CheckContext {
  tests: string[];
  tmp: string;
  worktree: string;
  remaining: () => number;
}

async function carryOver(
  input: CoverageCarryOverInput,
  seams: MutationRunnerSeams,
  ctx: CheckContext,
): Promise<CoverageCarryOverResult> {
  const { tests, tmp, worktree, remaining } = ctx;
  const childEnv: { env?: Record<string, string> } =
    input.credentialEnv === undefined ? {} : { env: input.credentialEnv };
  const exhausted = (): CoverageCarryOverResult => ({
    kind: "budget_exhausted",
    changedTests: tests,
    budgetSeconds: input.budgetSeconds,
  });

  // Base: the edited or removed tests, run at the merge base under coverage.
  const groups = await groupByProject(worktree, tests, seams);
  if (groups.size === 0) {
    return { kind: "not_applicable", reason: NO_DENO_PROJECT };
  }
  const baseCov: Coverage = new Map();
  let baseIndex = 0;
  const baseStop = await runUnderCoverage(seams, {
    root: worktree,
    canonicalRoot: await seams.realPath(worktree),
    groups,
    covDir: () => `${tmp}/cov-base-${baseIndex++}`,
    failure: "base tests fail at the merge base",
    remaining,
    childEnv,
    exhausted,
    target: baseCov,
  });
  if (baseStop !== null) return baseStop;

  // Executed base lines that survive the diff, mapped to head and de-duplicated.
  const parsed = parseFileHunks(input.diff);
  const carried = new Map<string, CarriedLine>();
  for (const [file, lines] of baseCov) {
    if (isDenoTestFile(file)) continue;
    for (const [line, hits] of lines) {
      if (hits <= 0) continue;
      const head = mapLine(parsed, file, line);
      if (head !== null) carried.set(`${head.file}\n${head.line}`, head);
    }
  }
  const carriedLines = [...carried.values()];
  if (carriedLines.length === 0) {
    return {
      kind: "completed",
      changedTests: tests,
      carried: 0,
      uncovered: [],
    };
  }

  const headCov: Coverage = new Map();
  let headIndex = 0;
  const headRun = {
    root: input.repoPath,
    canonicalRoot: await seams.realPath(input.repoPath),
    covDir: () => `${tmp}/cov-head-${headIndex++}`,
    failure: "head tests fail",
    remaining,
    childEnv,
    exhausted,
    target: headCov,
  };
  const unreached = (lines: CarriedLine[]) =>
    lines.filter((c) => (headCov.get(c.file)?.get(c.line) ?? 0) <= 0);

  // Head, first: the head versions of the edited tests that still exist. They
  // usually still reach most of what their base versions reached.
  const editedAtHead: string[] = [];
  for (const t of tests) {
    if (await seams.exists(`${input.repoPath}/${t}`)) editedAtHead.push(t);
  }
  const editedStop = await runUnderCoverage(seams, {
    ...headRun,
    groups: await groupByProject(input.repoPath, editedAtHead, seams),
  });
  if (editedStop !== null) return editedStop;

  // Head, then: only for files that still have an unreached carried line, the
  // tests that import that file directly (within its project). Importers run
  // one carried file at a time, each in its own batch, and what is still
  // unreached is recomputed after each batch. A file an earlier batch's
  // importer already reaches (directly, or through that importer's own
  // imports) is skipped, so a deleted whole test file whose loaded modules
  // share importers runs only a bounded number of them, not every importer of
  // every module in one `deno test` call.
  const afterEdited = unreached(carriedLines);
  if (afterEdited.length > 0) {
    const alreadyRun = new Set(editedAtHead);
    const headTests = await seams.listTestFiles(input.repoPath);
    const sources = new Map<string, string>();
    const readHead = async (rel: string): Promise<string> => {
      const cached = sources.get(rel);
      if (cached !== undefined) return cached;
      const text = await seams.readTextFile(`${input.repoPath}/${rel}`);
      sources.set(rel, text);
      return text;
    };
    const files = [...new Set(afterEdited.map((c) => c.file))].sort();
    for (const file of files) {
      if (unreached(afterEdited).every((c) => c.file !== file)) continue;
      const dir = await findDenoConfigDir(input.repoPath, file, seams);
      if (dir === null) continue;
      const prefix = dirPrefix(dir);
      const batch: string[] = [];
      for (const t of headTests) {
        if (!t.startsWith(prefix) || alreadyRun.has(t)) continue;
        // SIMPLE-ON-PURPOSE: only direct imports count, with no transitive import graph — upgrade when a line reached only through a helper module is reported uncovered in practice.
        if (importsModule(await readHead(t), dirOf(t), file)) {
          batch.push(t);
          alreadyRun.add(t);
        }
      }
      const stop = await runUnderCoverage(seams, {
        ...headRun,
        groups: new Map([[dir, batch]]),
      });
      if (stop !== null) return stop;
    }
  }

  const uncovered = unreached(afterEdited);
  uncovered.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
  );
  return {
    kind: "completed",
    changedTests: tests,
    carried: carriedLines.length,
    uncovered,
  };
}

interface CoverageRun {
  /** Where the tests are run from: the base worktree or the repository. */
  root: string;
  /** `root` with symlinks resolved; lcov records outside it are dropped. */
  canonicalRoot: string;
  /** Repo-relative test files by Deno project directory. */
  groups: Map<string, string[]>;
  /** The next fresh coverage directory. */
  covDir: () => string;
  /** How a failing test run is named in the error reason. */
  failure: string;
  remaining: () => number;
  childEnv: { env?: Record<string, string> };
  exhausted: () => CoverageCarryOverResult;
  /** Coverage is merged into this map. */
  target: Coverage;
}

/**
 * Run each project's tests under coverage, in project order, and merge the
 * reports into `run.target`. Null when every run succeeded; otherwise the
 * result the check stops with (budget exhaustion or an error).
 */
async function runUnderCoverage(
  seams: MutationRunnerSeams,
  run: CoverageRun,
): Promise<CoverageCarryOverResult | null> {
  for (const dir of [...run.groups.keys()].sort()) {
    const list = [...new Set(run.groups.get(dir) ?? [])].sort();
    if (list.length === 0) continue;
    const covDir = run.covDir();
    const cwd = projectDir(run.root, dir);
    const tested = await denoStep(
      seams,
      testArgs(covDir, list.map((t) => relativeTo(dir, t))),
      cwd,
      run.remaining,
      run.childEnv,
    );
    if (tested === null) return run.exhausted();
    if (tested.code !== 0) {
      return {
        kind: "error",
        reason: `${run.failure} (${list.join(", ")}): ${cause(tested, true)}`,
      };
    }
    const report = await denoStep(
      seams,
      ["coverage", "--lcov", covDir],
      cwd,
      run.remaining,
      {},
    );
    if (report === null) return run.exhausted();
    if (report.code !== 0) {
      return {
        kind: "error",
        reason: `deno coverage failed: ${cause(report, false)}`,
      };
    }
    addCoverage(run.target, parseLcov(report.stdout), run.canonicalRoot);
  }
  return null;
}

/** Run one git command in the repository; git time is bounded but not budgeted. */
function git(
  seams: MutationRunnerSeams,
  repoPath: string,
  args: string[],
): Promise<ProcessResult> {
  return seams.runProcess("git", args, {
    cwd: repoPath,
    timeoutMs: GIT_TIMEOUT_MS,
  });
}

/**
 * Run one `deno` step within the remaining budget. Null when the budget is spent
 * before it starts or the step itself times out.
 */
async function denoStep(
  seams: MutationRunnerSeams,
  args: string[],
  cwd: string,
  remaining: () => number,
  extra: { env?: Record<string, string> },
): Promise<ProcessResult | null> {
  const timeoutMs = remaining();
  if (timeoutMs <= 0) return null;
  const run = await seams.runProcess("deno", args, {
    cwd,
    timeoutMs,
    ...extra,
  });
  return run.timedOut ? null : run;
}

/**
 * The reason a failed child is reported with: the first non-empty stderr line
 * after stripping colour codes. With `preferError`, the first line that starts
 * with `error:` wins.
 */
function cause(run: ProcessResult, preferError: boolean): string {
  if (run.timedOut) return "timed out";
  const lines = stripAnsi(run.stderr).split("\n").map((l) => l.trim()).filter((
    l,
  ) => l !== "");
  const preferred = preferError
    ? lines.find((l) => l.startsWith("error:"))
    : undefined;
  return preferred ?? lines[0] ?? `exit code ${run.code}`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}

/** Remove the worktree and the temporary directory; failures never change the result. */
async function cleanUp(
  seams: MutationRunnerSeams,
  repoPath: string,
  worktree: string,
  tmp: string,
): Promise<void> {
  const removed = await quietly(() =>
    git(seams, repoPath, ["worktree", "remove", "--force", worktree])
  );
  if (removed === null || removed.code !== 0 || removed.timedOut) {
    await quietly(() => seams.removeDir(tmp));
    await quietly(() => git(seams, repoPath, ["worktree", "prune"]));
  }
  await quietly(() => seams.removeDir(tmp));
}

async function quietly<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Test files grouped by their nearest Deno project directory (`""` for the root). */
async function groupByProject(
  root: string,
  tests: readonly string[],
  seams: MutationRunnerSeams,
): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>();
  for (const t of tests) {
    const dir = await findDenoConfigDir(root, t, seams);
    if (dir === null) continue;
    groups.set(dir, [...(groups.get(dir) ?? []), t]);
  }
  return groups;
}

/** Merge one lcov report into `target`, keeping only paths under `root`. */
function addCoverage(target: Coverage, lcov: Coverage, root: string): void {
  for (const [sf, lines] of lcov) {
    if (!sf.startsWith(`${root}/`)) continue;
    const rel = sf.slice(root.length + 1);
    const dst = target.get(rel) ?? new Map<number, number>();
    for (const [line, hits] of lines) {
      dst.set(line, (dst.get(line) ?? 0) + hits);
    }
    target.set(rel, dst);
  }
}

function testArgs(covDir: string, rels: string[]): string[] {
  return ["test", "--no-check", "-A", `--coverage=${covDir}`, ...rels];
}

function projectDir(root: string, dir: string): string {
  return dir === "" ? root : `${root}/${dir}`;
}

function dirPrefix(dir: string): string {
  return dir === "" ? "" : `${dir}/`;
}

function relativeTo(dir: string, path: string): string {
  return path.slice(dirPrefix(dir).length);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
