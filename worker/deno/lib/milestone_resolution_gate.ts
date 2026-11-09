/**
 * The gate an automatic conflict resolution must pass (Issue #1559).
 *
 * A conflict the worker resolves itself gets the same verification a human's
 * resolution gets, and for the same reason: a resolution nobody checked is a
 * guess. The type-check gate of Issue #974 answers "does the merged tree still
 * compile?", which is the right question for a merge git resolved on its own.
 * It is not enough for a merge where the worker *chose a side*: dropping one
 * side's implementation compiles perfectly and fails the moment the other
 * side's tests run.
 *
 * So a resolved tree runs more of the repository's own tasks — its `check`,
 * its `check:manifests` and its unit suite — and only a tree that passes all
 * of them is pushed. A repository whose suite runs through its own
 * `quality.sh` rather than a manifest task is verified with that script
 * (Issue #2388). A tree that defines none of them is reported `skipped`,
 * and the sync treats that as a refusal: a resolution that cannot be verified
 * is not a resolution.
 *
 * A Cargo project's `cargo check` or `cargo test` step carries through the
 * same toolchain-gap detection as `milestone_merge_gate.ts`: a host `rustc`
 * older than a workspace package's `rust-version` is reported naming the
 * container's Rust pin, and skips the repair rounds built for a bad
 * resolution rather than a host limit (Issue #3255). A dependency-only
 * refusal stays an ordinary failure a repair round may answer.
 *
 * A Deno task that cannot fetch a remote module (an `https://` import the host
 * has no route to) is an environment fault the same way (Issue #4422). The
 * task did not run, so it is reported as left to the milestone PR's CI rather
 * than as passed, and it is not failed: a tree that passes every other task is
 * still pushed. A failure of any other kind still refuses the resolution.
 *
 * A Cargo step that cannot reach its crate registry (Issue #4786) is retried
 * once offline, from the local cargo cache, inside the remaining budget. If the
 * retry still cannot reach the registry the step is left to CI, as a timed-out
 * Cargo step is, and the passed detail names it.
 *
 * The Issue #974 type check runs first and has its own limit,
 * `typeCheckTimeoutMs` (300 s for Deno, 900 s for Cargo; Issue #4787). The
 * verification budget, {@link RESOLUTION_GATE_BUDGET_MS}, starts once that
 * check has passed and covers only the tasks after it, so a long type check
 * does not leave a later task unreached.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  checkMergedTree,
  collapseRepeatedLines,
  describeRustToolchainGap,
  detectCargoRegistryGap,
  detectRemoteModuleGap,
  detectRustToolchainGap,
  findProjectManifests,
  isCargoOfflineRegistryGap,
  type MergeGateFn,
  type MergeGateOutcome,
  type ProjectKind,
  readManifestTasks,
  withCargoOffline,
} from "./milestone_merge_gate.ts";
import {
  GateAccountUnavailable,
  manifestsFor,
  runRepositoryCommand,
} from "./untrusted_gate_spawn.ts";
import {
  CARGO_BUILD_SKIPPED_FOR_MERGE,
  shouldSkipEphemeralCargoBuild,
} from "./heavy_build_gate.ts";

/**
 * How long the whole verification may run before it is given up on.
 *
 * A single budget across every task, not one per task: this runs inside the
 * sync cycle, and three fifteen-minute tasks per project would block the loop
 * the milestone sync is supposed to stay out of the way of. A verification
 * that does not finish inside it is a failure, never a pass.
 *
 * The budget covers only the tasks after the Issue #974 type check, and starts
 * once that check has passed (Issue #4787). The type check has its own limit,
 * `typeCheckTimeoutMs` in milestone_merge_gate.ts, so a long cold cargo check
 * cannot leave `cargo test` unreached.
 */
export const RESOLUTION_GATE_BUDGET_MS = 900_000;

/**
 * The tasks a resolved tree is verified with, beyond the Issue #974 type
 * check, in the order they run.
 *
 * `test:unit` and `test` are alternatives — the first one the repository
 * defines is the unit suite, so a repo with both does not run its integration
 * tests inside a sync cycle.
 */
