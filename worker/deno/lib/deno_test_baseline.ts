/**
 * Baseline and infrastructure handling for the pre-push gate's `deno test`
 * check (Issue #4930, PR #5034 review).
 *
 * A failing `deno task test:unit` run is not always the branch's fault:
 *
 * - A module-fetch failure (a JSR manifest, an npm registry or an import
 *   that could not be downloaded) is a tool-download outage, not a test
 *   regression, so it is an infrastructure failure.
 * - A test that already fails the same way where the push forked is an
 *   established base failure. It is reported as a warning, not a block: the
 *   agent is never told to edit unrelated code to clear it.
 *
 * Only a failure that is red at the fork too is downgraded to a warning, and
 * only when every failure in the output is accounted for. Every other failed
 * run stays a verdict (fail closed): output that names no failed test, a
 * module that failed outside a test (`(uncaught error)`), a base that is
 * unavailable or passes, a different test red at the fork, and a timeout. A
 * pass the runner never reached because an earlier pass failed is run before
 * the downgrade stands ({@link judgeDenoTestCheck}).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { quoteArg } from "./cargo_deny_gate.ts";
import {
  type PreFlightGateError,
  type PreFlightRunner,
  runPreFlightGate,
} from "./pre_flight_gate.ts";

/** Longest output line the classifier examines. */
const LINE_CAP = 2000;

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * A line deno prints for a failed test: `<test name> => ./<file>:<line>:<col>`
 * (observed under both the ERRORS and the FAILURES heading).
 */
const FAILED_TEST_LINE = /^(.+?) => (\.\/[^\s:]+\.ts):\d+:\d+$/;

/**
 * How deno reports a test module that failed outside any test (a top-level
 * throw, a dangling promise, a missing named export): `./x_test.ts (uncaught
 * error)` under ERRORS and FAILURES, and `Uncaught error from ./x_test.ts
 * FAILED` while running. Neither names a test, so neither becomes a key.
 */
const UNCAUGHT_ERROR_LINE =
  /^(?:\S+ \(uncaught error\)|Uncaught error from \S+ FAILED)$/;

/**
 * The `deno task test:unit` runner's per-pass result line (see
 * `unit_test_runner.ts`): `=== parallel pass: FAILED in 3.1s`.
 */
const PASS_RESULT_LINE = /^=== (parallel|serial) pass: (PASSED|FAILED)\b/;

/** A test path safe to hand back to deno as an argument. */
const SAFE_TEST_PATH = /^\.\/(?!.*\.\.)[\w@+./-]+_test\.ts$/;

/**
 * Output lines that show a module could not be fetched. Each form was observed
 * from the real tool: a JSR manifest, an `https:` import, an npm package and
 * the transport error beneath them. A 404 (`JSR package not found`) is a real
 * missing dependency, not an outage, so it is deliberately absent.
 */
