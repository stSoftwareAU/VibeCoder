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
 */ import { assertSafeRefComponent } from "./git_ref_args.ts";
import { runGitCommand } from "./git_timeout.ts";
/** Patterns git uses to name the broken ref in its own stderr. */ const BROKEN_REF_PATTERNS = [
  /bad object (refs\/\S+)/g,
  /ignoring broken ref (refs\/\S+)/g,
  /missing object [0-9a-f]+ for (refs\/\S+)/g,
  /bad ref (refs\/\S+)/g
];
/** Trailing punctuation git's wording tacks onto a ref name. */ const TRAILING_PUNCTUATION = /[;,.'")\]]+$/;
/** Only these ref namespaces are ever repaired — never tags, notes, stash. */ function isRepairableNamespace(ref) {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/");
}
/**
 * Extract the ref names git's stderr blames for "bad object" / "broken
 * ref" / "missing object" failures.
 *
 * Deliberately narrow to `refs/heads/` and `refs/remotes/` — the only
 * namespaces {@link removeBrokenRef} will ever touch — and to names that
 * pass {@link assertSafeRefComponent}, so a hostile or malformed string
 * embedded in git's output (which, for a fetch, includes server-relayed
 * `remote:` lines) can never reach git as a positional. That check rejects
 * `..`, whitespace and every character git refuses in a ref, so a candidate
 * can never name a path that climbs out of the git directory.
 *
 * @param text - git stderr (or any text) to scan
 * @returns Ref names in first-seen order, de-duplicated
 */ export function brokenRefsIn(text) {
  const found = [];
  const seen = new Set();
  for (const pattern of BROKEN_REF_PATTERNS){
    // Patterns are shared `g`-flagged RegExp objects; reset lastIndex so a
    // previous exec on other text cannot skip matches here.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)){
      const raw = match[1];
      if (raw === undefined) continue;
      const ref = raw.replace(TRAILING_PUNCTUATION, "");
      if (!isRepairableNamespace(ref)) continue;
      try {
        assertSafeRefComponent(ref, "broken ref repair");
      } catch  {
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
 * cleared. `rev-parse --git-path` does not validate a ref name, so the
 * resolved path is only deleted once its real location is confirmed to be
 * inside `git rev-parse --git-common-dir` — never a file outside the clone.
 *
 * @param ref - The broken ref, validated against the same allowlist as
 *   {@link brokenRefsIn} before it ever reaches git.
 * @param options - Git command options (cwd, etc.)
 * @param runGit - Injectable seam for running git. Defaults to
 *   {@link runGitCommand}.
 * @returns `ok: true` once the ref is gone; `ok: false` naming the ref and
 *   git's own stderr when it could not be removed.
 */ export async function removeBrokenRef(ref, options, runGit = runGitCommand) {
  if (!isRepairableNamespace(ref)) {
    return {
      ok: false,
      error: new Error(`Refusing to remove '${ref}': only refs/heads/ and refs/remotes/ ` + `are ever repaired (Issue #2880)`)
    };
  }
  try {
    assertSafeRefComponent(ref, "broken ref repair");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
  const deleteArgs = [
    "update-ref",
    "-d",
    "--end-of-options",
    ref
  ];
  const first = await runGit(deleteArgs, options);
  if (first.ok && first.value.code === 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  // Fall back to removing the loose ref file directly, then retry.
  const pathArgs = [
    "rev-parse",
    "--git-path",
    ref
  ];
  const pathResult = await runGit(pathArgs, options);
  if (!pathResult.ok || pathResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Could not remove broken ref '${ref}': ${describe(deleteArgs, first)}`)
    };
  }
  const cwd = options.cwd ?? Deno.cwd();
  const looseRefPath = absoluteUnder(cwd, pathResult.value.stdout.trim());
  const contained = await confirmInsideGitCommonDir(ref, looseRefPath, cwd, options, runGit);
  if (!contained.ok) return contained;
  try {
    await Deno.remove(contained.value);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: new Error(`Could not remove broken ref '${ref}': ${describe(deleteArgs, first)}; and could not delete loose ref file ${looseRefPath}: ${error instanceof Error ? error.message : String(error)}`)
      };
    }
  }
  const retry = await runGit(deleteArgs, options);
  if (retry.ok && retry.value.code === 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  return {
    ok: false,
    error: new Error(`Could not remove broken ref '${ref}' even after deleting its loose ` + `ref file: ${describe(deleteArgs, retry)}`)
  };
}
/** Resolve a path git printed relative to `cwd` (no `@std/path` here). */ function absoluteUnder(cwd, path) {
  return path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
}
/** Split a path into its directory and final component. */ function splitLast(path) {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? {
    dir: path.slice(0, cut),
    name: path.slice(cut + 1)
  } : {
    dir: "/",
    name: path.slice(cut + 1)
  };
}
/**
 * Confirm `looseRefPath` really lives inside the repository's git common
 * directory, resolving symlinks on both sides, and return the real path to
 * delete. A path whose parent directory is already gone is reported as-is:
 * there is nothing left to delete, and `Deno.remove` will say NotFound.
 */ async function confirmInsideGitCommonDir(ref, looseRefPath, cwd, options, runGit) {
  const commonArgs = [
    "rev-parse",
    "--git-common-dir"
  ];
  const common = await runGit(commonArgs, options);
  if (!common.ok || common.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Could not remove broken ref '${ref}': cannot locate the git ` + `directory to confirm the loose ref path: ${describe(commonArgs, common)}`)
    };
  }
  let commonDir;
  let realParent;
  try {
    commonDir = await Deno.realPath(absoluteUnder(cwd, common.value.stdout.trim()));
    realParent = await Deno.realPath(splitLast(looseRefPath).dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: true,
        value: looseRefPath
      };
    }
    return {
      ok: false,
      error: new Error(`Could not remove broken ref '${ref}': cannot resolve ${looseRefPath}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
  const realPath = `${realParent}/${splitLast(looseRefPath).name}`;
  if (!realPath.startsWith(`${commonDir}/`)) {
    return {
      ok: false,
      error: new Error(`Refusing to delete ${realPath} for broken ref '${ref}': it resolves ` + `outside the git directory ${commonDir} (Issue #2880)`)
    };
  }
  return {
    ok: true,
    value: realPath
  };
}
/** Refs git's own wording blames for a broken-ref failure, per {@link isBrokenRefFailure}. */ const BAD_OBJECT_OR_BROKEN_REF = /(?:bad object|ignoring broken ref) (refs\/\S+)/g;
/**
 * Narrow check for whether a git failure message is a broken-ref failure
 * (Issue #2884) — as opposed to an ordinary "no such branch" failure that
 * happens to share some wording (e.g. `'nosuch' is not a commit`).
 *
 * True only when the message names at least one `refs/heads/…` or
 * `refs/remotes/…` ref via `bad object` or `ignoring broken ref`. A
 * `'<X>' is not a commit` line — which git also emits for an ordinary
 * "no such branch" failure — is never enough on its own: it only appears
 * here as the trailing symptom of the same `refs/remotes/<X>` /
 * `refs/heads/<X>` being reported broken, which the `bad object` /
 * `ignoring broken ref` check above already covers (see the module doc
 * comment for the full three-line example).
 *
 * @param message - The failure text to inspect (typically joined stderr).
 * @returns True when the message reports a broken ref this module can repair.
 */ export function isBrokenRefFailure(message) {
  for (const match of message.matchAll(BAD_OBJECT_OR_BROKEN_REF)){
    const raw = match[1];
    if (raw === undefined) continue;
    const ref = raw.replace(TRAILING_PUNCTUATION, "");
    if (isRepairableNamespace(ref)) return true;
  }
  return false;
}
/**
 * Sweep every `refs/heads/` and `refs/remotes/` ref in a shared clone for
 * broken loose refs and remove them, then re-fetch so the remote-tracking
 * refs are recreated clean (Issue #2884).
 *
 * This is the cheapest-first rung of shared-clone repair, run *before* the
 * full re-clone fallback tracked under #1093: a targeted sweep is far
 * cheaper than discarding and re-cloning the whole shared clone, and fixes
 * exactly the same class of failure (a stray broken loose ref blocking every
 * fetch/checkout in the clone) without losing any other local state.
 *
 * @param options - Git command options (cwd, etc.)
 * @param runGit - Injectable seam for running git. Defaults to
 *   {@link runGitCommand}.
 * @returns `ok: true` with the refs removed (possibly empty) once the sweep
 *   and re-fetch both succeed; `ok: false` naming whichever git step failed.
 */ export async function sweepBrokenRefs(options, runGit = runGitCommand) {
  const listArgs = [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes"
  ];
  const listed = await runGit(listArgs, options);
  if (!listed.ok || listed.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Could not sweep broken refs: ${describe(listArgs, listed)}`)
    };
  }
  const refs = listed.value.stdout.split("\n").map((line)=>line.trim()).filter((line)=>line.length > 0);
  const removed = [];
  for (const ref of refs){
    const verifyArgs = [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`
    ];
    const verified = await runGit(verifyArgs, options);
    if (verified.ok && verified.value.code === 0) continue;
    const removal = await removeBrokenRef(ref, options, runGit);
    if (!removal.ok) {
      return {
        ok: false,
        error: new Error(`Could not sweep broken refs: failed to remove '${ref}': ${removal.error.message}`)
      };
    }
    removed.push(ref);
  }
  const fetchArgs = [
    "fetch",
    "--prune",
    "origin"
  ];
  const fetched = await runGit(fetchArgs, options);
  if (!fetched.ok || fetched.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Could not sweep broken refs: ${describe(fetchArgs, fetched)}`)
    };
  }
  return {
    ok: true,
    value: {
      removed
    }
  };
}
/** Describe a git command outcome for an error message. */ function describe(args, result) {
  const command = `git ${args.join(" ")}`;
  if (!result.ok) {
    return `${command}: ${result.error.message}`;
  }
  const { code, stdout, stderr } = result.value;
  const output = stderr.trim() || stdout.trim() || "(no output)";
  return `${command} exited ${code}: ${output}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9icm9rZW5fcmVmX3JlcGFpci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlcGFpcmluZyBhIGJyb2tlbiBsb29zZSByZWYgaW4gYSBzaGFyZWQgY2xvbmUgKElzc3VlICMyODgwKS5cbiAqXG4gKiBBIHNoYXJlZCBjbG9uZSBjYW4gZW5kIHVwIGNhcnJ5aW5nIGEgbG9vc2UgcmVmIGZpbGUg4oCUIHVuZGVyXG4gKiBgcmVmcy9oZWFkcy9gIG9yIGByZWZzL3JlbW90ZXMvPHJlbW90ZT4vYCDigJQgd2hvc2UgY29udGVudHMgbmFtZSBhblxuICogb2JqZWN0IHRoZSBvYmplY3Qgc3RvcmUgbm8gbG9uZ2VyIGhhcy4gVmVyaWZpZWQgYWdhaW5zdCBnaXQgMi40NzogYW55XG4gKiBzdWNoIHJlZiBtYWtlcyBgZ2l0IGZldGNoIG9yaWdpbiA8YmFzZT5gIGZhaWwgb3V0cmlnaHRcbiAqIChgZmF0YWw6IGJhZCBvYmplY3QgcmVmcy88eD5gKSwgYW5kIGEgYnJva2VuIGByZWZzL3JlbW90ZXMvb3JpZ2luLzxiYXNlPmBcbiAqIG1ha2VzIGBnaXQgY2hlY2tvdXQgLUIg4oCmIG9yaWdpbi88YmFzZT5gIGZhaWwgdG9vXG4gKiAoYHdhcm5pbmc6IGlnbm9yaW5nIGJyb2tlbiByZWYgcmVmcy9yZW1vdGVzL29yaWdpbi88YmFzZT5gIGZvbGxvd2VkIGJ5XG4gKiBgZmF0YWw6ICdvcmlnaW4vPGJhc2U+JyBpcyBub3QgYSBjb21taXRgKS5cbiAqXG4gKiBFdmVyeSByZWYgaXMgcmVjb3ZlcmFibGUgZnJvbSB0aGUgcmVtb3RlLCBzbyB0aGUgcmVwYWlyIGlzIHNhZmUgYW5kXG4gKiBzZWxmLWhlYWxpbmc6IGRlbGV0ZSB0aGUgYnJva2VuIGxvb3NlIHJlZiB3aXRoIGBnaXQgdXBkYXRlLXJlZiAtZGAsIHRoZW5cbiAqIHJldHJ5IHRoZSBmZXRjaC9jaGVja291dCB0aGF0IGZhaWxlZCDigJQgdGhlIGZldGNoIHJlY3JlYXRlcyB0aGUgcmVmIGF0IHRoZVxuICogcmVtb3RlJ3Mgb3duIHRpcC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0U2FmZVJlZkNvbXBvbmVudCB9IGZyb20gXCIuL2dpdF9yZWZfYXJncy50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBHaXRDb21tYW5kT3B0aW9ucyxcbiAgdHlwZSBHaXRDb21tYW5kT3V0cHV0LFxuICBydW5HaXRDb21tYW5kLFxufSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuXG4vKiogUGF0dGVybnMgZ2l0IHVzZXMgdG8gbmFtZSB0aGUgYnJva2VuIHJlZiBpbiBpdHMgb3duIHN0ZGVyci4gKi9cbmNvbnN0IEJST0tFTl9SRUZfUEFUVEVSTlM6IHJlYWRvbmx5IFJlZ0V4cFtdID0gW1xuICAvYmFkIG9iamVjdCAocmVmc1xcL1xcUyspL2csXG4gIC9pZ25vcmluZyBicm9rZW4gcmVmIChyZWZzXFwvXFxTKykvZyxcbiAgL21pc3Npbmcgb2JqZWN0IFswLTlhLWZdKyBmb3IgKHJlZnNcXC9cXFMrKS9nLFxuICAvYmFkIHJlZiAocmVmc1xcL1xcUyspL2csXG5dO1xuXG4vKiogVHJhaWxpbmcgcHVuY3R1YXRpb24gZ2l0J3Mgd29yZGluZyB0YWNrcyBvbnRvIGEgcmVmIG5hbWUuICovXG5jb25zdCBUUkFJTElOR19QVU5DVFVBVElPTiA9IC9bOywuJ1wiKVxcXV0rJC87XG5cbi8qKiBPbmx5IHRoZXNlIHJlZiBuYW1lc3BhY2VzIGFyZSBldmVyIHJlcGFpcmVkIOKAlCBuZXZlciB0YWdzLCBub3Rlcywgc3Rhc2guICovXG5mdW5jdGlvbiBpc1JlcGFpcmFibGVOYW1lc3BhY2UocmVmOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIHJlZi5zdGFydHNXaXRoKFwicmVmcy9oZWFkcy9cIikgfHwgcmVmLnN0YXJ0c1dpdGgoXCJyZWZzL3JlbW90ZXMvXCIpO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgdGhlIHJlZiBuYW1lcyBnaXQncyBzdGRlcnIgYmxhbWVzIGZvciBcImJhZCBvYmplY3RcIiAvIFwiYnJva2VuXG4gKiByZWZcIiAvIFwibWlzc2luZyBvYmplY3RcIiBmYWlsdXJlcy5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgbmFycm93IHRvIGByZWZzL2hlYWRzL2AgYW5kIGByZWZzL3JlbW90ZXMvYCDigJQgdGhlIG9ubHlcbiAqIG5hbWVzcGFjZXMge0BsaW5rIHJlbW92ZUJyb2tlblJlZn0gd2lsbCBldmVyIHRvdWNoIOKAlCBhbmQgdG8gbmFtZXMgdGhhdFxuICogcGFzcyB7QGxpbmsgYXNzZXJ0U2FmZVJlZkNvbXBvbmVudH0sIHNvIGEgaG9zdGlsZSBvciBtYWxmb3JtZWQgc3RyaW5nXG4gKiBlbWJlZGRlZCBpbiBnaXQncyBvdXRwdXQgKHdoaWNoLCBmb3IgYSBmZXRjaCwgaW5jbHVkZXMgc2VydmVyLXJlbGF5ZWRcbiAqIGByZW1vdGU6YCBsaW5lcykgY2FuIG5ldmVyIHJlYWNoIGdpdCBhcyBhIHBvc2l0aW9uYWwuIFRoYXQgY2hlY2sgcmVqZWN0c1xuICogYC4uYCwgd2hpdGVzcGFjZSBhbmQgZXZlcnkgY2hhcmFjdGVyIGdpdCByZWZ1c2VzIGluIGEgcmVmLCBzbyBhIGNhbmRpZGF0ZVxuICogY2FuIG5ldmVyIG5hbWUgYSBwYXRoIHRoYXQgY2xpbWJzIG91dCBvZiB0aGUgZ2l0IGRpcmVjdG9yeS5cbiAqXG4gKiBAcGFyYW0gdGV4dCAtIGdpdCBzdGRlcnIgKG9yIGFueSB0ZXh0KSB0byBzY2FuXG4gKiBAcmV0dXJucyBSZWYgbmFtZXMgaW4gZmlyc3Qtc2VlbiBvcmRlciwgZGUtZHVwbGljYXRlZFxuICovXG5leHBvcnQgZnVuY3Rpb24gYnJva2VuUmVmc0luKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZm91bmQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIEJST0tFTl9SRUZfUEFUVEVSTlMpIHtcbiAgICAvLyBQYXR0ZXJucyBhcmUgc2hhcmVkIGBnYC1mbGFnZ2VkIFJlZ0V4cCBvYmplY3RzOyByZXNldCBsYXN0SW5kZXggc28gYVxuICAgIC8vIHByZXZpb3VzIGV4ZWMgb24gb3RoZXIgdGV4dCBjYW5ub3Qgc2tpcCBtYXRjaGVzIGhlcmUuXG4gICAgcGF0dGVybi5sYXN0SW5kZXggPSAwO1xuICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgdGV4dC5tYXRjaEFsbChwYXR0ZXJuKSkge1xuICAgICAgY29uc3QgcmF3ID0gbWF0Y2hbMV07XG4gICAgICBpZiAocmF3ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgcmVmID0gcmF3LnJlcGxhY2UoVFJBSUxJTkdfUFVOQ1RVQVRJT04sIFwiXCIpO1xuICAgICAgaWYgKCFpc1JlcGFpcmFibGVOYW1lc3BhY2UocmVmKSkgY29udGludWU7XG4gICAgICB0cnkge1xuICAgICAgICBhc3NlcnRTYWZlUmVmQ29tcG9uZW50KHJlZiwgXCJicm9rZW4gcmVmIHJlcGFpclwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChzZWVuLmhhcyhyZWYpKSBjb250aW51ZTtcbiAgICAgIHNlZW4uYWRkKHJlZik7XG4gICAgICBmb3VuZC5wdXNoKHJlZik7XG4gICAgfVxuICB9XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBEZWxldGUgYSBicm9rZW4gbG9vc2UgcmVmIHNvIHRoZSBuZXh0IGZldGNoIHJlY3JlYXRlcyBpdCBmcm9tIHRoZSByZW1vdGVcbiAqIChJc3N1ZSAjMjg4MCkuXG4gKlxuICogYGdpdCB1cGRhdGUtcmVmIC1kYCBhbG9uZSBpcyBub3JtYWxseSBlbm91Z2gg4oCUIGl0IHJlbW92ZXMgYSBsb29zZSByZWZcbiAqIGZpbGUgZXZlbiB3aGVuIHRoZSBvYmplY3QgaXQgbmFtZXMgaXMgbWlzc2luZy4gSWYgdGhhdCBzdGlsbCBmYWlscyAodGhlXG4gKiByZWYgbWlnaHQgYmUgd3JpdGUtbG9ja2VkLCBvciB1cGRhdGUtcmVmIGl0c2VsZiByZWZ1c2VzIGEgcmVmIGl0IGNhbm5vdFxuICogZXZlbiBwYXJzZSksIGZhbGwgYmFjayB0byByZXNvbHZpbmcgdGhlIHJlZidzIG9uLWRpc2sgcGF0aCB3aXRoXG4gKiBgZ2l0IHJldi1wYXJzZSAtLWdpdC1wYXRoYCBhbmQgcmVtb3ZpbmcgdGhlIGxvb3NlIGZpbGUgZGlyZWN0bHksIHRoZW5cbiAqIHJldHJ5aW5nIGB1cGRhdGUtcmVmIC1kYCBzbyBhbnkgaW4tbWVtb3J5IHJlZiBjYWNoZSBnaXQgaG9sZHMgaXMgYWxzb1xuICogY2xlYXJlZC4gYHJldi1wYXJzZSAtLWdpdC1wYXRoYCBkb2VzIG5vdCB2YWxpZGF0ZSBhIHJlZiBuYW1lLCBzbyB0aGVcbiAqIHJlc29sdmVkIHBhdGggaXMgb25seSBkZWxldGVkIG9uY2UgaXRzIHJlYWwgbG9jYXRpb24gaXMgY29uZmlybWVkIHRvIGJlXG4gKiBpbnNpZGUgYGdpdCByZXYtcGFyc2UgLS1naXQtY29tbW9uLWRpcmAg4oCUIG5ldmVyIGEgZmlsZSBvdXRzaWRlIHRoZSBjbG9uZS5cbiAqXG4gKiBAcGFyYW0gcmVmIC0gVGhlIGJyb2tlbiByZWYsIHZhbGlkYXRlZCBhZ2FpbnN0IHRoZSBzYW1lIGFsbG93bGlzdCBhc1xuICogICB7QGxpbmsgYnJva2VuUmVmc0lufSBiZWZvcmUgaXQgZXZlciByZWFjaGVzIGdpdC5cbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkLCBldGMuKVxuICogQHBhcmFtIHJ1bkdpdCAtIEluamVjdGFibGUgc2VhbSBmb3IgcnVubmluZyBnaXQuIERlZmF1bHRzIHRvXG4gKiAgIHtAbGluayBydW5HaXRDb21tYW5kfS5cbiAqIEByZXR1cm5zIGBvazogdHJ1ZWAgb25jZSB0aGUgcmVmIGlzIGdvbmU7IGBvazogZmFsc2VgIG5hbWluZyB0aGUgcmVmIGFuZFxuICogICBnaXQncyBvd24gc3RkZXJyIHdoZW4gaXQgY291bGQgbm90IGJlIHJlbW92ZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW1vdmVCcm9rZW5SZWYoXG4gIHJlZjogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbiAgcnVuR2l0OiB0eXBlb2YgcnVuR2l0Q29tbWFuZCA9IHJ1bkdpdENvbW1hbmQsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBpZiAoIWlzUmVwYWlyYWJsZU5hbWVzcGFjZShyZWYpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBSZWZ1c2luZyB0byByZW1vdmUgJyR7cmVmfSc6IG9ubHkgcmVmcy9oZWFkcy8gYW5kIHJlZnMvcmVtb3Rlcy8gYCArXG4gICAgICAgICAgYGFyZSBldmVyIHJlcGFpcmVkIChJc3N1ZSAjMjg4MClgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIHRyeSB7XG4gICAgYXNzZXJ0U2FmZVJlZkNvbXBvbmVudChyZWYsIFwiYnJva2VuIHJlZiByZXBhaXJcIik7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGRlbGV0ZUFyZ3MgPSBbXCJ1cGRhdGUtcmVmXCIsIFwiLWRcIiwgXCItLWVuZC1vZi1vcHRpb25zXCIsIHJlZl07XG4gIGNvbnN0IGZpcnN0ID0gYXdhaXQgcnVuR2l0KGRlbGV0ZUFyZ3MsIG9wdGlvbnMpO1xuICBpZiAoZmlyc3Qub2sgJiYgZmlyc3QudmFsdWUuY29kZSA9PT0gMCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH1cblxuICAvLyBGYWxsIGJhY2sgdG8gcmVtb3ZpbmcgdGhlIGxvb3NlIHJlZiBmaWxlIGRpcmVjdGx5LCB0aGVuIHJldHJ5LlxuICBjb25zdCBwYXRoQXJncyA9IFtcInJldi1wYXJzZVwiLCBcIi0tZ2l0LXBhdGhcIiwgcmVmXTtcbiAgY29uc3QgcGF0aFJlc3VsdCA9IGF3YWl0IHJ1bkdpdChwYXRoQXJncywgb3B0aW9ucyk7XG4gIGlmICghcGF0aFJlc3VsdC5vayB8fCBwYXRoUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCByZW1vdmUgYnJva2VuIHJlZiAnJHtyZWZ9JzogJHtkZXNjcmliZShkZWxldGVBcmdzLCBmaXJzdCl9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBjb25zdCBjd2QgPSBvcHRpb25zLmN3ZCA/PyBEZW5vLmN3ZCgpO1xuICBjb25zdCBsb29zZVJlZlBhdGggPSBhYnNvbHV0ZVVuZGVyKGN3ZCwgcGF0aFJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpKTtcbiAgY29uc3QgY29udGFpbmVkID0gYXdhaXQgY29uZmlybUluc2lkZUdpdENvbW1vbkRpcihcbiAgICByZWYsXG4gICAgbG9vc2VSZWZQYXRoLFxuICAgIGN3ZCxcbiAgICBvcHRpb25zLFxuICAgIHJ1bkdpdCxcbiAgKTtcbiAgaWYgKCFjb250YWluZWQub2spIHJldHVybiBjb250YWluZWQ7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoY29udGFpbmVkLnZhbHVlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoIShlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGBDb3VsZCBub3QgcmVtb3ZlIGJyb2tlbiByZWYgJyR7cmVmfSc6ICR7XG4gICAgICAgICAgICBkZXNjcmliZShkZWxldGVBcmdzLCBmaXJzdClcbiAgICAgICAgICB9OyBhbmQgY291bGQgbm90IGRlbGV0ZSBsb29zZSByZWYgZmlsZSAke2xvb3NlUmVmUGF0aH06ICR7XG4gICAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgICB9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcmV0cnkgPSBhd2FpdCBydW5HaXQoZGVsZXRlQXJncywgb3B0aW9ucyk7XG4gIGlmIChyZXRyeS5vayAmJiByZXRyeS52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgYENvdWxkIG5vdCByZW1vdmUgYnJva2VuIHJlZiAnJHtyZWZ9JyBldmVuIGFmdGVyIGRlbGV0aW5nIGl0cyBsb29zZSBgICtcbiAgICAgICAgYHJlZiBmaWxlOiAke2Rlc2NyaWJlKGRlbGV0ZUFyZ3MsIHJldHJ5KX1gLFxuICAgICksXG4gIH07XG59XG5cbi8qKiBSZXNvbHZlIGEgcGF0aCBnaXQgcHJpbnRlZCByZWxhdGl2ZSB0byBgY3dkYCAobm8gYEBzdGQvcGF0aGAgaGVyZSkuICovXG5mdW5jdGlvbiBhYnNvbHV0ZVVuZGVyKGN3ZDogc3RyaW5nLCBwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcGF0aC5zdGFydHNXaXRoKFwiL1wiKSA/IHBhdGggOiBgJHtjd2QucmVwbGFjZSgvXFwvKyQvLCBcIlwiKX0vJHtwYXRofWA7XG59XG5cbi8qKiBTcGxpdCBhIHBhdGggaW50byBpdHMgZGlyZWN0b3J5IGFuZCBmaW5hbCBjb21wb25lbnQuICovXG5mdW5jdGlvbiBzcGxpdExhc3QocGF0aDogc3RyaW5nKTogeyBkaXI6IHN0cmluZzsgbmFtZTogc3RyaW5nIH0ge1xuICBjb25zdCBjdXQgPSBwYXRoLmxhc3RJbmRleE9mKFwiL1wiKTtcbiAgcmV0dXJuIGN1dCA+IDBcbiAgICA/IHsgZGlyOiBwYXRoLnNsaWNlKDAsIGN1dCksIG5hbWU6IHBhdGguc2xpY2UoY3V0ICsgMSkgfVxuICAgIDogeyBkaXI6IFwiL1wiLCBuYW1lOiBwYXRoLnNsaWNlKGN1dCArIDEpIH07XG59XG5cbi8qKlxuICogQ29uZmlybSBgbG9vc2VSZWZQYXRoYCByZWFsbHkgbGl2ZXMgaW5zaWRlIHRoZSByZXBvc2l0b3J5J3MgZ2l0IGNvbW1vblxuICogZGlyZWN0b3J5LCByZXNvbHZpbmcgc3ltbGlua3Mgb24gYm90aCBzaWRlcywgYW5kIHJldHVybiB0aGUgcmVhbCBwYXRoIHRvXG4gKiBkZWxldGUuIEEgcGF0aCB3aG9zZSBwYXJlbnQgZGlyZWN0b3J5IGlzIGFscmVhZHkgZ29uZSBpcyByZXBvcnRlZCBhcy1pczpcbiAqIHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byBkZWxldGUsIGFuZCBgRGVuby5yZW1vdmVgIHdpbGwgc2F5IE5vdEZvdW5kLlxuICovXG5hc3luYyBmdW5jdGlvbiBjb25maXJtSW5zaWRlR2l0Q29tbW9uRGlyKFxuICByZWY6IHN0cmluZyxcbiAgbG9vc2VSZWZQYXRoOiBzdHJpbmcsXG4gIGN3ZDogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbiAgcnVuR2l0OiB0eXBlb2YgcnVuR2l0Q29tbWFuZCxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgY29uc3QgY29tbW9uQXJncyA9IFtcInJldi1wYXJzZVwiLCBcIi0tZ2l0LWNvbW1vbi1kaXJcIl07XG4gIGNvbnN0IGNvbW1vbiA9IGF3YWl0IHJ1bkdpdChjb21tb25BcmdzLCBvcHRpb25zKTtcbiAgaWYgKCFjb21tb24ub2sgfHwgY29tbW9uLnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCByZW1vdmUgYnJva2VuIHJlZiAnJHtyZWZ9JzogY2Fubm90IGxvY2F0ZSB0aGUgZ2l0IGAgK1xuICAgICAgICAgIGBkaXJlY3RvcnkgdG8gY29uZmlybSB0aGUgbG9vc2UgcmVmIHBhdGg6ICR7XG4gICAgICAgICAgICBkZXNjcmliZShjb21tb25BcmdzLCBjb21tb24pXG4gICAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgbGV0IGNvbW1vbkRpcjogc3RyaW5nO1xuICBsZXQgcmVhbFBhcmVudDogc3RyaW5nO1xuICB0cnkge1xuICAgIGNvbW1vbkRpciA9IGF3YWl0IERlbm8ucmVhbFBhdGgoXG4gICAgICBhYnNvbHV0ZVVuZGVyKGN3ZCwgY29tbW9uLnZhbHVlLnN0ZG91dC50cmltKCkpLFxuICAgICk7XG4gICAgcmVhbFBhcmVudCA9IGF3YWl0IERlbm8ucmVhbFBhdGgoc3BsaXRMYXN0KGxvb3NlUmVmUGF0aCkuZGlyKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBsb29zZVJlZlBhdGggfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBDb3VsZCBub3QgcmVtb3ZlIGJyb2tlbiByZWYgJyR7cmVmfSc6IGNhbm5vdCByZXNvbHZlICR7bG9vc2VSZWZQYXRofTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgY29uc3QgcmVhbFBhdGggPSBgJHtyZWFsUGFyZW50fS8ke3NwbGl0TGFzdChsb29zZVJlZlBhdGgpLm5hbWV9YDtcbiAgaWYgKCFyZWFsUGF0aC5zdGFydHNXaXRoKGAke2NvbW1vbkRpcn0vYCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYFJlZnVzaW5nIHRvIGRlbGV0ZSAke3JlYWxQYXRofSBmb3IgYnJva2VuIHJlZiAnJHtyZWZ9JzogaXQgcmVzb2x2ZXMgYCArXG4gICAgICAgICAgYG91dHNpZGUgdGhlIGdpdCBkaXJlY3RvcnkgJHtjb21tb25EaXJ9IChJc3N1ZSAjMjg4MClgLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcmVhbFBhdGggfTtcbn1cblxuLyoqIFJlZnMgZ2l0J3Mgb3duIHdvcmRpbmcgYmxhbWVzIGZvciBhIGJyb2tlbi1yZWYgZmFpbHVyZSwgcGVyIHtAbGluayBpc0Jyb2tlblJlZkZhaWx1cmV9LiAqL1xuY29uc3QgQkFEX09CSkVDVF9PUl9CUk9LRU5fUkVGID1cbiAgLyg/OmJhZCBvYmplY3R8aWdub3JpbmcgYnJva2VuIHJlZikgKHJlZnNcXC9cXFMrKS9nO1xuXG4vKipcbiAqIE5hcnJvdyBjaGVjayBmb3Igd2hldGhlciBhIGdpdCBmYWlsdXJlIG1lc3NhZ2UgaXMgYSBicm9rZW4tcmVmIGZhaWx1cmVcbiAqIChJc3N1ZSAjMjg4NCkg4oCUIGFzIG9wcG9zZWQgdG8gYW4gb3JkaW5hcnkgXCJubyBzdWNoIGJyYW5jaFwiIGZhaWx1cmUgdGhhdFxuICogaGFwcGVucyB0byBzaGFyZSBzb21lIHdvcmRpbmcgKGUuZy4gYCdub3N1Y2gnIGlzIG5vdCBhIGNvbW1pdGApLlxuICpcbiAqIFRydWUgb25seSB3aGVuIHRoZSBtZXNzYWdlIG5hbWVzIGF0IGxlYXN0IG9uZSBgcmVmcy9oZWFkcy/igKZgIG9yXG4gKiBgcmVmcy9yZW1vdGVzL+KApmAgcmVmIHZpYSBgYmFkIG9iamVjdGAgb3IgYGlnbm9yaW5nIGJyb2tlbiByZWZgLiBBXG4gKiBgJzxYPicgaXMgbm90IGEgY29tbWl0YCBsaW5lIOKAlCB3aGljaCBnaXQgYWxzbyBlbWl0cyBmb3IgYW4gb3JkaW5hcnlcbiAqIFwibm8gc3VjaCBicmFuY2hcIiBmYWlsdXJlIOKAlCBpcyBuZXZlciBlbm91Z2ggb24gaXRzIG93bjogaXQgb25seSBhcHBlYXJzXG4gKiBoZXJlIGFzIHRoZSB0cmFpbGluZyBzeW1wdG9tIG9mIHRoZSBzYW1lIGByZWZzL3JlbW90ZXMvPFg+YCAvXG4gKiBgcmVmcy9oZWFkcy88WD5gIGJlaW5nIHJlcG9ydGVkIGJyb2tlbiwgd2hpY2ggdGhlIGBiYWQgb2JqZWN0YCAvXG4gKiBgaWdub3JpbmcgYnJva2VuIHJlZmAgY2hlY2sgYWJvdmUgYWxyZWFkeSBjb3ZlcnMgKHNlZSB0aGUgbW9kdWxlIGRvY1xuICogY29tbWVudCBmb3IgdGhlIGZ1bGwgdGhyZWUtbGluZSBleGFtcGxlKS5cbiAqXG4gKiBAcGFyYW0gbWVzc2FnZSAtIFRoZSBmYWlsdXJlIHRleHQgdG8gaW5zcGVjdCAodHlwaWNhbGx5IGpvaW5lZCBzdGRlcnIpLlxuICogQHJldHVybnMgVHJ1ZSB3aGVuIHRoZSBtZXNzYWdlIHJlcG9ydHMgYSBicm9rZW4gcmVmIHRoaXMgbW9kdWxlIGNhbiByZXBhaXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Jyb2tlblJlZkZhaWx1cmUobWVzc2FnZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgbWVzc2FnZS5tYXRjaEFsbChCQURfT0JKRUNUX09SX0JST0tFTl9SRUYpKSB7XG4gICAgY29uc3QgcmF3ID0gbWF0Y2hbMV07XG4gICAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBjb25zdCByZWYgPSByYXcucmVwbGFjZShUUkFJTElOR19QVU5DVFVBVElPTiwgXCJcIik7XG4gICAgaWYgKGlzUmVwYWlyYWJsZU5hbWVzcGFjZShyZWYpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogU3dlZXAgZXZlcnkgYHJlZnMvaGVhZHMvYCBhbmQgYHJlZnMvcmVtb3Rlcy9gIHJlZiBpbiBhIHNoYXJlZCBjbG9uZSBmb3JcbiAqIGJyb2tlbiBsb29zZSByZWZzIGFuZCByZW1vdmUgdGhlbSwgdGhlbiByZS1mZXRjaCBzbyB0aGUgcmVtb3RlLXRyYWNraW5nXG4gKiByZWZzIGFyZSByZWNyZWF0ZWQgY2xlYW4gKElzc3VlICMyODg0KS5cbiAqXG4gKiBUaGlzIGlzIHRoZSBjaGVhcGVzdC1maXJzdCBydW5nIG9mIHNoYXJlZC1jbG9uZSByZXBhaXIsIHJ1biAqYmVmb3JlKiB0aGVcbiAqIGZ1bGwgcmUtY2xvbmUgZmFsbGJhY2sgdHJhY2tlZCB1bmRlciAjMTA5MzogYSB0YXJnZXRlZCBzd2VlcCBpcyBmYXJcbiAqIGNoZWFwZXIgdGhhbiBkaXNjYXJkaW5nIGFuZCByZS1jbG9uaW5nIHRoZSB3aG9sZSBzaGFyZWQgY2xvbmUsIGFuZCBmaXhlc1xuICogZXhhY3RseSB0aGUgc2FtZSBjbGFzcyBvZiBmYWlsdXJlIChhIHN0cmF5IGJyb2tlbiBsb29zZSByZWYgYmxvY2tpbmcgZXZlcnlcbiAqIGZldGNoL2NoZWNrb3V0IGluIHRoZSBjbG9uZSkgd2l0aG91dCBsb3NpbmcgYW55IG90aGVyIGxvY2FsIHN0YXRlLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkLCBldGMuKVxuICogQHBhcmFtIHJ1bkdpdCAtIEluamVjdGFibGUgc2VhbSBmb3IgcnVubmluZyBnaXQuIERlZmF1bHRzIHRvXG4gKiAgIHtAbGluayBydW5HaXRDb21tYW5kfS5cbiAqIEByZXR1cm5zIGBvazogdHJ1ZWAgd2l0aCB0aGUgcmVmcyByZW1vdmVkIChwb3NzaWJseSBlbXB0eSkgb25jZSB0aGUgc3dlZXBcbiAqICAgYW5kIHJlLWZldGNoIGJvdGggc3VjY2VlZDsgYG9rOiBmYWxzZWAgbmFtaW5nIHdoaWNoZXZlciBnaXQgc3RlcCBmYWlsZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzd2VlcEJyb2tlblJlZnMoXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuICBydW5HaXQ6IHR5cGVvZiBydW5HaXRDb21tYW5kID0gcnVuR2l0Q29tbWFuZCxcbik6IFByb21pc2U8UmVzdWx0PHsgcmVtb3ZlZDogc3RyaW5nW10gfT4+IHtcbiAgY29uc3QgbGlzdEFyZ3MgPSBbXG4gICAgXCJmb3ItZWFjaC1yZWZcIixcbiAgICBcIi0tZm9ybWF0PSUocmVmbmFtZSlcIixcbiAgICBcInJlZnMvaGVhZHNcIixcbiAgICBcInJlZnMvcmVtb3Rlc1wiLFxuICBdO1xuICBjb25zdCBsaXN0ZWQgPSBhd2FpdCBydW5HaXQobGlzdEFyZ3MsIG9wdGlvbnMpO1xuICBpZiAoIWxpc3RlZC5vayB8fCBsaXN0ZWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgQ291bGQgbm90IHN3ZWVwIGJyb2tlbiByZWZzOiAke2Rlc2NyaWJlKGxpc3RBcmdzLCBsaXN0ZWQpfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgY29uc3QgcmVmcyA9IGxpc3RlZC52YWx1ZS5zdGRvdXRcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcbiAgICAuZmlsdGVyKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG4gIGNvbnN0IHJlbW92ZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcmVmIG9mIHJlZnMpIHtcbiAgICBjb25zdCB2ZXJpZnlBcmdzID0gW1xuICAgICAgXCJyZXYtcGFyc2VcIixcbiAgICAgIFwiLS12ZXJpZnlcIixcbiAgICAgIFwiLS1xdWlldFwiLFxuICAgICAgXCItLWVuZC1vZi1vcHRpb25zXCIsXG4gICAgICBgJHtyZWZ9Xntjb21taXR9YCxcbiAgICBdO1xuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgcnVuR2l0KHZlcmlmeUFyZ3MsIG9wdGlvbnMpO1xuICAgIGlmICh2ZXJpZmllZC5vayAmJiB2ZXJpZmllZC52YWx1ZS5jb2RlID09PSAwKSBjb250aW51ZTtcblxuICAgIGNvbnN0IHJlbW92YWwgPSBhd2FpdCByZW1vdmVCcm9rZW5SZWYocmVmLCBvcHRpb25zLCBydW5HaXQpO1xuICAgIGlmICghcmVtb3ZhbC5vaykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgIGBDb3VsZCBub3Qgc3dlZXAgYnJva2VuIHJlZnM6IGZhaWxlZCB0byByZW1vdmUgJyR7cmVmfSc6ICR7cmVtb3ZhbC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cbiAgICByZW1vdmVkLnB1c2gocmVmKTtcbiAgfVxuXG4gIGNvbnN0IGZldGNoQXJncyA9IFtcImZldGNoXCIsIFwiLS1wcnVuZVwiLCBcIm9yaWdpblwiXTtcbiAgY29uc3QgZmV0Y2hlZCA9IGF3YWl0IHJ1bkdpdChmZXRjaEFyZ3MsIG9wdGlvbnMpO1xuICBpZiAoIWZldGNoZWQub2sgfHwgZmV0Y2hlZC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBDb3VsZCBub3Qgc3dlZXAgYnJva2VuIHJlZnM6ICR7ZGVzY3JpYmUoZmV0Y2hBcmdzLCBmZXRjaGVkKX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IHJlbW92ZWQgfSB9O1xufVxuXG4vKiogRGVzY3JpYmUgYSBnaXQgY29tbWFuZCBvdXRjb21lIGZvciBhbiBlcnJvciBtZXNzYWdlLiAqL1xuZnVuY3Rpb24gZGVzY3JpYmUoXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICByZXN1bHQ6IFJlc3VsdDxHaXRDb21tYW5kT3V0cHV0Pixcbik6IHN0cmluZyB7XG4gIGNvbnN0IGNvbW1hbmQgPSBgZ2l0ICR7YXJncy5qb2luKFwiIFwiKX1gO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIHJldHVybiBgJHtjb21tYW5kfTogJHtyZXN1bHQuZXJyb3IubWVzc2FnZX1gO1xuICB9XG4gIGNvbnN0IHsgY29kZSwgc3Rkb3V0LCBzdGRlcnIgfSA9IHJlc3VsdC52YWx1ZTtcbiAgY29uc3Qgb3V0cHV0ID0gc3RkZXJyLnRyaW0oKSB8fCBzdGRvdXQudHJpbSgpIHx8IFwiKG5vIG91dHB1dClcIjtcbiAgcmV0dXJuIGAke2NvbW1hbmR9IGV4aXRlZCAke2NvZGV9OiAke291dHB1dH1gO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQkMsR0FHRCxTQUFTLHNCQUFzQixRQUFRLG9CQUFvQjtBQUMzRCxTQUdFLGFBQWEsUUFDUixtQkFBbUI7QUFFMUIsZ0VBQWdFLEdBQ2hFLE1BQU0sc0JBQXlDO0VBQzdDO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRCw4REFBOEQsR0FDOUQsTUFBTSx1QkFBdUI7QUFFN0IsNEVBQTRFLEdBQzVFLFNBQVMsc0JBQXNCLEdBQVc7RUFDeEMsT0FBTyxJQUFJLFVBQVUsQ0FBQyxrQkFBa0IsSUFBSSxVQUFVLENBQUM7QUFDekQ7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sU0FBUyxhQUFhLElBQVk7RUFDdkMsTUFBTSxRQUFrQixFQUFFO0VBQzFCLE1BQU0sT0FBTyxJQUFJO0VBQ2pCLEtBQUssTUFBTSxXQUFXLG9CQUFxQjtJQUN6Qyx1RUFBdUU7SUFDdkUsd0RB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
// denoCacheMetadata=1908514894758483521,6434523372073005708