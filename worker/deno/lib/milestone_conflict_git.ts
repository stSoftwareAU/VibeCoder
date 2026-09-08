/**
 * The git side of a triaged milestone sync conflict (Issue #1559).
 *
 * `milestone_conflict_triage.ts` decides what to do with a conflicted file and
 * touches no git; this module is the other half — it reads both sides out of
 * the conflicted index, gathers the evidence the triage needs, and stages the
 * side the triage chose.
 *
 * Everything here fails loud. A side that cannot be read is **not** reported
 * as "that side deleted the file": that mistake would turn a transient git
 * failure into a resolution nobody chose, which is the whole fault this issue
 * exists to remove. Evidence that could not be gathered is reported as
 * incomplete rather than as "there was none", for the same reason.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import {
  buildAddPathArgs,
  buildCheckoutStrategyArgs,
  buildRemovePathArgs,
} from "./git_conflict_args.ts";
import {
  hasAnyStage,
  parseUnmergedStages,
  resolveTowardsIncoming,
} from "./merge_conflict_stages.ts";
import {
  type ConflictedFile,
  type ConflictPlan,
  type ConflictSide,
  extractTestNames,
  isTestPath,
  parseFixReferences,
  parseStampedIssues,
  type TestEvidence,
} from "./milestone_conflict_triage.ts";

/** The merge base of the two sides; empty when git could not compute one. */
export async function readMergeBase(
  milestoneRef: string,
  defaultBranch: string,
  options: GitCommandOptions,
): Promise<string> {
  const result = await runGitCommand(
    ["merge-base", milestoneRef, defaultBranch],
    options,
  );
  return result.ok && result.value.code === 0 ? result.value.stdout.trim() : "";
}

/**
 * Read both sides of every conflicted path, plus what each side says it fixes.
 *
 * Read while the merge is still in progress: stages 2 and 3 are the two sides
 * as git staged them, and they are gone once the merge is aborted. A side with
 * no stage deleted the file, which is a decision in its own right — so the
 * stages are read first and the content is only fetched for a stage that
 * exists. A stage that exists but cannot be read fails the whole resolution:
 * "could not read it" must never be mistaken for "that side deleted it".
 *
 * The fix references come from the commits on each side that touched *this*
 * path since the merge base. Without a merge base (a shallow clone with too
 * little history) there are no references, so the duplicate-fix rule does not
 * fire — the safe direction, since a wrong shared reference would resolve a
 * conflict nobody meant to resolve.
 */
export async function readConflictedSides(
  conflictedFiles: string[],
  mergeBase: string,
  defaultBranch: string,
  defaultRef: string,
  milestoneRef: string,
  options: GitCommandOptions,
): Promise<Result<ConflictedFile[]>> {
  const sides: ConflictedFile[] = [];
  for (const path of conflictedFiles) {
    const staged = await runGitCommand(["ls-files", "-u", "--", path], options);
    const stages = staged.ok && staged.value.code === 0
      ? parseUnmergedStages(staged.value.stdout)
      : { base: false, ours: false, theirs: false };
    if (!hasAnyStage(stages)) {
      const detail = staged.ok
        ? staged.value.stderr.trim()
        : staged.error.message;
      return {
        ok: false,
        error: new Error(
          `Refusing to resolve the merge of '${defaultBranch}' into ` +
            `'${milestoneRef}': the merge stages of conflicted file '${path}' ` +
            `could not be read, so which side has a version of it is unknown ` +
            `(Issues #1048, #1559): ${detail || "git reported no stderr"}`,
        ),
      };
    }

    const ours = await readStage(2, path, stages.ours, options);
    if (!ours.ok) return ours;
    const theirs = await readStage(3, path, stages.theirs, options);
    if (!theirs.ok) return theirs;

    sides.push({
      path,
      ours: ours.value,
      theirs: theirs.value,
      oursFixes: await readFixReferences(
        mergeBase,
        milestoneRef,
        path,
        options,
      ),
      theirsFixes: await readFixReferences(
        mergeBase,
        defaultRef,
        path,
        options,
      ),
    });
  }
  return { ok: true, value: sides };
}

