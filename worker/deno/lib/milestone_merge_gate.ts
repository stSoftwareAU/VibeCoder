/**
 * Type-check gate for the `main` → `milestone/<name>` sync merge (Issue #974).
 *
 * The sync pushed whatever the merge produced. Git reported no conflict
 * because both sides were internally consistent — only their combination was
 * not — so a resolution that dropped live wiring reached the milestone branch
 * three times running, and `milestone/*` has no required checks to catch it
 * downstream (#928, #796).
 *
 * This module answers one question about the merged tree, before the push:
 * does it still compile? The repository's own check is used — its
 * `deno task check` where one is defined, otherwise `deno check '**\/*.ts'` —
 * so the gate is the repo's gate rather than a second opinion invented here.
 *
 * A check that cannot be run reports `failed`, not `passed`: absence of a
 * failure is not success, and a tree nobody verified is exactly the tree this
 * gate exists to keep off the branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";
import { stripJsonc } from "./jsonc.ts";

/** How long the merged-tree type check may run before it is killed. */
export const MERGE_GATE_TIMEOUT_MS = 300_000;

/** Directory levels searched below the repo root for a Deno project. */
export const MERGE_GATE_MAX_DEPTH = 2;

/** Error name carried by the refusal, so callers can escalate on it. */
export const MILESTONE_MERGE_GATE_ERROR = "MilestoneMergeGateFailure";

/** Never descended into when looking for the project. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
]);

/** Longest check output carried into a log line or an escalation comment. */
const MAX_OUTPUT_LINES = 40;
const MAX_OUTPUT_CHARS = 4000;

/** The type check a repository defines for itself. */
export interface TypeCheckProject {
  /** Directory the check runs in. */
  dir: string;
  /** Arguments passed to the `deno` executable. */
  args: string[];
}

/** What the gate concluded about the merged tree. */
export type MergeGateStatus =
  /** The tree compiles — the push may proceed. */
  | "passed"
  /** The tree does not compile, or could not be checked — do not push. */
  | "failed"
  /** The repository defines no type check, so none was run. */
  | "skipped";

/** Outcome of {@link checkMergedTree}. */
export interface MergeGateOutcome {
  status: MergeGateStatus;
  /** One-line summary for the log and the escalation comment. */
  detail: string;
  /** Trimmed tail of the check output; empty when nothing ran. */
  output: string;
}

/** Gate signature injected into the sync, so tests can drive both verdicts. */
export type MergeGateFn = (repoDir: string) => Promise<MergeGateOutcome>;

/** Runs the resolved check. Injected in tests; spawns `deno` in production. */
export type TypeCheckRunner = (
  project: TypeCheckProject,
) => Promise<{ code: number; output: string }>;

/** Whether a path exists and is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Which arguments run this project's type check.
 *
 * A `check` task in the manifest is the repository's own gate — flags,
 * lockfile pins and all — so it is preferred. `deno.jsonc` may carry comments,
 * so the manifest is stripped before parsing rather than quietly losing the
 * repo's own task to a `JSON.parse` failure. A manifest that still cannot be
 * read falls back to a whole-tree `deno check`, which type-checks the same
 * files with default flags.
 */
async function resolveCheckArgs(manifestPath: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(
      stripJsonc(await Deno.readTextFile(manifestPath)),
    );
    const task = parsed?.tasks?.check;
    if (typeof task === "string" && task.trim()) return ["task", "check"];
  } catch {
    // Unparseable manifest — the generic check still type-checks the tree.
  }
  return ["check", "**/*.ts"];
}

/** The manifest in a directory, or null when it holds none. */
async function manifestIn(dir: string): Promise<string | null> {
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    const path = `${dir}/${manifest}`;
    if (await isFile(path)) return path;
  }
  return null;
}

/**
 * Locate every Deno project in the tree, breadth-first from the repo root.
 *
 * **All** of them, not the first one found: this repository carries
 * `container/deno-seed/deno.json` alongside `worker/deno/deno.json`, and a
 * search that stopped at whichever `Deno.readDir` happened to return first
 * would type-check a single-file seed project and call a broken
 * `worker/deno` clean — a gate that passes everything, which is the state
 * this issue exists to end.
 *
 * A directory that holds a manifest is not descended into: its own project
 * covers what lies beneath it. Each level is sorted, so the same tree yields
 * the same order on every host.
 *
 * @param repoDir - Root of the merged working tree
 * @returns Every project to check; empty when the tree defines none
 */
export async function findTypeCheckProjects(
  repoDir: string,
): Promise<TypeCheckProject[]> {
  const found: TypeCheckProject[] = [];
  let level = [repoDir];
  for (let depth = 0; depth <= MERGE_GATE_MAX_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level.sort()) {
      const manifest = await manifestIn(dir);
      if (manifest) {
        found.push({ dir, args: await resolveCheckArgs(manifest) });
        continue;
      }
      if (depth === MERGE_GATE_MAX_DEPTH) continue;
      try {
        for await (const entry of Deno.readDir(dir)) {
          if (!entry.isDirectory) continue;
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          next.push(`${dir}/${entry.name}`);
        }
      } catch {
        // An unreadable subdirectory simply contributes no candidates; an
        // unreadable *root* is caught by checkMergedTree, which fails.
      }
    }
    level = next;
  }
  return found;
}