export const RESOLUTION_GATE_TASKS = [
  "check:manifests",
  "test:unit",
  "test",
] as const;

/**
 * The repository's own quality gate, run as the unit suite when the tree
 * defines no unit-suite task and no Cargo workspace (Issue #2388).
 *
 * `quality.sh` is the fleet's convention for "everything this repository
 * checks before a PR" — `codebase_map.ts` tells every agent to run it, and the
 * CI-fix path runs it. A repository whose suite is `node --test …` behind that
 * script has no `deno task test` to find, and the gate used to call that
 * "nothing to verify with": a conflict the worker had already resolved
 * correctly was refused, uncharged, for every issue of its milestone, every
 * hour. The script runs a superset of a unit suite, which is more
 * verification than the gate asks for, never less.
 *
 * Run through `bash` rather than executed directly so a script committed
 * without its executable bit still verifies. It is the merged tree of two of
 * the repository's own protected branches — the same trust the `deno task`
 * and `cargo test` branches above already extend.
 */
export const QUALITY_SCRIPT = "quality.sh";

/** The unit-suite task names, most specific first. */
const UNIT_SUITE_TASKS = ["test:unit", "test"] as const;

/** One task to run in one project. */
export interface ResolutionTask {
  /** Directory the task runs in. */
  dir: string;
  /**
   * `deno task <task>`, `cargo <args>` for a Cargo workspace (#2138), or
   * `script` for the repository's own `quality.sh` (Issue #2388).
   */
  kind: ProjectKind | "script";
  /** The manifest task name, e.g. `check:manifests`; `test` for cargo. */
  task: string;
  /** The argv after the executable. */
  args: string[];
  /** What is left of {@link RESOLUTION_GATE_BUDGET_MS} when it starts. */
  timeoutMs: number;
}

/** How a task is spelled in a log line or an escalation. */
export function describeTask(task: ResolutionTask): string {
  if (task.kind === "script") return `./${task.args.join(" ")}`;
  return task.kind === "cargo"
    ? `cargo ${task.args.join(" ")}`
    : `deno task ${task.task}`;
}

/**
 * `cargo test` over the whole workspace as the unit suite (Issue #2138) —
 * `--locked` only when a `Cargo.lock` is committed, as the type check does.
 */
export async function cargoTestArgs(dir: string): Promise<string[]> {
  const args = ["test", "--workspace"];
  try {
    if ((await Deno.stat(`${dir}/Cargo.lock`)).isFile) args.push("--locked");
  } catch {
    // no lockfile: an unlocked crate is verified unlocked
  }
  return args;
}

/** Runs one task. Injected in tests; spawns `deno task <name>` in production. */
export type ResolutionTaskRunner = (
  task: ResolutionTask,
) => Promise<
  {
    code: number;
    output: string;
    accountUnavailable?: string;
    /**
     * Set when the task hit its time limit (Issue #4786), so the caller can
     * tell a timeout from a failing task. Set by the production runner only.
     */
    timedOut?: boolean;
  }
>;

/** Longest task output carried into a log line or an escalation comment. */
const MAX_OUTPUT_LINES = 40;
const MAX_OUTPUT_CHARS = 4000;

/** Keep the tail — a task's failure sits at the end of its output. */
function tail(output: string): string {
  const lines = collapseRepeatedLines(output.trim()).split("\n");
  const kept = lines.slice(-MAX_OUTPUT_LINES).join("\n");
  return kept.length > MAX_OUTPUT_CHARS ? kept.slice(-MAX_OUTPUT_CHARS) : kept;
}

/**
 * Which of a project's tasks verify a resolution.
 * `readManifestTasks` normalises string and command-bearing object tasks;
 * dependencies-only tasks are not discovered as checks or suites.
 *
 * @param defined - Every task the project's manifest declares
 * @returns The tasks to run, in order; empty when it declares none of them
 */