/**
 * One side of a conflicted path: its content, or null when that side has no
 * stage — that side deleted the file.
 *
 * A stage that exists but will not read is a failure, never a null.
 */
async function readStage(
  stage: 2 | 3,
  path: string,
  present: boolean,
  options: GitCommandOptions,
): Promise<Result<string | null>> {
  if (!present) return { ok: true, value: null };
  const result = await runGitCommand(["show", `:${stage}:${path}`], options);
  if (!result.ok || result.value.code !== 0) {
    const detail = result.ok
      ? result.value.stderr.trim()
      : result.error.message;
    return {
      ok: false,
      error: new Error(
        `Refusing to resolve a conflicted merge: stage ${stage} of ` +
          `'${path}' is present but could not be read, so one side of the ` +
          `conflict is unknown (Issue #1559): ${
            detail || "git reported no stderr"
          }`,
      ),
    };
  }
  return { ok: true, value: result.value.stdout };
}

/** Issues the commits touching `path` on one side say they close. */
async function readFixReferences(
  mergeBase: string,
  ref: string,
  path: string,
  options: GitCommandOptions,
): Promise<number[]> {
  if (!mergeBase || !ref) return [];
  const result = await runGitCommand(
    ["log", "--format=%B", `${mergeBase}..${ref}`, "--", path],
    options,
  );
  return result.ok && result.value.code === 0
    ? parseFixReferences(result.value.stdout)
    : [];
}

/**
 * The cases each side wrote for the issues its commits cite.
 *
 * Scoped to the commits that cite an issue, because that is the question the
 * duplicate-fix rule asks: of the two implementations of *this* fix, which
 * one's cases cover the other's? Pooling every case either branch added since
 * the merge base compares two populations dominated by unrelated churn.
 *
 * Evidence git refused to give up is reported `complete: false`, never as an
 * empty set — an unread suite must not read as "neither side wrote a case".
 */
export async function readTestEvidence(
  mergeBase: string,
  defaultRef: string,
  milestoneRef: string,
  options: GitCommandOptions,
): Promise<TestEvidence> {
  if (!mergeBase) return { oursAdded: {}, theirsAdded: {}, complete: false };

  let complete = true;
  const addedFor = async (
    ref: string,
  ): Promise<Record<number, string[]>> => {
    const added: Record<number, string[]> = {};
    if (!ref) {
      complete = false;
      return added;
    }
    // One line per commit: its hash, then the issues it claims to fix.
    const log = await runGitCommand(
      ["log", "--format=%H%x00%s%x00%b%x01", `${mergeBase}..${ref}`],
      options,
    );
    if (!log.ok || log.value.code !== 0) {
      complete = false;
      return added;
    }
    for (const entry of log.value.stdout.split("\u0001")) {
      const [sha, subject = "", body = ""] = entry.split("\u0000");
      if (!sha?.trim()) continue;
      const issues = [
        ...new Set([
          ...parseFixReferences(`${subject}\n${body}`),
          ...parseStampedIssues(subject),
        ]),
      ];
      if (issues.length === 0) continue;

      const changed = await runGitCommand(
        ["show", "--name-only", "--format=", sha.trim()],
        options,
      );
      if (!changed.ok || changed.value.code !== 0) {
        complete = false;
        continue;
      }
      for (
        const path of changed.value.stdout.split("\n").map((l) => l.trim())
      ) {
        if (!path || !isTestPath(path)) continue;
        // Cases this commit added: what the file has after it, minus what it
        // had at the merge base. A file absent from the base is not a
        // failure — every case in it is new.
        const before = await runGitCommand(
          ["show", `${mergeBase}:${path}`],
          options,
        );
        const after = await runGitCommand(["show", `${ref}:${path}`], options);
        const baseNames = before.ok && before.value.code === 0
          ? extractTestNames(before.value.stdout)
          : [];
        const names = after.ok && after.value.code === 0
          ? extractTestNames(after.value.stdout)
          : [];
        const fresh = names.filter((name) => !baseNames.includes(name));
        for (const issue of issues) {
          added[issue] = [...(added[issue] ?? []), ...fresh];
        }
      }
    }
    return added;
  };

  const oursAdded = await addedFor(milestoneRef);
  const theirsAdded = await addedFor(defaultRef);
  return { oursAdded, theirsAdded, complete };
}

