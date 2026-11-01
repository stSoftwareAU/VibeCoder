/**
 * Fast local checks a base merge must pass before the merge-conflict path
 * pushes it (Issue #4616).
 *
 * The repository's own fast checks (format, lint, type check and unit suite)
 * run for every project the merge touched. A failing check goes back to the
 * agent as a repair round. A check that cannot be run refuses the push, since
 * unrunnable is not clean. A Deno remote module the host cannot reach (Issue
 * #4422) or a `rustc` older than the workspace requires (Issue #3255) is an
 * environment fault, so that check is left to CI rather than failed.
 *
 * The checks reuse the helpers the resolution gate already uses, so both gates
 * judge the same commands.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { MergeConflictAgentOutcome } from "./merge_conflict_agent.ts";
import type { MergeConflictRepairContext } from "./prompt_builder.ts";
import {
  collapseRepeatedLines,
  describeRustToolchainGap,
  detectRemoteModuleGap,
  detectRustToolchainGap,
  findTypeCheckProjects,
  readManifestTasks,
} from "./milestone_merge_gate.ts";
import {
  cargoTestArgs,
  resolutionTasksFor,
} from "./milestone_resolution_gate.ts";
import {
  findProjectManifests,
  isFile,
  type ProjectKind,
} from "./project_manifests.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
import { buildCacheEnvForCheckout } from "./ephemeral_build_cache.ts";

/** One budget across every fast check of one merge (Issue #4616). */
export const MERGE_FAST_CHECKS_BUDGET_MS = 900_000;

/** Repair rounds the agent gets before the push is refused (Issue #4616). */
export const MERGE_FAST_CHECK_REPAIR_ROUNDS = 2;

/** Longest check output carried into a log line or a repair prompt. */
const MAX_OUTPUT_LINES = 40;
const MAX_OUTPUT_CHARS = 4000;

/** One command to run in one project. */
export interface FastCheck {
  /** Directory the command runs in. */
  dir: string;
  /** Which toolchain runs the command. */
  kind: ProjectKind;
  /** How the command reads, e.g. `deno lint in <dir>`. */
  label: string;
  /** The argv after the executable. */
  args: string[];
  /** What is left of the budget when the check starts. */
  timeoutMs: number;
}

/** Runs one check. Injected in tests; spawns the toolchain in production. */
export type FastCheckRunner = (
  check: FastCheck,
) => Promise<{ code: number; output: string }>;

/** What the fast checks concluded about the merged tree. */
export type MergeFastChecksOutcome =
  | { status: "passed"; ran: string[]; leftToCi: string[] }
  | { status: "failed"; failingCommand: string; output: string }
  | { status: "unverified"; detail: string; output: string };

/** Runs one git command in the checkout. Injected in tests. */
export type FastCheckGit = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What {@link verifyMergeBeforePush} concluded about the push. */
export type PrePushVerification =
  | {
    kind: "passed";
    ran: string[];
    leftToCi: string[];
    repairRounds: number;
  }
  | { kind: "refused"; detail: string }
  | { kind: "cut-short"; outcome: MergeConflictAgentOutcome };

/** Inputs to {@link verifyMergeBeforePush}. */
export interface VerifyBeforePushOptions {
  /** Root of the checkout the base merge is in. */
  repoDir: string;
  /** The PR head the merge started from, before the base was merged in. */
  headBeforeMerge: string;
  /** The base branch merged in, read from `origin/<baseBranch>`. */
  baseBranch: string;
  /** Runs one git command in the checkout. */
  git: FastCheckGit;
  /** Override the check run (tests). Defaults to {@link runMergeFastChecks}. */
  runChecks?: (
    repoDir: string,
    touchedPaths: readonly string[],
  ) => Promise<MergeFastChecksOutcome>;
  /** Runs one repair round of the merge-conflict agent. */
  runRepairAgent: (
    repair: MergeConflictRepairContext,
  ) => Promise<Result<MergeConflictAgentOutcome>>;
  /** Repair rounds allowed; defaults to {@link MERGE_FAST_CHECK_REPAIR_ROUNDS}. */
  maxRounds?: number;
  /** Logs each repair round. */
  logger: Logger;
}

