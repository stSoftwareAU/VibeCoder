/**
 * Deepen-on-demand helper for shallow clones (Issue #1502).
 *
 * When the worker clones repositories with `--depth 1` (see #1500, #1503),
 * operations that require full ancestry — commit-range `git log`,
 * `rev-list --count`, `git merge`, `git rebase` — will fail because the
 * common ancestor of the two refs is missing.
 *
 * This module provides two helpers:
 *
 *   - `isShallowRepo()` — detects whether the current repo is a shallow
 *     clone via `git rev-parse --is-shallow-repository`.
 *   - `ensureHistoryDepth(refs, options)` — if the repo is shallow and the
 *     given refs lack a common ancestor, fetches additional history in
 *     doubling steps (50, 100, 200, ...) up to a configurable maximum,
 *     then falls back to `git fetch --unshallow` as a last resort.
 *
 * On a non-shallow clone `ensureHistoryDepth` is a no-op — it does not
 * run any `fetch` subprocess.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ import { runGitCommand as defaultRunGitCommand } from "./git_timeout.ts";
/** Initial deepen step size (commits). */ export const INITIAL_DEEPEN_STEP = 50;
/** Default maximum cumulative deepen before falling back to --unshallow. */ export const DEFAULT_MAX_DEEPEN = 6400;
/**
 * Check whether the current repository is a shallow clone.
 *
 * Uses `git rev-parse --is-shallow-repository` which reports `true` when
 * a `.git/shallow` file exists. Available in Git 2.15+.
 *
 * @returns Result containing `true` if shallow, `false` if full.
 */ export async function isShallowRepo(options = {}) {
  const runner = options.gitRunner ?? defaultRunGitCommand;
  const result = await runner([
    "rev-parse",
    "--is-shallow-repository"
  ], stripInternalOptions(options));
  if (!result.ok) {
    return {
      ok: false,
      error: result.error
    };
  }
  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`git rev-parse --is-shallow-repository failed (exit ${result.value.code}): ${result.value.stderr.trim()}`)
    };
  }
  return {
    ok: true,
    value: result.value.stdout.trim() === "true"
  };
}
/**
 * Ensure the repository has enough history for the given refs to share a
 * common ancestor.
 *
 * Behaviour:
 *   1. If the repo is not shallow, returns ok immediately without running
 *      any fetch subprocess.
 *   2. If the refs already share a common ancestor, returns ok.
 *   3. Otherwise fetches additional history via `git fetch --deepen=<N>`
 *      with `N` starting at `initialStep` (default 50) and doubling each
 *      round, stopping when either the common ancestor is present or the
 *      cumulative deepen reaches `maxDeepen` (default 6400).
 *   4. As a last resort, runs `git fetch --unshallow`. If that still does
 *      not produce a common ancestor, returns an error.
 *
 * The common ancestor is detected via `git merge-base` across all
 * supplied refs.
 *
 * @param refs Two or more refs (e.g. ["main", "HEAD"]) that must share a
 *   common ancestor for the caller's operation to succeed.
 * @param options Deepen behaviour plus standard git options.
 * @returns Result<void> — ok on success, error when the ancestor cannot
 *   be produced even after --unshallow.
 */ export async function ensureHistoryDepth(refs, options = {}) {
  if (refs.length < 2) {
    // Nothing to anchor against — no deepening needed.
    return {
      ok: true,
      value: undefined
    };
  }
  const runner = options.gitRunner ?? defaultRunGitCommand;
  const gitOptions = stripInternalOptions(options);
  const remote = options.remote ?? "origin";
  const initialStep = Math.max(1, options.initialStep ?? INITIAL_DEEPEN_STEP);
  const maxDeepen = Math.max(initialStep, options.maxDeepen ?? DEFAULT_MAX_DEEPEN);
  // Fast path — non-shallow clones need no work.
  const shallow = await isShallowRepo({
    ...options
  });
  if (!shallow.ok) {
    return {
      ok: false,
      error: shallow.error
    };
  }
  if (!shallow.value) {
    return {
      ok: true,
      value: undefined
    };
  }
  // Already have the ancestor? Done.
  if (await hasCommonAncestor(runner, refs, gitOptions)) {
    return {
      ok: true,
      value: undefined
    };
  }
  // Deepen in doubling steps until the ancestor appears or we hit maxDeepen.
  let step = initialStep;
  let total = 0;
  while(total < maxDeepen){
    const thisStep = Math.min(step, maxDeepen - total);
    const fetchResult = await runner([
      "fetch",
      `--deepen=${thisStep}`,
      remote
    ], gitOptions);
    total += thisStep;
    // A failed deepen is non-fatal — break to the --unshallow fallback.
    if (!fetchResult.ok || fetchResult.value.code !== 0) {
      break;
    }
    if (await hasCommonAncestor(runner, refs, gitOptions)) {
      return {
        ok: true,
        value: undefined
      };
    }
    step = step * 2;
  }
  // Fallback: fully unshallow.
  const unshallowResult = await runner([
    "fetch",
    "--unshallow",
    remote
  ], gitOptions);
  if (!unshallowResult.ok || unshallowResult.value.code !== 0) {
    // Git refuses --unshallow on a complete repo with a non-zero exit — if
    // the repo is now full and the ancestor exists, treat this as success.
    const stillShallow = await isShallowRepo({
      ...options
    });
    if (stillShallow.ok && !stillShallow.value && await hasCommonAncestor(runner, refs, gitOptions)) {
      return {
        ok: true,
        value: undefined
      };
    }
    const errMsg = unshallowResult.ok ? unshallowResult.value.stderr.trim() : unshallowResult.error.message;
    return {
      ok: false,
      error: new Error(`Failed to deepen repo to find common ancestor of [${refs.join(", ")}]: ${errMsg}`)
    };
  }
  if (await hasCommonAncestor(runner, refs, gitOptions)) {
    return {
      ok: true,
      value: undefined
    };
  }
  return {
    ok: false,
    error: new Error(`Could not find common ancestor of [${refs.join(", ")}] after git fetch --unshallow`)
  };
}
/**
 * Return true when `git merge-base` produces a commit for the supplied refs.
 */ async function hasCommonAncestor(runner, refs, options) {
  const result = await runner([
    "merge-base",
    ...refs
  ], options);
  if (!result.ok) return false;
  if (result.value.code !== 0) return false;
  return result.value.stdout.trim().length > 0;
}
/**
 * Remove options fields that belong to this module and must not be
 * forwarded to `runGitCommand`.
 */ function stripInternalOptions(options) {
  const { cwd, timeoutSeconds, env } = options;
  const result = {};
  if (cwd !== undefined) result.cwd = cwd;
  if (timeoutSeconds !== undefined) result.timeoutSeconds = timeoutSeconds;
  if (env !== undefined) result.env = env;
  return result;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfaGlzdG9yeS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERlZXBlbi1vbi1kZW1hbmQgaGVscGVyIGZvciBzaGFsbG93IGNsb25lcyAoSXNzdWUgIzE1MDIpLlxuICpcbiAqIFdoZW4gdGhlIHdvcmtlciBjbG9uZXMgcmVwb3NpdG9yaWVzIHdpdGggYC0tZGVwdGggMWAgKHNlZSAjMTUwMCwgIzE1MDMpLFxuICogb3BlcmF0aW9ucyB0aGF0IHJlcXVpcmUgZnVsbCBhbmNlc3RyeSDigJQgY29tbWl0LXJhbmdlIGBnaXQgbG9nYCxcbiAqIGByZXYtbGlzdCAtLWNvdW50YCwgYGdpdCBtZXJnZWAsIGBnaXQgcmViYXNlYCDigJQgd2lsbCBmYWlsIGJlY2F1c2UgdGhlXG4gKiBjb21tb24gYW5jZXN0b3Igb2YgdGhlIHR3byByZWZzIGlzIG1pc3NpbmcuXG4gKlxuICogVGhpcyBtb2R1bGUgcHJvdmlkZXMgdHdvIGhlbHBlcnM6XG4gKlxuICogICAtIGBpc1NoYWxsb3dSZXBvKClgIOKAlCBkZXRlY3RzIHdoZXRoZXIgdGhlIGN1cnJlbnQgcmVwbyBpcyBhIHNoYWxsb3dcbiAqICAgICBjbG9uZSB2aWEgYGdpdCByZXYtcGFyc2UgLS1pcy1zaGFsbG93LXJlcG9zaXRvcnlgLlxuICogICAtIGBlbnN1cmVIaXN0b3J5RGVwdGgocmVmcywgb3B0aW9ucylgIOKAlCBpZiB0aGUgcmVwbyBpcyBzaGFsbG93IGFuZCB0aGVcbiAqICAgICBnaXZlbiByZWZzIGxhY2sgYSBjb21tb24gYW5jZXN0b3IsIGZldGNoZXMgYWRkaXRpb25hbCBoaXN0b3J5IGluXG4gKiAgICAgZG91Ymxpbmcgc3RlcHMgKDUwLCAxMDAsIDIwMCwgLi4uKSB1cCB0byBhIGNvbmZpZ3VyYWJsZSBtYXhpbXVtLFxuICogICAgIHRoZW4gZmFsbHMgYmFjayB0byBgZ2l0IGZldGNoIC0tdW5zaGFsbG93YCBhcyBhIGxhc3QgcmVzb3J0LlxuICpcbiAqIE9uIGEgbm9uLXNoYWxsb3cgY2xvbmUgYGVuc3VyZUhpc3RvcnlEZXB0aGAgaXMgYSBuby1vcCDigJQgaXQgZG9lcyBub3RcbiAqIHJ1biBhbnkgYGZldGNoYCBzdWJwcm9jZXNzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kIGFzIGRlZmF1bHRSdW5HaXRDb21tYW5kIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB0eXBlIHsgR2l0Q29tbWFuZE9wdGlvbnMsIEdpdENvbW1hbmRPdXRwdXQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuXG4vKiogSW5pdGlhbCBkZWVwZW4gc3RlcCBzaXplIChjb21taXRzKS4gKi9cbmV4cG9ydCBjb25zdCBJTklUSUFMX0RFRVBFTl9TVEVQID0gNTA7XG5cbi8qKiBEZWZhdWx0IG1heGltdW0gY3VtdWxhdGl2ZSBkZWVwZW4gYmVmb3JlIGZhbGxpbmcgYmFjayB0byAtLXVuc2hhbGxvdy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX01BWF9ERUVQRU4gPSA2NDAwO1xuXG4vKipcbiAqIFNpZ25hdHVyZSBvZiBhIGdpdCBydW5uZXIgZnVuY3Rpb24uIE1hdGNoZXMgYHJ1bkdpdENvbW1hbmRgIGluXG4gKiBgZ2l0X3RpbWVvdXQudHNgOyBhY2NlcHRlZCBhcyBhbiBvcHRpb24gdG8gbWFrZSB0aGlzIG1vZHVsZSB0ZXN0YWJsZVxuICogd2l0aG91dCBzcGF3bmluZyByZWFsIGdpdCBzdWJwcm9jZXNzZXMuXG4gKi9cbmV4cG9ydCB0eXBlIEdpdFJ1bm5lciA9IChcbiAgYXJnczogc3RyaW5nW10sXG4gIG9wdGlvbnM/OiBHaXRDb21tYW5kT3B0aW9ucyxcbikgPT4gUHJvbWlzZTxSZXN1bHQ8R2l0Q29tbWFuZE91dHB1dD4+O1xuXG4vKiogT3B0aW9ucyBmb3IgYGVuc3VyZUhpc3RvcnlEZXB0aGAuICovXG5leHBvcnQgaW50ZXJmYWNlIEVuc3VyZUhpc3RvcnlEZXB0aE9wdGlvbnMgZXh0ZW5kcyBHaXRDb21tYW5kT3B0aW9ucyB7XG4gIC8qKiBJbml0aWFsIGRlZXBlbiBzdGVwLCBkZWZhdWx0IDUwLiAqL1xuICBpbml0aWFsU3RlcD86IG51bWJlcjtcbiAgLyoqIE1heGltdW0gY3VtdWxhdGl2ZSBkZWVwZW4gYmVmb3JlIC0tdW5zaGFsbG93LCBkZWZhdWx0IDY0MDAuICovXG4gIG1heERlZXBlbj86IG51bWJlcjtcbiAgLyoqIFJlbW90ZSBuYW1lIHRvIGRlZXBlbiBmcm9tLCBkZWZhdWx0IFwib3JpZ2luXCIuICovXG4gIHJlbW90ZT86IHN0cmluZztcbiAgLyoqIEN1c3RvbSBnaXQgcnVubmVyICh0ZXN0cyBvbmx5KS4gKi9cbiAgZ2l0UnVubmVyPzogR2l0UnVubmVyO1xufVxuXG4vKiogT3B0aW9ucyBmb3IgYGlzU2hhbGxvd1JlcG9gLiAqL1xuZXhwb3J0IGludGVyZmFjZSBJc1NoYWxsb3dPcHRpb25zIGV4dGVuZHMgR2l0Q29tbWFuZE9wdGlvbnMge1xuICAvKiogQ3VzdG9tIGdpdCBydW5uZXIgKHRlc3RzIG9ubHkpLiAqL1xuICBnaXRSdW5uZXI/OiBHaXRSdW5uZXI7XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciB0aGUgY3VycmVudCByZXBvc2l0b3J5IGlzIGEgc2hhbGxvdyBjbG9uZS5cbiAqXG4gKiBVc2VzIGBnaXQgcmV2LXBhcnNlIC0taXMtc2hhbGxvdy1yZXBvc2l0b3J5YCB3aGljaCByZXBvcnRzIGB0cnVlYCB3aGVuXG4gKiBhIGAuZ2l0L3NoYWxsb3dgIGZpbGUgZXhpc3RzLiBBdmFpbGFibGUgaW4gR2l0IDIuMTUrLlxuICpcbiAqIEByZXR1cm5zIFJlc3VsdCBjb250YWluaW5nIGB0cnVlYCBpZiBzaGFsbG93LCBgZmFsc2VgIGlmIGZ1bGwuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpc1NoYWxsb3dSZXBvKFxuICBvcHRpb25zOiBJc1NoYWxsb3dPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxib29sZWFuLCBFcnJvcj4+IHtcbiAgY29uc3QgcnVubmVyID0gb3B0aW9ucy5naXRSdW5uZXIgPz8gZGVmYXVsdFJ1bkdpdENvbW1hbmQ7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bm5lcihcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLWlzLXNoYWxsb3ctcmVwb3NpdG9yeVwiXSxcbiAgICBzdHJpcEludGVybmFsT3B0aW9ucyhvcHRpb25zKSxcbiAgKTtcblxuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHJlc3VsdC5lcnJvciB9O1xuICB9XG5cbiAgaWYgKHJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBnaXQgcmV2LXBhcnNlIC0taXMtc2hhbGxvdy1yZXBvc2l0b3J5IGZhaWxlZCAoZXhpdCAke3Jlc3VsdC52YWx1ZS5jb2RlfSk6ICR7cmVzdWx0LnZhbHVlLnN0ZGVyci50cmltKCl9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCkgPT09IFwidHJ1ZVwiIH07XG59XG5cbi8qKlxuICogRW5zdXJlIHRoZSByZXBvc2l0b3J5IGhhcyBlbm91Z2ggaGlzdG9yeSBmb3IgdGhlIGdpdmVuIHJlZnMgdG8gc2hhcmUgYVxuICogY29tbW9uIGFuY2VzdG9yLlxuICpcbiAqIEJlaGF2aW91cjpcbiAqICAgMS4gSWYgdGhlIHJlcG8gaXMgbm90IHNoYWxsb3csIHJldHVybnMgb2sgaW1tZWRpYXRlbHkgd2l0aG91dCBydW5uaW5nXG4gKiAgICAgIGFueSBmZXRjaCBzdWJwcm9jZXNzLlxuICogICAyLiBJZiB0aGUgcmVmcyBhbHJlYWR5IHNoYXJlIGEgY29tbW9uIGFuY2VzdG9yLCByZXR1cm5zIG9rLlxuICogICAzLiBPdGhlcndpc2UgZmV0Y2hlcyBhZGRpdGlvbmFsIGhpc3RvcnkgdmlhIGBnaXQgZmV0Y2ggLS1kZWVwZW49PE4+YFxuICogICAgICB3aXRoIGBOYCBzdGFydGluZyBhdCBgaW5pdGlhbFN0ZXBgIChkZWZhdWx0IDUwKSBhbmQgZG91YmxpbmcgZWFjaFxuICogICAgICByb3VuZCwgc3RvcHBpbmcgd2hlbiBlaXRoZXIgdGhlIGNvbW1vbiBhbmNlc3RvciBpcyBwcmVzZW50IG9yIHRoZVxuICogICAgICBjdW11bGF0aXZlIGRlZXBlbiByZWFjaGVzIGBtYXhEZWVwZW5gIChkZWZhdWx0IDY0MDApLlxuICogICA0LiBBcyBhIGxhc3QgcmVzb3J0LCBydW5zIGBnaXQgZmV0Y2ggLS11bnNoYWxsb3dgLiBJZiB0aGF0IHN0aWxsIGRvZXNcbiAqICAgICAgbm90IHByb2R1Y2UgYSBjb21tb24gYW5jZXN0b3IsIHJldHVybnMgYW4gZXJyb3IuXG4gKlxuICogVGhlIGNvbW1vbiBhbmNlc3RvciBpcyBkZXRlY3RlZCB2aWEgYGdpdCBtZXJnZS1iYXNlYCBhY3Jvc3MgYWxsXG4gKiBzdXBwbGllZCByZWZzLlxuICpcbiAqIEBwYXJhbSByZWZzIFR3byBvciBtb3JlIHJlZnMgKGUuZy4gW1wibWFpblwiLCBcIkhFQURcIl0pIHRoYXQgbXVzdCBzaGFyZSBhXG4gKiAgIGNvbW1vbiBhbmNlc3RvciBmb3IgdGhlIGNhbGxlcidzIG9wZXJhdGlvbiB0byBzdWNjZWVkLlxuICogQHBhcmFtIG9wdGlvbnMgRGVlcGVuIGJlaGF2aW91ciBwbHVzIHN0YW5kYXJkIGdpdCBvcHRpb25zLlxuICogQHJldHVybnMgUmVzdWx0PHZvaWQ+IOKAlCBvayBvbiBzdWNjZXNzLCBlcnJvciB3aGVuIHRoZSBhbmNlc3RvciBjYW5ub3RcbiAqICAgYmUgcHJvZHVjZWQgZXZlbiBhZnRlciAtLXVuc2hhbGxvdy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuc3VyZUhpc3RvcnlEZXB0aChcbiAgcmVmczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IEVuc3VyZUhpc3RvcnlEZXB0aE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQsIEVycm9yPj4ge1xuICBpZiAocmVmcy5sZW5ndGggPCAyKSB7XG4gICAgLy8gTm90aGluZyB0byBhbmNob3IgYWdhaW5zdCDigJQgbm8gZGVlcGVuaW5nIG5lZWRlZC5cbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgY29uc3QgcnVubmVyID0gb3B0aW9ucy5naXRSdW5uZXIgPz8gZGVmYXVsdFJ1bkdpdENvbW1hbmQ7XG4gIGNvbnN0IGdpdE9wdGlvbnMgPSBzdHJpcEludGVybmFsT3B0aW9ucyhvcHRpb25zKTtcbiAgY29uc3QgcmVtb3RlID0gb3B0aW9ucy5yZW1vdGUgPz8gXCJvcmlnaW5cIjtcbiAgY29uc3QgaW5pdGlhbFN0ZXAgPSBNYXRoLm1heCgxLCBvcHRpb25zLmluaXRpYWxTdGVwID8/IElOSVRJQUxfREVFUEVOX1NURVApO1xuICBjb25zdCBtYXhEZWVwZW4gPSBNYXRoLm1heChcbiAgICBpbml0aWFsU3RlcCxcbiAgICBvcHRpb25zLm1heERlZXBlbiA/PyBERUZBVUxUX01BWF9ERUVQRU4sXG4gICk7XG5cbiAgLy8gRmFzdCBwYXRoIOKAlCBub24tc2hhbGxvdyBjbG9uZXMgbmVlZCBubyB3b3JrLlxuICBjb25zdCBzaGFsbG93ID0gYXdhaXQgaXNTaGFsbG93UmVwbyh7IC4uLm9wdGlvbnMgfSk7XG4gIGlmICghc2hhbGxvdy5vaykge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHNoYWxsb3cuZXJyb3IgfTtcbiAgfVxuICBpZiAoIXNoYWxsb3cudmFsdWUpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgLy8gQWxyZWFkeSBoYXZlIHRoZSBhbmNlc3Rvcj8gRG9uZS5cbiAgaWYgKGF3YWl0IGhhc0NvbW1vbkFuY2VzdG9yKHJ1bm5lciwgcmVmcywgZ2l0T3B0aW9ucykpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgLy8gRGVlcGVuIGluIGRvdWJsaW5nIHN0ZXBzIHVudGlsIHRoZSBhbmNlc3RvciBhcHBlYXJzIG9yIHdlIGhpdCBtYXhEZWVwZW4uXG4gIGxldCBzdGVwID0gaW5pdGlhbFN0ZXA7XG4gIGxldCB0b3RhbCA9IDA7XG4gIHdoaWxlICh0b3RhbCA8IG1heERlZXBlbikge1xuICAgIGNvbnN0IHRoaXNTdGVwID0gTWF0aC5taW4oc3RlcCwgbWF4RGVlcGVuIC0gdG90YWwpO1xuICAgIGNvbnN0IGZldGNoUmVzdWx0ID0gYXdhaXQgcnVubmVyKFxuICAgICAgW1wiZmV0Y2hcIiwgYC0tZGVlcGVuPSR7dGhpc1N0ZXB9YCwgcmVtb3RlXSxcbiAgICAgIGdpdE9wdGlvbnMsXG4gICAgKTtcbiAgICB0b3RhbCArPSB0aGlzU3RlcDtcblxuICAgIC8vIEEgZmFpbGVkIGRlZXBlbiBpcyBub24tZmF0YWwg4oCUIGJyZWFrIHRvIHRoZSAtLXVuc2hhbGxvdyBmYWxsYmFjay5cbiAgICBpZiAoIWZldGNoUmVzdWx0Lm9rIHx8IGZldGNoUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIGlmIChhd2FpdCBoYXNDb21tb25BbmNlc3RvcihydW5uZXIsIHJlZnMsIGdpdE9wdGlvbnMpKSB7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICAgIH1cblxuICAgIHN0ZXAgPSBzdGVwICogMjtcbiAgfVxuXG4gIC8vIEZhbGxiYWNrOiBmdWxseSB1bnNoYWxsb3cuXG4gIGNvbnN0IHVuc2hhbGxvd1Jlc3VsdCA9IGF3YWl0IHJ1bm5lcihcbiAgICBbXCJmZXRjaFwiLCBcIi0tdW5zaGFsbG93XCIsIHJlbW90ZV0sXG4gICAgZ2l0T3B0aW9ucyxcbiAgKTtcbiAgaWYgKCF1bnNoYWxsb3dSZXN1bHQub2sgfHwgdW5zaGFsbG93UmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAvLyBHaXQgcmVmdXNlcyAtLXVuc2hhbGxvdyBvbiBhIGNvbXBsZXRlIHJlcG8gd2l0aCBhIG5vbi16ZXJvIGV4aXQg4oCUIGlmXG4gICAgLy8gdGhlIHJlcG8gaXMgbm93IGZ1bGwgYW5kIHRoZSBhbmNlc3RvciBleGlzdHMsIHRyZWF0IHRoaXMgYXMgc3VjY2Vzcy5cbiAgICBjb25zdCBzdGlsbFNoYWxsb3cgPSBhd2FpdCBpc1NoYWxsb3dSZXBvKHsgLi4ub3B0aW9ucyB9KTtcbiAgICBpZiAoXG4gICAgICBzdGlsbFNoYWxsb3cub2sgJiYgIXN0aWxsU2hhbGxvdy52YWx1ZSAmJlxuICAgICAgYXdhaXQgaGFzQ29tbW9uQW5jZXN0b3IocnVubmVyLCByZWZzLCBnaXRPcHRpb25zKVxuICAgICkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgICB9XG4gICAgY29uc3QgZXJyTXNnID0gdW5zaGFsbG93UmVzdWx0Lm9rXG4gICAgICA/IHVuc2hhbGxvd1Jlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpXG4gICAgICA6IHVuc2hhbGxvd1Jlc3VsdC5lcnJvci5tZXNzYWdlO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgRmFpbGVkIHRvIGRlZXBlbiByZXBvIHRvIGZpbmQgY29tbW9uIGFuY2VzdG9yIG9mIFske1xuICAgICAgICAgIHJlZnMuam9pbihcIiwgXCIpXG4gICAgICAgIH1dOiAke2Vyck1zZ31gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGF3YWl0IGhhc0NvbW1vbkFuY2VzdG9yKHJ1bm5lciwgcmVmcywgZ2l0T3B0aW9ucykpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgIGBDb3VsZCBub3QgZmluZCBjb21tb24gYW5jZXN0b3Igb2YgWyR7XG4gICAgICAgIHJlZnMuam9pbihcIiwgXCIpXG4gICAgICB9XSBhZnRlciBnaXQgZmV0Y2ggLS11bnNoYWxsb3dgLFxuICAgICksXG4gIH07XG59XG5cbi8qKlxuICogUmV0dXJuIHRydWUgd2hlbiBgZ2l0IG1lcmdlLWJhc2VgIHByb2R1Y2VzIGEgY29tbWl0IGZvciB0aGUgc3VwcGxpZWQgcmVmcy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFzQ29tbW9uQW5jZXN0b3IoXG4gIHJ1bm5lcjogR2l0UnVubmVyLFxuICByZWZzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVubmVyKFtcIm1lcmdlLWJhc2VcIiwgLi4ucmVmc10sIG9wdGlvbnMpO1xuICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIGZhbHNlO1xuICBpZiAocmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpLmxlbmd0aCA+IDA7XG59XG5cbi8qKlxuICogUmVtb3ZlIG9wdGlvbnMgZmllbGRzIHRoYXQgYmVsb25nIHRvIHRoaXMgbW9kdWxlIGFuZCBtdXN0IG5vdCBiZVxuICogZm9yd2FyZGVkIHRvIGBydW5HaXRDb21tYW5kYC5cbiAqL1xuZnVuY3Rpb24gc3RyaXBJbnRlcm5hbE9wdGlvbnMoXG4gIG9wdGlvbnM6IEVuc3VyZUhpc3RvcnlEZXB0aE9wdGlvbnMgfCBJc1NoYWxsb3dPcHRpb25zLFxuKTogR2l0Q29tbWFuZE9wdGlvbnMge1xuICBjb25zdCB7IGN3ZCwgdGltZW91dFNlY29uZHMsIGVudiB9ID0gb3B0aW9ucztcbiAgY29uc3QgcmVzdWx0OiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9O1xuICBpZiAoY3dkICE9PSB1bmRlZmluZWQpIHJlc3VsdC5jd2QgPSBjd2Q7XG4gIGlmICh0aW1lb3V0U2Vjb25kcyAhPT0gdW5kZWZpbmVkKSByZXN1bHQudGltZW91dFNlY29uZHMgPSB0aW1lb3V0U2Vjb25kcztcbiAgaWYgKGVudiAhPT0gdW5kZWZpbmVkKSByZXN1bHQuZW52ID0gZW52O1xuICByZXR1cm4gcmVzdWx0O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FxQkMsR0FHRCxTQUFTLGlCQUFpQixvQkFBb0IsUUFBUSxtQkFBbUI7QUFHekUsd0NBQXdDLEdBQ3hDLE9BQU8sTUFBTSxzQkFBc0IsR0FBRztBQUV0QywwRUFBMEUsR0FDMUUsT0FBTyxNQUFNLHFCQUFxQixLQUFLO0FBOEJ2Qzs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxlQUFlLGNBQ3BCLFVBQTRCLENBQUMsQ0FBQztFQUU5QixNQUFNLFNBQVMsUUFBUSxTQUFTLElBQUk7RUFDcEMsTUFBTSxTQUFTLE1BQU0sT0FDbkI7SUFBQztJQUFhO0dBQTBCLEVBQ3hDLHFCQUFxQjtFQUd2QixJQUFJLENBQUMsT0FBTyxFQUFFLEVBQUU7SUFDZCxPQUFPO01BQUUsSUFBSTtNQUFPLE9BQU8sT0FBTyxLQUFLO0lBQUM7RUFDMUM7RUFFQSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHO0lBQzNCLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxJQUFJLE1BQ1QsQ0FBQyxtREFBbUQsRUFBRSxPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLElBQUk7SUFFN0c7RUFDRjtFQUVBLE9BQU87SUFB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
// denoCacheMetadata=16476837675488237217,1156069278526924571