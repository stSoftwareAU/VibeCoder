/**
 * Sweep-ledger `sweptAt` ancestry check for the pre-push gate (Issue #3689).
 *
 * CI's "Sweep ledger sweptAt ancestry" step rejects a slice whose `sweptAt`
 * is a branch commit rather than a default-branch commit (squash-merge later
 * deletes it). An agent that records its own HEAD only learns this after the
 * push, so the pre-push hook runs the same check first — but only when the
 * push touches the ledger file or a top-up file, and only for the slices those
 * files contribute.
 *
 * Fails closed: an unresolvable default ref, a history that cannot be
 * deepened, or any unexpected git failure blocks the push.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { ensureHistoryDepth, isShallowRepo } from "./git_history.ts";
import type { GitRunner } from "./git_history.ts";
import {
  LIB_SWEEP_LEDGER_PATH,
  LIB_SWEEP_TOP_UP_DIR,
  parseCoverageLedger,
  patchLedgerSlice,
  readCoverageLedger,
  type SweepGitRunner,
  SweepLedgerError,
  type SweepSlice,
  sweepSliceFile,
  verifySweptAtsOnDefaultBranch,
} from "./lib_sweep_coverage.ts";
import { atomicWrite } from "./file_utils.ts";
import { confinePath } from "./mutation_runner.ts";

/** Runs `git <args>` in `cwd` (structurally the pre-push gate's git seam). */
type Git = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const TOP_UP_PATH = new RegExp(
  `^${LIB_SWEEP_TOP_UP_DIR.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/` +
    `(top-up-[^/]+)\\.json$`,
);

/** True when any pushed file is the ledger or one of its top-up files. */
export function touchesSweepLedger(changed: readonly string[]): boolean {
  return changed.some((p) =>
    p === LIB_SWEEP_LEDGER_PATH || TOP_UP_PATH.test(p)
  );
}

/**
 * Outcome of {@link checkSweptAtAncestry}. `infrastructure` marks a failure to
 * read or deepen git history (PR #3716 review): the check could not run, which
 * is no verdict on the branch's ledger, so a caller can tell it from a
 * `sweptAt` that is genuinely not on the default branch.
 */
