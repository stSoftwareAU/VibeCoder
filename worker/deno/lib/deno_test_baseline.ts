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
 * Only a failure the run can positively attribute to the branch blocks. A
 * failure whose output names no failed test, or one the base run cannot be
 * compared to, stays a verdict (fail closed).
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
  | { kind: "verdict"; message: string }
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
  const verdict: DenoTestOutcome = { kind: "verdict", message: error.message };
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

/**
 * A {@link DenoTestBaseline} that checks the fork commit out into a throwaway
 * worktree and re-runs the failed test files there. Any git failure makes the
 * baseline unavailable (null), never a pass. The worktree is removed after.
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
  makeTempDir?: () => Promise<string>;
  removeDir?: (path: string) => Promise<void>;
}): DenoTestBaseline {
  return {
    async runAtBase(command, files) {
      const makeTemp = opts.makeTempDir ??
        (() => Deno.makeTempDir({ prefix: "vibe_deno_test_base_" }));
      const removeDir = opts.removeDir ??
        ((path: string) => Deno.remove(path, { recursive: true }));
      const dir = await makeTemp();
      const tree = `${dir}/tree`;
      let added = false;
      try {
        const add = await opts.git(
          ["worktree", "add", "--detach", tree, opts.forkSha],
          opts.cwd,
        );
        if (add.code !== 0) return null;
        added = true;
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
      } finally {
        if (added) {
          await opts.git(["worktree", "remove", "--force", tree], opts.cwd);
        }
        try {
          await removeDir(dir);
        } catch (error) {
          console.warn(
            `[PRE_PUSH_WARNING] could not remove ${dir}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    },
  };
}