/** Keep the tail of the output: a check's failure sits at the end of it. */
function tail(output: string): string {
  const lines = collapseRepeatedLines(output.trim()).split("\n");
  const kept = lines.slice(-MAX_OUTPUT_LINES).join("\n");
  return kept.length > MAX_OUTPUT_CHARS ? kept.slice(-MAX_OUTPUT_CHARS) : kept;
}

/** Append output to a one-line detail, when there is any. */
function withOutput(detail: string, output: string): string {
  return output ? `${detail}\n${output}` : detail;
}

/** A planned check; its timeout is set when it runs. */
function plannedCheck(
  kind: ProjectKind,
  dir: string,
  args: string[],
): FastCheck {
  const executable = kind === "cargo" ? "cargo" : "deno";
  return {
    dir,
    kind,
    label: `${executable} ${args.join(" ")} in ${dir}`,
    args,
    timeoutMs: 0,
  };
}

/**
 * Whether the merge touches a project. The root project (`rel` is empty) is
 * touched by any path; a nested project only by a path under its directory.
 */
function isTouched(rel: string, touchedPaths: readonly string[]): boolean {
  if (touchedPaths.length === 0) return false;
  if (rel === "") return true;
  return touchedPaths.some((path) => path.startsWith(`${rel}/`));
}

/** A project's directory relative to the repository root ("" for the root). */
function relativeDir(repoDir: string, dir: string): string {
  if (dir === repoDir) return "";
  const prefix = repoDir.endsWith("/") ? repoDir : `${repoDir}/`;
  return dir.startsWith(prefix) ? dir.slice(prefix.length) : dir;
}

/**
 * The paths the merge touched, against the PR head it started from.
 *
 * `git diff` against a commit compares the working tree with that commit, so
 * it covers a merge staged but uncommitted and a merge already committed alike.
 * `-z` keeps an unusual path name whole.
 *
 * @param git - Runs one git command in the checkout
 * @param headBeforeMerge - The PR head the merge started from
 * @returns The touched paths, or an error carrying git's own message
 */