/**
 * Merge one conflicted test file as a **union**: both sides' hunks kept.
 *
 * This is the resolution a test-file conflict gets when neither side contains
 * the other, because taking a side would drop cases. The result is checked
 * before it is staged — every case name on either side must survive it — and
 * the merged tree still has to pass the repository's own check and unit suite
 * afterwards, so a union that produces nonsense is rolled back rather than
 * pushed.
 *
 * @returns null when the union was staged; the reason it could not be, otherwise
 */
export async function unionMergeConflictedFile(
  file: ConflictedFile,
  options: GitCommandOptions,
): Promise<string | null> {
  if (file.ours === null || file.theirs === null) {
    return "one side has no version of the file, so there is nothing to union";
  }
  // `git merge-file` works on files, not index specs, so the three stages are
  // materialised in a scratch directory that is removed either way. Stage 1
  // is absent for an add/add conflict — an empty base is exactly right there.
  const base = await runGitCommand(["show", `:1:${file.path}`], options);
  const scratch = await Deno.makeTempDir({ prefix: "vibe-union-" });
  let merged: { code: number; stdout: string; stderr: string };
  try {
    await Deno.writeTextFile(`${scratch}/ours`, file.ours);
    await Deno.writeTextFile(
      `${scratch}/base`,
      base.ok && base.value.code === 0 ? base.value.stdout : "",
    );
    await Deno.writeTextFile(`${scratch}/theirs`, file.theirs);
    const result = await runGitCommand(
      [
        "merge-file",
        "-p",
        "--union",
        "-L",
        "milestone branch",
        "-L",
        "merge base",
        "-L",
        "default branch",
        `${scratch}/ours`,
        `${scratch}/base`,
        `${scratch}/theirs`,
      ],
      options,
    );
    if (!result.ok) {
      return `a union merge of this file failed: ${result.error.message}`;
    }
    merged = result.value;
  } catch (err) {
    return `a union merge of this file could not be prepared: ${
      err instanceof Error ? err.message : String(err)
    }`;
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => undefined);
  }

  // `git merge-file` exits with the number of remaining conflicts; a union
  // merge leaves none, so anything non-zero means it did not do the job.
  if (merged.code !== 0) {
    return `a union merge of this file failed: ${
      merged.stderr.trim() || `git merge-file exited ${merged.code}`
    }`;
  }

  const wanted = [
    ...new Set([
      ...extractTestNames(file.ours),
      ...extractTestNames(file.theirs),
    ]),
  ];
  const kept = new Set(extractTestNames(merged.stdout));
  const lost = wanted.filter((name) => !kept.has(name));
  if (lost.length > 0) {
    return `a union merge of this file would lose ${lost.length} case(s): ${
      lost.join(", ")
    }`;
  }

  const cwd = options.cwd ?? ".";
  try {
    await Deno.writeTextFile(`${cwd}/${file.path}`, merged.stdout);
  } catch (err) {
    return `the union of both sides could not be written: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  const added = await runGitCommand(buildAddPathArgs(file.path), options);
  if (!added.ok || added.value.code !== 0) {
    const detail = added.ok ? added.value.stderr.trim() : added.error.message;
    return `the union of both sides could not be staged: ${
      detail || "git reported no stderr"
    }`;
  }
  return null;
}

/** Build the refusal for a conflicted path whose chosen side would not take. */
function takeSideError(
  what: string,
  file: string,
  side: ConflictSide,
  defaultBranch: string,
  milestoneBranch: string,
  detail: string,
): Error {
  const whose = side === "theirs" ? defaultBranch : milestoneBranch;
  return new Error(
    `Failed to ${what} '${whose}'s version of '${file}' while merging ` +
      `'${defaultBranch}' into '${milestoneBranch}' — refusing to commit a ` +
      `resolution that would keep the other side instead ` +
      `(Issues #1048, #1559): ${detail.trim() || "git reported no stderr"}`,
  );
}

