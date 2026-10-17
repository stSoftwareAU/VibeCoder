/**
 * Security-fix discrimination (Issue #3659, VulnHunter Step E.5): the worker,
 * not the agent, runs the security test a PR summary names and checks that it
 * discriminates the fix. The test must be red against the vulnerable code and
 * green against the fixed code; a test that passes both ways proves nothing.
 *
 * The test is run twice in a disposable checkout:
 *
 * 1. at the head (the branch as it stands), expecting green; then
 * 2. with the base branch's versions of the changed non-test files restored,
 *    expecting red.
 *
 * The disposable checkout is a `git clone --shared` of the issue checkout,
 * detached at the head commit, with its remote removed, and it is removed
 * afterwards. The issue checkout itself is never modified.
 *
 * The base versions are taken at the merge base, matching the
 * `<base>...HEAD` diff the gate read: a base branch that has moved on since
 * the branch was cut must not be mistaken for part of the fix. A production
 * file the branch added has no base version, so it stays at its head version.
 *
 * "Could not run" is never counted as red. A missing import, a filter that
 * matches nothing, a timeout, a git failure or an exhausted budget all return
 * `not_checked`; only a named test line reported `FAILED` is a fail outcome.
 * Counting a broken run as red would let any test pass the gate by failing to
 * start (the #3615 shape).
 *
 * Children run under the mutation runner's allowlisted environment
 * (`buildUntrustedCommandEnv`, applied by the {@link MutationRunnerSeams}
 * `runProcess`); the repository's declared credentials reach the `deno` and
 * `cargo` runs only, never git.
 *
 * Deno tests (`deno test --filter`) and Rust tests (`cargo test <name>`, run in
 * the nearest package directory) are runnable; a cited test in any other
 * language is `not_checked`, naming its language as the cause.
 *
 * Every cited test is run in turn under one shared budget, and the fix is
 * discriminated when any one of them goes red at the base and green at the head
 * (see {@link runSecurityFixDiscrimination}).
 *
 * Australian English spelling used throughout.
 */

import { isDenoTestFile } from "./mutation_gate.ts";
import {
  findCargoPackageDir,
  findDenoConfigDir,
  type MutationRunnerSeams,
  type ProcessResult,
} from "./mutation_runner.ts";

export type DiscriminationRunOutcome = "pass" | "fail";

export interface CitedSecurityTest {
  /** Repo-relative test file path. */
  file: string;
  /** The declared test name, as written. */
  name: string;
}

/** One cited test's two runs: the base's production files, then the head. */
export interface DiscriminationRun {
  test: CitedSecurityTest;
  preFix: DiscriminationRunOutcome;
  postFix: DiscriminationRunOutcome;
}

/** A cited test that could not be run, with the cause retained as evidence. */
export interface DiscriminationNotRun {
  test: CitedSecurityTest;
  reason: string;
}

/**
 * `checked` carries the deciding run (a red-to-green test if the summary cited
 * one, else the first) and, when the summary cited several tests, every other
 * completed run in `others` and each unrun test with its cause in `notRun`.
 * The gate decides on the deciding run alone. A `not_checked` result for
 * several cited tests keeps each test's outcome or cause in structured entries
 * rather than one long `reason`, so the bounded stored record loses none.
 */
export type SecurityFixDiscrimination =
  | ({
    kind: "checked";
    others?: DiscriminationRun[];
    notRun?: DiscriminationNotRun[];
  } & DiscriminationRun)
  | {
    kind: "not_checked";
    /** A short summary line; per-test detail lives in `runs` and `notRun`. */
    reason: string;
    /** Completed base/head outcomes, when several tests were cited. */
    runs?: DiscriminationRun[];
    /** Each cited test that could not run, with its own cause. */
    notRun?: DiscriminationNotRun[];
  };

export interface DiscriminationRunInput {
  /** The issue checkout. */
  repoPath: string;
  /** Resolved base ref in `repoPath`, e.g. "origin/main". */
  baseRef: string;
  /** Changed non-test files (repo-relative), caller-filtered. */
  productionFiles: string[];
  /** Cited tests, in summary/diff order. */
  tests: CitedSecurityTest[];
  budgetSeconds: number;
  /** Passed as `runProcess` `opts.env` to the deno and cargo runs only. */
  credentialEnv?: Record<string, string>;
}