const FETCH_FAILURES: readonly RegExp[] = [
  /^error: JSR package manifest for .+ failed to load/,
  /^error: Import ['"]https?:\/\/.+['"] failed\b/,
  /^error: Failed loading https?:\/\/\S+ for package/,
  /^error: Failed caching npm package/,
  /error sending request for url/,
  /\b(?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
  /\bstatus(?: code)? 5\d\d\b/i,
];

function outputLines(output: string): string[] {
  return output.replace(ANSI, "").split("\n").map((line) =>
    line.replace(/\r$/, "").slice(0, LINE_CAP).trim()
  );
}

/**
 * The failed tests in a `deno test` output, as `<name> => <file>` keys (the
 * line and column are dropped so an edit above a test does not rename it).
 */
export function denoTestFailureKeys(output: string): Set<string> {
  const keys = new Set<string>();
  for (const line of outputLines(output)) {
    const match = FAILED_TEST_LINE.exec(line);
    if (match) keys.add(`${match[1]} => ${match[2]}`);
  }
  return keys;
}

/**
 * Whether a test module failed outside any test, a failure the keys of
 * {@link denoTestFailureKeys} do not carry, so it cannot be compared with the
 * base.
 */
export function hasUncaughtError(output: string): boolean {
  return outputLines(output).some((line) => UNCAUGHT_ERROR_LINE.test(line));
}

/**
 * Whether the `test:unit` runner stopped after a failed parallel pass and so
 * never ran its serial pass (or the time budget that follows the passes). A
 * run whose output has no pass result lines is not judged: its runner is not
 * ours.
 */
export function serialPassSkipped(output: string): boolean {
  const results = outputLines(output).flatMap((line) => {
    const match = PASS_RESULT_LINE.exec(line);
    return match ? [`${match[1]}:${match[2]}`] : [];
  });
  return results.includes("parallel:FAILED") &&
    !results.some((result) => result.startsWith("serial:"));
}

/** The distinct test files among {@link denoTestFailureKeys}, `./`-prefixed. */
function failedFiles(keys: ReadonlySet<string>): string[] {
  return [...new Set([...keys].map((key) => key.split(" => ").at(-1)!))]
    .sort();
}

/**
 * Whether a failed `deno test` run is a download outage: no test is named as
 * failed and a line shows a module fetch failing.
 */
export function isDenoFetchFailure(output: string): boolean {
  if (denoTestFailureKeys(output).size > 0) return false;
  return outputLines(output).some((line) =>
    FETCH_FAILURES.some((re) => re.test(line))
  );
}

/** The line of a failed run that names the cause, for an infrastructure note. */
function causeLine(output: string): string {
  const lines = outputLines(output);
  return lines.find((line) => FETCH_FAILURES.some((re) => re.test(line))) ??
    lines.find((line) => line !== "") ?? "no error text captured";
}

/** The verdict on a failed `deno test` check. */
export type DenoTestOutcome =
  | { kind: "infrastructure"; message: string }
  | { kind: "verdict"; message: string; error: PreFlightGateError }
  | { kind: "base-only"; warning: string };

/** The injected seams {@link judgeDenoTestFailure} reads the base through. */
export interface DenoTestBaseline {
  /** Run the failed tests again where the push forked; null: cannot compare. */
  runAtBase(
    command: (files: string[]) => string | null,
    files: string[],
  ): Promise<{ ranFiles: string[]; error: PreFlightGateError | null } | null>;
}

/**
 * Decide what a failed `deno test` check means (see the module doc).
 * `baseCommand` builds the command that re-runs given test files; a failed
 * test is base-only when its file exists at the base, the base run fails, and
 * the base output names the same failed test.
 */
export async function judgeDenoTestFailure(
  error: PreFlightGateError,
  baseline: DenoTestBaseline | null,
  baseCommand: (files: string[]) => string | null,
): Promise<DenoTestOutcome> {
  const verdict: DenoTestOutcome = {
    kind: "verdict",
    message: error.message,
    error,
  };
  if (error.reason === "not-started") {
    return {
      kind: "infrastructure",
      message:
        `deno test could not run, so the unit tests were not checked (this is not a pass): "${
          causeLine(error.output)
        }"`,
    };
  }
  if (error.reason === "non-zero-exit" && isDenoFetchFailure(error.output)) {
    return {
      kind: "infrastructure",
      message:
        `deno test could not fetch a module, so the unit tests were not checked (this is not a pass): "${
          causeLine(error.output)
        }"`,
    };
  }
  if (error.reason !== "non-zero-exit" || baseline === null) return verdict;

  const headKeys = denoTestFailureKeys(error.output);
  if (headKeys.size === 0) return verdict;
  // A module that failed outside a test has no key to compare: fail closed.
  if (hasUncaughtError(error.output)) return verdict;
  const files = failedFiles(headKeys);
  if (!files.every((file) => SAFE_TEST_PATH.test(file))) return verdict;

  const base = await baseline.runAtBase(baseCommand, files);
  if (base === null || base.error === null) return verdict;
  // A failing file the base lacks was added by the push: its failure is ours.
  if (!files.every((file) => base.ranFiles.includes(file))) return verdict;
  const baseKeys = denoTestFailureKeys(base.error.output);
  const fresh = [...headKeys].filter((key) => !baseKeys.has(key));
  if (fresh.length > 0) return verdict;
  return {
    kind: "base-only",
    warning:
      `${headKeys.size} unit test(s) fail the same way where this push ` +
      `forked, so they are not blocked: ${[...headKeys].sort().join("; ")}`,
  };
}

/**
 * Judge a failed `deno test` check and, when it is base-only, make sure the
 * rest of the suite was run. `deno task test:unit` stops after a failed
 * parallel pass, so its serial pass and time budget never ran: the serial pass
 * is run here (`--serial-only`) and judged the same way, and a pass that did
 * not run is never counted as passed. `run` runs a command at the head.
 *
 * The time budget over a failed parallel pass is the one thing not re-run: the
 * runner applies it only after every pass succeeded.
 */
export async function judgeDenoTestCheck(opts: {
  error: PreFlightGateError;
  command: string;
  baseline: DenoTestBaseline | null;
  baseCommand: (files: string[]) => string | null;
  run: (command: string) => Promise<Result<void, PreFlightGateError>>;
}): Promise<DenoTestOutcome> {
  const first = await judgeDenoTestFailure(
    opts.error,
    opts.baseline,
    opts.baseCommand,
  );
  if (first.kind !== "base-only" || !serialPassSkipped(opts.error.output)) {
    return first;
  }
  const rest = await opts.run(`${opts.command} --serial-only`);
  if (rest.ok) return first;
  const second = await judgeDenoTestFailure(
    rest.error,
    opts.baseline,
    opts.baseCommand,
  );
  return second.kind === "base-only"
    ? { kind: "base-only", warning: `${first.warning}\n${second.warning}` }
    : second;
}

/** Quote test paths into one `deno task test:unit` command, or null. */
export function unitTestCommand(files: readonly string[]): string | null {
  const quoted: string[] = [];
  for (const file of files) {
    const value = quoteArg(file.replace(/^\.\//, ""));
    if (value === null) return null;
    quoted.push(value);
  }
  return `deno task test:unit ${quoted.join(" ")}`;
}

/** Where the throwaway worktrees live, under the repository's git directory. */
export const BASELINE_WORKTREE_DIR = "vibe-deno-test-base";

/**
 * A {@link DenoTestBaseline} that checks the fork commit out into a throwaway
 * worktree and re-runs the failed test files there. Any git failure makes the
 * baseline unavailable (null), never a pass. The worktree is removed after.
 *
 * Git itself makes the worktree, under the repository's common git directory
 * (`git rev-parse --git-common-dir`), and removes it again (`git worktree
 * remove --force`, then `git worktree prune`). The Deno process writes nothing,
 * so the agent's pre-push hook, whose Deno process may write only to the temp
 * directory, can run it (PR #5034 review). A checkout that cannot be made is
 * an unavailable baseline (null), so the verdict keeps the head's own output.
 */
export function worktreeBaseline(opts: {
  cwd: string;
  /** Path of the deno root relative to the repository ("." for the top). */
  root: string;
  forkSha: string;
  git: (
    args: string[],
    cwd: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  runner?: PreFlightRunner;
  timeoutSeconds?: number;
}): DenoTestBaseline {
  return {
    async runAtBase(command, files) {
      let tree: string | null = null;
      try {
        const common = await opts.git(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          opts.cwd,
        );
        const gitDir = common.stdout.trim();
        if (common.code !== 0 || !gitDir.startsWith("/")) return null;
        const candidate =
          `${gitDir}/${BASELINE_WORKTREE_DIR}/${crypto.randomUUID()}`;
        const add = await opts.git(
          ["worktree", "add", "--detach", candidate, opts.forkSha],
          opts.cwd,
        );
        if (add.code !== 0) return null;
        tree = candidate;
        const rootDir = opts.root === "." ? tree : `${tree}/${opts.root}`;
        const prefix = opts.root === "." ? "" : `${opts.root}/`;
        const present = await opts.git(
          [
            "ls-tree",
            "-r",
            "--name-only",
            opts.forkSha,
            "--",
            ...files.map((f) => `${prefix}${f.replace(/^\.\//, "")}`),
          ],
          opts.cwd,
        );
        if (present.code !== 0) return null;
        const atBase = new Set(present.stdout.split("\n").filter((p) => p));
        const ranFiles = files.filter((f) =>
          atBase.has(`${prefix}${f.replace(/^\.\//, "")}`)
        );
        if (ranFiles.length === 0) return { ranFiles, error: null };
        const baseCommand = command(ranFiles);
        if (baseCommand === null) return null;
        const result: Result<void, PreFlightGateError> = await runPreFlightGate(
          [baseCommand],
          {
            cwd: rootDir,
            runner: opts.runner,
            timeoutSeconds: opts.timeoutSeconds,
          },
        );
        return { ranFiles, error: result.ok ? null : result.error };
      } catch (error) {
        console.warn(
          `[PRE_PUSH_WARNING] the fork checkout for the deno test baseline failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      } finally {
        if (tree !== null) {
          const removed = await opts.git(
            ["worktree", "remove", "--force", tree],
            opts.cwd,
          );
          if (removed.code !== 0) {
            console.warn(
              `[PRE_PUSH_WARNING] could not remove ${tree}: ${removed.stderr.trim()}`,
            );
          }
          await opts.git(["worktree", "prune"], opts.cwd);
        }
      }
    },
  };
}