/**
 * Stage the side the triage chose for every conflicted path.
 *
 * "Taking a side" is not the same as "keeping the file": where the chosen side
 * has no version, taking it means deleting the file — the modify/delete rule
 * of Issue #1048, which is how `lib/fleet_health.ts` came back on
 * `milestone/863` before it existed. That rule lives in
 * `merge_conflict_stages.ts` and is read from there rather than restated.
 */
export async function applyConflictPlan(
  plan: ConflictPlan,
  sides: ConflictedFile[],
  defaultBranch: string,
  milestoneBranch: string,
  options: GitCommandOptions,
): Promise<Result<void>> {
  const decided = new Map(plan.resolved.map((d) => [d.path, d]));
  for (const file of sides) {
    const action = decided.get(file.path)?.action;
    if (action !== "ours" && action !== "theirs") continue;
    const side: ConflictSide = action;

    const staged = await runGitCommand(
      ["ls-files", "-u", "--", file.path],
      options,
    );
    const stages = staged.ok && staged.value.code === 0
      ? parseUnmergedStages(staged.value.stdout)
      : { base: false, ours: false, theirs: false };
    if (!hasAnyStage(stages)) {
      // Every conflicted path has stages. None means git could not be read,
      // and guessing here is precisely the silent wrong answer (Issue #1048).
      const detail = staged.ok
        ? staged.value.stderr.trim()
        : staged.error.message;
      return {
        ok: false,
        error: new Error(
          `Refusing to resolve the merge of '${defaultBranch}' into ` +
            `'${milestoneBranch}': the merge stages of conflicted file ` +
            `'${file.path}' could not be read (Issue #1048): ${
              detail || "git reported no stderr"
            }`,
        ),
      };
    }

    // The chosen side has no version of the file: taking that side deletes it.
    const deletes = side === "theirs"
      ? resolveTowardsIncoming(stages) === "delete"
      : !stages.ours;
    if (deletes) {
      const removed = await runGitCommand(
        buildRemovePathArgs(file.path),
        options,
      );
      if (!removed.ok || removed.value.code !== 0) {
        return {
          ok: false,
          error: takeSideError(
            "delete",
            file.path,
            side,
            defaultBranch,
            milestoneBranch,
            removed.ok ? removed.value.stderr : removed.error.message,
          ),
        };
      }
      continue;
    }

    // Both exit codes matter (Issue #1048): a `checkout --<side>` that failed
    // leaves the other side's working-tree copy in place, and the `add` below
    // would stage exactly the side the triage rejected.
    const checkedOut = await runGitCommand(
      buildCheckoutStrategyArgs(side, file.path),
      options,
    );
    if (!checkedOut.ok || checkedOut.value.code !== 0) {
      return {
        ok: false,
        error: takeSideError(
          "check out",
          file.path,
          side,
          defaultBranch,
          milestoneBranch,
          checkedOut.ok ? checkedOut.value.stderr : checkedOut.error.message,
        ),
      };
    }
    const added = await runGitCommand(buildAddPathArgs(file.path), options);
    if (!added.ok || added.value.code !== 0) {
      return {
        ok: false,
        error: takeSideError(
          "stage",
          file.path,
          side,
          defaultBranch,
          milestoneBranch,
          added.ok ? added.value.stderr : added.error.message,
        ),
      };
    }
  }
  return { ok: true, value: undefined };
}