export const DEFAULT_DISCRIMINATION_BUDGET_SECONDS = 600;

const CLIP = 300;

/** Deno colours some output even on a pipe; drop the SGR codes. */
function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}...` : text;
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of stripAnsi(text).split("\n")) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return null;
}

/**
 * The outcome `deno test` reported for the test called `name`: "pass" for an
 * unindented `<name> ... ok` line, "fail" for `<name> ... FAILED` (each
 * optionally followed by ` (<duration>)`), and null for anything else (absent,
 * `ignored`, or only an indented `t.step` line). A filter that matches nothing
 * exits 0 and prints no such line, so null, never a pass.
 */
export function namedTestOutcome(
  stdout: string,
  name: string,
): DiscriminationRunOutcome | null {
  for (const raw of stripAnsi(stdout).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(name)) continue;
    const rest = line.slice(name.length);
    if (matchStatus(rest, " ... ok")) return "pass";
    if (matchStatus(rest, " ... FAILED")) return "fail";
  }
  return null;
}

function matchStatus(rest: string, marker: string): boolean {
  if (!rest.startsWith(marker)) return false;
  const tail = rest.slice(marker.length);
  return tail === "" || (tail.startsWith(" (") && tail.endsWith(")"));
}

/** libtest appends this to the path of a `#[should_panic]` test's line. */
const SHOULD_PANIC_SUFFIX = " - should panic";

function stripShouldPanic(path: string): string {
  return path.endsWith(SHOULD_PANIC_SUFFIX)
    ? path.slice(0, -SHOULD_PANIC_SUFFIX.length)
    : path;
}

/**
 * The outcome `cargo test` reported for the test whose function is `name`: a
 * `test <path> ... ok` or `... FAILED` line whose path is `name` or ends in
 * `::name` (a test inside a `mod`), with libtest's ` - should panic` suffix on
 * a `#[should_panic]` test ignored. "fail" wins when several tests share the
 * name and any failed; null for anything else (absent, `ignored`), so a filter
 * that matches nothing, or a build that never reached the tests, is never a
 * pass.
 */
export function namedRustTestOutcome(
  stdout: string,
  name: string,
): DiscriminationRunOutcome | null {
  let outcome: DiscriminationRunOutcome | null = null;
  for (const raw of stripAnsi(stdout).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("test ")) continue;
    const sep = line.indexOf(" ... ");
    if (sep < 0) continue;
    const path = stripShouldPanic(line.slice(5, sep));
    if (path !== name && !path.endsWith(`::${name}`)) continue;
    const status = line.slice(sep + 5);
    if (status === "FAILED") return "fail";
    if (status === "ok") outcome = "pass";
  }
  return outcome;
}

/** A Rust function name, as a `cargo test` filter. Leading `-` can never match. */
const RUST_TEST_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRustFile(file: string): boolean {
  return file.endsWith(".rs");
}

function notChecked(reason: string): SecurityFixDiscrimination {
  return { kind: "not_checked", reason };
}

/** Carries a not_checked reason out of the step helpers. */
class NotChecked extends Error {}

/** Whether the worker can execute this cited test (a Deno or Rust one). */
function isRunnable(t: CitedSecurityTest): boolean {
  return t.name.trim() !== "" && (isRustFile(t.file) ||
    (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(t.file) && isDenoTestFile(t.file)));
}

/** The budget shared by every cited test's runs. */
interface Clock {
  totalSeconds: number;
  remaining: () => number;
}

/**
 * Run every cited test the worker can execute (the caller bounds the count), in
 * order, within one shared budget. The fix is discriminated when any one of
 * them goes red at the base and green at the head: each cited test is a test
 * the summary names in full, so one that discriminates is evidence enough, and
 * the other runs are recorded beside it. When none does, a test that could not
 * be run makes the whole result `not_checked`, because that test may be the
 * one that discriminates.
 */
