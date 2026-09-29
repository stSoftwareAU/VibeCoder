/**
 * Repairing a broken loose ref in a shared clone (Issue #2880).
 *
 * A shared clone can end up carrying a loose ref file — under
 * `refs/heads/` or `refs/remotes/<remote>/` — whose contents name an
 * object the object store no longer has. Verified against git 2.47: any
 * such ref makes `git fetch origin <base>` fail outright
 * (`fatal: bad object refs/<x>`), and a broken `refs/remotes/origin/<base>`
 * makes `git checkout -B … origin/<base>` fail too
 * (`warning: ignoring broken ref refs/remotes/origin/<base>` followed by
 * `fatal: 'origin/<base>' is not a commit`).
 *
 * Every ref is recoverable from the remote, so the repair is safe and
 * self-healing: delete the broken loose ref with `git update-ref -d`, then
 * retry the fetch/checkout that failed — the fetch recreates the ref at the
 * remote's own tip.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { assertSafeGitRef } from "./git_ref_args.ts";
import {
  type GitCommandOptions,
  type GitCommandOutput,
  runGitCommand,
} from "./git_timeout.ts";

/** Patterns git uses to name the broken ref in its own stderr. */
const BROKEN_REF_PATTERNS: readonly RegExp[] = [
  /bad object (refs\/\S+)/g,
  /ignoring broken ref (refs\/\S+)/g,
  /missing object [0-9a-f]+ for (refs\/\S+)/g,
  /bad ref (refs\/\S+)/g,
];

/** Trailing punctuation git's wording tacks onto a ref name. */
const TRAILING_PUNCTUATION = /[;,.'")\]]+$/;

/** Only these ref namespaces are ever repaired — never tags, notes, stash. */
function isRepairableNamespace(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/");
}

/**
 * Extract the ref names git's stderr blames for "bad object" / "broken
 * ref" / "missing object" failures.
 *
 * Deliberately narrow to `refs/heads/` and `refs/remotes/` — the only
 * namespaces {@link removeBrokenRef} will ever touch — and to names that
 * pass {@link assertSafeGitRef}, so a hostile or malformed string embedded
 * in git's own output can never reach `git update-ref -d` as a positional.
 *
 * @param text - git stderr (or any text) to scan
 * @returns Ref names in first-seen order, de-duplicated
 */
export function brokenRefsIn(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of BROKEN_REF_PATTERNS) {
    // Patterns are shared `g`-flagged RegExp objects; reset lastIndex so a
    // previous exec on other text cannot skip matches here.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const ref = raw.replace(TRAILING_PUNCTUATION, "");
      if (!isRepairableNamespace(ref)) continue;
      try {
        assertSafeGitRef(ref, "broken ref repair");
      } catch {
        continue;
      }
      if (seen.has(ref)) continue;
      seen.add(ref);
      found.push(ref);
    }
  }
  return found;
}

/**
 * Delete a broken loose ref so the next fetch recreates it from the remote
 * (Issue #2880).
 *
 * `git update-ref -d` alone is normally enough — it removes a loose ref
 * file even when the object it names is missing. If that still fails (the
 * ref might be write-locked, or update-ref itself refuses a ref it cannot
 * even parse), fall back to resolving the ref's on-disk path with
 * `git rev-parse --git-path` and removing the loose file directly, then
 * retrying `update-ref -d` so any in-memory ref cache git holds is also
 * cleared.
 *
 * @param ref - The broken ref, validated against the same allowlist as
 *   {@link brokenRefsIn} before it ever reaches git.
 * @param options - Git command options (cwd, etc.)
 * @param runGit - Injectable seam for running git. Defaults to
 *   {@link runGitCommand}.
 * @returns `ok: true` once the ref is gone; `ok: false` naming the ref and
 *   git's own stderr when it could not be removed.
 */
export async function removeBrokenRef(
  ref: string,
  options: GitCommandOptions,
  runGit: typeof runGitCommand = runGitCommand,
): Promise<Result<void>> {
  if (!isRepairableNamespace(ref)) {
    return {
      ok: false,
      error: new Error(
        `Refusing to remove '${ref}': only refs/heads/ and refs/remotes/ ` +
          `are ever repaired (Issue #2880)`,
      ),
    };
  }
  try {
    assertSafeGitRef(ref, "broken ref repair");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  const deleteArgs = ["update-ref", "-d", "--end-of-options", ref];
  const first = await runGit(deleteArgs, options);
  if (first.ok && first.value.code === 0) {
    return { ok: true, value: undefined };
  }

  // Fall back to removing the loose ref file directly, then retry.
  const pathArgs = ["rev-parse", "--git-path", ref];
  const pathResult = await runGit(pathArgs, options);
  if (!pathResult.ok || pathResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Could not remove broken ref '${ref}': ${describe(deleteArgs, first)}`,
      ),
    };
  }
  const relativePath = pathResult.value.stdout.trim();
  const cwd = options.cwd ?? Deno.cwd();
  const looseRefPath = relativePath.startsWith("/")
    ? relativePath
    : `${cwd}/${relativePath}`;
  try {
    await Deno.remove(looseRefPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: new Error(
          `Could not remove broken ref '${ref}': ${
            describe(deleteArgs, first)
          }; and could not delete loose ref file ${looseRefPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
  }

  const retry = await runGit(deleteArgs, options);
  if (retry.ok && retry.value.code === 0) {
    return { ok: true, value: undefined };
  }
  return {
    ok: false,
    error: new Error(
      `Could not remove broken ref '${ref}' even after deleting its loose ` +
        `ref file: ${describe(deleteArgs, retry)}`,
    ),
  };
}

/** Describe a git command outcome for an error message. */
function describe(
  args: readonly string[],
  result: Result<GitCommandOutput>,
): string {
  const command = `git ${args.join(" ")}`;
  if (!result.ok) {
    return `${command}: ${result.error.message}`;
  }
  const { code, stdout, stderr } = result.value;
  const output = stderr.trim() || stdout.trim() || "(no output)";
  return `${command} exited ${code}: ${output}`;
}