/** Keep the tail of the output — the errors sit at the end of a check run. */
function tail(output: string): string {
  const lines = output.trim().split("\n");
  const kept = lines.slice(-MAX_OUTPUT_LINES).join("\n");
  return kept.length > MAX_OUTPUT_CHARS ? kept.slice(-MAX_OUTPUT_CHARS) : kept;
}

/** Spawn the repository's own check with a bounded timeout. */
const spawnTypeCheck: TypeCheckRunner = async (project) => {
  const result = await runWithTimeout(Deno.execPath(), project.args, {
    cwd: project.dir,
    timeoutMs: MERGE_GATE_TIMEOUT_MS,
  });
  if (!result.ok) return { code: 1, output: result.error.message };
  const { code, stdout, stderr, timedOut } = result.value;
  const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean)
    .join("\n");
  if (timedOut) {
    return {
      code: 124,
      output: `${output}\nType check timed out after ${MERGE_GATE_TIMEOUT_MS}ms`
        .trim(),
    };
  }
  return { code, output };
};

/**
 * Run the repository's own type check against a merged working tree.
 *
 * @param repoDir - Root of the merged working tree (the clone's cwd)
 * @param runner - Override the spawned check (tests)
 * @returns The verdict, with the check output when one ran
 */
export async function checkMergedTree(
  repoDir: string,
  runner: TypeCheckRunner = spawnTypeCheck,
): Promise<MergeGateOutcome> {
  // A tree that cannot be read is a check that could not be run, not a
  // repository without one — refuse rather than wave it through as "skipped".
  try {
    if (!(await Deno.stat(repoDir)).isDirectory) {
      return {
        status: "failed",
        detail:
          `merged tree '${repoDir}' is not a directory — nothing checked it`,
        output: "",
      };
    }
  } catch (err) {
    return {
      status: "failed",
      detail: `merged tree '${repoDir}' could not be read — nothing checked it`,
      output: tail(err instanceof Error ? err.message : String(err)),
    };
  }

  const projects = await findTypeCheckProjects(repoDir);
  if (projects.length === 0) {
    return {
      status: "skipped",
      detail:
        `no deno.json(c) under '${repoDir}' — the merged tree was not type-checked`,
      output: "",
    };
  }

  const checked: string[] = [];
  for (const project of projects) {
    const where = `deno ${project.args.join(" ")} in ${project.dir}`;
    let result: { code: number; output: string };
    try {
      result = await runner(project);
    } catch (err) {
      // Unrunnable is not clean: refuse the push rather than assume it
      // compiles.
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        detail: `${where} could not be run`,
        output: tail(message),
      };
    }
    if (result.code !== 0) {
      return {
        status: "failed",
        detail: `${where} failed (exit ${result.code})`,
        output: tail(result.output),
      };
    }
    checked.push(where);
  }

  return {
    status: "passed",
    detail: `${checked.join("; ")} passed`,
    output: "",
  };
}

/**
 * The refusal raised when a merged tree does not compile (Issue #974).
 *
 * Typed with {@link MILESTONE_MERGE_GATE_ERROR} so the sync can tell it apart
 * from an ordinary merge failure and escalate on the first occurrence — a
 * tree that does not compile is not a transient condition that a retry fixes.
 */
export function mergeGateFailureError(
  milestoneBranch: string,
  defaultBranch: string,
  outcome: MergeGateOutcome,
): Error {
  const err = new Error(
    `Refused to push the merge of '${defaultBranch}' into ` +
      `'${milestoneBranch}': the merged tree does not pass the repository's ` +
      `own check (Issue #974) — ${outcome.detail}${
        outcome.output ? `\n${outcome.output}` : ""
      }`,
  );
  err.name = MILESTONE_MERGE_GATE_ERROR;
  return err;
}

/** Whether an error is the merge-gate refusal. */
export function isMergeGateFailure(err: unknown): boolean {
  return err instanceof Error && err.name === MILESTONE_MERGE_GATE_ERROR;
}

/** Everything the escalation comment names. */
export interface MergeGateEscalation {
  repo: string;
  milestoneBranch: string;
  defaultBranch: string;
  /** The refusal message, including the check output. */
  reason: string;
}

/**
 * Body of the needs-human comment posted on the milestone's tracking issue.
 *
 * The merge is named, the check output travels with it, and the comment says
 * plainly that nothing was pushed — so the reader knows the branch is intact
 * and what has to be resolved before it moves.
 */
export function buildMergeGateEscalationComment(
  e: MergeGateEscalation,
): string {
  return `## Milestone sync merge fails the repo's own check — needs a human\n\n` +
    `Merging \`${e.defaultBranch}\` into \`${e.milestoneBranch}\` in ` +
    `\`${e.repo}\` produced a tree that fails the repository's own check ` +
    `(a type error, or whatever else that check enforces — a stale lockfile ` +
    `under \`--frozen\`, say), so it was **not pushed** and the local merge ` +
    `was discarded (Issue #974).\n\n` +
    `Git reported no conflict: both sides were internally consistent and ` +
    `only their combination is not, which is how the same wiring was lost ` +
    `three times before this gate existed (#928, #796).\n\n` +
    `Check output:\n\n\`\`\`\n${e.reason}\n\`\`\`\n\n` +
    `Resolve the merge by hand on \`${e.milestoneBranch}\`. The sync will ` +
    `keep refusing to push until the merged tree compiles.`;
}
