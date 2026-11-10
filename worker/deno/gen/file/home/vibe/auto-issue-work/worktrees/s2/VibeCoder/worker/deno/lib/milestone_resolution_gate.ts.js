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
 */ import { checkMergedTree, collapseRepeatedLines, describeRustToolchainGap, detectCargoRegistryGap, detectRemoteModuleGap, detectRustToolchainGap, findProjectManifests, isCargoOfflineRegistryGap, readManifestTasks, withCargoOffline } from "./milestone_merge_gate.ts";
import { GateAccountUnavailable, manifestsFor, runRepositoryCommand } from "./untrusted_gate_spawn.ts";
import { CARGO_BUILD_SKIPPED_FOR_MERGE, shouldSkipEphemeralCargoBuild } from "./heavy_build_gate.ts";
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
 */ export const RESOLUTION_GATE_BUDGET_MS = 900_000;
/**
 * The tasks a resolved tree is verified with, beyond the Issue #974 type
 * check, in the order they run.
 *
 * `test:unit` and `test` are alternatives — the first one the repository
 * defines is the unit suite, so a repo with both does not run its integration
 * tests inside a sync cycle.
 */ export const RESOLUTION_GATE_TASKS = [
  "check:manifests",
  "test:unit",
  "test"
];
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
 */ export const QUALITY_SCRIPT = "quality.sh";