export function resolutionTasksFor(defined: string[]): string[] {
  const tasks: string[] = [];
  if (defined.includes("check:manifests")) tasks.push("check:manifests");
  const unitSuite = UNIT_SUITE_TASKS.find((name) => defined.includes(name));
  if (unitSuite) tasks.push(unitSuite);
  return tasks;
}

/** Whether the tree carries the repository's own quality gate. */
async function hasQualityScript(repoDir: string): Promise<boolean> {
  try {
    return (await Deno.stat(`${repoDir}/${QUALITY_SCRIPT}`)).isFile;
  } catch {
    return false;
  }
}

/** Whether a task name is the unit suite (the one the issue requires). */
function isUnitSuite(task: string): boolean {
  return (UNIT_SUITE_TASKS as readonly string[]).includes(task);
}

/**
 * Spawn one of the repository's own tasks within the remaining budget. The
 * command runner is injectable so a test can check what a timed-out task
 * returns (Issue #4786), as {@link spawnTypeCheck}'s is (Issue #4787).
 */
export const spawnTask = async (
  task: ResolutionTask,
  /** The command runner. Production uses the real one; tests inject a fake. */
  run: typeof runRepositoryCommand = runRepositoryCommand,
): ReturnType<ResolutionTaskRunner> => {
  // The repository's own code runs with a stated environment and no parent
  // credential (Issue #4659). Build-cache placement for the checkout (Issue
  // #2247) is decided inside runRepositoryCommand, not here.
  const result = await run(
    task.kind === "script"
      ? "bash"
      : task.kind === "cargo"
      ? "cargo"
      : Deno.execPath(),
    task.args,
    {
      cwd: task.dir,
      timeoutMs: task.timeoutMs,
      manifests: await manifestsFor(task.kind, task.dir),
    },
  );
  if (!result.ok) {
    return {
      code: 1,
      output: result.error.message,
      ...(result.error instanceof GateAccountUnavailable
        ? { accountUnavailable: result.error.message }
        : {}),
    };
  }
  const { code, stdout, stderr, timedOut } = result.value;
  const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean)
    .join("\n");
  if (timedOut) {
    return {
      code: 124,
      output: `${output}\n'${
        describeTask(task)
      }' timed out after ${task.timeoutMs}ms`
        .trim(),
      timedOut: true,
    };
  }
  return { code, output };
};

/**
 * Verify a tree whose conflicts the worker resolved itself.
 *
 * @param repoDir - Root of the merged working tree (the clone's cwd)
 * @param runner - Override the spawned task (tests)
 * @returns `passed` when every task that ran passed. A task left to CI because
 *   the host could not fetch its remote modules (Issue #4422) is not run, so
 *   the passed outcome names it in `suiteLeftToCi` and in its detail. A type
 *   check left to CI the same way is carried through as `checkLeftToCi`
 *   (Issue #4441), so the report does not claim it passed. A Cargo step (check
 *   carried through, or `cargo test`) that hit its time limit (Issue #4786) is
 *   left to CI the same way and named as timed out in the passed detail; a Cargo
 *   step that could not reach its crate registry even on an offline retry
 *   (Issue #4786) is left to CI likewise and named in the passed detail; a Deno
 *   task that times out is still a failure. `skipped` when the
 *   tree defines nothing to run, which the caller must treat as a refusal. That
 *   refusal is fail closed: an all-left-to-CI tree where no unit suite or
 *   quality script ran is still `skipped`, and the early `skipped` return (the
 *   type check did not pass) never carries `checkLeftToCi`
 */