export async function listMergeTouchedPaths(
  git: FastCheckGit,
  headBeforeMerge: string,
): Promise<Result<string[]>> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await git(["diff", "--name-only", "-z", headBeforeMerge]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(`git diff --name-only failed: ${message}`),
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git diff --name-only failed (exit ${result.code}): ${result.stderr.trim()}`,
      ),
    };
  }
  return {
    ok: true,
    value: result.stdout.split("\0").filter((path) => path.length > 0),
  };
}

/** The clippy arguments used where the repository's CI declares none. */
const DEFAULT_CLIPPY_ARGS = [
  "--workspace",
  "--all-targets",
  "--",
  "-D",
  "warnings",
];

/**
 * The arguments the repository's CI passes to `cargo clippy` (Issue #4616).
 *
 * Reads `.github/workflows/*.yml` and `*.yaml` in name order and returns the
 * tokens after `clippy` on the first invocation it can reproduce, so the
 * planned command carries the same lint flags CI does. Comment lines are
 * skipped, a backslash continuation is joined, and a line with a shell
 * expansion or quote (`${{ }}`, `$VAR`, a quoted word) is skipped because it
 * cannot be reproduced as argv.
 *
 * @param repoDir - Root of the checkout
 * @returns The CI's clippy arguments, or `undefined` when none is declared
 */
export async function readCiClippyArgs(
  repoDir: string,
): Promise<string[] | undefined> {
  const dir = `${repoDir}/.github/workflows`;
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && /\.ya?ml$/.test(entry.name)) names.push(entry.name);
    }
  } catch {
    return undefined;
  }
  for (const name of names.sort()) {
    let text: string;
    try {
      text = await Deno.readTextFile(`${dir}/${name}`);
    } catch {
      continue;
    }
    for (const line of text.replace(/\\\r?\n/g, " ").split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      const found = /\bcargo\s+(?:\+\S+\s+)?clippy((?:\s+[^\s&|;#]+)*)/.exec(
        line,
      );
      if (!found) continue;
      const tokens = (found[1] ?? "").split(/\s+/).filter((token) =>
        token.length > 0
      );
      if (tokens.some((token) => /[$"'`]/.test(token))) continue;
      return tokens;
    }
  }
  return undefined;
}

/**
 * The checks to run for every project the merge touched, in order.
 *
 * A Deno project runs `fmt --check`, `lint`, its type check (the repository's
 * own `check` task where one is defined) and each task that
 * {@link resolutionTasksFor} names. A Cargo project runs `fmt`, `clippy` with
 * the arguments the repository's CI passes ({@link readCiClippyArgs}, else
 * `--workspace --all-targets -- -D warnings`), and {@link cargoTestArgs}. Every planned check leaves
 * `timeoutMs` at 0; {@link runMergeFastChecks} sets the remaining budget when
 * it runs the check, and a check that exceeds it is `unverified` (exit 124),
 * never a repair target.
 *
 * @param repoDir - Root of the checkout
 * @param touchedPaths - The paths the merge touched
 * @returns The checks to run; empty when no project is touched
 */
export async function planFastChecks(
  repoDir: string,
  touchedPaths: readonly string[],
): Promise<FastCheck[]> {
  const typeCheckArgs = new Map(
    (await findTypeCheckProjects(repoDir))
      .filter((project) => project.kind === "deno")
      .map((project) => [project.dir, project.args]),
  );
  const checks: FastCheck[] = [];
  const clippyArgs = (await readCiClippyArgs(repoDir)) ?? DEFAULT_CLIPPY_ARGS;
  for (const project of await findProjectManifests(repoDir)) {
    const rel = relativeDir(repoDir, project.dir);
    if (!isTouched(rel, touchedPaths)) continue;
    if (project.kind === "cargo") {
      const locked = (await isFile(`${project.dir}/Cargo.lock`)) &&
          !clippyArgs.includes("--locked")
        ? ["--locked"]
        : [];
      // `--locked` is a cargo option, so it goes before the `--` separator.
      const separator = clippyArgs.indexOf("--");
      const cargoSide = separator < 0
        ? clippyArgs
        : clippyArgs.slice(0, separator);
      const lintSide = separator < 0 ? [] : clippyArgs.slice(separator);
      checks.push(
        plannedCheck("cargo", project.dir, ["fmt", "--all", "--", "--check"]),
        plannedCheck("cargo", project.dir, [
          "clippy",
          ...cargoSide,
          ...locked,
          ...lintSide,
        ]),
        plannedCheck("cargo", project.dir, await cargoTestArgs(project.dir)),
      );
      continue;
    }
    const typeCheck = typeCheckArgs.get(project.dir);
    if (typeCheck === undefined) {
      // findTypeCheckProjects walks the same manifests, so a miss is a bug. A
      // silent skip here would be a check that never ran.
      throw new Error(`no type check resolved for ${project.dir}`);
    }
    checks.push(
      plannedCheck("deno", project.dir, ["fmt", "--check"]),
      plannedCheck("deno", project.dir, ["lint"]),
      plannedCheck("deno", project.dir, typeCheck),
    );
    for (
      const task of resolutionTasksFor(
        await readManifestTasks(project.manifest),
      )
    ) {
      checks.push(plannedCheck("deno", project.dir, ["task", task]));
    }
  }
  return checks;
}

/**
 * Spawn one check within its remaining budget.
 *
 * A spawn failure (the toolchain is not installed) throws, so the caller
 * reports the check as unverified rather than as a failure or a pass.
 */
const spawnFastCheck: FastCheckRunner = async (check) => {
  const result = await runWithTimeout(
    check.kind === "cargo" ? "cargo" : Deno.execPath(),
    check.args,
    {
      cwd: check.dir,
      timeoutMs: check.timeoutMs,
      // Build artefacts off the persistent volume where the runtime refuses
      // to trim it (Issue #2247); empty on every other runtime.
      env: buildCacheEnvForCheckout(check.dir),
    },
  );
  if (!result.ok) throw result.error;
  const { code, stdout, stderr, timedOut } = result.value;
  const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean)
    .join("\n");
  if (timedOut) {
    return {
      code: 124,
      output: `${output}\n${check.label} timed out after ${check.timeoutMs}ms`
        .trim(),
    };
  }
  return { code, output };
};

/**
 * Run the planned checks against the merged tree, stopping at the first
 * failure.
 *
 * One deadline covers every check, and each check gets what is left of it. A
 * check failing for an environment reason (an unreachable remote module, a
 * `rustc` older than the workspace requires) is left to CI and the run goes
 * on. Any other failure stops the run, so the repair round names the first
 * thing that is wrong. A check that cannot run, a check that times out (exit
 * code 124, which a repair round cannot fix), or a budget spent before a check
 * starts, is `unverified`.
 *
 * @param repoDir - Root of the checkout
 * @param touchedPaths - The paths the merge touched
 * @param runner - Runs one check (tests inject it)
 * @param now - Reads the clock (tests inject it so the budget is deterministic)
 * @returns `passed` when every check that ran passed, `failed` at the first
 *   failing check, or `unverified` when a check could not be run
 */
export async function runMergeFastChecks(
  repoDir: string,
  touchedPaths: readonly string[],
  runner: FastCheckRunner = spawnFastCheck,
  now: () => number = () => Date.now(),
): Promise<MergeFastChecksOutcome> {
  const plan = await planFastChecks(repoDir, touchedPaths);
  const deadline = now() + MERGE_FAST_CHECKS_BUDGET_MS;
  const ran: string[] = [];
  const leftToCi: string[] = [];

  for (const check of plan) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        status: "unverified",
        detail: `${check.label} was not reached within the ` +
          `${MERGE_FAST_CHECKS_BUDGET_MS}ms budget — the merge is unverified, ` +
          "so it is not pushed",
        output: "",
      };
    }
    let result: { code: number; output: string };
    try {
      result = await runner({ ...check, timeoutMs: remaining });
    } catch (err) {
      // Unrunnable is not clean: the merge stays unverified.
      return {
        status: "unverified",
        detail: `${check.label} could not be run`,
        output: tail(err instanceof Error ? err.message : String(err)),
      };
    }
    if (result.code === 0) {
      ran.push(check.label);
      continue;
    }
    // A timeout (code 124, from spawnFastCheck) is not something a repair round
    // can fix, and the check never finished, so it is unverified, not failed.
    if (result.code === 124) {
      return {
        status: "unverified",
        detail:
          `${check.label} timed out — the merge is unverified, so it is ` +
          "not pushed",
        output: tail(result.output),
      };
    }
    // Environment faults a repair round cannot answer (Issues #4422, #3255).
    const remote = check.kind === "deno"
      ? detectRemoteModuleGap(result.output)
      : undefined;
    if (remote) {
      leftToCi.push(
        `${check.label} could not fetch its remote modules (${remote.cause})`,
      );
      continue;
    }
    const gap = check.kind === "cargo"
      ? detectRustToolchainGap(result.output)
      : undefined;
    if (gap) {
      leftToCi.push(describeRustToolchainGap(check.label, result.code, gap));
      continue;
    }
    return {
      status: "failed",
      failingCommand: check.label,
      output: tail(result.output),
    };
  }
  return { status: "passed", ran, leftToCi };
}