export type SweepCheckResult =
  | { ok: true; value: void }
  | { ok: false; error: string; infrastructure?: true };

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Rewrite any checked `sweptAt` that is not on `origin/main` to
 * `git merge-base origin/main HEAD`, then commit that fix-up.
 * A failed merge-base is returned as an error and the branch commit is left
 * in place; the ancestry check still runs only after a successful repoint
 * (Issue #4235). The ancestry check itself is unchanged.
 */
async function repointOffMainSweptAts(opts: {
  cwd: string;
  slices: readonly SweepSlice[];
  git: Git;
}): Promise<
  | { ok: true; slices: SweepSlice[] }
  | { ok: false; error: string }
> {
  const off: SweepSlice[] = [];
  for (const slice of opts.slices) {
    const ancestry = await opts.git(
      ["merge-base", "--is-ancestor", slice.sweptAt, "origin/main"],
      opts.cwd,
    );
    if (ancestry.code === 0) continue;
    if (ancestry.code !== 1 && ancestry.code !== 128) {
      return {
        ok: false,
        error:
          `could not check whether sweptAt ${slice.sweptAt} is on origin/main: ${
            ancestry.stderr.trim() ||
            `git merge-base --is-ancestor exit ${ancestry.code}`
          }`,
      };
    }
    off.push(slice);
  }
  if (off.length === 0) return { ok: true, slices: [...opts.slices] };

  const base = await opts.git(
    ["merge-base", "origin/main", "HEAD"],
    opts.cwd,
  );
  const mergeBase = base.stdout.trim();
  if (base.code !== 0 || !COMMIT_SHA.test(mergeBase)) {
    return {
      ok: false,
      error: `git merge-base origin/main HEAD failed: ${
        base.stderr.trim() || mergeBase || `exit ${base.code}`
      }`,
    };
  }

  const byFile = new Map<string, SweepSlice[]>();
  for (const slice of off) {
    const relative = await sweepSliceFile(opts.cwd, slice.chunk);
    const group = byFile.get(relative) ?? [];
    group.push(slice);
    byFile.set(relative, group);
  }
  for (const [relative, group] of byFile) {
    const target = await confinePath(opts.cwd, relative, {
      realPath: Deno.realPath,
    });
    if (target === null) {
      return {
        ok: false,
        error: `sweep ledger path escapes the repository: ${relative}`,
      };
    }
    let text = await Deno.readTextFile(target);
    for (const slice of group) {
      text = patchLedgerSlice(text, slice.chunk, { sweptAt: mergeBase });
    }
    const written = await atomicWrite({ targetFile: target, content: text });
    if (!written.ok) {
      return { ok: false, error: written.error.message };
    }
  }
  const paths = [...byFile.keys()];
  const added = await opts.git(["add", "--", ...paths], opts.cwd);
  if (added.code !== 0) {
    return {
      ok: false,
      error: `could not stage the repointed sweep ledger: ${
        added.stderr.trim() || `git add exit ${added.code}`
      }`,
    };
  }
  const committed = await opts.git(
    [
      "-c",
      "user.email=vibe-coder@localhost",
      "-c",
      "user.name=Vibe Coder",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Repoint sweep ledger sweptAt to the origin/main merge-base\n\n" +
      `The recorded commit was not on origin/main. sweptAt is now ${mergeBase}.`,
      "--",
      ...paths,
    ],
    opts.cwd,
  );
  if (committed.code !== 0) {
    return {
      ok: false,
      error: `could not commit the repointed sweep ledger: ${
        committed.stderr.trim() || committed.stdout.trim() ||
        `git commit exit ${committed.code}`
      }`,
    };
  }
  console.log(
    `repointed sweep ledger sweptAt for ${
      off.map((slice) => slice.chunk).join(", ")
    } to ${mergeBase}`,
  );
  const replaced = new Map(off.map((slice) => [slice.chunk, mergeBase]));
  return {
    ok: true,
    slices: opts.slices.map((slice) => {
      const sweptAt = replaced.get(slice.chunk);
      return sweptAt === undefined ? slice : { ...slice, sweptAt };
    }),
  };
}

/**
 * Verify the `sweptAt` of the slices contributed by the changed ledger files.
 * Makes no git call at all when no ledger file changed. Off-main values are
 * repointed to the origin/main merge-base before the ancestry check.
 */
export async function checkSweptAtAncestry(opts: {
  cwd: string;
  changed: readonly string[];
  git: Git;
  defaultRef?: string;
}): Promise<SweepCheckResult> {
  if (!touchesSweepLedger(opts.changed)) return { ok: true, value: undefined };
  const { cwd, git } = opts;
  const runGit: SweepGitRunner = (args) => git([...args], cwd);

  let defaultRef = opts.defaultRef?.trim() ?? "";
  if (defaultRef === "") {
    const head = await git(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd,
    );
    defaultRef = head.stdout.trim();
    if (head.code !== 0 || defaultRef === "") {
      return {
        ok: false,
        error: "sweep ledger changed but the default branch cannot be " +
          `resolved (git symbolic-ref refs/remotes/origin/HEAD: ${
            head.stderr.trim() || `exit ${head.code}`
          }) — run \`git remote set-head origin --auto\` and push again`,
      };
    }
  }

  let ledger;
  let inFileChunks: Set<string>;
  try {
    ledger = await readCoverageLedger(cwd);
    // The ledger file's own slices, parsed without the top-up directory: by
    // source file, not by chunk name, since the ledger file also holds
    // `top-up-<n>` slices of its own (up to LEDGER_FILE_LAST_TOP_UP_ISSUE).
    inFileChunks = new Set(
      parseCoverageLedger(
        await Deno.readTextFile(`${cwd}/${LIB_SWEEP_LEDGER_PATH}`),
      ).slices.map((slice) => slice.chunk),
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof SweepLedgerError
        ? error.message
        : `could not read the sweep ledger: ${
          error instanceof Error ? error.message : String(error)
        }`,
    };
  }

  // Only the slices the changed files contribute: a changed top-up file is
  // the slice with its name as chunk; a changed ledger file contributes every
  // slice it holds itself.
  const changedTopUps = new Set<string>();
  for (const p of opts.changed) {
    const m = TOP_UP_PATH.exec(p);
    if (m) changedTopUps.add(m[1]!);
  }
  const ledgerChanged = opts.changed.includes(LIB_SWEEP_LEDGER_PATH);
  const slices = ledger.slices.filter((slice) =>
    changedTopUps.has(slice.chunk) ||
    (ledgerChanged && inFileChunks.has(slice.chunk))
  );
  const filtered = { ...ledger, slices };

  const gitRunner: GitRunner = async (args, options) => ({
    ok: true,
    value: await git(args, options?.cwd ?? cwd),
  });
  const shallow = await isShallowRepo({ cwd, gitRunner });
  if (!shallow.ok) {
    return {
      ok: false,
      infrastructure: true,
      error:
        `could not check whether the clone is shallow: ${shallow.error.message}`,
    };
  }
  if (shallow.value) {
    const deepened = await ensureHistoryDepth(["HEAD", defaultRef], {
      cwd,
      gitRunner,
    });
    if (!deepened.ok) {
      return {
        ok: false,
        infrastructure: true,
        error:
          `could not deepen history to check sweptAt ancestry: ${deepened.error.message}`,
      };
    }
    // HEAD and the default branch may already meet while an older sweptAt
    // is still beyond the shallow boundary, so fetch the rest if one is.
    for (const slice of slices) {
      const have = await git(
        ["cat-file", "-e", `${slice.sweptAt}^{commit}`],
        cwd,
      );
      if (have.code === 0) continue;
      const full = await git(["fetch", "--unshallow", "origin"], cwd);
      if (full.code !== 0) {
        return {
          ok: false,
          infrastructure: true,
          error: "could not deepen history to check sweptAt ancestry: " +
            (full.stderr.trim() || `git fetch --unshallow exit ${full.code}`),
        };
      }
      break;
    }
  }

  const repaired = await repointOffMainSweptAts({ cwd, slices, git });
  if (!repaired.ok) return repaired;
  const checked = { ...filtered, slices: repaired.slices };

  try {
    await verifySweptAtsOnDefaultBranch(checked, defaultRef, runGit);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, value: undefined };
}
