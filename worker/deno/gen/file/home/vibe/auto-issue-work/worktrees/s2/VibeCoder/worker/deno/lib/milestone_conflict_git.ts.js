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
 */ import { runGitCommand } from "./git_timeout.ts";
import { isJsonPath, unionIsWellFormed } from "./both_inserted_conflict_rule.ts";
import { unionJsonInsertions } from "./json_insertion_union.ts";
import { mergeDuplicateRustUses } from "./rust_use_union.ts";
import { buildAddPathArgs, buildCheckoutStrategyArgs, buildRemovePathArgs } from "./git_conflict_args.ts";
import { hasAnyStage, parseUnmergedStages, resolveTowardsIncoming } from "./merge_conflict_stages.ts";
import { describeGitFailure } from "./milestone_merge_state.ts";
import { extractTestNames, isTestPath, parseFixReferences, parseStampedIssues } from "./milestone_conflict_triage.ts";
/** The merge base of the two sides; empty when git could not compute one. */ export async function readMergeBase(milestoneRef, defaultBranch, options) {
  const result = await runGitCommand([
    "merge-base",
    milestoneRef,
    defaultBranch
  ], options);
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
 */ export async function readConflictedSides(conflictedFiles, mergeBase, defaultBranch, defaultRef, milestoneRef, options) {
  const sides = [];
  for (const path of conflictedFiles){
    const staged = await runGitCommand([
      "ls-files",
      "-u",
      "--",
      path
    ], options);
    const stages = staged.ok && staged.value.code === 0 ? parseUnmergedStages(staged.value.stdout) : {
      base: false,
      ours: false,
      theirs: false
    };
    if (!hasAnyStage(stages)) {
      const detail = describeGitFailure(staged);
      return {
        ok: false,
        error: new Error(`Refusing to resolve the merge of '${defaultBranch}' into ` + `'${milestoneRef}': the merge stages of conflicted file '${path}' ` + `could not be read, so which side has a version of it is unknown ` + `(Issues #1048, #1559): ${detail}`)
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
      oursFixes: await readFixReferences(mergeBase, milestoneRef, path, options),
      theirsFixes: await readFixReferences(mergeBase, defaultRef, path, options)
    });
  }
  return {
    ok: true,
    value: sides
  };
}
/**
 * One side of a conflicted path: its content, or null when that side has no
 * stage — that side deleted the file.
 *
 * A stage that exists but will not read is a failure, never a null.
 */ async function readStage(stage, path, present, options) {
  if (!present) return {
    ok: true,
    value: null
  };
  const result = await runGitCommand([
    "show",
    `:${stage}:${path}`
  ], options);
  if (!result.ok || result.value.code !== 0) {
    const detail = describeGitFailure(result);
    return {
      ok: false,
      error: new Error(`Refusing to resolve a conflicted merge: stage ${stage} of ` + `'${path}' is present but could not be read, so one side of the ` + `conflict is unknown (Issue #1559): ${detail}`)
    };
  }
  return {
    ok: true,
    value: result.value.stdout
  };
}
/** Issues the commits touching `path` on one side say they close. */ async function readFixReferences(mergeBase, ref, path, options) {
  if (!mergeBase || !ref) return [];
  const result = await runGitCommand([
    "log",
    "--format=%B",
    `${mergeBase}..${ref}`,
    "--",
    path
  ], options);
  return result.ok && result.value.code === 0 ? parseFixReferences(result.value.stdout) : [];
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
 */ export async function readTestEvidence(mergeBase, defaultRef, milestoneRef, options) {
  if (!mergeBase) return {
    oursAdded: {},
    theirsAdded: {},
    complete: false
  };
  let complete = true;
  const addedFor = async (ref)=>{
    const added = {};
    if (!ref) {
      complete = false;
      return added;
    }
    // One line per commit: its hash, then the issues it claims to fix.
    const log = await runGitCommand([
      "log",
      "--format=%H%x00%s%x00%b%x01",
      `${mergeBase}..${ref}`
    ], options);
    if (!log.ok || log.value.code !== 0) {
      complete = false;
      return added;
    }
    for (const entry of log.value.stdout.split("\u0001")){
      const [sha, subject = "", body = ""] = entry.split("\u0000");
      if (!sha?.trim()) continue;
      const issues = [
        ...new Set([
          ...parseFixReferences(`${subject}\n${body}`),
          ...parseStampedIssues(subject)
        ])
      ];
      if (issues.length === 0) continue;
      const changed = await runGitCommand([
        "show",
        "--name-only",
        "--format=",
        sha.trim()
      ], options);
      if (!changed.ok || changed.value.code !== 0) {
        complete = false;
        continue;
      }
      for (const path of changed.value.stdout.split("\n").map((l)=>l.trim())){
        if (!path || !isTestPath(path)) continue;
        // Cases this commit added: what the file has after it, minus what it
        // had at the merge base. A file absent from the base is not a
        // failure — every case in it is new.
        const before = await runGitCommand([
          "show",
          `${mergeBase}:${path}`
        ], options);
        const after = await runGitCommand([
          "show",
          `${ref}:${path}`
        ], options);
        const baseNames = before.ok && before.value.code === 0 ? extractTestNames(before.value.stdout) : [];
        const names = after.ok && after.value.code === 0 ? extractTestNames(after.value.stdout) : [];
        const fresh = names.filter((name)=>!baseNames.includes(name));
        for (const issue of issues){
          added[issue] = [
            ...added[issue] ?? [],
            ...fresh
          ];
        }
      }
    }
    return added;
  };
  const oursAdded = await addedFor(milestoneRef);
  const theirsAdded = await addedFor(defaultRef);
  return {
    oursAdded,
    theirsAdded,
    complete
  };
}
/**
 * Union the two sides' **text** with `git merge-file --union`.
 *
 * `git merge-file` works on files, not index specs, so the three stages are
 * materialised in a scratch directory that is removed either way. `--union`
 * keeps both sides whichever way round they are given; which file comes first
 * is only what the merged text says first.
 *
 * @returns the merged text, or the reason it could not be produced
 */ async function textUnionMerge(ours, theirs, baseText, order, options) {
  const scratch = await Deno.makeTempDir({
    prefix: "vibe-union-"
  });
  let merged;
  try {
    await Deno.writeTextFile(`${scratch}/ours`, ours);
    await Deno.writeTextFile(`${scratch}/base`, baseText);
    await Deno.writeTextFile(`${scratch}/theirs`, theirs);
    const first = order === "default-first" ? "theirs" : "ours";
    const last = order === "default-first" ? "ours" : "theirs";
    const label = (side)=>side === "ours" ? "milestone branch" : "default branch";
    const result = await runGitCommand([
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
      `${scratch}/${last}`
    ], options);
    if (!result.ok) {
      return {
        ok: false,
        error: `a union merge of this file failed: ${result.error.message}`
      };
    }
    merged = result.value;
  } catch (err) {
    return {
      ok: false,
      error: `a union merge of this file could not be prepared: ${err instanceof Error ? err.message : String(err)}`
    };
  } finally{
    await Deno.remove(scratch, {
      recursive: true
    }).catch(()=>undefined);
  }
  // `git merge-file` exits with the number of remaining conflicts; a union
  // merge leaves none, so anything non-zero means it did not do the job.
  if (merged.code !== 0) {
    return {
      ok: false,
      error: `a union merge of this file failed: ${merged.stderr.trim() || `git merge-file exited ${merged.code}`}`
    };
  }
  return {
    ok: true,
    value: merged.stdout
  };
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
 */ export async function unionMergeConflictedFile(file, options, order = "milestone-first") {
  if (file.ours === null || file.theirs === null) {
    return "one side has no version of the file, so there is nothing to union";
  }
  // Stage 1 is the merge base. It is absent for an add/add conflict, which is
  // "there is no base" rather than "the base was empty" — the structural JSON
  // union needs a real one, and the textual union treats it as empty text.
  const base = await runGitCommand([
    "show",
    `:1:${file.path}`
  ], options);
  const baseText = base.ok && base.value.code === 0 ? base.value.stdout : null;
  // `unionJsonInsertions` emits its `theirs` argument's insertions first, and
  // `file.theirs` is the default branch's side — so the two are passed
  // straight through for "default-first" and swapped for "milestone-first".
  const structured = isJsonPath(file.path) && baseText !== null ? unionJsonInsertions(baseText, order === "default-first" ? file.ours : file.theirs, order === "default-first" ? file.theirs : file.ours) : null;
  let mergedText;
  if (structured?.ok) {
    mergedText = structured.value;
  } else {
    const text = await textUnionMerge(file.ours, file.theirs, baseText ?? "", order, options);
    if (!text.ok) return text.error;
    mergedText = text.value;
    // A textual union of two edits to the same `use` line keeps both, which
    // rustc rejects as E0252 (Issue #3007) — fold the duplicate back into one.
    if (file.path.endsWith(".rs")) {
      mergedText = mergeDuplicateRustUses(mergedText);
    }
  }
  const wanted = [
    ...new Set([
      ...extractTestNames(file.ours),
      ...extractTestNames(file.theirs)
    ])
  ];
  const kept = new Set(extractTestNames(mergedText));
  const lost = wanted.filter((name)=>!kept.has(name));
  if (lost.length > 0) {
    return `a union merge of this file would lose ${lost.length} case(s): ${lost.join(", ")}`;
  }
  // A JSON ledger whose union does not parse is not a resolution (Issue
  // #1768): two entries appended into the same array leave the document
  // invalid, and an invalid document must never be written or staged. The
  // structural union above cannot produce one, so reaching here with a `.json`
  // path means it declined — and its reason is the one worth reporting.
  if (!unionIsWellFormed(file.path, mergedText)) {
    const why = structured && !structured.ok ? ` (it was not unioned as JSON first: ${structured.error})` : "";
    return "the union of both sides does not parse as JSON, so it was not " + `written${why}`;
  }
  const cwd = options.cwd ?? ".";
  try {
    await Deno.writeTextFile(`${cwd}/${file.path}`, mergedText);
  } catch (err) {
    return `the union of both sides could not be written: ${err instanceof Error ? err.message : String(err)}`;
  }
  const added = await runGitCommand(buildAddPathArgs(file.path), options);
  if (!added.ok || added.value.code !== 0) {
    return `the union of both sides could not be staged: ${describeGitFailure(added)}`;
  }
  return null;
}
/** Build the refusal for a conflicted path whose chosen side would not take. */ function takeSideError(what, file, side, defaultBranch, milestoneBranch, detail) {
  const whose = side === "theirs" ? defaultBranch : milestoneBranch;
  return new Error(`Failed to ${what} '${whose}'s version of '${file}' while merging ` + `'${defaultBranch}' into '${milestoneBranch}' — refusing to commit a ` + `resolution that would keep the other side instead ` + `(Issues #1048, #1559): ${detail.trim()}`);
}
/**
 * Stage the side the triage chose for every conflicted path.
 *
 * "Taking a side" is not the same as "keeping the file": where the chosen side
 * has no version, taking it means deleting the file — the modify/delete rule
 * of Issue #1048, which is how `lib/fleet_health.ts` came back on
 * `milestone/863` before it existed. That rule lives in
 * `merge_conflict_stages.ts` and is read from there rather than restated.
 */ export async function applyConflictPlan(plan, sides, defaultBranch, milestoneBranch, options) {
  const decided = new Map(plan.resolved.map((d)=>[
      d.path,
      d
    ]));
  for (const file of sides){
    const action = decided.get(file.path)?.action;
    if (action !== "ours" && action !== "theirs") continue;
    const side = action;
    const staged = await runGitCommand([
      "ls-files",
      "-u",
      "--",
      file.path
    ], options);
    const stages = staged.ok && staged.value.code === 0 ? parseUnmergedStages(staged.value.stdout) : {
      base: false,
      ours: false,
      theirs: false
    };
    if (!hasAnyStage(stages)) {
      // Every conflicted path has stages. None means git could not be read,
      // and guessing here is precisely the silent wrong answer (Issue #1048).
      const detail = describeGitFailure(staged);
      return {
        ok: false,
        error: new Error(`Refusing to resolve the merge of '${defaultBranch}' into ` + `'${milestoneBranch}': the merge stages of conflicted file ` + `'${file.path}' could not be read (Issue #1048): ${detail}`)
      };
    }
    // The chosen side has no version of the file: taking that side deletes it.
    const deletes = side === "theirs" ? resolveTowardsIncoming(stages) === "delete" : !stages.ours;
    if (deletes) {
      const removed = await runGitCommand(buildRemovePathArgs(file.path), options);
      if (!removed.ok || removed.value.code !== 0) {
        return {
          ok: false,
          error: takeSideError("delete", file.path, side, defaultBranch, milestoneBranch, removed.ok ? removed.value.stderr : removed.error.message)
        };
      }
      continue;
    }
    // Both exit codes matter (Issue #1048): a `checkout --<side>` that failed
    // leaves the other side's working-tree copy in place, and the `add` below
    // would stage exactly the side the triage rejected.
    const checkedOut = await runGitCommand(buildCheckoutStrategyArgs(side, file.path), options);
    if (!checkedOut.ok || checkedOut.value.code !== 0) {
      return {
        ok: false,
        error: takeSideError("check out", file.path, side, defaultBranch, milestoneBranch, checkedOut.ok ? checkedOut.value.stderr : checkedOut.error.message)
      };
    }
    const added = await runGitCommand(buildAddPathArgs(file.path), options);
    if (!added.ok || added.value.code !== 0) {
      return {
        ok: false,
        error: takeSideError("stage", file.path, side, defaultBranch, milestoneBranch, added.ok ? added.value.stderr : added.error.message)
      };
    }
  }
  return {
    ok: true,
    value: undefined
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfY29uZmxpY3RfZ2l0LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIGdpdCBzaWRlIG9mIGEgdHJpYWdlZCBtaWxlc3RvbmUgc3luYyBjb25mbGljdCAoSXNzdWUgIzE1NTkpLlxuICpcbiAqIGBtaWxlc3RvbmVfY29uZmxpY3RfdHJpYWdlLnRzYCBkZWNpZGVzIHdoYXQgdG8gZG8gd2l0aCBhIGNvbmZsaWN0ZWQgZmlsZSBhbmRcbiAqIHRvdWNoZXMgbm8gZ2l0OyB0aGlzIG1vZHVsZSBpcyB0aGUgb3RoZXIgaGFsZiDigJQgaXQgcmVhZHMgYm90aCBzaWRlcyBvdXQgb2ZcbiAqIHRoZSBjb25mbGljdGVkIGluZGV4LCBnYXRoZXJzIHRoZSBldmlkZW5jZSB0aGUgdHJpYWdlIG5lZWRzLCBhbmQgc3RhZ2VzIHRoZVxuICogc2lkZSB0aGUgdHJpYWdlIGNob3NlLlxuICpcbiAqIEV2ZXJ5dGhpbmcgaGVyZSBmYWlscyBsb3VkLiBBIHNpZGUgdGhhdCBjYW5ub3QgYmUgcmVhZCBpcyAqKm5vdCoqIHJlcG9ydGVkXG4gKiBhcyBcInRoYXQgc2lkZSBkZWxldGVkIHRoZSBmaWxlXCI6IHRoYXQgbWlzdGFrZSB3b3VsZCB0dXJuIGEgdHJhbnNpZW50IGdpdFxuICogZmFpbHVyZSBpbnRvIGEgcmVzb2x1dGlvbiBub2JvZHkgY2hvc2UsIHdoaWNoIGlzIHRoZSB3aG9sZSBmYXVsdCB0aGlzIGlzc3VlXG4gKiBleGlzdHMgdG8gcmVtb3ZlLiBFdmlkZW5jZSB0aGF0IGNvdWxkIG5vdCBiZSBnYXRoZXJlZCBpcyByZXBvcnRlZCBhc1xuICogaW5jb21wbGV0ZSByYXRoZXIgdGhhbiBhcyBcInRoZXJlIHdhcyBub25lXCIsIGZvciB0aGUgc2FtZSByZWFzb24uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHR5cGUgeyBHaXRDb21tYW5kT3B0aW9ucyB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQge1xuICBpc0pzb25QYXRoLFxuICB1bmlvbklzV2VsbEZvcm1lZCxcbn0gZnJvbSBcIi4vYm90aF9pbnNlcnRlZF9jb25mbGljdF9ydWxlLnRzXCI7XG5pbXBvcnQgeyB1bmlvbkpzb25JbnNlcnRpb25zIH0gZnJvbSBcIi4vanNvbl9pbnNlcnRpb25fdW5pb24udHNcIjtcbmltcG9ydCB7IG1lcmdlRHVwbGljYXRlUnVzdFVzZXMgfSBmcm9tIFwiLi9ydXN0X3VzZV91bmlvbi50c1wiO1xuaW1wb3J0IHtcbiAgYnVpbGRBZGRQYXRoQXJncyxcbiAgYnVpbGRDaGVja291dFN0cmF0ZWd5QXJncyxcbiAgYnVpbGRSZW1vdmVQYXRoQXJncyxcbn0gZnJvbSBcIi4vZ2l0X2NvbmZsaWN0X2FyZ3MudHNcIjtcbmltcG9ydCB7XG4gIGhhc0FueVN0YWdlLFxuICBwYXJzZVVubWVyZ2VkU3RhZ2VzLFxuICByZXNvbHZlVG93YXJkc0luY29taW5nLFxufSBmcm9tIFwiLi9tZXJnZV9jb25mbGljdF9zdGFnZXMudHNcIjtcbmltcG9ydCB7IGRlc2NyaWJlR2l0RmFpbHVyZSB9IGZyb20gXCIuL21pbGVzdG9uZV9tZXJnZV9zdGF0ZS50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBDb25mbGljdGVkRmlsZSxcbiAgdHlwZSBDb25mbGljdFBsYW4sXG4gIHR5cGUgQ29uZmxpY3RTaWRlLFxuICBleHRyYWN0VGVzdE5hbWVzLFxuICBpc1Rlc3RQYXRoLFxuICBwYXJzZUZpeFJlZmVyZW5jZXMsXG4gIHBhcnNlU3RhbXBlZElzc3VlcyxcbiAgdHlwZSBUZXN0RXZpZGVuY2UsXG59IGZyb20gXCIuL21pbGVzdG9uZV9jb25mbGljdF90cmlhZ2UudHNcIjtcblxuLyoqIFRoZSBtZXJnZSBiYXNlIG9mIHRoZSB0d28gc2lkZXM7IGVtcHR5IHdoZW4gZ2l0IGNvdWxkIG5vdCBjb21wdXRlIG9uZS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkTWVyZ2VCYXNlKFxuICBtaWxlc3RvbmVSZWY6IHN0cmluZyxcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wibWVyZ2UtYmFzZVwiLCBtaWxlc3RvbmVSZWYsIGRlZmF1bHRCcmFuY2hdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIHJldHVybiByZXN1bHQub2sgJiYgcmVzdWx0LnZhbHVlLmNvZGUgPT09IDAgPyByZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSA6IFwiXCI7XG59XG5cbi8qKlxuICogUmVhZCBib3RoIHNpZGVzIG9mIGV2ZXJ5IGNvbmZsaWN0ZWQgcGF0aCwgcGx1cyB3aGF0IGVhY2ggc2lkZSBzYXlzIGl0IGZpeGVzLlxuICpcbiAqIFJlYWQgd2hpbGUgdGhlIG1lcmdlIGlzIHN0aWxsIGluIHByb2dyZXNzOiBzdGFnZXMgMiBhbmQgMyBhcmUgdGhlIHR3byBzaWRlc1xuICogYXMgZ2l0IHN0YWdlZCB0aGVtLCBhbmQgdGhleSBhcmUgZ29uZSBvbmNlIHRoZSBtZXJnZSBpcyBhYm9ydGVkLiBBIHNpZGUgd2l0aFxuICogbm8gc3RhZ2UgZGVsZXRlZCB0aGUgZmlsZSwgd2hpY2ggaXMgYSBkZWNpc2lvbiBpbiBpdHMgb3duIHJpZ2h0IOKAlCBzbyB0aGVcbiAqIHN0YWdlcyBhcmUgcmVhZCBmaXJzdCBhbmQgdGhlIGNvbnRlbnQgaXMgb25seSBmZXRjaGVkIGZvciBhIHN0YWdlIHRoYXRcbiAqIGV4aXN0cy4gQSBzdGFnZSB0aGF0IGV4aXN0cyBidXQgY2Fubm90IGJlIHJlYWQgZmFpbHMgdGhlIHdob2xlIHJlc29sdXRpb246XG4gKiBcImNvdWxkIG5vdCByZWFkIGl0XCIgbXVzdCBuZXZlciBiZSBtaXN0YWtlbiBmb3IgXCJ0aGF0IHNpZGUgZGVsZXRlZCBpdFwiLlxuICpcbiAqIFRoZSBmaXggcmVmZXJlbmNlcyBjb21lIGZyb20gdGhlIGNvbW1pdHMgb24gZWFjaCBzaWRlIHRoYXQgdG91Y2hlZCAqdGhpcypcbiAqIHBhdGggc2luY2UgdGhlIG1lcmdlIGJhc2UuIFdpdGhvdXQgYSBtZXJnZSBiYXNlIChhIHNoYWxsb3cgY2xvbmUgd2l0aCB0b29cbiAqIGxpdHRsZSBoaXN0b3J5KSB0aGVyZSBhcmUgbm8gcmVmZXJlbmNlcywgc28gdGhlIGR1cGxpY2F0ZS1maXggcnVsZSBkb2VzIG5vdFxuICogZmlyZSDigJQgdGhlIHNhZmUgZGlyZWN0aW9uLCBzaW5jZSBhIHdyb25nIHNoYXJlZCByZWZlcmVuY2Ugd291bGQgcmVzb2x2ZSBhXG4gKiBjb25mbGljdCBub2JvZHkgbWVhbnQgdG8gcmVzb2x2ZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRDb25mbGljdGVkU2lkZXMoXG4gIGNvbmZsaWN0ZWRGaWxlczogc3RyaW5nW10sXG4gIG1lcmdlQmFzZTogc3RyaW5nLFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4gIGRlZmF1bHRSZWY6IHN0cmluZyxcbiAgbWlsZXN0b25lUmVmOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8Q29uZmxpY3RlZEZpbGVbXT4+IHtcbiAgY29uc3Qgc2lkZXM6IENvbmZsaWN0ZWRGaWxlW10gPSBbXTtcbiAgZm9yIChjb25zdCBwYXRoIG9mIGNvbmZsaWN0ZWRGaWxlcykge1xuICAgIGNvbnN0IHN0YWdlZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wibHMtZmlsZXNcIiwgXCItdVwiLCBcIi0tXCIsIHBhdGhdLCBvcHRpb25zKTtcbiAgICBjb25zdCBzdGFnZXMgPSBzdGFnZWQub2sgJiYgc3RhZ2VkLnZhbHVlLmNvZGUgPT09IDBcbiAgICAgID8gcGFyc2VVbm1lcmdlZFN0YWdlcyhzdGFnZWQudmFsdWUuc3Rkb3V0KVxuICAgICAgOiB7IGJhc2U6IGZhbHNlLCBvdXJzOiBmYWxzZSwgdGhlaXJzOiBmYWxzZSB9O1xuICAgIGlmICghaGFzQW55U3RhZ2Uoc3RhZ2VzKSkge1xuICAgICAgY29uc3QgZGV0YWlsID0gZGVzY3JpYmVHaXRGYWlsdXJlKHN0YWdlZCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYFJlZnVzaW5nIHRvIHJlc29sdmUgdGhlIG1lcmdlIG9mICcke2RlZmF1bHRCcmFuY2h9JyBpbnRvIGAgK1xuICAgICAgICAgICAgYCcke21pbGVzdG9uZVJlZn0nOiB0aGUgbWVyZ2Ugc3RhZ2VzIG9mIGNvbmZsaWN0ZWQgZmlsZSAnJHtwYXRofScgYCArXG4gICAgICAgICAgICBgY291bGQgbm90IGJlIHJlYWQsIHNvIHdoaWNoIHNpZGUgaGFzIGEgdmVyc2lvbiBvZiBpdCBpcyB1bmtub3duIGAgK1xuICAgICAgICAgICAgYChJc3N1ZXMgIzEwNDgsICMxNTU5KTogJHtkZXRhaWx9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgb3VycyA9IGF3YWl0IHJlYWRTdGFnZSgyLCBwYXRoLCBzdGFnZXMub3Vycywgb3B0aW9ucyk7XG4gICAgaWYgKCFvdXJzLm9rKSByZXR1cm4gb3VycztcbiAgICBjb25zdCB0aGVpcnMgPSBhd2FpdCByZWFkU3RhZ2UoMywgcGF0aCwgc3RhZ2VzLnRoZWlycywgb3B0aW9ucyk7XG4gICAgaWYgKCF0aGVpcnMub2spIHJldHVybiB0aGVpcnM7XG4gICAgLy8gU3RhZ2UgMSBpcyB3aGF0IHByb3ZlcyBub3RoaW5nIHdhcyBkZWxldGVkIChJc3N1ZSAjMTc2OCkuIEl0IGlzIGFic2VudFxuICAgIC8vIGZvciBhbiBhZGQvYWRkIGNvbmZsaWN0LCB3aGljaCBpcyBhIG51bGwgdGhlIHRyaWFnZSByZWFkcyBhcyBcIm5vIGJhc2VcIixcbiAgICAvLyBuZXZlciBhcyBcInRoZSBiYXNlIHdhcyBlbXB0eVwiLlxuICAgIGNvbnN0IGJhc2UgPSBhd2FpdCByZWFkU3RhZ2UoMSwgcGF0aCwgc3RhZ2VzLmJhc2UsIG9wdGlvbnMpO1xuICAgIGlmICghYmFzZS5vaykgcmV0dXJuIGJhc2U7XG5cbiAgICBzaWRlcy5wdXNoKHtcbiAgICAgIHBhdGgsXG4gICAgICBvdXJzOiBvdXJzLnZhbHVlLFxuICAgICAgdGhlaXJzOiB0aGVpcnMudmFsdWUsXG4gICAgICBiYXNlOiBiYXNlLnZhbHVlLFxuICAgICAgb3Vyc0ZpeGVzOiBhd2FpdCByZWFkRml4UmVmZXJlbmNlcyhcbiAgICAgICAgbWVyZ2VCYXNlLFxuICAgICAgICBtaWxlc3RvbmVSZWYsXG4gICAgICAgIHBhdGgsXG4gICAgICAgIG9wdGlvbnMsXG4gICAgICApLFxuICAgICAgdGhlaXJzRml4ZXM6IGF3YWl0IHJlYWRGaXhSZWZlcmVuY2VzKFxuICAgICAgICBtZXJnZUJhc2UsXG4gICAgICAgIGRlZmF1bHRSZWYsXG4gICAgICAgIHBhdGgsXG4gICAgICAgIG9wdGlvbnMsXG4gICAgICApLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogc2lkZXMgfTtcbn1cblxuLyoqXG4gKiBPbmUgc2lkZSBvZiBhIGNvbmZsaWN0ZWQgcGF0aDogaXRzIGNvbnRlbnQsIG9yIG51bGwgd2hlbiB0aGF0IHNpZGUgaGFzIG5vXG4gKiBzdGFnZSDigJQgdGhhdCBzaWRlIGRlbGV0ZWQgdGhlIGZpbGUuXG4gKlxuICogQSBzdGFnZSB0aGF0IGV4aXN0cyBidXQgd2lsbCBub3QgcmVhZCBpcyBhIGZhaWx1cmUsIG5ldmVyIGEgbnVsbC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZFN0YWdlKFxuICBzdGFnZTogMSB8IDIgfCAzLFxuICBwYXRoOiBzdHJpbmcsXG4gIHByZXNlbnQ6IGJvb2xlYW4sXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nIHwgbnVsbD4+IHtcbiAgaWYgKCFwcmVzZW50KSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG51bGwgfTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJzaG93XCIsIGA6JHtzdGFnZX06JHtwYXRofWBdLCBvcHRpb25zKTtcbiAgaWYgKCFyZXN1bHQub2sgfHwgcmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICBjb25zdCBkZXRhaWwgPSBkZXNjcmliZUdpdEZhaWx1cmUocmVzdWx0KTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYFJlZnVzaW5nIHRvIHJlc29sdmUgYSBjb25mbGljdGVkIG1lcmdlOiBzdGFnZSAke3N0YWdlfSBvZiBgICtcbiAgICAgICAgICBgJyR7cGF0aH0nIGlzIHByZXNlbnQgYnV0IGNvdWxkIG5vdCBiZSByZWFkLCBzbyBvbmUgc2lkZSBvZiB0aGUgYCArXG4gICAgICAgICAgYGNvbmZsaWN0IGlzIHVua25vd24gKElzc3VlICMxNTU5KTogJHtkZXRhaWx9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHJlc3VsdC52YWx1ZS5zdGRvdXQgfTtcbn1cblxuLyoqIElzc3VlcyB0aGUgY29tbWl0cyB0b3VjaGluZyBgcGF0aGAgb24gb25lIHNpZGUgc2F5IHRoZXkgY2xvc2UuICovXG5hc3luYyBmdW5jdGlvbiByZWFkRml4UmVmZXJlbmNlcyhcbiAgbWVyZ2VCYXNlOiBzdHJpbmcsXG4gIHJlZjogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuICBpZiAoIW1lcmdlQmFzZSB8fCAhcmVmKSByZXR1cm4gW107XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wibG9nXCIsIFwiLS1mb3JtYXQ9JUJcIiwgYCR7bWVyZ2VCYXNlfS4uJHtyZWZ9YCwgXCItLVwiLCBwYXRoXSxcbiAgICBvcHRpb25zLFxuICApO1xuICByZXR1cm4gcmVzdWx0Lm9rICYmIHJlc3VsdC52YWx1ZS5jb2RlID09PSAwXG4gICAgPyBwYXJzZUZpeFJlZmVyZW5jZXMocmVzdWx0LnZhbHVlLnN0ZG91dClcbiAgICA6IFtdO1xufVxuXG4vKipcbiAqIFRoZSBjYXNlcyBlYWNoIHNpZGUgd3JvdGUgZm9yIHRoZSBpc3N1ZXMgaXRzIGNvbW1pdHMgY2l0ZS5cbiAqXG4gKiBTY29wZWQgdG8gdGhlIGNvbW1pdHMgdGhhdCBjaXRlIGFuIGlzc3VlLCBiZWNhdXNlIHRoYXQgaXMgdGhlIHF1ZXN0aW9uIHRoZVxuICogZHVwbGljYXRlLWZpeCBydWxlIGFza3M6IG9mIHRoZSB0d28gaW1wbGVtZW50YXRpb25zIG9mICp0aGlzKiBmaXgsIHdoaWNoXG4gKiBvbmUncyBjYXNlcyBjb3ZlciB0aGUgb3RoZXIncz8gUG9vbGluZyBldmVyeSBjYXNlIGVpdGhlciBicmFuY2ggYWRkZWQgc2luY2VcbiAqIHRoZSBtZXJnZSBiYXNlIGNvbXBhcmVzIHR3byBwb3B1bGF0aW9ucyBkb21pbmF0ZWQgYnkgdW5yZWxhdGVkIGNodXJuLlxuICpcbiAqIEV2aWRlbmNlIGdpdCByZWZ1c2VkIHRvIGdpdmUgdXAgaXMgcmVwb3J0ZWQgYGNvbXBsZXRlOiBmYWxzZWAsIG5ldmVyIGFzIGFuXG4gKiBlbXB0eSBzZXQg4oCUIGFuIHVucmVhZCBzdWl0ZSBtdXN0IG5vdCByZWFkIGFzIFwibmVpdGhlciBzaWRlIHdyb3RlIGEgY2FzZVwiLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZFRlc3RFdmlkZW5jZShcbiAgbWVyZ2VCYXNlOiBzdHJpbmcsXG4gIGRlZmF1bHRSZWY6IHN0cmluZyxcbiAgbWlsZXN0b25lUmVmOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuKTogUHJvbWlzZTxUZXN0RXZpZGVuY2U+IHtcbiAgaWYgKCFtZXJnZUJhc2UpIHJldHVybiB7IG91cnNBZGRlZDoge30sIHRoZWlyc0FkZGVkOiB7fSwgY29tcGxldGU6IGZhbHNlIH07XG5cbiAgbGV0IGNvbXBsZXRlID0gdHJ1ZTtcbiAgY29uc3QgYWRkZWRGb3IgPSBhc3luYyAoXG4gICAgcmVmOiBzdHJpbmcsXG4gICk6IFByb21pc2U8UmVjb3JkPG51bWJlciwgc3RyaW5nW10+PiA9PiB7XG4gICAgY29uc3QgYWRkZWQ6IFJlY29yZDxudW1iZXIsIHN0cmluZ1tdPiA9IHt9O1xuICAgIGlmICghcmVmKSB7XG4gICAgICBjb21wbGV0ZSA9IGZhbHNlO1xuICAgICAgcmV0dXJuIGFkZGVkO1xuICAgIH1cbiAgICAvLyBPbmUgbGluZSBwZXIgY29tbWl0OiBpdHMgaGFzaCwgdGhlbiB0aGUgaXNzdWVzIGl0IGNsYWltcyB0byBmaXguXG4gICAgY29uc3QgbG9nID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgIFtcImxvZ1wiLCBcIi0tZm9ybWF0PSVIJXgwMCVzJXgwMCViJXgwMVwiLCBgJHttZXJnZUJhc2V9Li4ke3JlZn1gXSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICBpZiAoIWxvZy5vayB8fCBsb2cudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgY29tcGxldGUgPSBmYWxzZTtcbiAgICAgIHJldHVybiBhZGRlZDtcbiAgICB9XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBsb2cudmFsdWUuc3Rkb3V0LnNwbGl0KFwiXFx1MDAwMVwiKSkge1xuICAgICAgY29uc3QgW3NoYSwgc3ViamVjdCA9IFwiXCIsIGJvZHkgPSBcIlwiXSA9IGVudHJ5LnNwbGl0KFwiXFx1MDAwMFwiKTtcbiAgICAgIGlmICghc2hhPy50cmltKCkpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgaXNzdWVzID0gW1xuICAgICAgICAuLi5uZXcgU2V0KFtcbiAgICAgICAgICAuLi5wYXJzZUZpeFJlZmVyZW5jZXMoYCR7c3ViamVjdH1cXG4ke2JvZHl9YCksXG4gICAgICAgICAgLi4ucGFyc2VTdGFtcGVkSXNzdWVzKHN1YmplY3QpLFxuICAgICAgICBdKSxcbiAgICAgIF07XG4gICAgICBpZiAoaXNzdWVzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IGNoYW5nZWQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgICBbXCJzaG93XCIsIFwiLS1uYW1lLW9ubHlcIiwgXCItLWZvcm1hdD1cIiwgc2hhLnRyaW0oKV0sXG4gICAgICAgIG9wdGlvbnMsXG4gICAgICApO1xuICAgICAgaWYgKCFjaGFuZ2VkLm9rIHx8IGNoYW5nZWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgICBjb21wbGV0ZSA9IGZhbHNlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGZvciAoXG4gICAgICAgIGNvbnN0IHBhdGggb2YgY2hhbmdlZC52YWx1ZS5zdGRvdXQuc3BsaXQoXCJcXG5cIikubWFwKChsKSA9PiBsLnRyaW0oKSlcbiAgICAgICkge1xuICAgICAgICBpZiAoIXBhdGggfHwgIWlzVGVzdFBhdGgocGF0aCkpIGNvbnRpbnVlO1xuICAgICAgICAvLyBDYXNlcyB0aGlzIGNvbW1pdCBhZGRlZDogd2hhdCB0aGUgZmlsZSBoYXMgYWZ0ZXIgaXQsIG1pbnVzIHdoYXQgaXRcbiAgICAgICAgLy8gaGFkIGF0IHRoZSBtZXJnZSBiYXNlLiBBIGZpbGUgYWJzZW50IGZyb20gdGhlIGJhc2UgaXMgbm90IGFcbiAgICAgICAgLy8gZmFpbHVyZSDigJQgZXZlcnkgY2FzZSBpbiBpdCBpcyBuZXcuXG4gICAgICAgIGNvbnN0IGJlZm9yZSA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICAgICAgW1wic2hvd1wiLCBgJHttZXJnZUJhc2V9OiR7cGF0aH1gXSxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICApO1xuICAgICAgICBjb25zdCBhZnRlciA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wic2hvd1wiLCBgJHtyZWZ9OiR7cGF0aH1gXSwgb3B0aW9ucyk7XG4gICAgICAgIGNvbnN0IGJhc2VOYW1lcyA9IGJlZm9yZS5vayAmJiBiZWZvcmUudmFsdWUuY29kZSA9PT0gMFxuICAgICAgICAgID8gZXh0cmFjdFRlc3ROYW1lcyhiZWZvcmUudmFsdWUuc3Rkb3V0KVxuICAgICAgICAgIDogW107XG4gICAgICAgIGNvbnN0IG5hbWVzID0gYWZ0ZXIub2sgJiYgYWZ0ZXIudmFsdWUuY29kZSA9PT0gMFxuICAgICAgICAgID8gZXh0cmFjdFRlc3ROYW1lcyhhZnRlci52YWx1ZS5zdGRvdXQpXG4gICAgICAgICAgOiBbXTtcbiAgICAgICAgY29uc3QgZnJlc2ggPSBuYW1lcy5maWx0ZXIoKG5hbWUpID0+ICFiYXNlTmFtZXMuaW5jbHVkZXMobmFtZSkpO1xuICAgICAgICBmb3IgKGNvbnN0IGlzc3VlIG9mIGlzc3Vlcykge1xuICAgICAgICAgIGFkZGVkW2lzc3VlXSA9IFsuLi4oYWRkZWRbaXNzdWVdID8/IFtdKSwgLi4uZnJlc2hdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBhZGRlZDtcbiAgfTtcblxuICBjb25zdCBvdXJzQWRkZWQgPSBhd2FpdCBhZGRlZEZvcihtaWxlc3RvbmVSZWYpO1xuICBjb25zdCB0aGVpcnNBZGRlZCA9IGF3YWl0IGFkZGVkRm9yKGRlZmF1bHRSZWYpO1xuICByZXR1cm4geyBvdXJzQWRkZWQsIHRoZWlyc0FkZGVkLCBjb21wbGV0ZSB9O1xufVxuXG4vKiogV2hpY2ggc2lkZSdzIGh1bmsgYSB1bmlvbiBtZXJnZSBlbWl0cyBmaXJzdC4gKi9cbmV4cG9ydCB0eXBlIFVuaW9uT3JkZXIgPVxuICAvKiogVGhlIG1pbGVzdG9uZSBicmFuY2gncyBodW5rIGZpcnN0IOKAlCB0aGUgdGVzdC1maWxlIHVuaW9uIG9mICMxNTU5LiAqL1xuICB8IFwibWlsZXN0b25lLWZpcnN0XCJcbiAgLyoqIFRoZSBkZWZhdWx0IGJyYW5jaCdzIGh1bmsgZmlyc3Qg4oCUIHRoZSBhcHBlbmQtb25seSBsZWRnZXIgcnVsZSBvZiAjMTc2OC4gKi9cbiAgfCBcImRlZmF1bHQtZmlyc3RcIjtcblxuLyoqXG4gKiBVbmlvbiB0aGUgdHdvIHNpZGVzJyAqKnRleHQqKiB3aXRoIGBnaXQgbWVyZ2UtZmlsZSAtLXVuaW9uYC5cbiAqXG4gKiBgZ2l0IG1lcmdlLWZpbGVgIHdvcmtzIG9uIGZpbGVzLCBub3QgaW5kZXggc3BlY3MsIHNvIHRoZSB0aHJlZSBzdGFnZXMgYXJlXG4gKiBtYXRlcmlhbGlzZWQgaW4gYSBzY3JhdGNoIGRpcmVjdG9yeSB0aGF0IGlzIHJlbW92ZWQgZWl0aGVyIHdheS4gYC0tdW5pb25gXG4gKiBrZWVwcyBib3RoIHNpZGVzIHdoaWNoZXZlciB3YXkgcm91bmQgdGhleSBhcmUgZ2l2ZW47IHdoaWNoIGZpbGUgY29tZXMgZmlyc3RcbiAqIGlzIG9ubHkgd2hhdCB0aGUgbWVyZ2VkIHRleHQgc2F5cyBmaXJzdC5cbiAqXG4gKiBAcmV0dXJucyB0aGUgbWVyZ2VkIHRleHQsIG9yIHRoZSByZWFzb24gaXQgY291bGQgbm90IGJlIHByb2R1Y2VkXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHRleHRVbmlvbk1lcmdlKFxuICBvdXJzOiBzdHJpbmcsXG4gIHRoZWlyczogc3RyaW5nLFxuICBiYXNlVGV4dDogc3RyaW5nLFxuICBvcmRlcjogVW5pb25PcmRlcixcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmcsIHN0cmluZz4+IHtcbiAgY29uc3Qgc2NyYXRjaCA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoeyBwcmVmaXg6IFwidmliZS11bmlvbi1cIiB9KTtcbiAgbGV0IG1lcmdlZDogeyBjb2RlOiBudW1iZXI7IHN0ZG91dDogc3RyaW5nOyBzdGRlcnI6IHN0cmluZyB9O1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtzY3JhdGNofS9vdXJzYCwgb3Vycyk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3NjcmF0Y2h9L2Jhc2VgLCBiYXNlVGV4dCk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3NjcmF0Y2h9L3RoZWlyc2AsIHRoZWlycyk7XG4gICAgY29uc3QgZmlyc3QgPSBvcmRlciA9PT0gXCJkZWZhdWx0LWZpcnN0XCIgPyBcInRoZWlyc1wiIDogXCJvdXJzXCI7XG4gICAgY29uc3QgbGFzdCA9IG9yZGVyID09PSBcImRlZmF1bHQtZmlyc3RcIiA/IFwib3Vyc1wiIDogXCJ0aGVpcnNcIjtcbiAgICBjb25zdCBsYWJlbCA9IChzaWRlOiBzdHJpbmcpID0+XG4gICAgICBzaWRlID09PSBcIm91cnNcIiA/IFwibWlsZXN0b25lIGJyYW5jaFwiIDogXCJkZWZhdWx0IGJyYW5jaFwiO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBbXG4gICAgICAgIFwibWVyZ2UtZmlsZVwiLFxuICAgICAgICBcIi1wXCIsXG4gICAgICAgIFwiLS11bmlvblwiLFxuICAgICAgICBcIi1MXCIsXG4gICAgICAgIGxhYmVsKGZpcnN0KSxcbiAgICAgICAgXCItTFwiLFxuICAgICAgICBcIm1lcmdlIGJhc2VcIixcbiAgICAgICAgXCItTFwiLFxuICAgICAgICBsYWJlbChsYXN0KSxcbiAgICAgICAgYCR7c2NyYXRjaH0vJHtmaXJzdH1gLFxuICAgICAgICBgJHtzY3JhdGNofS9iYXNlYCxcbiAgICAgICAgYCR7c2NyYXRjaH0vJHtsYXN0fWAsXG4gICAgICBdLFxuICAgICAgb3B0aW9ucyxcbiAgICApO1xuICAgIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBgYSB1bmlvbiBtZXJnZSBvZiB0aGlzIGZpbGUgZmFpbGVkOiAke3Jlc3VsdC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICB9O1xuICAgIH1cbiAgICBtZXJnZWQgPSByZXN1bHQudmFsdWU7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogYGEgdW5pb24gbWVyZ2Ugb2YgdGhpcyBmaWxlIGNvdWxkIG5vdCBiZSBwcmVwYXJlZDogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9YCxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHNjcmF0Y2gsIHsgcmVjdXJzaXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cblxuICAvLyBgZ2l0IG1lcmdlLWZpbGVgIGV4aXRzIHdpdGggdGhlIG51bWJlciBvZiByZW1haW5pbmcgY29uZmxpY3RzOyBhIHVuaW9uXG4gIC8vIG1lcmdlIGxlYXZlcyBub25lLCBzbyBhbnl0aGluZyBub24temVybyBtZWFucyBpdCBkaWQgbm90IGRvIHRoZSBqb2IuXG4gIGlmIChtZXJnZWQuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogYGEgdW5pb24gbWVyZ2Ugb2YgdGhpcyBmaWxlIGZhaWxlZDogJHtcbiAgICAgICAgbWVyZ2VkLnN0ZGVyci50cmltKCkgfHwgYGdpdCBtZXJnZS1maWxlIGV4aXRlZCAke21lcmdlZC5jb2RlfWBcbiAgICAgIH1gLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBtZXJnZWQuc3Rkb3V0IH07XG59XG5cbi8qKlxuICogTWVyZ2Ugb25lIGNvbmZsaWN0ZWQgZmlsZSBhcyBhICoqdW5pb24qKjogYm90aCBzaWRlcycgaHVua3Mga2VwdC5cbiAqXG4gKiBUaGlzIGlzIHRoZSByZXNvbHV0aW9uIGEgdGVzdC1maWxlIGNvbmZsaWN0IGdldHMgd2hlbiBuZWl0aGVyIHNpZGUgY29udGFpbnNcbiAqIHRoZSBvdGhlciwgYmVjYXVzZSB0YWtpbmcgYSBzaWRlIHdvdWxkIGRyb3AgY2FzZXMsIGFuZCB0aGUgcmVzb2x1dGlvbiBhblxuICogYXBwZW5kLW9ubHkgbGVkZ2VyIGdldHMgd2hlbiBib3RoIHNpZGVzIG9ubHkgYXBwZW5kZWQgKElzc3VlICMxNzY4KS4gVGhlXG4gKiByZXN1bHQgaXMgY2hlY2tlZCBiZWZvcmUgaXQgaXMgc3RhZ2VkIOKAlCBldmVyeSBjYXNlIG5hbWUgb24gZWl0aGVyIHNpZGUgbXVzdFxuICogc3Vydml2ZSBpdCwgYW5kIGEgYC5qc29uYCByZXN1bHQgbXVzdCBwYXJzZSDigJQgYW5kIHRoZSBtZXJnZWQgdHJlZSBzdGlsbCBoYXNcbiAqIHRvIHBhc3MgdGhlIHJlcG9zaXRvcnkncyBvd24gY2hlY2sgYW5kIHVuaXQgc3VpdGUgYWZ0ZXJ3YXJkcywgc28gYSB1bmlvbiB0aGF0XG4gKiBwcm9kdWNlcyBub25zZW5zZSBpcyByb2xsZWQgYmFjayByYXRoZXIgdGhhbiBwdXNoZWQuXG4gKlxuICogIyMgQSBgLmpzb25gIGxlZGdlciBpcyB1bmlvbmVkIGJ5IHZhbHVlIGZpcnN0IChJc3N1ZSAjMjAxMylcbiAqXG4gKiBUd28gYnJhbmNoZXMgdGhhdCBlYWNoIGFwcGVuZCBhIHNsaWNlIHRvIGBkb2NzL2F1ZGl0cy8qLmpzb25gIGNvbmZsaWN0XG4gKiAqaW5zaWRlKiB0aGUgYXBwZW5kZWQgb2JqZWN0LCBzbyBubyBhcnJhbmdlbWVudCBvZiB0aGUgdHdvIGh1bmtzJyB0ZXh0IGlzXG4gKiB2YWxpZCBKU09OOiB0aGUgdGV4dHVhbCB1bmlvbiBjb3VsZCBvbmx5IGV2ZXIgcHJvZHVjZSBhIGRvY3VtZW50IHRoZVxuICogd2VsbC1mb3JtZWRuZXNzIGNoZWNrIGJlbG93IGhhcyB0byByZWZ1c2UsIGFuZCB0aGlzIHJ1bmcgZXNjYWxhdGVkIHRoYXQgdG8gYVxuICogaHVtYW4uIFRoZSBQUi1tZXJnZSBydW5nIGxlYXJudCB0aGUgc2FtZSBsZXNzb24gaW4gIzE5NjgsIHNvIGEgYC5qc29uYCBwYXRoXG4gKiB3aXRoIGEgbWVyZ2UgYmFzZSBpcyB1bmlvbmVkICoqYnkgdmFsdWUqKiBmaXJzdCwgdGhyb3VnaFxuICogYGpzb25faW5zZXJ0aW9uX3VuaW9uLnRzYCDigJQgd2hpY2ggZG9lcyBpdHMgb3duIGluc2VydGlvbi1vbmx5IGNoZWNraW5nIGFuZFxuICogcmUtc2VyaWFsaXNlcyBpbiB0aGUgZmlsZSdzIG93biBmb3JtYXR0aW5nLiBBbnl0aGluZyBpdCByZWZ1c2VzIChhIGRlbGV0aW9uLFxuICogYSBjb25mbGljdGluZyBlZGl0LCBmb3JtYXR0aW5nIGl0IHdvdWxkIG5vdCByZXByb2R1Y2UpIGZhbGxzIGJhY2sgdG8gdGhlXG4gKiB0ZXh0dWFsIHVuaW9uIGV4YWN0bHkgYXMgYmVmb3JlLCBhbmQgaXRzIHJlYXNvbiBpcyBjYXJyaWVkIGludG8gdGhlIHJlZnVzYWxcbiAqIHNvIGEgaHVtYW4gcmVhZGluZyB0aGUgZXNjYWxhdGlvbiBpcyB0b2xkIHdoeSB0aGUgc3RydWN0dXJhbCBtZXJnZSBkZWNsaW5lZC5cbiAqXG4gKiBAcGFyYW0gb3JkZXIgLSBXaGljaCBzaWRlJ3MgaHVuayBjb21lcyBmaXJzdCBpbiB0aGUgbWVyZ2VkIHRleHRcbiAqIEByZXR1cm5zIG51bGwgd2hlbiB0aGUgdW5pb24gd2FzIHN0YWdlZDsgdGhlIHJlYXNvbiBpdCBjb3VsZCBub3QgYmUsIG90aGVyd2lzZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdW5pb25NZXJnZUNvbmZsaWN0ZWRGaWxlKFxuICBmaWxlOiBDb25mbGljdGVkRmlsZSxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4gIG9yZGVyOiBVbmlvbk9yZGVyID0gXCJtaWxlc3RvbmUtZmlyc3RcIixcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoZmlsZS5vdXJzID09PSBudWxsIHx8IGZpbGUudGhlaXJzID09PSBudWxsKSB7XG4gICAgcmV0dXJuIFwib25lIHNpZGUgaGFzIG5vIHZlcnNpb24gb2YgdGhlIGZpbGUsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gdW5pb25cIjtcbiAgfVxuICAvLyBTdGFnZSAxIGlzIHRoZSBtZXJnZSBiYXNlLiBJdCBpcyBhYnNlbnQgZm9yIGFuIGFkZC9hZGQgY29uZmxpY3QsIHdoaWNoIGlzXG4gIC8vIFwidGhlcmUgaXMgbm8gYmFzZVwiIHJhdGhlciB0aGFuIFwidGhlIGJhc2Ugd2FzIGVtcHR5XCIg4oCUIHRoZSBzdHJ1Y3R1cmFsIEpTT05cbiAgLy8gdW5pb24gbmVlZHMgYSByZWFsIG9uZSwgYW5kIHRoZSB0ZXh0dWFsIHVuaW9uIHRyZWF0cyBpdCBhcyBlbXB0eSB0ZXh0LlxuICBjb25zdCBiYXNlID0gYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJzaG93XCIsIGA6MToke2ZpbGUucGF0aH1gXSwgb3B0aW9ucyk7XG4gIGNvbnN0IGJhc2VUZXh0ID0gYmFzZS5vayAmJiBiYXNlLnZhbHVlLmNvZGUgPT09IDAgPyBiYXNlLnZhbHVlLnN0ZG91dCA6IG51bGw7XG5cbiAgLy8gYHVuaW9uSnNvbkluc2VydGlvbnNgIGVtaXRzIGl0cyBgdGhlaXJzYCBhcmd1bWVudCdzIGluc2VydGlvbnMgZmlyc3QsIGFuZFxuICAvLyBgZmlsZS50aGVpcnNgIGlzIHRoZSBkZWZhdWx0IGJyYW5jaCdzIHNpZGUg4oCUIHNvIHRoZSB0d28gYXJlIHBhc3NlZFxuICAvLyBzdHJhaWdodCB0aHJvdWdoIGZvciBcImRlZmF1bHQtZmlyc3RcIiBhbmQgc3dhcHBlZCBmb3IgXCJtaWxlc3RvbmUtZmlyc3RcIi5cbiAgY29uc3Qgc3RydWN0dXJlZCA9IGlzSnNvblBhdGgoZmlsZS5wYXRoKSAmJiBiYXNlVGV4dCAhPT0gbnVsbFxuICAgID8gdW5pb25Kc29uSW5zZXJ0aW9ucyhcbiAgICAgIGJhc2VUZXh0LFxuICAgICAgb3JkZXIgPT09IFwiZGVmYXVsdC1maXJzdFwiID8gZmlsZS5vdXJzIDogZmlsZS50aGVpcnMsXG4gICAgICBvcmRlciA9PT0gXCJkZWZhdWx0LWZpcnN0XCIgPyBmaWxlLnRoZWlycyA6IGZpbGUub3VycyxcbiAgICApXG4gICAgOiBudWxsO1xuXG4gIGxldCBtZXJnZWRUZXh0OiBzdHJpbmc7XG4gIGlmIChzdHJ1Y3R1cmVkPy5vaykge1xuICAgIG1lcmdlZFRleHQgPSBzdHJ1Y3R1cmVkLnZhbHVlO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCB0ZXh0VW5pb25NZXJnZShcbiAgICAgIGZpbGUub3VycyxcbiAgICAgIGZpbGUudGhlaXJzLFxuICAgICAgYmFzZVRleHQgPz8gXCJcIixcbiAgICAgIG9yZGVyLFxuICAgICAgb3B0aW9ucyxcbiAgICApO1xuICAgIGlmICghdGV4dC5vaykgcmV0dXJuIHRleHQuZXJyb3I7XG4gICAgbWVyZ2VkVGV4dCA9IHRleHQudmFsdWU7XG4gICAgLy8gQSB0ZXh0dWFsIHVuaW9uIG9mIHR3byBlZGl0cyB0byB0aGUgc2FtZSBgdXNlYCBsaW5lIGtlZXBzIGJvdGgsIHdoaWNoXG4gICAgLy8gcnVzdGMgcmVqZWN0cyBhcyBFMDI1MiAoSXNzdWUgIzMwMDcpIOKAlCBmb2xkIHRoZSBkdXBsaWNhdGUgYmFjayBpbnRvIG9uZS5cbiAgICBpZiAoZmlsZS5wYXRoLmVuZHNXaXRoKFwiLnJzXCIpKSB7XG4gICAgICBtZXJnZWRUZXh0ID0gbWVyZ2VEdXBsaWNhdGVSdXN0VXNlcyhtZXJnZWRUZXh0KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCB3YW50ZWQgPSBbXG4gICAgLi4ubmV3IFNldChbXG4gICAgICAuLi5leHRyYWN0VGVzdE5hbWVzKGZpbGUub3VycyksXG4gICAgICAuLi5leHRyYWN0VGVzdE5hbWVzKGZpbGUudGhlaXJzKSxcbiAgICBdKSxcbiAgXTtcbiAgY29uc3Qga2VwdCA9IG5ldyBTZXQoZXh0cmFjdFRlc3ROYW1lcyhtZXJnZWRUZXh0KSk7XG4gIGNvbnN0IGxvc3QgPSB3YW50ZWQuZmlsdGVyKChuYW1lKSA9PiAha2VwdC5oYXMobmFtZSkpO1xuICBpZiAobG9zdC5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIGBhIHVuaW9uIG1lcmdlIG9mIHRoaXMgZmlsZSB3b3VsZCBsb3NlICR7bG9zdC5sZW5ndGh9IGNhc2Uocyk6ICR7XG4gICAgICBsb3N0LmpvaW4oXCIsIFwiKVxuICAgIH1gO1xuICB9XG5cbiAgLy8gQSBKU09OIGxlZGdlciB3aG9zZSB1bmlvbiBkb2VzIG5vdCBwYXJzZSBpcyBub3QgYSByZXNvbHV0aW9uIChJc3N1ZVxuICAvLyAjMTc2OCk6IHR3byBlbnRyaWVzIGFwcGVuZGVkIGludG8gdGhlIHNhbWUgYXJyYXkgbGVhdmUgdGhlIGRvY3VtZW50XG4gIC8vIGludmFsaWQsIGFuZCBhbiBpbnZhbGlkIGRvY3VtZW50IG11c3QgbmV2ZXIgYmUgd3JpdHRlbiBvciBzdGFnZWQuIFRoZVxuICAvLyBzdHJ1Y3R1cmFsIHVuaW9uIGFib3ZlIGNhbm5vdCBwcm9kdWNlIG9uZSwgc28gcmVhY2hpbmcgaGVyZSB3aXRoIGEgYC5qc29uYFxuICAvLyBwYXRoIG1lYW5zIGl0IGRlY2xpbmVkIOKAlCBhbmQgaXRzIHJlYXNvbiBpcyB0aGUgb25lIHdvcnRoIHJlcG9ydGluZy5cbiAgaWYgKCF1bmlvbklzV2VsbEZvcm1lZChmaWxlLnBhdGgsIG1lcmdlZFRleHQpKSB7XG4gICAgY29uc3Qgd2h5ID0gc3RydWN0dXJlZCAmJiAhc3RydWN0dXJlZC5va1xuICAgICAgPyBgIChpdCB3YXMgbm90IHVuaW9uZWQgYXMgSlNPTiBmaXJzdDogJHtzdHJ1Y3R1cmVkLmVycm9yfSlgXG4gICAgICA6IFwiXCI7XG4gICAgcmV0dXJuIFwidGhlIHVuaW9uIG9mIGJvdGggc2lkZXMgZG9lcyBub3QgcGFyc2UgYXMgSlNPTiwgc28gaXQgd2FzIG5vdCBcIiArXG4gICAgICBgd3JpdHRlbiR7d2h5fWA7XG4gIH1cblxuICBjb25zdCBjd2QgPSBvcHRpb25zLmN3ZCA/PyBcIi5cIjtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y3dkfS8ke2ZpbGUucGF0aH1gLCBtZXJnZWRUZXh0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIGB0aGUgdW5pb24gb2YgYm90aCBzaWRlcyBjb3VsZCBub3QgYmUgd3JpdHRlbjogJHtcbiAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgIH1gO1xuICB9XG4gIGNvbnN0IGFkZGVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChidWlsZEFkZFBhdGhBcmdzKGZpbGUucGF0aCksIG9wdGlvbnMpO1xuICBpZiAoIWFkZGVkLm9rIHx8IGFkZGVkLnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4gYHRoZSB1bmlvbiBvZiBib3RoIHNpZGVzIGNvdWxkIG5vdCBiZSBzdGFnZWQ6ICR7XG4gICAgICBkZXNjcmliZUdpdEZhaWx1cmUoYWRkZWQpXG4gICAgfWA7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBCdWlsZCB0aGUgcmVmdXNhbCBmb3IgYSBjb25mbGljdGVkIHBhdGggd2hvc2UgY2hvc2VuIHNpZGUgd291bGQgbm90IHRha2UuICovXG5mdW5jdGlvbiB0YWtlU2lkZUVycm9yKFxuICB3aGF0OiBzdHJpbmcsXG4gIGZpbGU6IHN0cmluZyxcbiAgc2lkZTogQ29uZmxpY3RTaWRlLFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nLFxuICBkZXRhaWw6IHN0cmluZyxcbik6IEVycm9yIHtcbiAgY29uc3Qgd2hvc2UgPSBzaWRlID09PSBcInRoZWlyc1wiID8gZGVmYXVsdEJyYW5jaCA6IG1pbGVzdG9uZUJyYW5jaDtcbiAgcmV0dXJuIG5ldyBFcnJvcihcbiAgICBgRmFpbGVkIHRvICR7d2hhdH0gJyR7d2hvc2V9J3MgdmVyc2lvbiBvZiAnJHtmaWxlfScgd2hpbGUgbWVyZ2luZyBgICtcbiAgICAgIGAnJHtkZWZhdWx0QnJhbmNofScgaW50byAnJHttaWxlc3RvbmVCcmFuY2h9JyDigJQgcmVmdXNpbmcgdG8gY29tbWl0IGEgYCArXG4gICAgICBgcmVzb2x1dGlvbiB0aGF0IHdvdWxkIGtlZXAgdGhlIG90aGVyIHNpZGUgaW5zdGVhZCBgICtcbiAgICAgIGAoSXNzdWVzICMxMDQ4LCAjMTU1OSk6ICR7ZGV0YWlsLnRyaW0oKX1gLFxuICApO1xufVxuXG4vKipcbiAqIFN0YWdlIHRoZSBzaWRlIHRoZSB0cmlhZ2UgY2hvc2UgZm9yIGV2ZXJ5IGNvbmZsaWN0ZWQgcGF0aC5cbiAqXG4gKiBcIlRha2luZyBhIHNpZGVcIiBpcyBub3QgdGhlIHNhbWUgYXMgXCJrZWVwaW5nIHRoZSBmaWxlXCI6IHdoZXJlIHRoZSBjaG9zZW4gc2lkZVxuICogaGFzIG5vIHZlcnNpb24sIHRha2luZyBpdCBtZWFucyBkZWxldGluZyB0aGUgZmlsZSDigJQgdGhlIG1vZGlmeS9kZWxldGUgcnVsZVxuICogb2YgSXNzdWUgIzEwNDgsIHdoaWNoIGlzIGhvdyBgbGliL2ZsZWV0X2hlYWx0aC50c2AgY2FtZSBiYWNrIG9uXG4gKiBgbWlsZXN0b25lLzg2M2AgYmVmb3JlIGl0IGV4aXN0ZWQuIFRoYXQgcnVsZSBsaXZlcyBpblxuICogYG1lcmdlX2NvbmZsaWN0X3N0YWdlcy50c2AgYW5kIGlzIHJlYWQgZnJvbSB0aGVyZSByYXRoZXIgdGhhbiByZXN0YXRlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFwcGx5Q29uZmxpY3RQbGFuKFxuICBwbGFuOiBDb25mbGljdFBsYW4sXG4gIHNpZGVzOiBDb25mbGljdGVkRmlsZVtdLFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IGRlY2lkZWQgPSBuZXcgTWFwKHBsYW4ucmVzb2x2ZWQubWFwKChkKSA9PiBbZC5wYXRoLCBkXSkpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2Ygc2lkZXMpIHtcbiAgICBjb25zdCBhY3Rpb24gPSBkZWNpZGVkLmdldChmaWxlLnBhdGgpPy5hY3Rpb247XG4gICAgaWYgKGFjdGlvbiAhPT0gXCJvdXJzXCIgJiYgYWN0aW9uICE9PSBcInRoZWlyc1wiKSBjb250aW51ZTtcbiAgICBjb25zdCBzaWRlOiBDb25mbGljdFNpZGUgPSBhY3Rpb247XG5cbiAgICBjb25zdCBzdGFnZWQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1wibHMtZmlsZXNcIiwgXCItdVwiLCBcIi0tXCIsIGZpbGUucGF0aF0sXG4gICAgICBvcHRpb25zLFxuICAgICk7XG4gICAgY29uc3Qgc3RhZ2VzID0gc3RhZ2VkLm9rICYmIHN0YWdlZC52YWx1ZS5jb2RlID09PSAwXG4gICAgICA/IHBhcnNlVW5tZXJnZWRTdGFnZXMoc3RhZ2VkLnZhbHVlLnN0ZG91dClcbiAgICAgIDogeyBiYXNlOiBmYWxzZSwgb3VyczogZmFsc2UsIHRoZWlyczogZmFsc2UgfTtcbiAgICBpZiAoIWhhc0FueVN0YWdlKHN0YWdlcykpIHtcbiAgICAgIC8vIEV2ZXJ5IGNvbmZsaWN0ZWQgcGF0aCBoYXMgc3RhZ2VzLiBOb25lIG1lYW5zIGdpdCBjb3VsZCBub3QgYmUgcmVhZCxcbiAgICAgIC8vIGFuZCBndWVzc2luZyBoZXJlIGlzIHByZWNpc2VseSB0aGUgc2lsZW50IHdyb25nIGFuc3dlciAoSXNzdWUgIzEwNDgpLlxuICAgICAgY29uc3QgZGV0YWlsID0gZGVzY3JpYmVHaXRGYWlsdXJlKHN0YWdlZCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYFJlZnVzaW5nIHRvIHJlc29sdmUgdGhlIG1lcmdlIG9mICcke2RlZmF1bHRCcmFuY2h9JyBpbnRvIGAgK1xuICAgICAgICAgICAgYCcke21pbGVzdG9uZUJyYW5jaH0nOiB0aGUgbWVyZ2Ugc3RhZ2VzIG9mIGNvbmZsaWN0ZWQgZmlsZSBgICtcbiAgICAgICAgICAgIGAnJHtmaWxlLnBhdGh9JyBjb3VsZCBub3QgYmUgcmVhZCAoSXNzdWUgIzEwNDgpOiAke2RldGFpbH1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBUaGUgY2hvc2VuIHNpZGUgaGFzIG5vIHZlcnNpb24gb2YgdGhlIGZpbGU6IHRha2luZyB0aGF0IHNpZGUgZGVsZXRlcyBpdC5cbiAgICBjb25zdCBkZWxldGVzID0gc2lkZSA9PT0gXCJ0aGVpcnNcIlxuICAgICAgPyByZXNvbHZlVG93YXJkc0luY29taW5nKHN0YWdlcykgPT09IFwiZGVsZXRlXCJcbiAgICAgIDogIXN0YWdlcy5vdXJzO1xuICAgIGlmIChkZWxldGVzKSB7XG4gICAgICBjb25zdCByZW1vdmVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgICAgYnVpbGRSZW1vdmVQYXRoQXJncyhmaWxlLnBhdGgpLFxuICAgICAgICBvcHRpb25zLFxuICAgICAgKTtcbiAgICAgIGlmICghcmVtb3ZlZC5vayB8fCByZW1vdmVkLnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IHRha2VTaWRlRXJyb3IoXG4gICAgICAgICAgICBcImRlbGV0ZVwiLFxuICAgICAgICAgICAgZmlsZS5wYXRoLFxuICAgICAgICAgICAgc2lkZSxcbiAgICAgICAgICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgICAgICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICAgICAgICByZW1vdmVkLm9rID8gcmVtb3ZlZC52YWx1ZS5zdGRlcnIgOiByZW1vdmVkLmVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIEJvdGggZXhpdCBjb2RlcyBtYXR0ZXIgKElzc3VlICMxMDQ4KTogYSBgY2hlY2tvdXQgLS08c2lkZT5gIHRoYXQgZmFpbGVkXG4gICAgLy8gbGVhdmVzIHRoZSBvdGhlciBzaWRlJ3Mgd29ya2luZy10cmVlIGNvcHkgaW4gcGxhY2UsIGFuZCB0aGUgYGFkZGAgYmVsb3dcbiAgICAvLyB3b3VsZCBzdGFnZSBleGFjdGx5IHRoZSBzaWRlIHRoZSB0cmlhZ2UgcmVqZWN0ZWQuXG4gICAgY29uc3QgY2hlY2tlZE91dCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBidWlsZENoZWNrb3V0U3RyYXRlZ3lBcmdzKHNpZGUsIGZpbGUucGF0aCksXG4gICAgICBvcHRpb25zLFxuICAgICk7XG4gICAgaWYgKCFjaGVja2VkT3V0Lm9rIHx8IGNoZWNrZWRPdXQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogdGFrZVNpZGVFcnJvcihcbiAgICAgICAgICBcImNoZWNrIG91dFwiLFxuICAgICAgICAgIGZpbGUucGF0aCxcbiAgICAgICAgICBzaWRlLFxuICAgICAgICAgIGRlZmF1bHRCcmFuY2gsXG4gICAgICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICAgIGNoZWNrZWRPdXQub2sgPyBjaGVja2VkT3V0LnZhbHVlLnN0ZGVyciA6IGNoZWNrZWRPdXQuZXJyb3IubWVzc2FnZSxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IGFkZGVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChidWlsZEFkZFBhdGhBcmdzKGZpbGUucGF0aCksIG9wdGlvbnMpO1xuICAgIGlmICghYWRkZWQub2sgfHwgYWRkZWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogdGFrZVNpZGVFcnJvcihcbiAgICAgICAgICBcInN0YWdlXCIsXG4gICAgICAgICAgZmlsZS5wYXRoLFxuICAgICAgICAgIHNpZGUsXG4gICAgICAgICAgZGVmYXVsdEJyYW5jaCxcbiAgICAgICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICAgICAgYWRkZWQub2sgPyBhZGRlZC52YWx1ZS5zdGRlcnIgOiBhZGRlZC5lcnJvci5tZXNzYWdlLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FHRCxTQUFTLGFBQWEsUUFBUSxtQkFBbUI7QUFFakQsU0FDRSxVQUFVLEVBQ1YsaUJBQWlCLFFBQ1osbUNBQW1DO0FBQzFDLFNBQVMsbUJBQW1CLFFBQVEsNEJBQTRCO0FBQ2hFLFNBQVMsc0JBQXNCLFFBQVEsc0JBQXNCO0FBQzdELFNBQ0UsZ0JBQWdCLEVBQ2hCLHlCQUF5QixFQUN6QixtQkFBbUIsUUFDZCx5QkFBeUI7QUFDaEMsU0FDRSxXQUFXLEVBQ1gsbUJBQW1CLEVBQ25CLHNCQUFzQixRQUNqQiw2QkFBNkI7QUFDcEMsU0FBUyxrQkFBa0IsUUFBUSw2QkFBNkI7QUFDaEUsU0FJRSxnQkFBZ0IsRUFDaEIsVUFBVSxFQUNWLGtCQUFrQixFQUNsQixrQkFBa0IsUUFFYixpQ0FBaUM7QUFFeEMsMkVBQTJFLEdBQzNFLE9BQU8sZUFBZSxjQUNwQixZQUFvQixFQUNwQixhQUFxQixFQUNyQixPQUEwQjtFQUUxQixNQUFNLFNBQVMsTUFBTSxjQUNuQjtJQUFDO0lBQWM7SUFBYztHQUFjLEVBQzNDO0VBRUYsT0FBTyxPQUFPLEVBQUUsSUFBSSxPQUFPLEtBQUssQ0FBQyxJQUFJLEtBQUssSUFBSSxPQUFPLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLO0FBQzdFO0FBRUE7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBQ0QsT0FBTyxlQUFlLG9CQUNwQixlQUF5QixFQUN6QixTQUFpQixFQUNqQixh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
// denoCacheMetadata=14075799094449840677,8285210771702611256