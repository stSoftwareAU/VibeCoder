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
 * `runProcess`); the repository's declared credentials reach the `deno` runs
 * only, never git.
 *
 * Only Deno tests are runnable today.
 *
 * Australian English spelling used throughout.
 */

import { isDenoTestFile } from "./mutation_gate.ts";
import {
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

export type SecurityFixDiscrimination =
  | {
    kind: "checked";
    test: CitedSecurityTest;
    preFix: DiscriminationRunOutcome;
    postFix: DiscriminationRunOutcome;
  }
  | { kind: "not_checked"; reason: string };

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
  /** Passed as `runProcess` `opts.env` to the deno runs only. */
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

function notChecked(reason: string): SecurityFixDiscrimination {
  return { kind: "not_checked", reason };
}

/** Carries a not_checked reason out of the step helpers. */
class NotChecked extends Error {}

export async function runSecurityFixDiscrimination(
  input: DiscriminationRunInput,
  seams: MutationRunnerSeams,
): Promise<SecurityFixDiscrimination> {
  try {
    return await discriminate(input, seams);
  } catch (err) {
    if (err instanceof NotChecked) return notChecked(err.message);
    const message = err instanceof Error ? err.message : String(err);
    return notChecked(`discrimination runner failed: ${message}`);
  }
}

async function discriminate(
  input: DiscriminationRunInput,
  seams: MutationRunnerSeams,
): Promise<SecurityFixDiscrimination> {
  const test = input.tests.find((t) =>
    isDenoTestFile(t.file) && t.name.trim() !== ""
  );
  if (test === undefined) {
    if (input.tests.length === 0) {
      return notChecked(
        "the PR summary cites no string-named test declared in the branch diff",
      );
    }
    return notChecked(
      "only Deno tests can be executed by the worker; no cited test is in a " +
        `Deno test file (cited: ${input.tests.map((t) => t.file).join(", ")})`,
    );
  }
  if (input.baseRef === "" || input.baseRef.startsWith("-")) {
    return notChecked(`unusable base ref "${input.baseRef}"`);
  }

  const budgetMs = input.budgetSeconds * 1000;
  const start = seams.now();
  const remaining = () => budgetMs - (seams.now() - start);
  const guard = (what: string) => {
    if (remaining() <= 0) {
      throw new NotChecked(
        `the discrimination budget of ${input.budgetSeconds}s ran out before ${what}`,
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

    const configDir = await findDenoConfigDir(checkout, test.file, seams);
    if (configDir === null) {
      return notChecked(
        `no deno.json, deno.jsonc or deno.lock above ${test.file}`,
      );
    }
    const normalised = test.file.split("/").filter((p) => p !== "" && p !== ".")
      .join("/");
    const relTest = configDir === ""
      ? normalised
      : normalised.slice(configDir.length + 1);
    const cwd = configDir === "" ? checkout : `${checkout}/${configDir}`;

    const runTest = async (
      where: string,
    ): Promise<
      { outcome: DiscriminationRunOutcome } | { reason: string }
    > => {
      guard(`the ${where} run`);
      const res: ProcessResult = await seams.runProcess(
        "deno",
        ["test", "--no-check", "-A", "--filter", test.name, relTest],
        {
          cwd,
          timeoutMs: remaining(),
          ...(input.credentialEnv === undefined
            ? {}
            : { env: input.credentialEnv }),
        },
      );
      if (res.timedOut) return { reason: `the ${where} run timed out` };
      const outcome = namedTestOutcome(res.stdout, test.name);
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

function runFailureCause(res: ProcessResult, name: string): string {
  const lines = stripAnsi(res.stderr).split("\n").map((l) => l.trim());
  const errorLine = lines.find((l) => l.startsWith("error:"));
  if (errorLine !== undefined) return errorLine;
  const first = lines.find((l) => l !== "");
  if (first !== undefined) return first;
  return `no test named "${name}" was reported`;
}