export async function verifyResolvedTree(
  repoDir: string,
  runner: ResolutionTaskRunner = spawnTask,
  /** The Issue #974 type check. Injected in tests; the real gate otherwise. */
  typeCheck: MergeGateFn = checkMergedTree,
  /** Reads the clock. Injected in tests so the budget is deterministic. */
  now: () => number = () => Date.now(),
  /**
   * Whether the ephemeral cargo build must not run (Issue #4326).
   * Defaults to a fresh read of the host-disk budget. A mixed tree's type
   * check still passes, so the detail string is not where this is decided.
   */
  skipCargoBuild: () => Promise<boolean> = () =>
    shouldSkipEphemeralCargoBuild(repoDir),
): Promise<MergeGateOutcome> {
  // A tree that cannot be read is a verification that could not be run.
  try {
    if (!(await Deno.stat(repoDir)).isDirectory) {
      return {
        status: "failed",
        detail: `merged tree '${repoDir}' is not a directory — nothing ` +
          `verified the resolution`,
        output: "",
      };
    }
  } catch (err) {
    return {
      status: "failed",
      detail: `merged tree '${repoDir}' could not be read — nothing verified ` +
        `the resolution`,
      output: tail(err instanceof Error ? err.message : String(err)),
    };
  }

  // The Issue #974 gate first, exactly as it stands — including its fallback
  // to a whole-tree `deno check` where the manifest names no `check` task.
  // Re-implementing it here would quietly drop that fallback, and a
  // resolution pushed without any type check is the state #974 exists to end.
  const typed = await typeCheck(repoDir);
  if (typed.status !== "passed") {
    return typed.status === "failed" ? typed : {
      status: "skipped",
      detail: `${typed.detail} — the Issue #974 type check did not run`,
      output: typed.output,
      ...(typed.cargoSkipped ? { cargoSkipped: true } : {}),
    };
  }

  // The budget starts after the type check, which has its own limit, so a long
  // cold cargo check does not spend the budget of the tasks after it (Issue
  // #4787).
  const deadline = now() + RESOLUTION_GATE_BUDGET_MS;

  const ran: string[] = [typed.detail];
  // Tasks the host could not run for want of remote modules (Issue #4422).
  const leftToCi: string[] = [];
  let unitSuiteRan = false;
  let unitSuiteLeftToCi = false;
  // Re-read the budget. A mixed tree's type check returns `passed` after it
  // skips cargo, and parsing that detail would miss a budget that flipped
  // between the two gates (Issue #4326). The type check's own `cargoSkipped`
  // is honoured as well: a `cargo check` that timed out (Issue #4786) fills
  // the same cold target as `cargo test`, so the suite waits for CI too.
  const projects = await findProjectManifests(repoDir);
  const skipCargo = projects.some((project) => project.kind === "cargo") &&
    (typed.cargoSkipped === true || await skipCargoBuild());
  let skippedCargoSuite = false;
  // Cargo steps left to CI: those that hit their time limit, and those that
  // could not reach their crate registry even offline (Issue #4786). Each entry
  // names the step and its cause; the passed detail adds the CI suffix.
  const cargoLeftNotes: string[] = [];
  // Run Deno first: a cargo timeout may consume the whole remaining budget.
  const orderedProjects = [
    ...projects.filter((project) => project.kind !== "cargo"),
    ...projects.filter((project) => project.kind === "cargo"),
  ];
  for (const project of orderedProjects) {
    if (project.kind === "cargo" && skipCargo) {
      // `cargo test` fills the same ephemeral target the type check declined
      // to fill. The suite waits for CI.
      skippedCargoSuite = true;
      continue;
    }
    // Issue #2138: a Cargo workspace's unit suite is `cargo test`; a Deno
    // project's is whichever of its tasks resolutionTasksFor names.
    const planned: ResolutionTask[] = project.kind === "cargo"
      ? [{
        dir: project.dir,
        kind: "cargo",
        task: "test",
        args: await cargoTestArgs(project.dir),
        timeoutMs: 0,
      }]
      : resolutionTasksFor(await readManifestTasks(project.manifest)).map(
        (task) => ({
          dir: project.dir,
          kind: "deno" as const,
          task,
          args: ["task", task],
          timeoutMs: 0,
        }),
      );
    for (const step of planned) {
      const task = step.task;
      const where = `${describeTask(step)} in ${project.dir}`;
      let timeoutMs = deadline - now();
      if (timeoutMs <= 0) {
        return {
          status: "failed",
          detail: `${where} was not reached within the ` +
            `${RESOLUTION_GATE_BUDGET_MS}ms verification budget — the ` +
            `resolution is unverified, so it is not pushed`,
          output: "",
        };
      }
      let result: {
        code: number;
        output: string;
        accountUnavailable?: string;
        timedOut?: boolean;
      };
      try {
        result = await runner({ ...step, timeoutMs });
      } catch (err) {
        // Unrunnable is not clean — the resolution stays unverified.
        return {
          status: "failed",
          detail: `${where} could not be run`,
          output: tail(err instanceof Error ? err.message : String(err)),
        };
      }
      // The cause the first attempt named when it could not reach the crate
      // registry (Issue #4786); set only when the step was retried offline.
      let registryCause: string | undefined;
      const firstGap = step.kind === "cargo" && result.code !== 0 &&
          !result.timedOut && !result.accountUnavailable
        ? detectCargoRegistryGap(result.output)
        : undefined;
      if (firstGap) {
        // A cargo step that cannot reach its registry is retried once offline,
        // from the local cargo cache, inside whatever budget is left (Issue
        // #4786). The retry gets a fresh reading of the clock.
        registryCause = firstGap.cause;
        timeoutMs = deadline - now();
        if (timeoutMs <= 0) {
          return {
            status: "failed",
            detail: `${where} was not reached within the ` +
              `${RESOLUTION_GATE_BUDGET_MS}ms verification budget — the ` +
              `resolution is unverified, so it is not pushed`,
            output: "",
          };
        }
        try {
          result = await runner({
            ...step,
            args: withCargoOffline(step.args),
            timeoutMs,
          });
        } catch (err) {
          return {
            status: "failed",
            detail: `${where} could not be run`,
            output: tail(err instanceof Error ? err.message : String(err)),
          };
        }
        // Still no registry after the offline retry: the step is left to CI,
        // with the first attempt's cause (Issue #4786).
        if (
          result.code !== 0 && !result.accountUnavailable &&
          isCargoOfflineRegistryGap(result.output)
        ) {
          skippedCargoSuite = true;
          cargoLeftNotes.push(
            `${where} could not reach its crate registry (${registryCause})`,
          );
          continue;
        }
      }
      if (result.accountUnavailable) {
        leftToCi.push(`${where}: ${result.accountUnavailable}`);
        if (step.kind === "cargo" || isUnitSuite(task)) {
          unitSuiteLeftToCi = true;
        }
        continue;
      }
      if (result.code !== 0) {
        // Issue #4786: a cargo step that hit its time limit on a cold ephemeral
        // target says nothing about the resolution, so it is left to CI. A
        // Deno task that times out is still a failure, below.
        if (step.kind === "cargo" && result.timedOut) {
          skippedCargoSuite = true;
          cargoLeftNotes.push(`${where} timed out after ${timeoutMs}ms`);
          continue;
        }
        // Issue #4422: a Deno task that could not fetch a remote module ran on
        // a host with no route to the module host. That is an environment
        // fault, so the task is left to CI rather than failed or passed.
        const remote = step.kind === "deno"
          ? detectRemoteModuleGap(result.output)
          : undefined;
        if (remote) {
          leftToCi.push(
            `${where} could not fetch its remote modules (${remote.cause})`,
          );
          if (isUnitSuite(task)) unitSuiteLeftToCi = true;
          continue;
        }
        // Issue #3255: `cargo test` fails the same way `cargo check` does
        // when the host's rustc is older than the tree's rust-version — an
        // environment fault, not a bad resolution, so it is named as such.
        const gap = step.kind === "cargo"
          ? detectRustToolchainGap(result.output)
          : undefined;
        if (gap) {
          return {
            status: "failed",
            detail: describeRustToolchainGap(where, result.code, gap),
            output: tail(result.output),
            toolchainGap: gap,
          };
        }
        return {
          status: "failed",
          detail: `${where} failed (exit ${result.code})`,
          output: tail(result.output),
        };
      }
      // A step that passed only on the offline retry says so (Issue #4786).
      ran.push(
        registryCause !== undefined
          ? `${where} (verified offline from the local cargo cache, Issue #4786)`
          : where,
      );
      if (step.kind === "cargo" || isUnitSuite(task)) unitSuiteRan = true;
    }
  }

  // `quality.sh` runs cargo. It is not a substitute for a suite the budget
  // just skipped, and a `skipped` verdict would refuse the resolution that
  // budget exists to let land (Issue #4326).
  const cargoSkippedAsOnlySuite = !unitSuiteRan && skippedCargoSuite;
  // A unit suite the host could not fetch (Issue #4422) is not replaced by
  // quality.sh either: the script runs the same suite and hits the same host
  // limit, so the suite stays left to CI.
  if (
    !unitSuiteRan && !skippedCargoSuite && !unitSuiteLeftToCi &&
    await hasQualityScript(repoDir)
  ) {
    // Issue #2388: no manifest names a unit suite, but the repository has its
    // own quality gate — run that, inside whatever budget is left.
    const step: ResolutionTask = {
      dir: repoDir,
      kind: "script",
      task: QUALITY_SCRIPT,
      args: [QUALITY_SCRIPT],
      timeoutMs: 0,
    };
    const where = `${describeTask(step)} in ${repoDir}`;
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) {
      return {
        status: "failed",
        detail: `${where} was not reached within the ` +
          `${RESOLUTION_GATE_BUDGET_MS}ms verification budget — the ` +
          `resolution is unverified, so it is not pushed`,
        output: "",
      };
    }
    let result: { code: number; output: string; accountUnavailable?: string };
    try {
      result = await runner({ ...step, timeoutMs });
    } catch (err) {
      return {
        status: "failed",
        detail: `${where} could not be run`,
        output: tail(err instanceof Error ? err.message : String(err)),
      };
    }
    if (result.accountUnavailable) {
      leftToCi.push(`${where}: ${result.accountUnavailable}`);
      unitSuiteLeftToCi = true;
    } else if (result.code !== 0) {
      return {
        status: "failed",
        detail: `${where} failed (exit ${result.code})`,
        output: tail(result.output),
      };
    }
    if (!result.accountUnavailable) {
      ran.push(where);
      unitSuiteRan = true;
    }
  }

  // A unit suite left to CI for want of remote modules is not "nothing ran the
  // cases" either: it was not run because the host could not, and the report
  // names it (Issue #4422).
  if (!unitSuiteRan && !cargoSkippedAsOnlySuite && !unitSuiteLeftToCi) {
    // Choosing a side compiles perfectly while dropping the other side's
    // behaviour, so the type check alone does not verify a resolution.
    return {
      status: "skipped",
      detail: `no ${UNIT_SUITE_TASKS.join("/")} task, Cargo.toml or ` +
        `${QUALITY_SCRIPT} under '${repoDir}' — nothing ran the cases that ` +
        "would show a dropped implementation",
      output: "",
    };
  }

  const cargoLeftToCi = skippedCargoSuite || typed.cargoSkipped === true;
  const cargoNote = cargoLeftToCi &&
      !typed.detail.includes(CARGO_BUILD_SKIPPED_FOR_MERGE)
    ? `; ${CARGO_BUILD_SKIPPED_FOR_MERGE} (Issue #4326)`
    : "";
  const suiteNote = leftToCi.length > 0
    ? `; ${leftToCi.join("; ")} — left to the milestone PR's CI (Issue #4422)`
    : "";
  const cargoLeftNote = cargoLeftNotes.map((note) =>
    `; ${note} — left to CI (Issue #4786)`
  ).join("");
  return {
    status: "passed",
    detail: `${ran.join("; ")} passed${cargoNote}${cargoLeftNote}${suiteNote}`,
    output: "",
    ...(cargoLeftToCi ? { cargoSkipped: true } : {}),
    ...(leftToCi.length > 0 ? { suiteLeftToCi: leftToCi.join("; ") } : {}),
    ...(typed.checkLeftToCi ? { checkLeftToCi: typed.checkLeftToCi } : {}),
  };
}