export async function runSecurityFixDiscrimination(
  input: DiscriminationRunInput,
  seams: MutationRunnerSeams,
): Promise<SecurityFixDiscrimination> {
  if (input.tests.length === 0) {
    return notChecked(
      "the PR summary cites no test the worker can execute: none declared in the branch diff and named " +
        "in full in the summary; the worker runs only Deno and Rust tests",
    );
  }
  if (input.baseRef === "" || input.baseRef.startsWith("-")) {
    return notChecked(`unusable base ref "${input.baseRef}"`);
  }

  const start = seams.now();
  const clock: Clock = {
    totalSeconds: input.budgetSeconds,
    remaining: () => input.budgetSeconds * 1000 - (seams.now() - start),
  };
  const runs: Array<
    { test: CitedSecurityTest; result: SecurityFixDiscrimination }
  > = [];
  for (const test of input.tests) {
    if (!isRunnable(test)) {
      runs.push({
        test,
        result: notChecked(
          "the language of the cited test cannot be executed: the worker " +
            `runs only Deno and Rust tests (cited: ${clip(test.file)})`,
        ),
      });
      continue;
    }
    try {
      runs.push({
        test,
        result: await discriminate(input, test, seams, clock),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runs.push({
        test,
        result: notChecked(
          err instanceof NotChecked
            ? message
            : `discrimination runner failed: ${message}`,
        ),
      });
    }
  }
  return combineRuns(runs);
}

function combineRuns(
  runs: Array<{ test: CitedSecurityTest; result: SecurityFixDiscrimination }>,
): SecurityFixDiscrimination {
  const only = runs[0];
  if (runs.length === 1 && only !== undefined) return only.result;
  const checked: DiscriminationRun[] = [];
  for (const { result } of runs) {
    if (result.kind === "checked") {
      checked.push({
        test: result.test,
        preFix: result.preFix,
        postFix: result.postFix,
      });
    }
  }
  const notRun: DiscriminationNotRun[] = runs.flatMap(({ test, result }) =>
    result.kind === "not_checked"
      ? [{
        test: { file: clip(test.file), name: clip(test.name) },
        reason: clip(result.reason),
      }]
      : []
  );
  const winner = checked.find((c) =>
    c.preFix === "fail" && c.postFix === "pass"
  );
  if (winner !== undefined) return withOthers(winner, checked, notRun);
  if (notRun.length > 0) {
    // A test that did not run may be the one that discriminates.
    return {
      kind: "not_checked",
      reason: `${notRun.length} of ${runs.length} cited tests could not be run`,
      ...(checked.length > 0 ? { runs: checked } : {}),
      notRun,
    };
  }
  return withOthers(checked[0] as DiscriminationRun, checked);
}

function withOthers(
  deciding: DiscriminationRun,
  all: DiscriminationRun[],
  notRun: DiscriminationNotRun[] = [],
): SecurityFixDiscrimination {
  const others = all.filter((c) => c !== deciding);
  return {
    kind: "checked",
    ...deciding,
    ...(others.length > 0 ? { others } : {}),
    ...(notRun.length > 0 ? { notRun } : {}),
  };
}

async function discriminate(
  input: DiscriminationRunInput,
  test: CitedSecurityTest,
  seams: MutationRunnerSeams,
  clock: Clock,
): Promise<SecurityFixDiscrimination> {
  const rust = isRustFile(test.file);
  if (rust && !RUST_TEST_NAME.test(test.name)) {
    return notChecked(
      `the cited Rust test name "${clip(test.name)}" is not a function name`,
    );
  }
  if (input.baseRef === "" || input.baseRef.startsWith("-")) {
    return notChecked(`unusable base ref "${input.baseRef}"`);
  }

  const remaining = clock.remaining;
  const guard = (what: string) => {
    if (remaining() <= 0) {
      throw new NotChecked(
        `the discrimination budget of ${clock.totalSeconds}s ran out before ${what}`,
      );
    }
  };

  const git = async (
    step: string,
    args: string[],
    cwd: string,
  ): Promise<string> => {
    guard(step);
    const res = await seams.runProcess("git", args, {
      cwd,
      timeoutMs: remaining(),
    });
    if (res.timedOut) {
      throw new NotChecked(`git ${step} timed out`);
    }
    if (res.code !== 0) {
      const cause = firstNonEmptyLine(res.stderr) ?? `exit code ${res.code}`;
      throw new NotChecked(`git ${step} failed: ${clip(cause)}`);
    }
    return res.stdout;
  };

  const headSha = (await git(
    "rev-parse",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    input.repoPath,
  )).trim();
  const baseSha = (await git(
    "merge-base",
    ["merge-base", input.baseRef, "HEAD"],
    input.repoPath,
  )).trim();

  const tmp = await seams.makeTempDir();
  try {
    const checkout = `${tmp}/checkout`;
    await git(
      "clone",
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-checkout",
        input.repoPath,
        checkout,
      ],
      tmp,
    );
    await git(
      "checkout of the head",
      ["checkout", "--quiet", "--detach", headSha],
      checkout,
    );
    await git("remote remove", ["remote", "remove", "origin"], checkout);

    const normalised = test.file.split("/").filter((p) => p !== "" && p !== ".")
      .join("/");
    const configDir = rust
      ? await findCargoPackageDir(checkout, test.file, seams)
      : await findDenoConfigDir(checkout, test.file, seams);
    if (configDir === null) {
      return notChecked(
        rust
          ? `no Cargo.toml declaring a package above ${test.file}`
          : `no deno.json, deno.jsonc or deno.lock above ${test.file}`,
      );
    }
    const relTest = configDir === ""
      ? normalised
      : normalised.slice(configDir.length + 1);
    const cwd = configDir === "" ? checkout : `${checkout}/${configDir}`;
    const [cmd, args] = rust
      ? ["cargo", rustTestArgs(relTest, test.name)] as const
      : [
        "deno",
        ["test", "--no-check", "-A", "--filter", test.name, relTest],
      ] as const;

    const runTest = async (
      where: string,
    ): Promise<
      { outcome: DiscriminationRunOutcome } | { reason: string }
    > => {
      guard(`the ${where} run`);
      const res: ProcessResult = await seams.runProcess(
        cmd,
        [...args],
        {
          cwd,
          timeoutMs: remaining(),
          ...(input.credentialEnv === undefined
            ? {}
            : { env: input.credentialEnv }),
        },
      );
      if (res.timedOut) return { reason: `the ${where} run timed out` };
      const outcome = rust
        ? namedRustTestOutcome(res.stdout, test.name)
        : namedTestOutcome(res.stdout, test.name);
      if (outcome === null) {
        return {
          reason: `the cited test did not run at the ${where}: ${
            clip(runFailureCause(res, test.name))
          }`,
        };
      }
      return { outcome };
    };

    const head = await runTest("head");
    if ("reason" in head) return notChecked(head.reason);

    if (input.productionFiles.length > 0) {
      const listed = await git(
        "ls-tree of the base",
        [
          "ls-tree",
          "-r",
          "--name-only",
          baseSha,
          "--",
          ...input.productionFiles,
        ],
        checkout,
      );
      const atBase = listed.split("\n").filter((l) => l !== "");
      if (atBase.length > 0) {
        await git(
          "restore of the base files",
          ["checkout", "--quiet", baseSha, "--", ...atBase],
          checkout,
        );
      }
    }

    const base = await runTest("base");
    if ("reason" in base) return notChecked(base.reason);

    return {
      kind: "checked",
      test,
      preFix: base.outcome,
      postFix: head.outcome,
    };
  } finally {
    await seams.removeDir(tmp);
  }
}

/**
 * `cargo test` arguments for one function. A file directly under `tests/` is its
 * own integration-test target, so `--test <stem>` skips building every other
 * target; any other layout runs the name as a filter across the package.
 */
function rustTestArgs(relTest: string, name: string): string[] {
  const target = /^tests\/([A-Za-z0-9_-]+)\.rs$/.exec(relTest)?.[1];
  return [
    "test",
    "--no-fail-fast",
    ...(target === undefined ? [] : ["--test", target]),
    name,
  ];
}

function runFailureCause(res: ProcessResult, name: string): string {
  const lines = stripAnsi(res.stderr).split("\n").map((l) => l.trim());
  // `error:` is deno's and cargo's summary; `error[E…]:` is rustc's own cause.
  const errorLine = lines.find((l) =>
    l.startsWith("error:") || l.startsWith("error[")
  );
  if (errorLine !== undefined) return errorLine;
  const first = lines.find((l) => l !== "");
  if (first !== undefined) return first;
  return `no test named "${name}" was reported`;
}