/** The unit-suite task names, most specific first. */ const UNIT_SUITE_TASKS = [
  "test:unit",
  "test"
];
/** How a task is spelled in a log line or an escalation. */ export function describeTask(task) {
  if (task.kind === "script") return `./${task.args.join(" ")}`;
  return task.kind === "cargo" ? `cargo ${task.args.join(" ")}` : `deno task ${task.task}`;
}
/**
 * `cargo test` over the whole workspace as the unit suite (Issue #2138) —
 * `--locked` only when a `Cargo.lock` is committed, as the type check does.
 */ export async function cargoTestArgs(dir) {
  const args = [
    "test",
    "--workspace"
  ];
  try {
    if ((await Deno.stat(`${dir}/Cargo.lock`)).isFile) args.push("--locked");
  } catch  {
  // no lockfile: an unlocked crate is verified unlocked
  }
  return args;
}
/** Longest task output carried into a log line or an escalation comment. */ const MAX_OUTPUT_LINES = 40;
const MAX_OUTPUT_CHARS = 4000;
/** Keep the tail — a task's failure sits at the end of its output. */ function tail(output) {
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
 */ export function resolutionTasksFor(defined) {
  const tasks = [];
  if (defined.includes("check:manifests")) tasks.push("check:manifests");
  const unitSuite = UNIT_SUITE_TASKS.find((name)=>defined.includes(name));
  if (unitSuite) tasks.push(unitSuite);
  return tasks;
}
/** Whether the tree carries the repository's own quality gate. */ async function hasQualityScript(repoDir) {
  try {
    return (await Deno.stat(`${repoDir}/${QUALITY_SCRIPT}`)).isFile;
  } catch  {
    return false;
  }
}
/** Whether a task name is the unit suite (the one the issue requires). */ function isUnitSuite(task) {
  return UNIT_SUITE_TASKS.includes(task);
}
/**
 * Spawn one of the repository's own tasks within the remaining budget. The
 * command runner is injectable so a test can check what a timed-out task
 * returns (Issue #4786), as {@link spawnTypeCheck}'s is (Issue #4787).
 */ export const spawnTask = async (task, /** The command runner. Production uses the real one; tests inject a fake. */ run = runRepositoryCommand)=>{
  // The repository's own code runs with a stated environment and no parent
  // credential (Issue #4659). Build-cache placement for the checkout (Issue
  // #2247) is decided inside runRepositoryCommand, not here.
  const result = await run(task.kind === "script" ? "bash" : task.kind === "cargo" ? "cargo" : Deno.execPath(), task.args, {
    cwd: task.dir,
    timeoutMs: task.timeoutMs,
    manifests: await manifestsFor(task.kind, task.dir)
  });
  if (!result.ok) {
    return {
      code: 1,
      output: result.error.message,
      ...result.error instanceof GateAccountUnavailable ? {
        accountUnavailable: result.error.message
      } : {}
    };
  }
  const { code, stdout, stderr, timedOut } = result.value;
  const output = [
    stdout,
    stderr
  ].map((s)=>s.trim()).filter(Boolean).join("\n");
  if (timedOut) {
    return {
      code: 124,
      output: `${output}\n'${describeTask(task)}' timed out after ${task.timeoutMs}ms`.trim(),
      timedOut: true
    };
  }
  return {
    code,
    output
  };
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
 */ export async function verifyResolvedTree(repoDir, runner = spawnTask, /** The Issue #974 type check. Injected in tests; the real gate otherwise. */ typeCheck = checkMergedTree, /** Reads the clock. Injected in tests so the budget is deterministic. */ now = ()=>Date.now(), /**
   * Whether the ephemeral cargo build must not run (Issue #4326).
   * Defaults to a fresh read of the host-disk budget. A mixed tree's type
   * check still passes, so the detail string is not where this is decided.
   */ skipCargoBuild = ()=>shouldSkipEphemeralCargoBuild(repoDir)) {
  // A tree that cannot be read is a verification that could not be run.
  try {
    if (!(await Deno.stat(repoDir)).isDirectory) {
      return {
        status: "failed",
        detail: `merged tree '${repoDir}' is not a directory — nothing ` + `verified the resolution`,
        output: ""
      };
    }
  } catch (err) {
    return {
      status: "failed",
      detail: `merged tree '${repoDir}' could not be read — nothing verified ` + `the resolution`,
      output: tail(err instanceof Error ? err.message : String(err))
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
      ...typed.cargoSkipped ? {
        cargoSkipped: true
      } : {}
    };
  }
  // The budget starts after the type check, which has its own limit, so a long
  // cold cargo check does not spend the budget of the tasks after it (Issue
  // #4787).
  const deadline = now() + RESOLUTION_GATE_BUDGET_MS;
  const ran = [
    typed.detail
  ];
  // Tasks the host could not run for want of remote modules (Issue #4422).
  const leftToCi = [];
  let unitSuiteRan = false;
  let unitSuiteLeftToCi = false;
  // Re-read the budget. A mixed tree's type check returns `passed` after it
  // skips cargo, and parsing that detail would miss a budget that flipped
  // between the two gates (Issue #4326). The type check's own `cargoSkipped`
  // is honoured as well: a `cargo check` that timed out (Issue #4786) fills
  // the same cold target as `cargo test`, so the suite waits for CI too.
  const projects = await findProjectManifests(repoDir);
  const skipCargo = projects.some((project)=>project.kind === "cargo") && (typed.cargoSkipped === true || await skipCargoBuild());
  let skippedCargoSuite = false;
  // Cargo steps left to CI: those that hit their time limit, and those that
  // could not reach their crate registry even offline (Issue #4786). Each entry
  // names the step and its cause; the passed detail adds the CI suffix.
  const cargoLeftNotes = [];
  // Run Deno first: a cargo timeout may consume the whole remaining budget.
  const orderedProjects = [
    ...projects.filter((project)=>project.kind !== "cargo"),
    ...projects.filter((project)=>project.kind === "cargo")
  ];
  for (const project of orderedProjects){
    if (project.kind === "cargo" && skipCargo) {
      // `cargo test` fills the same ephemeral target the type check declined
      // to fill. The suite waits for CI.
      skippedCargoSuite = true;
      continue;
    }
    // Issue #2138: a Cargo workspace's unit suite is `cargo test`; a Deno
    // project's is whichever of its tasks resolutionTasksFor names.
    const planned = project.kind === "cargo" ? [
      {
        dir: project.dir,
        kind: "cargo",
        task: "test",
        args: await cargoTestArgs(project.dir),
        timeoutMs: 0
      }
    ] : resolutionTasksFor(await readManifestTasks(project.manifest)).map((task)=>({
        dir: project.dir,
        kind: "deno",
        task,
        args: [
          "task",
          task
        ],
        timeoutMs: 0
      }));
    for (const step of planned){
      const task = step.task;
      const where = `${describeTask(step)} in ${project.dir}`;
      let timeoutMs = deadline - now();
      if (timeoutMs <= 0) {
        return {
          status: "failed",
          detail: `${where} was not reached within the ` + `${RESOLUTION_GATE_BUDGET_MS}ms verification budget — the ` + `resolution is unverified, so it is not pushed`,
          output: ""
        };
      }
      let result;
      try {
        result = await runner({
          ...step,
          timeoutMs
        });
      } catch (err) {
        // Unrunnable is not clean — the resolution stays unverified.
        return {
          status: "failed",
          detail: `${where} could not be run`,
          output: tail(err instanceof Error ? err.message : String(err))
        };
      }
      // The cause the first attempt named when it could not reach the crate
      // registry (Issue #4786); set only when the step was retried offline.
      let registryCause;
      const firstGap = step.kind === "cargo" && result.code !== 0 && !result.timedOut && !result.accountUnavailable ? detectCargoRegistryGap(result.output) : undefined;
      if (firstGap) {
        // A cargo step that cannot reach its registry is retried once offline,
        // from the local cargo cache, inside whatever budget is left (Issue
        // #4786). The retry gets a fresh reading of the clock.
        registryCause = firstGap.cause;
        timeoutMs = deadline - now();
        if (timeoutMs <= 0) {
          return {
            status: "failed",
            detail: `${where} was not reached within the ` + `${RESOLUTION_GATE_BUDGET_MS}ms verification budget — the ` + `resolution is unverified, so it is not pushed`,
            output: ""
          };
        }
        try {
          result = await runner({
            ...step,
            args: withCargoOffline(step.args),
            timeoutMs
          });
        } catch (err) {
          return {
            status: "failed",
            detail: `${where} could not be run`,
            output: tail(err instanceof Error ? err.message : String(err))
          };
        }
        // Still no registry after the offline retry: the step is left to CI,
        // with the first attempt's cause (Issue #4786).
        if (result.code !== 0 && !result.accountUnavailable && isCargoOfflineRegistryGap(result.output)) {
          skippedCargoSuite = true;
          cargoLeftNotes.push(`${where} could not reach its crate registry (${registryCause})`);
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
        const remote = step.kind === "deno" ? detectRemoteModuleGap(result.output) : undefined;
        if (remote) {
          leftToCi.push(`${where} could not fetch its remote modules (${remote.cause})`);
          if (isUnitSuite(task)) unitSuiteLeftToCi = true;
          continue;
        }
        // Issue #3255: `cargo test` fails the same way `cargo check` does
        // when the host's rustc is older than the tree's rust-version — an
        // environment fault, not a bad resolution, so it is named as such.
        const gap = step.kind === "cargo" ? detectRustToolchainGap(result.output) : undefined;
        if (gap) {
          return {
            status: "failed",
            detail: describeRustToolchainGap(where, result.code, gap),
            output: tail(result.output),
            toolchainGap: gap
          };
        }
        return {
          status: "failed",
          detail: `${where} failed (exit ${result.code})`,
          output: tail(result.output)
        };
      }
      // A step that passed only on the offline retry says so (Issue #4786).
      ran.push(registryCause !== undefined ? `${where} (verified offline from the local cargo cache, Issue #4786)` : where);
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
  if (!unitSuiteRan && !skippedCargoSuite && !unitSuiteLeftToCi && await hasQualityScript(repoDir)) {
    // Issue #2388: no manifest names a unit suite, but the repository has its
    // own quality gate — run that, inside whatever budget is left.
    const step = {
      dir: repoDir,
      kind: "script",
      task: QUALITY_SCRIPT,
      args: [
        QUALITY_SCRIPT
      ],
      timeoutMs: 0
    };
    const where = `${describeTask(step)} in ${repoDir}`;
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) {
      return {
        status: "failed",
        detail: `${where} was not reached within the ` + `${RESOLUTION_GATE_BUDGET_MS}ms verification budget — the ` + `resolution is unverified, so it is not pushed`,
        output: ""
      };
    }
    let result;
    try {
      result = await runner({
        ...step,
        timeoutMs
      });
    } catch (err) {
      return {
        status: "failed",
        detail: `${where} could not be run`,
        output: tail(err instanceof Error ? err.message : String(err))
      };
    }
    if (result.accountUnavailable) {
      leftToCi.push(`${where}: ${result.accountUnavailable}`);
      unitSuiteLeftToCi = true;
    } else if (result.code !== 0) {
      return {
        status: "failed",
        detail: `${where} failed (exit ${result.code})`,
        output: tail(result.output)
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
      detail: `no ${UNIT_SUITE_TASKS.join("/")} task, Cargo.toml or ` + `${QUALITY_SCRIPT} under '${repoDir}' — nothing ran the cases that ` + "would show a dropped implementation",
      output: ""
    };
  }
  const cargoLeftToCi = skippedCargoSuite || typed.cargoSkipped === true;
  const cargoNote = cargoLeftToCi && !typed.detail.includes(CARGO_BUILD_SKIPPED_FOR_MERGE) ? `; ${CARGO_BUILD_SKIPPED_FOR_MERGE} (Issue #4326)` : "";
  const suiteNote = leftToCi.length > 0 ? `; ${leftToCi.join("; ")} — left to the milestone PR's CI (Issue #4422)` : "";
  const cargoLeftNote = cargoLeftNotes.map((note)=>`; ${note} — left to CI (Issue #4786)`).join("");
  return {
    status: "passed",
    detail: `${ran.join("; ")} passed${cargoNote}${cargoLeftNote}${suiteNote}`,
    output: "",
    ...cargoLeftToCi ? {
      cargoSkipped: true
    } : {},
    ...leftToCi.length > 0 ? {
      suiteLeftToCi: leftToCi.join("; ")
    } : {},
    ...typed.checkLeftToCi ? {
      checkLeftToCi: typed.checkLeftToCi
    } : {}
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfcmVzb2x1dGlvbl9nYXRlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIGdhdGUgYW4gYXV0b21hdGljIGNvbmZsaWN0IHJlc29sdXRpb24gbXVzdCBwYXNzIChJc3N1ZSAjMTU1OSkuXG4gKlxuICogQSBjb25mbGljdCB0aGUgd29ya2VyIHJlc29sdmVzIGl0c2VsZiBnZXRzIHRoZSBzYW1lIHZlcmlmaWNhdGlvbiBhIGh1bWFuJ3NcbiAqIHJlc29sdXRpb24gZ2V0cywgYW5kIGZvciB0aGUgc2FtZSByZWFzb246IGEgcmVzb2x1dGlvbiBub2JvZHkgY2hlY2tlZCBpcyBhXG4gKiBndWVzcy4gVGhlIHR5cGUtY2hlY2sgZ2F0ZSBvZiBJc3N1ZSAjOTc0IGFuc3dlcnMgXCJkb2VzIHRoZSBtZXJnZWQgdHJlZSBzdGlsbFxuICogY29tcGlsZT9cIiwgd2hpY2ggaXMgdGhlIHJpZ2h0IHF1ZXN0aW9uIGZvciBhIG1lcmdlIGdpdCByZXNvbHZlZCBvbiBpdHMgb3duLlxuICogSXQgaXMgbm90IGVub3VnaCBmb3IgYSBtZXJnZSB3aGVyZSB0aGUgd29ya2VyICpjaG9zZSBhIHNpZGUqOiBkcm9wcGluZyBvbmVcbiAqIHNpZGUncyBpbXBsZW1lbnRhdGlvbiBjb21waWxlcyBwZXJmZWN0bHkgYW5kIGZhaWxzIHRoZSBtb21lbnQgdGhlIG90aGVyXG4gKiBzaWRlJ3MgdGVzdHMgcnVuLlxuICpcbiAqIFNvIGEgcmVzb2x2ZWQgdHJlZSBydW5zIG1vcmUgb2YgdGhlIHJlcG9zaXRvcnkncyBvd24gdGFza3Mg4oCUIGl0cyBgY2hlY2tgLFxuICogaXRzIGBjaGVjazptYW5pZmVzdHNgIGFuZCBpdHMgdW5pdCBzdWl0ZSDigJQgYW5kIG9ubHkgYSB0cmVlIHRoYXQgcGFzc2VzIGFsbFxuICogb2YgdGhlbSBpcyBwdXNoZWQuIEEgcmVwb3NpdG9yeSB3aG9zZSBzdWl0ZSBydW5zIHRocm91Z2ggaXRzIG93blxuICogYHF1YWxpdHkuc2hgIHJhdGhlciB0aGFuIGEgbWFuaWZlc3QgdGFzayBpcyB2ZXJpZmllZCB3aXRoIHRoYXQgc2NyaXB0XG4gKiAoSXNzdWUgIzIzODgpLiBBIHRyZWUgdGhhdCBkZWZpbmVzIG5vbmUgb2YgdGhlbSBpcyByZXBvcnRlZCBgc2tpcHBlZGAsXG4gKiBhbmQgdGhlIHN5bmMgdHJlYXRzIHRoYXQgYXMgYSByZWZ1c2FsOiBhIHJlc29sdXRpb24gdGhhdCBjYW5ub3QgYmUgdmVyaWZpZWRcbiAqIGlzIG5vdCBhIHJlc29sdXRpb24uXG4gKlxuICogQSBDYXJnbyBwcm9qZWN0J3MgYGNhcmdvIGNoZWNrYCBvciBgY2FyZ28gdGVzdGAgc3RlcCBjYXJyaWVzIHRocm91Z2ggdGhlXG4gKiBzYW1lIHRvb2xjaGFpbi1nYXAgZGV0ZWN0aW9uIGFzIGBtaWxlc3RvbmVfbWVyZ2VfZ2F0ZS50c2A6IGEgaG9zdCBgcnVzdGNgXG4gKiBvbGRlciB0aGFuIGEgd29ya3NwYWNlIHBhY2thZ2UncyBgcnVzdC12ZXJzaW9uYCBpcyByZXBvcnRlZCBuYW1pbmcgdGhlXG4gKiBjb250YWluZXIncyBSdXN0IHBpbiwgYW5kIHNraXBzIHRoZSByZXBhaXIgcm91bmRzIGJ1aWx0IGZvciBhIGJhZFxuICogcmVzb2x1dGlvbiByYXRoZXIgdGhhbiBhIGhvc3QgbGltaXQgKElzc3VlICMzMjU1KS4gQSBkZXBlbmRlbmN5LW9ubHlcbiAqIHJlZnVzYWwgc3RheXMgYW4gb3JkaW5hcnkgZmFpbHVyZSBhIHJlcGFpciByb3VuZCBtYXkgYW5zd2VyLlxuICpcbiAqIEEgRGVubyB0YXNrIHRoYXQgY2Fubm90IGZldGNoIGEgcmVtb3RlIG1vZHVsZSAoYW4gYGh0dHBzOi8vYCBpbXBvcnQgdGhlIGhvc3RcbiAqIGhhcyBubyByb3V0ZSB0bykgaXMgYW4gZW52aXJvbm1lbnQgZmF1bHQgdGhlIHNhbWUgd2F5IChJc3N1ZSAjNDQyMikuIFRoZVxuICogdGFzayBkaWQgbm90IHJ1biwgc28gaXQgaXMgcmVwb3J0ZWQgYXMgbGVmdCB0byB0aGUgbWlsZXN0b25lIFBSJ3MgQ0kgcmF0aGVyXG4gKiB0aGFuIGFzIHBhc3NlZCwgYW5kIGl0IGlzIG5vdCBmYWlsZWQ6IGEgdHJlZSB0aGF0IHBhc3NlcyBldmVyeSBvdGhlciB0YXNrIGlzXG4gKiBzdGlsbCBwdXNoZWQuIEEgZmFpbHVyZSBvZiBhbnkgb3RoZXIga2luZCBzdGlsbCByZWZ1c2VzIHRoZSByZXNvbHV0aW9uLlxuICpcbiAqIEEgQ2FyZ28gc3RlcCB0aGF0IGNhbm5vdCByZWFjaCBpdHMgY3JhdGUgcmVnaXN0cnkgKElzc3VlICM0Nzg2KSBpcyByZXRyaWVkXG4gKiBvbmNlIG9mZmxpbmUsIGZyb20gdGhlIGxvY2FsIGNhcmdvIGNhY2hlLCBpbnNpZGUgdGhlIHJlbWFpbmluZyBidWRnZXQuIElmIHRoZVxuICogcmV0cnkgc3RpbGwgY2Fubm90IHJlYWNoIHRoZSByZWdpc3RyeSB0aGUgc3RlcCBpcyBsZWZ0IHRvIENJLCBhcyBhIHRpbWVkLW91dFxuICogQ2FyZ28gc3RlcCBpcywgYW5kIHRoZSBwYXNzZWQgZGV0YWlsIG5hbWVzIGl0LlxuICpcbiAqIFRoZSBJc3N1ZSAjOTc0IHR5cGUgY2hlY2sgcnVucyBmaXJzdCBhbmQgaGFzIGl0cyBvd24gbGltaXQsXG4gKiBgdHlwZUNoZWNrVGltZW91dE1zYCAoMzAwIHMgZm9yIERlbm8sIDkwMCBzIGZvciBDYXJnbzsgSXNzdWUgIzQ3ODcpLiBUaGVcbiAqIHZlcmlmaWNhdGlvbiBidWRnZXQsIHtAbGluayBSRVNPTFVUSU9OX0dBVEVfQlVER0VUX01TfSwgc3RhcnRzIG9uY2UgdGhhdFxuICogY2hlY2sgaGFzIHBhc3NlZCBhbmQgY292ZXJzIG9ubHkgdGhlIHRhc2tzIGFmdGVyIGl0LCBzbyBhIGxvbmcgdHlwZSBjaGVja1xuICogZG9lcyBub3QgbGVhdmUgYSBsYXRlciB0YXNrIHVucmVhY2hlZC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQge1xuICBjaGVja01lcmdlZFRyZWUsXG4gIGNvbGxhcHNlUmVwZWF0ZWRMaW5lcyxcbiAgZGVzY3JpYmVSdXN0VG9vbGNoYWluR2FwLFxuICBkZXRlY3RDYXJnb1JlZ2lzdHJ5R2FwLFxuICBkZXRlY3RSZW1vdGVNb2R1bGVHYXAsXG4gIGRldGVjdFJ1c3RUb29sY2hhaW5HYXAsXG4gIGZpbmRQcm9qZWN0TWFuaWZlc3RzLFxuICBpc0NhcmdvT2ZmbGluZVJlZ2lzdHJ5R2FwLFxuICB0eXBlIE1lcmdlR2F0ZUZuLFxuICB0eXBlIE1lcmdlR2F0ZU91dGNvbWUsXG4gIHR5cGUgUHJvamVjdEtpbmQsXG4gIHJlYWRNYW5pZmVzdFRhc2tzLFxuICB3aXRoQ2FyZ29PZmZsaW5lLFxufSBmcm9tIFwiLi9taWxlc3RvbmVfbWVyZ2VfZ2F0ZS50c1wiO1xuaW1wb3J0IHtcbiAgR2F0ZUFjY291bnRVbmF2YWlsYWJsZSxcbiAgbWFuaWZlc3RzRm9yLFxuICBydW5SZXBvc2l0b3J5Q29tbWFuZCxcbn0gZnJvbSBcIi4vdW50cnVzdGVkX2dhdGVfc3Bhd24udHNcIjtcbmltcG9ydCB7XG4gIENBUkdPX0JVSUxEX1NLSVBQRURfRk9SX01FUkdFLFxuICBzaG91bGRTa2lwRXBoZW1lcmFsQ2FyZ29CdWlsZCxcbn0gZnJvbSBcIi4vaGVhdnlfYnVpbGRfZ2F0ZS50c1wiO1xuXG4vKipcbiAqIEhvdyBsb25nIHRoZSB3aG9sZSB2ZXJpZmljYXRpb24gbWF5IHJ1biBiZWZvcmUgaXQgaXMgZ2l2ZW4gdXAgb24uXG4gKlxuICogQSBzaW5nbGUgYnVkZ2V0IGFjcm9zcyBldmVyeSB0YXNrLCBub3Qgb25lIHBlciB0YXNrOiB0aGlzIHJ1bnMgaW5zaWRlIHRoZVxuICogc3luYyBjeWNsZSwgYW5kIHRocmVlIGZpZnRlZW4tbWludXRlIHRhc2tzIHBlciBwcm9qZWN0IHdvdWxkIGJsb2NrIHRoZSBsb29wXG4gKiB0aGUgbWlsZXN0b25lIHN5bmMgaXMgc3VwcG9zZWQgdG8gc3RheSBvdXQgb2YgdGhlIHdheSBvZi4gQSB2ZXJpZmljYXRpb25cbiAqIHRoYXQgZG9lcyBub3QgZmluaXNoIGluc2lkZSBpdCBpcyBhIGZhaWx1cmUsIG5ldmVyIGEgcGFzcy5cbiAqXG4gKiBUaGUgYnVkZ2V0IGNvdmVycyBvbmx5IHRoZSB0YXNrcyBhZnRlciB0aGUgSXNzdWUgIzk3NCB0eXBlIGNoZWNrLCBhbmQgc3RhcnRzXG4gKiBvbmNlIHRoYXQgY2hlY2sgaGFzIHBhc3NlZCAoSXNzdWUgIzQ3ODcpLiBUaGUgdHlwZSBjaGVjayBoYXMgaXRzIG93biBsaW1pdCxcbiAqIGB0eXBlQ2hlY2tUaW1lb3V0TXNgIGluIG1pbGVzdG9uZV9tZXJnZV9nYXRlLnRzLCBzbyBhIGxvbmcgY29sZCBjYXJnbyBjaGVja1xuICogY2Fubm90IGxlYXZlIGBjYXJnbyB0ZXN0YCB1bnJlYWNoZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVNPTFVUSU9OX0dBVEVfQlVER0VUX01TID0gOTAwXzAwMDtcblxuLyoqXG4gKiBUaGUgdGFza3MgYSByZXNvbHZlZCB0cmVlIGlzIHZlcmlmaWVkIHdpdGgsIGJleW9uZCB0aGUgSXNzdWUgIzk3NCB0eXBlXG4gKiBjaGVjaywgaW4gdGhlIG9yZGVyIHRoZXkgcnVuLlxuICpcbiAqIGB0ZXN0OnVuaXRgIGFuZCBgdGVzdGAgYXJlIGFsdGVybmF0aXZlcyDigJQgdGhlIGZpcnN0IG9uZSB0aGUgcmVwb3NpdG9yeVxuICogZGVmaW5lcyBpcyB0aGUgdW5pdCBzdWl0ZSwgc28gYSByZXBvIHdpdGggYm90aCBkb2VzIG5vdCBydW4gaXRzIGludGVncmF0aW9uXG4gKiB0ZXN0cyBpbnNpZGUgYSBzeW5jIGN5Y2xlLlxuICovXG5leHBvcnQgY29uc3QgUkVTT0xVVElPTl9HQVRFX1RBU0tTID0gW1xuICBcImNoZWNrOm1hbmlmZXN0c1wiLFxuICBcInRlc3Q6dW5pdFwiLFxuICBcInRlc3RcIixcbl0gYXMgY29uc3Q7XG5cbi8qKlxuICogVGhlIHJlcG9zaXRvcnkncyBvd24gcXVhbGl0eSBnYXRlLCBydW4gYXMgdGhlIHVuaXQgc3VpdGUgd2hlbiB0aGUgdHJlZVxuICogZGVmaW5lcyBubyB1bml0LXN1aXRlIHRhc2sgYW5kIG5vIENhcmdvIHdvcmtzcGFjZSAoSXNzdWUgIzIzODgpLlxuICpcbiAqIGBxdWFsaXR5LnNoYCBpcyB0aGUgZmxlZXQncyBjb252ZW50aW9uIGZvciBcImV2ZXJ5dGhpbmcgdGhpcyByZXBvc2l0b3J5XG4gKiBjaGVja3MgYmVmb3JlIGEgUFJcIiDigJQgYGNvZGViYXNlX21hcC50c2AgdGVsbHMgZXZlcnkgYWdlbnQgdG8gcnVuIGl0LCBhbmQgdGhlXG4gKiBDSS1maXggcGF0aCBydW5zIGl0LiBBIHJlcG9zaXRvcnkgd2hvc2Ugc3VpdGUgaXMgYG5vZGUgLS10ZXN0IOKApmAgYmVoaW5kIHRoYXRcbiAqIHNjcmlwdCBoYXMgbm8gYGRlbm8gdGFzayB0ZXN0YCB0byBmaW5kLCBhbmQgdGhlIGdhdGUgdXNlZCB0byBjYWxsIHRoYXRcbiAqIFwibm90aGluZyB0byB2ZXJpZnkgd2l0aFwiOiBhIGNvbmZsaWN0IHRoZSB3b3JrZXIgaGFkIGFscmVhZHkgcmVzb2x2ZWRcbiAqIGNvcnJlY3RseSB3YXMgcmVmdXNlZCwgdW5jaGFyZ2VkLCBmb3IgZXZlcnkgaXNzdWUgb2YgaXRzIG1pbGVzdG9uZSwgZXZlcnlcbiAqIGhvdXIuIFRoZSBzY3JpcHQgcnVucyBhIHN1cGVyc2V0IG9mIGEgdW5pdCBzdWl0ZSwgd2hpY2ggaXMgbW9yZVxuICogdmVyaWZpY2F0aW9uIHRoYW4gdGhlIGdhdGUgYXNrcyBmb3IsIG5ldmVyIGxlc3MuXG4gKlxuICogUnVuIHRocm91Z2ggYGJhc2hgIHJhdGhlciB0aGFuIGV4ZWN1dGVkIGRpcmVjdGx5IHNvIGEgc2NyaXB0IGNvbW1pdHRlZFxuICogd2l0aG91dCBpdHMgZXhlY3V0YWJsZSBiaXQgc3RpbGwgdmVyaWZpZXMuIEl0IGlzIHRoZSBtZXJnZWQgdHJlZSBvZiB0d28gb2ZcbiAqIHRoZSByZXBvc2l0b3J5J3Mgb3duIHByb3RlY3RlZCBicmFuY2hlcyDigJQgdGhlIHNhbWUgdHJ1c3QgdGhlIGBkZW5vIHRhc2tgXG4gKiBhbmQgYGNhcmdvIHRlc3RgIGJyYW5jaGVzIGFib3ZlIGFscmVhZHkgZXh0ZW5kLlxuICovXG5leHBvcnQgY29uc3QgUVVBTElUWV9TQ1JJUFQgPSBcInF1YWxpdHkuc2hcIjtcblxuLyoqIFRoZSB1bml0LXN1aXRlIHRhc2sgbmFtZXMsIG1vc3Qgc3BlY2lmaWMgZmlyc3QuICovXG5jb25zdCBVTklUX1NVSVRFX1RBU0tTID0gW1widGVzdDp1bml0XCIsIFwidGVzdFwiXSBhcyBjb25zdDtcblxuLyoqIE9uZSB0YXNrIHRvIHJ1biBpbiBvbmUgcHJvamVjdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x1dGlvblRhc2sge1xuICAvKiogRGlyZWN0b3J5IHRoZSB0YXNrIHJ1bnMgaW4uICovXG4gIGRpcjogc3RyaW5nO1xuICAvKipcbiAgICogYGRlbm8gdGFzayA8dGFzaz5gLCBgY2FyZ28gPGFyZ3M+YCBmb3IgYSBDYXJnbyB3b3Jrc3BhY2UgKCMyMTM4KSwgb3JcbiAgICogYHNjcmlwdGAgZm9yIHRoZSByZXBvc2l0b3J5J3Mgb3duIGBxdWFsaXR5LnNoYCAoSXNzdWUgIzIzODgpLlxuICAgKi9cbiAga2luZDogUHJvamVjdEtpbmQgfCBcInNjcmlwdFwiO1xuICAvKiogVGhlIG1hbmlmZXN0IHRhc2sgbmFtZSwgZS5nLiBgY2hlY2s6bWFuaWZlc3RzYDsgYHRlc3RgIGZvciBjYXJnby4gKi9cbiAgdGFzazogc3RyaW5nO1xuICAvKiogVGhlIGFyZ3YgYWZ0ZXIgdGhlIGV4ZWN1dGFibGUuICovXG4gIGFyZ3M6IHN0cmluZ1tdO1xuICAvKiogV2hhdCBpcyBsZWZ0IG9mIHtAbGluayBSRVNPTFVUSU9OX0dBVEVfQlVER0VUX01TfSB3aGVuIGl0IHN0YXJ0cy4gKi9cbiAgdGltZW91dE1zOiBudW1iZXI7XG59XG5cbi8qKiBIb3cgYSB0YXNrIGlzIHNwZWxsZWQgaW4gYSBsb2cgbGluZSBvciBhbiBlc2NhbGF0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlc2NyaWJlVGFzayh0YXNrOiBSZXNvbHV0aW9uVGFzayk6IHN0cmluZyB7XG4gIGlmICh0YXNrLmtpbmQgPT09IFwic2NyaXB0XCIpIHJldHVybiBgLi8ke3Rhc2suYXJncy5qb2luKFwiIFwiKX1gO1xuICByZXR1cm4gdGFzay5raW5kID09PSBcImNhcmdvXCJcbiAgICA/IGBjYXJnbyAke3Rhc2suYXJncy5qb2luKFwiIFwiKX1gXG4gICAgOiBgZGVubyB0YXNrICR7dGFzay50YXNrfWA7XG59XG5cbi8qKlxuICogYGNhcmdvIHRlc3RgIG92ZXIgdGhlIHdob2xlIHdvcmtzcGFjZSBhcyB0aGUgdW5pdCBzdWl0ZSAoSXNzdWUgIzIxMzgpIOKAlFxuICogYC0tbG9ja2VkYCBvbmx5IHdoZW4gYSBgQ2FyZ28ubG9ja2AgaXMgY29tbWl0dGVkLCBhcyB0aGUgdHlwZSBjaGVjayBkb2VzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FyZ29UZXN0QXJncyhkaXI6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgY29uc3QgYXJncyA9IFtcInRlc3RcIiwgXCItLXdvcmtzcGFjZVwiXTtcbiAgdHJ5IHtcbiAgICBpZiAoKGF3YWl0IERlbm8uc3RhdChgJHtkaXJ9L0NhcmdvLmxvY2tgKSkuaXNGaWxlKSBhcmdzLnB1c2goXCItLWxvY2tlZFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gbm8gbG9ja2ZpbGU6IGFuIHVubG9ja2VkIGNyYXRlIGlzIHZlcmlmaWVkIHVubG9ja2VkXG4gIH1cbiAgcmV0dXJuIGFyZ3M7XG59XG5cbi8qKiBSdW5zIG9uZSB0YXNrLiBJbmplY3RlZCBpbiB0ZXN0czsgc3Bhd25zIGBkZW5vIHRhc2sgPG5hbWU+YCBpbiBwcm9kdWN0aW9uLiAqL1xuZXhwb3J0IHR5cGUgUmVzb2x1dGlvblRhc2tSdW5uZXIgPSAoXG4gIHRhc2s6IFJlc29sdXRpb25UYXNrLFxuKSA9PiBQcm9taXNlPFxuICB7XG4gICAgY29kZTogbnVtYmVyO1xuICAgIG91dHB1dDogc3RyaW5nO1xuICAgIGFjY291bnRVbmF2YWlsYWJsZT86IHN0cmluZztcbiAgICAvKipcbiAgICAgKiBTZXQgd2hlbiB0aGUgdGFzayBoaXQgaXRzIHRpbWUgbGltaXQgKElzc3VlICM0Nzg2KSwgc28gdGhlIGNhbGxlciBjYW5cbiAgICAgKiB0ZWxsIGEgdGltZW91dCBmcm9tIGEgZmFpbGluZyB0YXNrLiBTZXQgYnkgdGhlIHByb2R1Y3Rpb24gcnVubmVyIG9ubHkuXG4gICAgICovXG4gICAgdGltZWRPdXQ/OiBib29sZWFuO1xuICB9XG4+O1xuXG4vKiogTG9uZ2VzdCB0YXNrIG91dHB1dCBjYXJyaWVkIGludG8gYSBsb2cgbGluZSBvciBhbiBlc2NhbGF0aW9uIGNvbW1lbnQuICovXG5jb25zdCBNQVhfT1VUUFVUX0xJTkVTID0gNDA7XG5jb25zdCBNQVhfT1VUUFVUX0NIQVJTID0gNDAwMDtcblxuLyoqIEtlZXAgdGhlIHRhaWwg4oCUIGEgdGFzaydzIGZhaWx1cmUgc2l0cyBhdCB0aGUgZW5kIG9mIGl0cyBvdXRwdXQuICovXG5mdW5jdGlvbiB0YWlsKG91dHB1dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXMgPSBjb2xsYXBzZVJlcGVhdGVkTGluZXMob3V0cHV0LnRyaW0oKSkuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGtlcHQgPSBsaW5lcy5zbGljZSgtTUFYX09VVFBVVF9MSU5FUykuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIGtlcHQubGVuZ3RoID4gTUFYX09VVFBVVF9DSEFSUyA/IGtlcHQuc2xpY2UoLU1BWF9PVVRQVVRfQ0hBUlMpIDoga2VwdDtcbn1cblxuLyoqXG4gKiBXaGljaCBvZiBhIHByb2plY3QncyB0YXNrcyB2ZXJpZnkgYSByZXNvbHV0aW9uLlxuICogYHJlYWRNYW5pZmVzdFRhc2tzYCBub3JtYWxpc2VzIHN0cmluZyBhbmQgY29tbWFuZC1iZWFyaW5nIG9iamVjdCB0YXNrcztcbiAqIGRlcGVuZGVuY2llcy1vbmx5IHRhc2tzIGFyZSBub3QgZGlzY292ZXJlZCBhcyBjaGVja3Mgb3Igc3VpdGVzLlxuICpcbiAqIEBwYXJhbSBkZWZpbmVkIC0gRXZlcnkgdGFzayB0aGUgcHJvamVjdCdzIG1hbmlmZXN0IGRlY2xhcmVzXG4gKiBAcmV0dXJucyBUaGUgdGFza3MgdG8gcnVuLCBpbiBvcmRlcjsgZW1wdHkgd2hlbiBpdCBkZWNsYXJlcyBub25lIG9mIHRoZW1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdXRpb25UYXNrc0ZvcihkZWZpbmVkOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgdGFza3M6IHN0cmluZ1tdID0gW107XG4gIGlmIChkZWZpbmVkLmluY2x1ZGVzKFwiY2hlY2s6bWFuaWZlc3RzXCIpKSB0YXNrcy5wdXNoKFwiY2hlY2s6bWFuaWZlc3RzXCIpO1xuICBjb25zdCB1bml0U3VpdGUgPSBVTklUX1NVSVRFX1RBU0tTLmZpbmQoKG5hbWUpID0+IGRlZmluZWQuaW5jbHVkZXMobmFtZSkpO1xuICBpZiAodW5pdFN1aXRlKSB0YXNrcy5wdXNoKHVuaXRTdWl0ZSk7XG4gIHJldHVybiB0YXNrcztcbn1cblxuLyoqIFdoZXRoZXIgdGhlIHRyZWUgY2FycmllcyB0aGUgcmVwb3NpdG9yeSdzIG93biBxdWFsaXR5IGdhdGUuICovXG5hc3luYyBmdW5jdGlvbiBoYXNRdWFsaXR5U2NyaXB0KHJlcG9EaXI6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIHJldHVybiAoYXdhaXQgRGVuby5zdGF0KGAke3JlcG9EaXJ9LyR7UVVBTElUWV9TQ1JJUFR9YCkpLmlzRmlsZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBXaGV0aGVyIGEgdGFzayBuYW1lIGlzIHRoZSB1bml0IHN1aXRlICh0aGUgb25lIHRoZSBpc3N1ZSByZXF1aXJlcykuICovXG5mdW5jdGlvbiBpc1VuaXRTdWl0ZSh0YXNrOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIChVTklUX1NVSVRFX1RBU0tTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyh0YXNrKTtcbn1cblxuLyoqXG4gKiBTcGF3biBvbmUgb2YgdGhlIHJlcG9zaXRvcnkncyBvd24gdGFza3Mgd2l0aGluIHRoZSByZW1haW5pbmcgYnVkZ2V0LiBUaGVcbiAqIGNvbW1hbmQgcnVubmVyIGlzIGluamVjdGFibGUgc28gYSB0ZXN0IGNhbiBjaGVjayB3aGF0IGEgdGltZWQtb3V0IHRhc2tcbiAqIHJldHVybnMgKElzc3VlICM0Nzg2KSwgYXMge0BsaW5rIHNwYXduVHlwZUNoZWNrfSdzIGlzIChJc3N1ZSAjNDc4NykuXG4gKi9cbmV4cG9ydCBjb25zdCBzcGF3blRhc2sgPSBhc3luYyAoXG4gIHRhc2s6IFJlc29sdXRpb25UYXNrLFxuICAvKiogVGhlIGNvbW1hbmQgcnVubmVyLiBQcm9kdWN0aW9uIHVzZXMgdGhlIHJlYWwgb25lOyB0ZXN0cyBpbmplY3QgYSBmYWtlLiAqL1xuICBydW46IHR5cGVvZiBydW5SZXBvc2l0b3J5Q29tbWFuZCA9IHJ1blJlcG9zaXRvcnlDb21tYW5kLFxuKTogUmV0dXJuVHlwZTxSZXNvbHV0aW9uVGFza1J1bm5lcj4gPT4ge1xuICAvLyBUaGUgcmVwb3NpdG9yeSdzIG93biBjb2RlIHJ1bnMgd2l0aCBhIHN0YXRlZCBlbnZpcm9ubWVudCBhbmQgbm8gcGFyZW50XG4gIC8vIGNyZWRlbnRpYWwgKElzc3VlICM0NjU5KS4gQnVpbGQtY2FjaGUgcGxhY2VtZW50IGZvciB0aGUgY2hlY2tvdXQgKElzc3VlXG4gIC8vICMyMjQ3KSBpcyBkZWNpZGVkIGluc2lkZSBydW5SZXBvc2l0b3J5Q29tbWFuZCwgbm90IGhlcmUuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bihcbiAgICB0YXNrLmtpbmQgPT09IFwic2NyaXB0XCJcbiAgICAgID8gXCJiYXNoXCJcbiAgICAgIDogdGFzay5raW5kID09PSBcImNhcmdvXCJcbiAgICAgID8gXCJjYXJnb1wiXG4gICAgICA6IERlbm8uZXhlY1BhdGgoKSxcbiAgICB0YXNrLmFyZ3MsXG4gICAge1xuICAgICAgY3dkOiB0YXNrLmRpcixcbiAgICAgIHRpbWVvdXRNczogdGFzay50aW1lb3V0TXMsXG4gICAgICBtYW5pZmVzdHM6IGF3YWl0IG1hbmlmZXN0c0Zvcih0YXNrLmtpbmQsIHRhc2suZGlyKSxcbiAgICB9LFxuICApO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIHJldHVybiB7XG4gICAgICBjb2RlOiAxLFxuICAgICAgb3V0cHV0OiByZXN1bHQuZXJyb3IubWVzc2FnZSxcbiAgICAgIC4uLihyZXN1bHQuZXJyb3IgaW5zdGFuY2VvZiBHYXRlQWNjb3VudFVuYXZhaWxhYmxlXG4gICAgICAgID8geyBhY2NvdW50VW5hdmFpbGFibGU6IHJlc3VsdC5lcnJvci5tZXNzYWdlIH1cbiAgICAgICAgOiB7fSksXG4gICAgfTtcbiAgfVxuICBjb25zdCB7IGNvZGUsIHN0ZG91dCwgc3RkZXJyLCB0aW1lZE91dCB9ID0gcmVzdWx0LnZhbHVlO1xuICBjb25zdCBvdXRwdXQgPSBbc3Rkb3V0LCBzdGRlcnJdLm1hcCgocykgPT4gcy50cmltKCkpLmZpbHRlcihCb29sZWFuKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICBpZiAodGltZWRPdXQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29kZTogMTI0LFxuICAgICAgb3V0cHV0OiBgJHtvdXRwdXR9XFxuJyR7XG4gICAgICAgIGRlc2NyaWJlVGFzayh0YXNrKVxuICAgICAgfScgdGltZWQgb3V0IGFmdGVyICR7dGFzay50aW1lb3V0TXN9bXNgXG4gICAgICAgIC50cmltKCksXG4gICAgICB0aW1lZE91dDogdHJ1ZSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IGNvZGUsIG91dHB1dCB9O1xufTtcblxuLyoqXG4gKiBWZXJpZnkgYSB0cmVlIHdob3NlIGNvbmZsaWN0cyB0aGUgd29ya2VyIHJlc29sdmVkIGl0c2VsZi5cbiAqXG4gKiBAcGFyYW0gcmVwb0RpciAtIFJvb3Qgb2YgdGhlIG1lcmdlZCB3b3JraW5nIHRyZWUgKHRoZSBjbG9uZSdzIGN3ZClcbiAqIEBwYXJhbSBydW5uZXIgLSBPdmVycmlkZSB0aGUgc3Bhd25lZCB0YXNrICh0ZXN0cylcbiAqIEByZXR1cm5zIGBwYXNzZWRgIHdoZW4gZXZlcnkgdGFzayB0aGF0IHJhbiBwYXNzZWQuIEEgdGFzayBsZWZ0IHRvIENJIGJlY2F1c2VcbiAqICAgdGhlIGhvc3QgY291bGQgbm90IGZldGNoIGl0cyByZW1vdGUgbW9kdWxlcyAoSXNzdWUgIzQ0MjIpIGlzIG5vdCBydW4sIHNvXG4gKiAgIHRoZSBwYXNzZWQgb3V0Y29tZSBuYW1lcyBpdCBpbiBgc3VpdGVMZWZ0VG9DaWAgYW5kIGluIGl0cyBkZXRhaWwuIEEgdHlwZVxuICogICBjaGVjayBsZWZ0IHRvIENJIHRoZSBzYW1lIHdheSBpcyBjYXJyaWVkIHRocm91Z2ggYXMgYGNoZWNrTGVmdFRvQ2lgXG4gKiAgIChJc3N1ZSAjNDQ0MSksIHNvIHRoZSByZXBvcnQgZG9lcyBub3QgY2xhaW0gaXQgcGFzc2VkLiBBIENhcmdvIHN0ZXAgKGNoZWNrXG4gKiAgIGNhcnJpZWQgdGhyb3VnaCwgb3IgYGNhcmdvIHRlc3RgKSB0aGF0IGhpdCBpdHMgdGltZSBsaW1pdCAoSXNzdWUgIzQ3ODYpIGlzXG4gKiAgIGxlZnQgdG8gQ0kgdGhlIHNhbWUgd2F5IGFuZCBuYW1lZCBhcyB0aW1lZCBvdXQgaW4gdGhlIHBhc3NlZCBkZXRhaWw7IGEgQ2FyZ29cbiAqICAgc3RlcCB0aGF0IGNvdWxkIG5vdCByZWFjaCBpdHMgY3JhdGUgcmVnaXN0cnkgZXZlbiBvbiBhbiBvZmZsaW5lIHJldHJ5XG4gKiAgIChJc3N1ZSAjNDc4NikgaXMgbGVmdCB0byBDSSBsaWtld2lzZSBhbmQgbmFtZWQgaW4gdGhlIHBhc3NlZCBkZXRhaWw7IGEgRGVub1xuICogICB0YXNrIHRoYXQgdGltZXMgb3V0IGlzIHN0aWxsIGEgZmFpbHVyZS4gYHNraXBwZWRgIHdoZW4gdGhlXG4gKiAgIHRyZWUgZGVmaW5lcyBub3RoaW5nIHRvIHJ1biwgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHRyZWF0IGFzIGEgcmVmdXNhbC4gVGhhdFxuICogICByZWZ1c2FsIGlzIGZhaWwgY2xvc2VkOiBhbiBhbGwtbGVmdC10by1DSSB0cmVlIHdoZXJlIG5vIHVuaXQgc3VpdGUgb3JcbiAqICAgcXVhbGl0eSBzY3JpcHQgcmFuIGlzIHN0aWxsIGBza2lwcGVkYCwgYW5kIHRoZSBlYXJseSBgc2tpcHBlZGAgcmV0dXJuICh0aGVcbiAqICAgdHlwZSBjaGVjayBkaWQgbm90IHBhc3MpIG5ldmVyIGNhcnJpZXMgYGNoZWNrTGVmdFRvQ2lgXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB2ZXJpZnlSZXNvbHZlZFRyZWUoXG4gIHJlcG9EaXI6IHN0cmluZyxcbiAgcnVubmVyOiBSZXNvbHV0aW9uVGFza1J1bm5lciA9IHNwYXduVGFzayxcbiAgLyoqIFRoZSBJc3N1ZSAjOTc0IHR5cGUgY2hlY2suIEluamVjdGVkIGluIHRlc3RzOyB0aGUgcmVhbCBnYXRlIG90aGVyd2lzZS4gKi9cbiAgdHlwZUNoZWNrOiBNZXJnZUdhdGVGbiA9IGNoZWNrTWVyZ2VkVHJlZSxcbiAgLyoqIFJlYWRzIHRoZSBjbG9jay4gSW5qZWN0ZWQgaW4gdGVzdHMgc28gdGhlIGJ1ZGdldCBpcyBkZXRlcm1pbmlzdGljLiAqL1xuICBub3c6ICgpID0+IG51bWJlciA9ICgpID0+IERhdGUubm93KCksXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBlcGhlbWVyYWwgY2FyZ28gYnVpbGQgbXVzdCBub3QgcnVuIChJc3N1ZSAjNDMyNikuXG4gICAqIERlZmF1bHRzIHRvIGEgZnJlc2ggcmVhZCBvZiB0aGUgaG9zdC1kaXNrIGJ1ZGdldC4gQSBtaXhlZCB0cmVlJ3MgdHlwZVxuICAgKiBjaGVjayBzdGlsbCBwYXNzZXMsIHNvIHRoZSBkZXRhaWwgc3RyaW5nIGlzIG5vdCB3aGVyZSB0aGlzIGlzIGRlY2lkZWQuXG4gICAqL1xuICBza2lwQ2FyZ29CdWlsZDogKCkgPT4gUHJvbWlzZTxib29sZWFuPiA9ICgpID0+XG4gICAgc2hvdWxkU2tpcEVwaGVtZXJhbENhcmdvQnVpbGQocmVwb0RpciksXG4pOiBQcm9taXNlPE1lcmdlR2F0ZU91dGNvbWU+IHtcbiAgLy8gQSB0cmVlIHRoYXQgY2Fubm90IGJlIHJlYWQgaXMgYSB2ZXJpZmljYXRpb24gdGhhdCBjb3VsZCBub3QgYmUgcnVuLlxuICB0cnkge1xuICAgIGlmICghKGF3YWl0IERlbm8uc3RhdChyZXBvRGlyKSkuaXNEaXJlY3RvcnkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1czogXCJmYWlsZWRcIixcbiAgICAgICAgZGV0YWlsOiBgbWVyZ2VkIHRyZWUgJyR7cmVwb0Rpcn0nIGlzIG5vdCBhIGRpcmVjdG9yeSDigJQgbm90aGluZyBgICtcbiAgICAgICAgICBgdmVyaWZpZWQgdGhlIHJlc29sdXRpb25gLFxuICAgICAgICBvdXRwdXQ6IFwiXCIsXG4gICAgICB9O1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1czogXCJmYWlsZWRcIixcbiAgICAgIGRldGFpbDogYG1lcmdlZCB0cmVlICcke3JlcG9EaXJ9JyBjb3VsZCBub3QgYmUgcmVhZCDigJQgbm90aGluZyB2ZXJpZmllZCBgICtcbiAgICAgICAgYHRoZSByZXNvbHV0aW9uYCxcbiAgICAgIG91dHB1dDogdGFpbChlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikpLFxuICAgIH07XG4gIH1cblxuICAvLyBUaGUgSXNzdWUgIzk3NCBnYXRlIGZpcnN0LCBleGFjdGx5IGFzIGl0IHN0YW5kcyDigJQgaW5jbHVkaW5nIGl0cyBmYWxsYmFja1xuICAvLyB0byBhIHdob2xlLXRyZWUgYGRlbm8gY2hlY2tgIHdoZXJlIHRoZSBtYW5pZmVzdCBuYW1lcyBubyBgY2hlY2tgIHRhc2suXG4gIC8vIFJlLWltcGxlbWVudGluZyBpdCBoZXJlIHdvdWxkIHF1aWV0bHkgZHJvcCB0aGF0IGZhbGxiYWNrLCBhbmQgYVxuICAvLyByZXNvbHV0aW9uIHB1c2hlZCB3aXRob3V0IGFueSB0eXBlIGNoZWNrIGlzIHRoZSBzdGF0ZSAjOTc0IGV4aXN0cyB0byBlbmQuXG4gIGNvbnN0IHR5cGVkID0gYXdhaXQgdHlwZUNoZWNrKHJlcG9EaXIpO1xuICBpZiAodHlwZWQuc3RhdHVzICE9PSBcInBhc3NlZFwiKSB7XG4gICAgcmV0dXJuIHR5cGVkLnN0YXR1cyA9PT0gXCJmYWlsZWRcIiA/IHR5cGVkIDoge1xuICAgICAgc3RhdHVzOiBcInNraXBwZWRcIixcbiAgICAgIGRldGFpbDogYCR7dHlwZWQuZGV0YWlsfSDigJQgdGhlIElzc3VlICM5NzQgdHlwZSBjaGVjayBkaWQgbm90IHJ1bmAsXG4gICAgICBvdXRwdXQ6IHR5cGVkLm91dHB1dCxcbiAgICAgIC4uLih0eXBlZC5jYXJnb1NraXBwZWQgPyB7IGNhcmdvU2tpcHBlZDogdHJ1ZSB9IDoge30pLFxuICAgIH07XG4gIH1cblxuICAvLyBUaGUgYnVkZ2V0IHN0YXJ0cyBhZnRlciB0aGUgdHlwZSBjaGVjaywgd2hpY2ggaGFzIGl0cyBvd24gbGltaXQsIHNvIGEgbG9uZ1xuICAvLyBjb2xkIGNhcmdvIGNoZWNrIGRvZXMgbm90IHNwZW5kIHRoZSBidWRnZXQgb2YgdGhlIHRhc2tzIGFmdGVyIGl0IChJc3N1ZVxuICAvLyAjNDc4NykuXG4gIGNvbnN0IGRlYWRsaW5lID0gbm93KCkgKyBSRVNPTFVUSU9OX0dBVEVfQlVER0VUX01TO1xuXG4gIGNvbnN0IHJhbjogc3RyaW5nW10gPSBbdHlwZWQuZGV0YWlsXTtcbiAgLy8gVGFza3MgdGhlIGhvc3QgY291bGQgbm90IHJ1biBmb3Igd2FudCBvZiByZW1vdGUgbW9kdWxlcyAoSXNzdWUgIzQ0MjIpLlxuICBjb25zdCBsZWZ0VG9DaTogc3RyaW5nW10gPSBbXTtcbiAgbGV0IHVuaXRTdWl0ZVJhbiA9IGZhbHNlO1xuICBsZXQgdW5pdFN1aXRlTGVmdFRvQ2kgPSBmYWxzZTtcbiAgLy8gUmUtcmVhZCB0aGUgYnVkZ2V0LiBBIG1peGVkIHRyZWUncyB0eXBlIGNoZWNrIHJldHVybnMgYHBhc3NlZGAgYWZ0ZXIgaXRcbiAgLy8gc2tpcHMgY2FyZ28sIGFuZCBwYXJzaW5nIHRoYXQgZGV0YWlsIHdvdWxkIG1pc3MgYSBidWRnZXQgdGhhdCBmbGlwcGVkXG4gIC8vIGJldHdlZW4gdGhlIHR3byBnYXRlcyAoSXNzdWUgIzQzMjYpLiBUaGUgdHlwZSBjaGVjaydzIG93biBgY2FyZ29Ta2lwcGVkYFxuICAvLyBpcyBob25vdXJlZCBhcyB3ZWxsOiBhIGBjYXJnbyBjaGVja2AgdGhhdCB0aW1lZCBvdXQgKElzc3VlICM0Nzg2KSBmaWxsc1xuICAvLyB0aGUgc2FtZSBjb2xkIHRhcmdldCBhcyBgY2FyZ28gdGVzdGAsIHNvIHRoZSBzdWl0ZSB3YWl0cyBmb3IgQ0kgdG9vLlxuICBjb25zdCBwcm9qZWN0cyA9IGF3YWl0IGZpbmRQcm9qZWN0TWFuaWZlc3RzKHJlcG9EaXIpO1xuICBjb25zdCBza2lwQ2FyZ28gPSBwcm9qZWN0cy5zb21lKChwcm9qZWN0KSA9PiBwcm9qZWN0LmtpbmQgPT09IFwiY2FyZ29cIikgJiZcbiAgICAodHlwZWQuY2FyZ29Ta2lwcGVkID09PSB0cnVlIHx8IGF3YWl0IHNraXBDYXJnb0J1aWxkKCkpO1xuICBsZXQgc2tpcHBlZENhcmdvU3VpdGUgPSBmYWxzZTtcbiAgLy8gQ2FyZ28gc3RlcHMgbGVmdCB0byBDSTogdGhvc2UgdGhhdCBoaXQgdGhlaXIgdGltZSBsaW1pdCwgYW5kIHRob3NlIHRoYXRcbiAgLy8gY291bGQgbm90IHJlYWNoIHRoZWlyIGNyYXRlIHJlZ2lzdHJ5IGV2ZW4gb2ZmbGluZSAoSXNzdWUgIzQ3ODYpLiBFYWNoIGVudHJ5XG4gIC8vIG5hbWVzIHRoZSBzdGVwIGFuZCBpdHMgY2F1c2U7IHRoZSBwYXNzZWQgZGV0YWlsIGFkZHMgdGhlIENJIHN1ZmZpeC5cbiAgY29uc3QgY2FyZ29MZWZ0Tm90ZXM6IHN0cmluZ1tdID0gW107XG4gIC8vIFJ1biBEZW5vIGZpcnN0OiBhIGNhcmdvIHRpbWVvdXQgbWF5IGNvbnN1bWUgdGhlIHdob2xlIHJlbWFpbmluZyBidWRnZXQuXG4gIGNvbnN0IG9yZGVyZWRQcm9qZWN0cyA9IFtcbiAgICAuLi5wcm9qZWN0cy5maWx0ZXIoKHByb2plY3QpID0+IHByb2plY3Qua2luZCAhPT0gXCJjYXJnb1wiKSxcbiAgICAuLi5wcm9qZWN0cy5maWx0ZXIoKHByb2plY3QpID0+IHByb2plY3Qua2luZCA9PT0gXCJjYXJnb1wiKSxcbiAgXTtcbiAgZm9yIChjb25zdCBwcm9qZWN0IG9mIG9yZGVyZWRQcm9qZWN0cykge1xuICAgIGlmIChwcm9qZWN0LmtpbmQgPT09IFwiY2FyZ29cIiAmJiBza2lwQ2FyZ28pIHtcbiAgICAgIC8vIGBjYXJnbyB0ZXN0YCBmaWxscyB0aGUgc2FtZSBlcGhlbWVyYWwgdGFyZ2V0IHRoZSB0eXBlIGNoZWNrIGRlY2xpbmVkXG4gICAgICAvLyB0byBmaWxsLiBUaGUgc3VpdGUgd2FpdHMgZm9yIENJLlxuICAgICAgc2tpcHBlZENhcmdvU3VpdGUgPSB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIElzc3VlICMyMTM4OiBhIENhcmdvIHdvcmtzcGFjZSdzIHVuaXQgc3VpdGUgaXMgYGNhcmdvIHRlc3RgOyBhIERlbm9cbiAgICAvLyBwcm9qZWN0J3MgaXMgd2hpY2hldmVyIG9mIGl0cyB0YXNrcyByZXNvbHV0aW9uVGFza3NGb3IgbmFtZXMuXG4gICAgY29uc3QgcGxhbm5lZDogUmVzb2x1dGlvblRhc2tbXSA9IHByb2plY3Qua2luZCA9PT0gXCJjYXJnb1wiXG4gICAgICA/IFt7XG4gICAgICAgIGRpcjogcHJvamVjdC5kaXIsXG4gICAgICAgIGtpbmQ6IFwiY2FyZ29cIixcbiAgICAgICAgdGFzazogXCJ0ZXN0XCIsXG4gICAgICAgIGFyZ3M6IGF3YWl0IGNhcmdvVGVzdEFyZ3MocHJvamVjdC5kaXIpLFxuICAgICAgICB0aW1lb3V0TXM6IDAsXG4gICAgICB9XVxuICAgICAgOiByZXNvbHV0aW9uVGFza3NGb3IoYXdhaXQgcmVhZE1hbmlmZXN0VGFza3MocHJvamVjdC5tYW5pZmVzdCkpLm1hcChcbiAgICAgICAgKHRhc2spID0+ICh7XG4gICAgICAgICAgZGlyOiBwcm9qZWN0LmRpcixcbiAgICAgICAgICBraW5kOiBcImRlbm9cIiBhcyBjb25zdCxcbiAgICAgICAgICB0YXNrLFxuICAgICAgICAgIGFyZ3M6IFtcInRhc2tcIiwgdGFza10sXG4gICAgICAgICAgdGltZW91dE1zOiAwLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgZm9yIChjb25zdCBzdGVwIG9mIHBsYW5uZWQpIHtcbiAgICAgIGNvbnN0IHRhc2sgPSBzdGVwLnRhc2s7XG4gICAgICBjb25zdCB3aGVyZSA9IGAke2Rlc2NyaWJlVGFzayhzdGVwKX0gaW4gJHtwcm9qZWN0LmRpcn1gO1xuICAgICAgbGV0IHRpbWVvdXRNcyA9IGRlYWRsaW5lIC0gbm93KCk7XG4gICAgICBpZiAodGltZW91dE1zIDw9IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICAgICAgZGV0YWlsOiBgJHt3aGVyZX0gd2FzIG5vdCByZWFjaGVkIHdpdGhpbiB0aGUgYCArXG4gICAgICAgICAgICBgJHtSRVNPTFVUSU9OX0dBVEVfQlVER0VUX01TfW1zIHZlcmlmaWNhdGlvbiBidWRnZXQg4oCUIHRoZSBgICtcbiAgICAgICAgICAgIGByZXNvbHV0aW9uIGlzIHVudmVyaWZpZWQsIHNvIGl0IGlzIG5vdCBwdXNoZWRgLFxuICAgICAgICAgIG91dHB1dDogXCJcIixcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGxldCByZXN1bHQ6IHtcbiAgICAgICAgY29kZTogbnVtYmVyO1xuICAgICAgICBvdXRwdXQ6IHN0cmluZztcbiAgICAgICAgYWNjb3VudFVuYXZhaWxhYmxlPzogc3RyaW5nO1xuICAgICAgICB0aW1lZE91dD86IGJvb2xlYW47XG4gICAgICB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgcnVubmVyKHsgLi4uc3RlcCwgdGltZW91dE1zIH0pO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIC8vIFVucnVubmFibGUgaXMgbm90IGNsZWFuIOKAlCB0aGUgcmVzb2x1dGlvbiBzdGF5cyB1bnZlcmlmaWVkLlxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1czogXCJmYWlsZWRcIixcbiAgICAgICAgICBkZXRhaWw6IGAke3doZXJlfSBjb3VsZCBub3QgYmUgcnVuYCxcbiAgICAgICAgICBvdXRwdXQ6IHRhaWwoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIC8vIFRoZSBjYXVzZSB0aGUgZmlyc3QgYXR0ZW1wdCBuYW1lZCB3aGVuIGl0IGNvdWxkIG5vdCByZWFjaCB0aGUgY3JhdGVcbiAgICAgIC8vIHJlZ2lzdHJ5IChJc3N1ZSAjNDc4Nik7IHNldCBvbmx5IHdoZW4gdGhlIHN0ZXAgd2FzIHJldHJpZWQgb2ZmbGluZS5cbiAgICAgIGxldCByZWdpc3RyeUNhdXNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBmaXJzdEdhcCA9IHN0ZXAua2luZCA9PT0gXCJjYXJnb1wiICYmIHJlc3VsdC5jb2RlICE9PSAwICYmXG4gICAgICAgICAgIXJlc3VsdC50aW1lZE91dCAmJiAhcmVzdWx0LmFjY291bnRVbmF2YWlsYWJsZVxuICAgICAgICA/IGRldGVjdENhcmdvUmVnaXN0cnlHYXAocmVzdWx0Lm91dHB1dClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBpZiAoZmlyc3RHYXApIHtcbiAgICAgICAgLy8gQSBjYXJnbyBzdGVwIHRoYXQgY2Fubm90IHJlYWNoIGl0cyByZWdpc3RyeSBpcyByZXRyaWVkIG9uY2Ugb2ZmbGluZSxcbiAgICAgICAgLy8gZnJvbSB0aGUgbG9jYWwgY2FyZ28gY2FjaGUsIGluc2lkZSB3aGF0ZXZlciBidWRnZXQgaXMgbGVmdCAoSXNzdWVcbiAgICAgICAgLy8gIzQ3ODYpLiBUaGUgcmV0cnkgZ2V0cyBhIGZyZXNoIHJlYWRpbmcgb2YgdGhlIGNsb2NrLlxuICAgICAgICByZWdpc3RyeUNhdXNlID0gZmlyc3RHYXAuY2F1c2U7XG4gICAgICAgIHRpbWVvdXRNcyA9IGRlYWRsaW5lIC0gbm93KCk7XG4gICAgICAgIGlmICh0aW1lb3V0TXMgPD0gMCkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICAgICAgICBkZXRhaWw6IGAke3doZXJlfSB3YXMgbm90IHJlYWNoZWQgd2l0aGluIHRoZSBgICtcbiAgICAgICAgICAgICAgYCR7UkVTT0xVVElPTl9HQVRFX0JVREdFVF9NU31tcyB2ZXJpZmljYXRpb24gYnVkZ2V0IOKAlCB0aGUgYCArXG4gICAgICAgICAgICAgIGByZXNvbHV0aW9uIGlzIHVudmVyaWZpZWQsIHNvIGl0IGlzIG5vdCBwdXNoZWRgLFxuICAgICAgICAgICAgb3V0cHV0OiBcIlwiLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXN1bHQgPSBhd2FpdCBydW5uZXIoe1xuICAgICAgICAgICAgLi4uc3RlcCxcbiAgICAgICAgICAgIGFyZ3M6IHdpdGhDYXJnb09mZmxpbmUoc3RlcC5hcmdzKSxcbiAgICAgICAgICAgIHRpbWVvdXRNcyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN0YXR1czogXCJmYWlsZWRcIixcbiAgICAgICAgICAgIGRldGFpbDogYCR7d2hlcmV9IGNvdWxkIG5vdCBiZSBydW5gLFxuICAgICAgICAgICAgb3V0cHV0OiB0YWlsKGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSksXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICAvLyBTdGlsbCBubyByZWdpc3RyeSBhZnRlciB0aGUgb2ZmbGluZSByZXRyeTogdGhlIHN0ZXAgaXMgbGVmdCB0byBDSSxcbiAgICAgICAgLy8gd2l0aCB0aGUgZmlyc3QgYXR0ZW1wdCdzIGNhdXNlIChJc3N1ZSAjNDc4NikuXG4gICAgICAgIGlmIChcbiAgICAgICAgICByZXN1bHQuY29kZSAhPT0gMCAmJiAhcmVzdWx0LmFjY291bnRVbmF2YWlsYWJsZSAmJlxuICAgICAgICAgIGlzQ2FyZ29PZmZsaW5lUmVnaXN0cnlHYXAocmVzdWx0Lm91dHB1dClcbiAgICAgICAgKSB7XG4gICAgICAgICAgc2tpcHBlZENhcmdvU3VpdGUgPSB0cnVlO1xuICAgICAgICAgIGNhcmdvTGVmdE5vdGVzLnB1c2goXG4gICAgICAgICAgICBgJHt3aGVyZX0gY291bGQgbm90IHJlYWNoIGl0cyBjcmF0ZSByZWdpc3RyeSAoJHtyZWdpc3RyeUNhdXNlfSlgLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChyZXN1bHQuYWNjb3VudFVuYXZhaWxhYmxlKSB7XG4gICAgICAgIGxlZnRUb0NpLnB1c2goYCR7d2hlcmV9OiAke3Jlc3VsdC5hY2NvdW50VW5hdmFpbGFibGV9YCk7XG4gICAgICAgIGlmIChzdGVwLmtpbmQgPT09IFwiY2FyZ29cIiB8fCBpc1VuaXRTdWl0ZSh0YXNrKSkge1xuICAgICAgICAgIHVuaXRTdWl0ZUxlZnRUb0NpID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXN1bHQuY29kZSAhPT0gMCkge1xuICAgICAgICAvLyBJc3N1ZSAjNDc4NjogYSBjYXJnbyBzdGVwIHRoYXQgaGl0IGl0cyB0aW1lIGxpbWl0IG9uIGEgY29sZCBlcGhlbWVyYWxcbiAgICAgICAgLy8gdGFyZ2V0IHNheXMgbm90aGluZyBhYm91dCB0aGUgcmVzb2x1dGlvbiwgc28gaXQgaXMgbGVmdCB0byBDSS4gQVxuICAgICAgICAvLyBEZW5vIHRhc2sgdGhhdCB0aW1lcyBvdXQgaXMgc3RpbGwgYSBmYWlsdXJlLCBiZWxvdy5cbiAgICAgICAgaWYgKHN0ZXAua2luZCA9PT0gXCJjYXJnb1wiICYmIHJlc3VsdC50aW1lZE91dCkge1xuICAgICAgICAgIHNraXBwZWRDYXJnb1N1aXRlID0gdHJ1ZTtcbiAgICAgICAgICBjYXJnb0xlZnROb3Rlcy5wdXNoKGAke3doZXJlfSB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0TXN9bXNgKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICAvLyBJc3N1ZSAjNDQyMjogYSBEZW5vIHRhc2sgdGhhdCBjb3VsZCBub3QgZmV0Y2ggYSByZW1vdGUgbW9kdWxlIHJhbiBvblxuICAgICAgICAvLyBhIGhvc3Qgd2l0aCBubyByb3V0ZSB0byB0aGUgbW9kdWxlIGhvc3QuIFRoYXQgaXMgYW4gZW52aXJvbm1lbnRcbiAgICAgICAgLy8gZmF1bHQsIHNvIHRoZSB0YXNrIGlzIGxlZnQgdG8gQ0kgcmF0aGVyIHRoYW4gZmFpbGVkIG9yIHBhc3NlZC5cbiAgICAgICAgY29uc3QgcmVtb3RlID0gc3RlcC5raW5kID09PSBcImRlbm9cIlxuICAgICAgICAgID8gZGV0ZWN0UmVtb3RlTW9kdWxlR2FwKHJlc3VsdC5vdXRwdXQpXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChyZW1vdGUpIHtcbiAgICAgICAgICBsZWZ0VG9DaS5wdXNoKFxuICAgICAgICAgICAgYCR7d2hlcmV9IGNvdWxkIG5vdCBmZXRjaCBpdHMgcmVtb3RlIG1vZHVsZXMgKCR7cmVtb3RlLmNhdXNlfSlgLFxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKGlzVW5pdFN1aXRlKHRhc2spKSB1bml0U3VpdGVMZWZ0VG9DaSA9IHRydWU7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgLy8gSXNzdWUgIzMyNTU6IGBjYXJnbyB0ZXN0YCBmYWlscyB0aGUgc2FtZSB3YXkgYGNhcmdvIGNoZWNrYCBkb2VzXG4gICAgICAgIC8vIHdoZW4gdGhlIGhvc3QncyBydXN0YyBpcyBvbGRlciB0aGFuIHRoZSB0cmVlJ3MgcnVzdC12ZXJzaW9uIOKAlCBhblxuICAgICAgICAvLyBlbnZpcm9ubWVudCBmYXVsdCwgbm90IGEgYmFkIHJlc29sdXRpb24sIHNvIGl0IGlzIG5hbWVkIGFzIHN1Y2guXG4gICAgICAgIGNvbnN0IGdhcCA9IHN0ZXAua2luZCA9PT0gXCJjYXJnb1wiXG4gICAgICAgICAgPyBkZXRlY3RSdXN0VG9vbGNoYWluR2FwKHJlc3VsdC5vdXRwdXQpXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChnYXApIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3RhdHVzOiBcImZhaWxlZFwiLFxuICAgICAgICAgICAgZGV0YWlsOiBkZXNjcmliZVJ1c3RUb29sY2hhaW5HYXAod2hlcmUsIHJlc3VsdC5jb2RlLCBnYXApLFxuICAgICAgICAgICAgb3V0cHV0OiB0YWlsKHJlc3VsdC5vdXRwdXQpLFxuICAgICAgICAgICAgdG9vbGNoYWluR2FwOiBnYXAsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1czogXCJmYWlsZWRcIixcbiAgICAgICAgICBkZXRhaWw6IGAke3doZXJlfSBmYWlsZWQgKGV4aXQgJHtyZXN1bHQuY29kZX0pYCxcbiAgICAgICAgICBvdXRwdXQ6IHRhaWwocmVzdWx0Lm91dHB1dCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICAvLyBBIHN0ZXAgdGhhdCBwYXNzZWQgb25seSBvbiB0aGUgb2ZmbGluZSByZXRyeSBzYXlzIHNvIChJc3N1ZSAjNDc4NikuXG4gICAgICByYW4ucHVzaChcbiAgICAgICAgcmVnaXN0cnlDYXVzZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgPyBgJHt3aGVyZX0gKHZlcmlmaWVkIG9mZmxpbmUgZnJvbSB0aGUgbG9jYWwgY2FyZ28gY2FjaGUsIElzc3VlICM0Nzg2KWBcbiAgICAgICAgICA6IHdoZXJlLFxuICAgICAgKTtcbiAgICAgIGlmIChzdGVwLmtpbmQgPT09IFwiY2FyZ29cIiB8fCBpc1VuaXRTdWl0ZSh0YXNrKSkgdW5pdFN1aXRlUmFuID0gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICAvLyBgcXVhbGl0eS5zaGAgcnVucyBjYXJnby4gSXQgaXMgbm90IGEgc3Vic3RpdHV0ZSBmb3IgYSBzdWl0ZSB0aGUgYnVkZ2V0XG4gIC8vIGp1c3Qgc2tpcHBlZCwgYW5kIGEgYHNraXBwZWRgIHZlcmRpY3Qgd291bGQgcmVmdXNlIHRoZSByZXNvbHV0aW9uIHRoYXRcbiAgLy8gYnVkZ2V0IGV4aXN0cyB0byBsZXQgbGFuZCAoSXNzdWUgIzQzMjYpLlxuICBjb25zdCBjYXJnb1NraXBwZWRBc09ubHlTdWl0ZSA9ICF1bml0U3VpdGVSYW4gJiYgc2tpcHBlZENhcmdvU3VpdGU7XG4gIC8vIEEgdW5pdCBzdWl0ZSB0aGUgaG9zdCBjb3VsZCBub3QgZmV0Y2ggKElzc3VlICM0NDIyKSBpcyBub3QgcmVwbGFjZWQgYnlcbiAgLy8gcXVhbGl0eS5zaCBlaXRoZXI6IHRoZSBzY3JpcHQgcnVucyB0aGUgc2FtZSBzdWl0ZSBhbmQgaGl0cyB0aGUgc2FtZSBob3N0XG4gIC8vIGxpbWl0LCBzbyB0aGUgc3VpdGUgc3RheXMgbGVmdCB0byBDSS5cbiAgaWYgKFxuICAgICF1bml0U3VpdGVSYW4gJiYgIXNraXBwZWRDYXJnb1N1aXRlICYmICF1bml0U3VpdGVMZWZ0VG9DaSAmJlxuICAgIGF3YWl0IGhhc1F1YWxpdHlTY3JpcHQocmVwb0RpcilcbiAgKSB7XG4gICAgLy8gSXNzdWUgIzIzODg6IG5vIG1hbmlmZXN0IG5hbWVzIGEgdW5pdCBzdWl0ZSwgYnV0IHRoZSByZXBvc2l0b3J5IGhhcyBpdHNcbiAgICAvLyBvd24gcXVhbGl0eSBnYXRlIOKAlCBydW4gdGhhdCwgaW5zaWRlIHdoYXRldmVyIGJ1ZGdldCBpcyBsZWZ0LlxuICAgIGNvbnN0IHN0ZXA6IFJlc29sdXRpb25UYXNrID0ge1xuICAgICAgZGlyOiByZXBvRGlyLFxuICAgICAga2luZDogXCJzY3JpcHRcIixcbiAgICAgIHRhc2s6IFFVQUxJVFlfU0NSSVBULFxuICAgICAgYXJnczogW1FVQUxJVFlfU0NSSVBUXSxcbiAgICAgIHRpbWVvdXRNczogMCxcbiAgICB9O1xuICAgIGNvbnN0IHdoZXJlID0gYCR7ZGVzY3JpYmVUYXNrKHN0ZXApfSBpbiAke3JlcG9EaXJ9YDtcbiAgICBjb25zdCB0aW1lb3V0TXMgPSBkZWFkbGluZSAtIG5vdygpO1xuICAgIGlmICh0aW1lb3V0TXMgPD0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzOiBcImZhaWxlZFwiLFxuICAgICAgICBkZXRhaWw6IGAke3doZXJlfSB3YXMgbm90IHJlYWNoZWQgd2l0aGluIHRoZSBgICtcbiAgICAgICAgICBgJHtSRVNPTFVUSU9OX0dBVEVfQlVER0VUX01TfW1zIHZlcmlmaWNhdGlvbiBidWRnZXQg4oCUIHRoZSBgICtcbiAgICAgICAgICBgcmVzb2x1dGlvbiBpcyB1bnZlcmlmaWVkLCBzbyBpdCBpcyBub3QgcHVzaGVkYCxcbiAgICAgICAgb3V0cHV0OiBcIlwiLFxuICAgICAgfTtcbiAgICB9XG4gICAgbGV0IHJlc3VsdDogeyBjb2RlOiBudW1iZXI7IG91dHB1dDogc3RyaW5nOyBhY2NvdW50VW5hdmFpbGFibGU/OiBzdHJpbmcgfTtcbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0gYXdhaXQgcnVubmVyKHsgLi4uc3RlcCwgdGltZW91dE1zIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzOiBcImZhaWxlZFwiLFxuICAgICAgICBkZXRhaWw6IGAke3doZXJlfSBjb3VsZCBub3QgYmUgcnVuYCxcbiAgICAgICAgb3V0cHV0OiB0YWlsKGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSksXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAocmVzdWx0LmFjY291bnRVbmF2YWlsYWJsZSkge1xuICAgICAgbGVmdFRvQ2kucHVzaChgJHt3aGVyZX06ICR7cmVzdWx0LmFjY291bnRVbmF2YWlsYWJsZX1gKTtcbiAgICAgIHVuaXRTdWl0ZUxlZnRUb0NpID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKHJlc3VsdC5jb2RlICE9PSAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICAgIGRldGFpbDogYCR7d2hlcmV9IGZhaWxlZCAoZXhpdCAke3Jlc3VsdC5jb2RlfSlgLFxuICAgICAgICBvdXRwdXQ6IHRhaWwocmVzdWx0Lm91dHB1dCksXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAoIXJlc3VsdC5hY2NvdW50VW5hdmFpbGFibGUpIHtcbiAgICAgIHJhbi5wdXNoKHdoZXJlKTtcbiAgICAgIHVuaXRTdWl0ZVJhbiA9IHRydWU7XG4gICAgfVxuICB9XG5cbiAgLy8gQSB1bml0IHN1aXRlIGxlZnQgdG8gQ0kgZm9yIHdhbnQgb2YgcmVtb3RlIG1vZHVsZXMgaXMgbm90IFwibm90aGluZyByYW4gdGhlXG4gIC8vIGNhc2VzXCIgZWl0aGVyOiBpdCB3YXMgbm90IHJ1biBiZWNhdXNlIHRoZSBob3N0IGNvdWxkIG5vdCwgYW5kIHRoZSByZXBvcnRcbiAgLy8gbmFtZXMgaXQgKElzc3VlICM0NDIyKS5cbiAgaWYgKCF1bml0U3VpdGVSYW4gJiYgIWNhcmdvU2tpcHBlZEFzT25seVN1aXRlICYmICF1bml0U3VpdGVMZWZ0VG9DaSkge1xuICAgIC8vIENob29zaW5nIGEgc2lkZSBjb21waWxlcyBwZXJmZWN0bHkgd2hpbGUgZHJvcHBpbmcgdGhlIG90aGVyIHNpZGUnc1xuICAgIC8vIGJlaGF2aW91ciwgc28gdGhlIHR5cGUgY2hlY2sgYWxvbmUgZG9lcyBub3QgdmVyaWZ5IGEgcmVzb2x1dGlvbi5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcInNraXBwZWRcIixcbiAgICAgIGRldGFpbDogYG5vICR7VU5JVF9TVUlURV9UQVNLUy5qb2luKFwiL1wiKX0gdGFzaywgQ2FyZ28udG9tbCBvciBgICtcbiAgICAgICAgYCR7UVVBTElUWV9TQ1JJUFR9IHVuZGVyICcke3JlcG9EaXJ9JyDigJQgbm90aGluZyByYW4gdGhlIGNhc2VzIHRoYXQgYCArXG4gICAgICAgIFwid291bGQgc2hvdyBhIGRyb3BwZWQgaW1wbGVtZW50YXRpb25cIixcbiAgICAgIG91dHB1dDogXCJcIixcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgY2FyZ29MZWZ0VG9DaSA9IHNraXBwZWRDYXJnb1N1aXRlIHx8IHR5cGVkLmNhcmdvU2tpcHBlZCA9PT0gdHJ1ZTtcbiAgY29uc3QgY2FyZ29Ob3RlID0gY2FyZ29MZWZ0VG9DaSAmJlxuICAgICAgIXR5cGVkLmRldGFpbC5pbmNsdWRlcyhDQVJHT19CVUlMRF9TS0lQUEVEX0ZPUl9NRVJHRSlcbiAgICA/IGA7ICR7Q0FSR09fQlVJTERfU0tJUFBFRF9GT1JfTUVSR0V9IChJc3N1ZSAjNDMyNilgXG4gICAgOiBcIlwiO1xuICBjb25zdCBzdWl0ZU5vdGUgPSBsZWZ0VG9DaS5sZW5ndGggPiAwXG4gICAgPyBgOyAke2xlZnRUb0NpLmpvaW4oXCI7IFwiKX0g4oCUIGxlZnQgdG8gdGhlIG1pbGVzdG9uZSBQUidzIENJIChJc3N1ZSAjNDQyMilgXG4gICAgOiBcIlwiO1xuICBjb25zdCBjYXJnb0xlZnROb3RlID0gY2FyZ29MZWZ0Tm90ZXMubWFwKChub3RlKSA9PlxuICAgIGA7ICR7bm90ZX0g4oCUIGxlZnQgdG8gQ0kgKElzc3VlICM0Nzg2KWBcbiAgKS5qb2luKFwiXCIpO1xuICByZXR1cm4ge1xuICAgIHN0YXR1czogXCJwYXNzZWRcIixcbiAgICBkZXRhaWw6IGAke3Jhbi5qb2luKFwiOyBcIil9IHBhc3NlZCR7Y2FyZ29Ob3RlfSR7Y2FyZ29MZWZ0Tm90ZX0ke3N1aXRlTm90ZX1gLFxuICAgIG91dHB1dDogXCJcIixcbiAgICAuLi4oY2FyZ29MZWZ0VG9DaSA/IHsgY2FyZ29Ta2lwcGVkOiB0cnVlIH0gOiB7fSksXG4gICAgLi4uKGxlZnRUb0NpLmxlbmd0aCA+IDAgPyB7IHN1aXRlTGVmdFRvQ2k6IGxlZnRUb0NpLmpvaW4oXCI7IFwiKSB9IDoge30pLFxuICAgIC4uLih0eXBlZC5jaGVja0xlZnRUb0NpID8geyBjaGVja0xlZnRUb0NpOiB0eXBlZC5jaGVja0xlZnRUb0NpIH0gOiB7fSksXG4gIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBNENDLEdBRUQsU0FDRSxlQUFlLEVBQ2YscUJBQXFCLEVBQ3JCLHdCQUF3QixFQUN4QixzQkFBc0IsRUFDdEIscUJBQXFCLEVBQ3JCLHNCQUFzQixFQUN0QixvQkFBb0IsRUFDcEIseUJBQXlCLEVBSXpCLGlCQUFpQixFQUNqQixnQkFBZ0IsUUFDWCw0QkFBNEI7QUFDbkMsU0FDRSxzQkFBc0IsRUFDdEIsWUFBWSxFQUNaLG9CQUFvQixRQUNmLDRCQUE0QjtBQUNuQyxTQUNFLDZCQUE2QixFQUM3Qiw2QkFBNkIsUUFDeEIsd0JBQXdCO0FBRS9COzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE9BQU8sTUFBTSw0QkFBNEIsUUFBUTtBQUVqRDs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxNQUFNLHdCQUF3QjtFQUNuQztFQUNBO0VBQ0E7Q0FDRCxDQUFVO0FBRVg7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBaUJDLEdBQ0QsT0FBTyxNQUFNLGlCQUFpQixhQUFhO0FBRTNDLG9EQUFvRCxHQUNwRCxNQUFNLG1CQUFtQjtFQUFDO0VBQWE7Q0FBTztBQW1COUMsMERBQTBELEdBQzFELE9BQU8sU0FBUyxhQUFhLElBQW9CO0VBQy9DLElBQUksS0FBSyxJQUFJLEtB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
// denoCacheMetadata=9160331298159672651,526403737182456977