/**
 * The subjects of the base commits the merge brought in, newest first. Any
 * failure reads as none: the repair prompt is better without them than the
 * repair round is lost.
 */
async function mergedCommitSubjects(
  git: FastCheckGit,
  headBeforeMerge: string,
  baseBranch: string,
): Promise<string[]> {
  try {
    const result = await git([
      "log",
      "--format=%s",
      "-n",
      "20",
      `${headBeforeMerge}..origin/${baseBranch}`,
    ]);
    if (result.code !== 0) return [];
    return result.stdout.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Whether a merge is staged and uncommitted (`MERGE_HEAD` exists). */
async function mergeIsStaged(git: FastCheckGit): Promise<boolean> {
  try {
    const result = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Decide whether a base merge may be pushed, repairing it on the way if a
 * fast check fails (Issue #4616).
 *
 * A failing check gets up to `maxRounds` repair rounds. Each round runs the
 * merge-conflict agent with the failing command and its output, then lists the
 * touched paths and runs the checks again. An `unverified` check is refused at
 * once, with no repair: the agent cannot answer a check that did not run. A
 * repair run the worker or the provider ended is `cut-short`, not judged.
 *
 * @param opts - The checkout, the merge base, git, the repair runner and logger
 * @returns Whether the push may proceed, must be refused, or was cut short
 */
export async function verifyMergeBeforePush(
  opts: VerifyBeforePushOptions,
): Promise<PrePushVerification> {
  const { repoDir, headBeforeMerge, baseBranch, git, logger } = opts;
  const runChecks = opts.runChecks ?? runMergeFastChecks;
  const maxRounds = opts.maxRounds ?? MERGE_FAST_CHECK_REPAIR_ROUNDS;

  const listed = await listMergeTouchedPaths(git, headBeforeMerge);
  if (!listed.ok) {
    return {
      kind: "refused",
      detail:
        `could not list the paths the merge touched: ${listed.error.message}`,
    };
  }
  let touched = listed.value;
  let repairRounds = 0;

  for (;;) {
    const outcome = await runChecks(repoDir, touched);
    if (outcome.status === "passed") {
      return {
        kind: "passed",
        ran: outcome.ran,
        leftToCi: outcome.leftToCi,
        repairRounds,
      };
    }
    if (outcome.status === "unverified") {
      return {
        kind: "refused",
        detail: withOutput(outcome.detail, outcome.output),
      };
    }
    if (repairRounds >= maxRounds) {
      return {
        kind: "refused",
        detail: withOutput(
          `${outcome.failingCommand} still fails after ${repairRounds} ` +
            "repair round(s) — the merge is not pushed",
          outcome.output,
        ),
      };
    }

    repairRounds++;
    logger.info(
      `Pre-push checks of the merge into ${baseBranch} failed at ` +
        `${outcome.failingCommand}; repair round ${repairRounds} of ${maxRounds}`,
    );
    const repair: MergeConflictRepairContext = {
      round: repairRounds,
      maxRounds,
      failingCommand: outcome.failingCommand,
      output: outcome.output,
      mergedCommitSubjects: await mergedCommitSubjects(
        git,
        headBeforeMerge,
        baseBranch,
      ),
      mergeStaged: await mergeIsStaged(git),
    };
    const agent = await opts.runRepairAgent(repair);
    if (!agent.ok) {
      return {
        kind: "refused",
        detail: `repair agent failed: ${agent.error.message}`,
      };
    }
    const reply = agent.value;
    if (
      reply.terminated || reply.providerUnavailable !== undefined ||
      reply.finishDeadline === true
    ) {
      return { kind: "cut-short", outcome: reply };
    }

    // The repair may have changed what the merge touches, so list again.
    const relisted = await listMergeTouchedPaths(git, headBeforeMerge);
    if (!relisted.ok) {
      return {
        kind: "refused",
        detail:
          `could not list the paths the merge touched: ${relisted.error.message}`,
      };
    }
    touched = relisted.value;
  }
}
