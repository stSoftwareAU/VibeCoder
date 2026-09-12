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
  isJsonPath,
  unionIsWellFormed,
} from "./both_inserted_conflict_rule.ts";
import { unionJsonInsertions } from "./json_insertion_union.ts";
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
import { describeGitFailure } from "./milestone_merge_state.ts";
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
      const detail = describeGitFailure(staged);
      return {
        ok: false,
        error: new Error(
          `Refusing to resolve the merge of '${defaultBranch}' into ` +
            `'${milestoneRef}': the merge stages of conflicted file '${path}' ` +
            `could not be read, so which side has a version of it is unknown ` +
            `(Issues #1048, #1559): ${detail}`,
        ),
      };
    }

    const ours = await readStage(2, path, stages.ours, options);
    if (!ours.ok) return ours;
    const theirs = await readStage(3, path, stages.theirs, options);
    if (!theirs.ok) return theirs;
    // Stage 1 is what proves nothing was deleted (Issue #1768). It is absent
    // for an add/add conflict, which is a null the triage reads as "no base",
    // never as "the base was empty".
    const base = await readStage(1, path, stages.base, options);
    if (!base.ok) return base;

    sides.push({
      path,
      ours: ours.value,
      theirs: theirs.value,
      base: base.value,
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
  stage: 1 | 2 | 3,
  path: string,
  present: boolean,
  options: GitCommandOptions,
): Promise<Result<string | null>> {
  if (!present) return { ok: true, value: null };
  const result = await runGitCommand(["show", `:${stage}:${path}`], options);
  if (!result.ok || result.value.code !== 0) {
    const detail = describeGitFailure(result);
    return {
      ok: false,
      error: new Error(
        `Refusing to resolve a conflicted merge: stage ${stage} of ` +
          `'${path}' is present but could not be read, so one side of the ` +
          `conflict is unknown (Issue #1559): ${detail}`,
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

/** Which side's hunk a union merge emits first. */
export type UnionOrder =
  /** The milestone branch's hunk first — the test-file union of #1559. */
  | "milestone-first"
  /** The default branch's hunk first — the append-only ledger rule of #1768. */
  | "default-first";

/**
 * Union the two sides' **text** with `git merge-file --union`.
 *
 * `git merge-file` works on files, not index specs, so the three stages are
 * materialised in a scratch directory that is removed either way. `--union`
 * keeps both sides whichever way round they are given; which file comes first
 * is only what the merged text says first.
 *
 * @returns the merged text, or the reason it could not be produced
 */
async function textUnionMerge(
  ours: string,
  theirs: string,
  baseText: string,
  order: UnionOrder,
  options: GitCommandOptions,
): Promise<Result<string, string>> {
  const scratch = await Deno.makeTempDir({ prefix: "vibe-union-" });
  let merged: { code: number; stdout: string; stderr: string };
  try {
    await Deno.writeTextFile(`${scratch}/ours`, ours);
    await Deno.writeTextFile(`${scratch}/base`, baseText);
    await Deno.writeTextFile(`${scratch}/theirs`, theirs);
    const first = order === "default-first" ? "theirs" : "ours";
    const last = order === "default-first" ? "ours" : "theirs";
    const label = (side: string) =>
      side === "ours" ? "milestone branch" : "default branch";
    const result = await runGitCommand(
      [
        "merge-file",
        "-p",
        "--union",
        "-L",
        label(first),
        "-L",
        "merge base",
        "-L",
        label(last),
        `${scratch}/${first}`,
        `${scratch}/base`,
        `${scratch}/${last}`,
      ],
      options,
    );
    if (!result.ok) {
      return {
        ok: false,
        error: `a union merge of this file failed: ${result.error.message}`,
      };
    }
    merged = result.value;
  } catch (err) {
    return {
      ok: false,
      error: `a union merge of this file could not be prepared: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => undefined);
  }

  // `git merge-file` exits with the number of remaining conflicts; a union
  // merge leaves none, so anything non-zero means it did not do the job.
  if (merged.code !== 0) {
    return {
      ok: false,
      error: `a union merge of this file failed: ${
        merged.stderr.trim() || `git merge-file exited ${merged.code}`
      }`,
    };
  }
  return { ok: true, value: merged.stdout };
}

/**
 * Merge one conflicted file as a **union**: both sides' hunks kept.
 *
 * This is the resolution a test-file conflict gets when neither side contains
 * the other, because taking a side would drop cases, and the resolution an
 * append-only ledger gets when both sides only appended (Issue #1768). The
 * result is checked before it is staged — every case name on either side must
 * survive it, and a `.json` result must parse — and the merged tree still has
 * to pass the repository's own check and unit suite afterwards, so a union that
 * produces nonsense is rolled back rather than pushed.
 *
 * ## A `.json` ledger is unioned by value first (Issue #2013)
 *
 * Two branches that each append a slice to `docs/audits/*.json` conflict
 * *inside* the appended object, so no arrangement of the two hunks' text is
 * valid JSON: the textual union could only ever produce a document the
 * well-formedness check below has to refuse, and this rung escalated that to a
 * human. The PR-merge rung learnt the same lesson in #1968, so a `.json` path
 * with a merge base is unioned **by value** first, through
 * `json_insertion_union.ts` — which does its own insertion-only checking and
 * re-serialises in the file's own formatting. Anything it refuses (a deletion,
 * a conflicting edit, formatting it would not reproduce) falls back to the
 * textual union exactly as before, and its reason is carried into the refusal
 * so a human reading the escalation is told why the structural merge declined.
 *
 * @param order - Which side's hunk comes first in the merged text
 * @returns null when the union was staged; the reason it could not be, otherwise
 */
export async function unionMergeConflictedFile(
  file: ConflictedFile,
  options: GitCommandOptions,
  order: UnionOrder = "milestone-first",
): Promise<string | null> {
  if (file.ours === null || file.theirs === null) {
    return "one side has no version of the file, so there is nothing to union";
  }
  // Stage 1 is the merge base. It is absent for an add/add conflict, which is
  // "there is no base" rather than "the base was empty" — the structural JSON
  // union needs a real one, and the textual union treats it as empty text.
  const base = await runGitCommand(["show", `:1:${file.path}`], options);
  const baseText = base.ok && base.value.code === 0 ? base.value.stdout : null;

  // `unionJsonInsertions` emits its `theirs` argument's insertions first, and
  // `file.theirs` is the default branch's side — so the two are passed
  // straight through for "default-first" and swapped for "milestone-first".
  const structured = isJsonPath(file.path) && baseText !== null
    ? unionJsonInsertions(
      baseText,
      order === "default-first" ? file.ours : file.theirs,
      order === "default-first" ? file.theirs : file.ours,
    )
    : null;

  let mergedText: string;
  if (structured?.ok) {
    mergedText = structured.value;
  } else {
    const text = await textUnionMerge(
      file.ours,
      file.theirs,
      baseText ?? "",
      order,
      options,
    );
    if (!text.ok) return text.error;
    mergedText = text.value;
  }

  const wanted = [
    ...new Set([
      ...extractTestNames(file.ours),
      ...extractTestNames(file.theirs),
    ]),
  ];
  const kept = new Set(extractTestNames(mergedText));
  const lost = wanted.filter((name) => !kept.has(name));
  if (lost.length > 0) {
    return `a union merge of this file would lose ${lost.length} case(s): ${
      lost.join(", ")
    }`;
  }

  // A JSON ledger whose union does not parse is not a resolution (Issue
  // #1768): two entries appended into the same array leave the document
  // invalid, and an invalid document must never be written or staged. The
  // structural union above cannot produce one, so reaching here with a `.json`
  // path means it declined — and its reason is the one worth reporting.
  if (!unionIsWellFormed(file.path, mergedText)) {
    const why = structured && !structured.ok
      ? ` (it was not unioned as JSON first: ${structured.error})`
      : "";
    return "the union of both sides does not parse as JSON, so it was not " +
      `written${why}`;
  }

  const cwd = options.cwd ?? ".";
  try {
    await Deno.writeTextFile(`${cwd}/${file.path}`, mergedText);
  } catch (err) {
    return `the union of both sides could not be written: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  const added = await runGitCommand(buildAddPathArgs(file.path), options);
  if (!added.ok || added.value.code !== 0) {
    return `the union of both sides could not be staged: ${
      describeGitFailure(added)
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
      `(Issues #1048, #1559): ${detail.trim()}`,
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
      const detail = describeGitFailure(staged);
      return {
        ok: false,
        error: new Error(
          `Refusing to resolve the merge of '${defaultBranch}' into ` +
            `'${milestoneBranch}': the merge stages of conflicted file ` +
            `'${file.path}' could not be read (Issue #1048): ${detail}`,
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
