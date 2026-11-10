/**
 * Remote-head resolution and honest unpushed counting (Issue #211).
 *
 * `git rev-list --count HEAD --not --remotes=origin` only answers "how many of
 * my commits are unpushed" when a remote-tracking ref exists for the branch.
 * When it does not — a single-branch clone, whose `remote.origin.fetch` covers
 * only the default branch, never gains `refs/remotes/origin/<feature>` even
 * after a successful `git push -u` — the count silently degrades to "commits
 * ahead of the default branch". A perfectly good push then reports 4 commits
 * still unpushed, which triggered a bogus recovery, a "please check the branch
 * status" comment to a human, and a spurious `merge-conflict` label on a PR
 * that was mergeable (NEAT-AI-core #557, #563).
 *
 * The fix is to measure against the branch's *own* remote head:
 *   1. `refs/remotes/origin/<branch>` when it exists (free, offline, and kept
 *      current by git itself on any clone with a wildcard fetch refspec);
 *   2. otherwise `git ls-remote --heads origin <branch>` — authoritative
 *      regardless of the local refspec;
 *   3. and when the branch genuinely is not on the remote, every commit not
 *      reachable from an origin ref is unpushed (the first-push case).
 *
 * Fails loud: when neither the tracking ref nor `ls-remote` can answer, the
 * count is unknowable and an error Result carrying git's own stderr is
 * returned rather than a fabricated 0.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { assertSafeGitRef, buildFetchArgs } from "./git_ref_args.ts";
import { runGitCommand } from "./git_timeout.ts";
/** Matches a full git object id (SHA-1 or SHA-256). */ const OBJECT_ID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/**
 * Resolve the remote head of a branch (Issue #211).
 *
 * @param branchName - The branch to resolve (untrusted positional)
 * @param options - Git command options (cwd selects the repo)
 * @returns The remote head SHA and its source, or an error Result when the
 *   remote state cannot be determined at all.
 */ export async function resolveRemoteBranchHead(branchName, options = {}) {
  try {
    assertSafeGitRef(branchName, "branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
  // 1. The remote-tracking ref, when the clone keeps one for this branch.
  const trackingResult = await runGitCommand([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${branchName}`
  ], options);
  if (trackingResult.ok && trackingResult.value.code === 0) {
    const sha = trackingResult.value.stdout.trim();
    if (OBJECT_ID_PATTERN.test(sha)) {
      return {
        ok: true,
        value: {
          sha,
          source: "tracking-ref"
        }
      };
    }
  }
  // 2. Ask the remote directly — correct on a single-branch clone, and on any
  //    clone whose tracking ref was never fetched or has been pruned.
  const lsRemoteResult = await runGitCommand([
    "ls-remote",
    "--heads",
    "--end-of-options",
    "origin",
    branchName
  ], options);
  if (!lsRemoteResult.ok) {
    return {
      ok: false,
      error: new Error(`Cannot determine the remote head of '${branchName}': ` + `git ls-remote failed: ${lsRemoteResult.error.message}`)
    };
  }
  if (lsRemoteResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Cannot determine the remote head of '${branchName}': ` + `git ls-remote exited ${lsRemoteResult.value.code}: ` + `${lsRemoteResult.value.stderr.trim() || "no stderr"}`)
    };
  }
  const sha = parseLsRemoteSha(lsRemoteResult.value.stdout, branchName);
  if (sha === null) {
    // 3. The branch really is not on the remote yet (first push).
    return {
      ok: true,
      value: {
        sha: null,
        source: "absent"
      }
    };
  }
  return {
    ok: true,
    value: {
      sha,
      source: "ls-remote"
    }
  };
}
/**
 * Extract the SHA for `refs/heads/<branchName>` from `git ls-remote` output.
 *
 * Exported for testing: the output is one `<sha>\t<ref>` line per matching
 * ref, and `--heads <pattern>` matches by suffix, so `feature` would also
 * match `refs/heads/other/feature` — only the exact ref counts.
 *
 * @param stdout - Raw `git ls-remote` output
 * @param branchName - The branch whose ref to match exactly
 * @returns The SHA, or null when the exact ref is absent
 */ export function parseLsRemoteSha(stdout, branchName) {
  for (const line of stdout.split("\n")){
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref !== `refs/heads/${branchName}`) continue;
    if (!OBJECT_ID_PATTERN.test(sha)) continue;
    return sha;
  }
  return null;
}
/**
 * Resolve the remote head of a branch and count what `HEAD` has beyond it
 * (Issue #211).
 *
 * Callers that need both facts (the push path needs to know whether the branch
 * exists remotely at all) use this to pay for the remote lookup once.
 *
 * @param branchName - The branch being pushed (untrusted positional)
 * @param options - Git command options (cwd selects the repo)
 * @returns The remote head, its source, and the unpushed count — or an error
 *   Result when the remote state cannot be determined.
 */ export async function describeUnpushedCommits(branchName, options = {}) {
  const headResult = await resolveRemoteBranchHead(branchName, options);
  if (!headResult.ok) {
    return {
      ok: false,
      error: headResult.error
    };
  }
  const { sha, source } = headResult.value;
  const countResult = await countAgainstRemoteHead(sha, branchName, options);
  if (!countResult.ok) {
    return {
      ok: false,
      error: countResult.error
    };
  }
  return {
    ok: true,
    value: {
      sha,
      source,
      count: countResult.value
    }
  };
}
/**
 * Count the commits on `HEAD` that the branch's remote head does not have
 * (Issue #211).
 *
 * @param branchName - The branch being pushed (untrusted positional)
 * @param options - Git command options (cwd selects the repo)
 * @returns The number of unpushed commits (0 = fully pushed), or an error
 *   Result when the remote state cannot be determined.
 */ export async function countUnpushedCommits(branchName, options = {}) {
  const state = await describeUnpushedCommits(branchName, options);
  return state.ok ? {
    ok: true,
    value: state.value.count
  } : state;
}
/**
 * Count `HEAD` against a resolved remote head.
 *
 * @param sha - The remote head SHA, or null when the branch is not on the remote
 * @param branchName - The branch being counted (for messages and the fetch)
 * @param options - Git command options
 * @returns The unpushed commit count
 */ async function countAgainstRemoteHead(sha, branchName, options) {
  // The branch is not on the remote — everything not reachable from an origin
  // ref is unpushed. This is the only case `--remotes=origin` answers
  // correctly, and it is the first-push case.
  if (sha === null) {
    return await countRevList([
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      "--remotes=origin"
    ], options, `count commits not yet on origin for '${branchName}'`);
  }
  const localHead = await runGitCommand([
    "rev-parse",
    "HEAD"
  ], options);
  if (localHead.ok && localHead.value.code === 0) {
    if (localHead.value.stdout.trim() === sha) return {
      ok: true,
      value: 0
    };
  }
  // Count against the remote head. The object may be missing locally on a
  // shallow clone or when a sibling pushed it, so fetch the branch once
  // before giving up.
  const direct = await countRevList([
    "rev-list",
    "--count",
    `${sha}..HEAD`
  ], options, `count commits ahead of origin/${branchName}`);
  if (direct.ok) return direct;
  const fetchResult = await runGitCommand(buildFetchArgs("origin", branchName), options);
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    const detail = fetchResult.ok ? fetchResult.value.stderr.trim() || `exit ${fetchResult.value.code}` : fetchResult.error.message;
    return {
      ok: false,
      error: new Error(`Cannot count unpushed commits for '${branchName}': the remote head ` + `${sha} is not present locally and fetching it failed: ${detail}`)
    };
  }
  return await countRevList([
    "rev-list",
    "--count",
    `${sha}..HEAD`
  ], options, `count commits ahead of origin/${branchName} after fetch`);
}
/**
 * Run a `rev-list --count` and parse its output, failing loud on a bad exit.
 *
 * @param args - Full git argv
 * @param options - Git command options
 * @param what - Short description used in the error message
 * @returns The parsed count, or an error Result carrying git's stderr
 */ async function countRevList(args, options, what) {
  const result = await runGitCommand(args, options);
  if (!result.ok) {
    return {
      ok: false,
      error: new Error(`Failed to ${what}: ${result.error.message}`)
    };
  }
  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Failed to ${what}: git exited ${result.value.code}: ` + `${result.value.stderr.trim() || "no stderr"}`)
    };
  }
  const parsed = parseInt(result.value.stdout.trim(), 10);
  if (Number.isNaN(parsed)) {
    return {
      ok: false,
      error: new Error(`Failed to ${what}: git printed '${result.value.stdout.trim()}'`)
    };
  }
  return {
    ok: true,
    value: parsed
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfcmVtb3RlX2hlYWQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZW1vdGUtaGVhZCByZXNvbHV0aW9uIGFuZCBob25lc3QgdW5wdXNoZWQgY291bnRpbmcgKElzc3VlICMyMTEpLlxuICpcbiAqIGBnaXQgcmV2LWxpc3QgLS1jb3VudCBIRUFEIC0tbm90IC0tcmVtb3Rlcz1vcmlnaW5gIG9ubHkgYW5zd2VycyBcImhvdyBtYW55IG9mXG4gKiBteSBjb21taXRzIGFyZSB1bnB1c2hlZFwiIHdoZW4gYSByZW1vdGUtdHJhY2tpbmcgcmVmIGV4aXN0cyBmb3IgdGhlIGJyYW5jaC5cbiAqIFdoZW4gaXQgZG9lcyBub3Qg4oCUIGEgc2luZ2xlLWJyYW5jaCBjbG9uZSwgd2hvc2UgYHJlbW90ZS5vcmlnaW4uZmV0Y2hgIGNvdmVyc1xuICogb25seSB0aGUgZGVmYXVsdCBicmFuY2gsIG5ldmVyIGdhaW5zIGByZWZzL3JlbW90ZXMvb3JpZ2luLzxmZWF0dXJlPmAgZXZlblxuICogYWZ0ZXIgYSBzdWNjZXNzZnVsIGBnaXQgcHVzaCAtdWAg4oCUIHRoZSBjb3VudCBzaWxlbnRseSBkZWdyYWRlcyB0byBcImNvbW1pdHNcbiAqIGFoZWFkIG9mIHRoZSBkZWZhdWx0IGJyYW5jaFwiLiBBIHBlcmZlY3RseSBnb29kIHB1c2ggdGhlbiByZXBvcnRzIDQgY29tbWl0c1xuICogc3RpbGwgdW5wdXNoZWQsIHdoaWNoIHRyaWdnZXJlZCBhIGJvZ3VzIHJlY292ZXJ5LCBhIFwicGxlYXNlIGNoZWNrIHRoZSBicmFuY2hcbiAqIHN0YXR1c1wiIGNvbW1lbnQgdG8gYSBodW1hbiwgYW5kIGEgc3B1cmlvdXMgYG1lcmdlLWNvbmZsaWN0YCBsYWJlbCBvbiBhIFBSXG4gKiB0aGF0IHdhcyBtZXJnZWFibGUgKE5FQVQtQUktY29yZSAjNTU3LCAjNTYzKS5cbiAqXG4gKiBUaGUgZml4IGlzIHRvIG1lYXN1cmUgYWdhaW5zdCB0aGUgYnJhbmNoJ3MgKm93biogcmVtb3RlIGhlYWQ6XG4gKiAgIDEuIGByZWZzL3JlbW90ZXMvb3JpZ2luLzxicmFuY2g+YCB3aGVuIGl0IGV4aXN0cyAoZnJlZSwgb2ZmbGluZSwgYW5kIGtlcHRcbiAqICAgICAgY3VycmVudCBieSBnaXQgaXRzZWxmIG9uIGFueSBjbG9uZSB3aXRoIGEgd2lsZGNhcmQgZmV0Y2ggcmVmc3BlYyk7XG4gKiAgIDIuIG90aGVyd2lzZSBgZ2l0IGxzLXJlbW90ZSAtLWhlYWRzIG9yaWdpbiA8YnJhbmNoPmAg4oCUIGF1dGhvcml0YXRpdmVcbiAqICAgICAgcmVnYXJkbGVzcyBvZiB0aGUgbG9jYWwgcmVmc3BlYztcbiAqICAgMy4gYW5kIHdoZW4gdGhlIGJyYW5jaCBnZW51aW5lbHkgaXMgbm90IG9uIHRoZSByZW1vdGUsIGV2ZXJ5IGNvbW1pdCBub3RcbiAqICAgICAgcmVhY2hhYmxlIGZyb20gYW4gb3JpZ2luIHJlZiBpcyB1bnB1c2hlZCAodGhlIGZpcnN0LXB1c2ggY2FzZSkuXG4gKlxuICogRmFpbHMgbG91ZDogd2hlbiBuZWl0aGVyIHRoZSB0cmFja2luZyByZWYgbm9yIGBscy1yZW1vdGVgIGNhbiBhbnN3ZXIsIHRoZVxuICogY291bnQgaXMgdW5rbm93YWJsZSBhbmQgYW4gZXJyb3IgUmVzdWx0IGNhcnJ5aW5nIGdpdCdzIG93biBzdGRlcnIgaXNcbiAqIHJldHVybmVkIHJhdGhlciB0aGFuIGEgZmFicmljYXRlZCAwLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnRTYWZlR2l0UmVmLCBidWlsZEZldGNoQXJncyB9IGZyb20gXCIuL2dpdF9yZWZfYXJncy50c1wiO1xuaW1wb3J0IHsgcnVuR2l0Q29tbWFuZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdpdENvbW1hbmRPcHRpb25zIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcblxuLyoqIE1hdGNoZXMgYSBmdWxsIGdpdCBvYmplY3QgaWQgKFNIQS0xIG9yIFNIQS0yNTYpLiAqL1xuY29uc3QgT0JKRUNUX0lEX1BBVFRFUk4gPSAvXlswLTlhLWZdezQwfShbMC05YS1mXXsyNH0pPyQvO1xuXG4vKiogV2hlcmUgYSBicmFuY2gncyByZW1vdGUgaGVhZCBjYW1lIGZyb20uICovXG5leHBvcnQgdHlwZSBSZW1vdGVIZWFkU291cmNlID0gXCJ0cmFja2luZy1yZWZcIiB8IFwibHMtcmVtb3RlXCIgfCBcImFic2VudFwiO1xuXG4vKiogVGhlIHJlbW90ZSBoZWFkIG9mIGEgYnJhbmNoLCBhbmQgaG93IGl0IHdhcyByZXNvbHZlZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVtb3RlQnJhbmNoSGVhZCB7XG4gIC8qKiBUaGUgcmVtb3RlIGhlYWQgU0hBLCBvciBgbnVsbGAgd2hlbiB0aGUgYnJhbmNoIGlzIG5vdCBvbiB0aGUgcmVtb3RlLiAqL1xuICBzaGE6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBIb3cgdGhlIGFuc3dlciB3YXMgb2J0YWluZWQuICovXG4gIHNvdXJjZTogUmVtb3RlSGVhZFNvdXJjZTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSByZW1vdGUgaGVhZCBvZiBhIGJyYW5jaCAoSXNzdWUgIzIxMSkuXG4gKlxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgYnJhbmNoIHRvIHJlc29sdmUgKHVudHJ1c3RlZCBwb3NpdGlvbmFsKVxuICogQHBhcmFtIG9wdGlvbnMgLSBHaXQgY29tbWFuZCBvcHRpb25zIChjd2Qgc2VsZWN0cyB0aGUgcmVwbylcbiAqIEByZXR1cm5zIFRoZSByZW1vdGUgaGVhZCBTSEEgYW5kIGl0cyBzb3VyY2UsIG9yIGFuIGVycm9yIFJlc3VsdCB3aGVuIHRoZVxuICogICByZW1vdGUgc3RhdGUgY2Fubm90IGJlIGRldGVybWluZWQgYXQgYWxsLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZVJlbW90ZUJyYW5jaEhlYWQoXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVzdWx0PFJlbW90ZUJyYW5jaEhlYWQ+PiB7XG4gIHRyeSB7XG4gICAgYXNzZXJ0U2FmZUdpdFJlZihicmFuY2hOYW1lLCBcImJyYW5jaCBuYW1lXCIpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gMS4gVGhlIHJlbW90ZS10cmFja2luZyByZWYsIHdoZW4gdGhlIGNsb25lIGtlZXBzIG9uZSBmb3IgdGhpcyBicmFuY2guXG4gIGNvbnN0IHRyYWNraW5nUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLXZlcmlmeVwiLCBcIi0tcXVpZXRcIiwgYHJlZnMvcmVtb3Rlcy9vcmlnaW4vJHticmFuY2hOYW1lfWBdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICh0cmFja2luZ1Jlc3VsdC5vayAmJiB0cmFja2luZ1Jlc3VsdC52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgY29uc3Qgc2hhID0gdHJhY2tpbmdSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKTtcbiAgICBpZiAoT0JKRUNUX0lEX1BBVFRFUk4udGVzdChzaGEpKSB7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgc2hhLCBzb3VyY2U6IFwidHJhY2tpbmctcmVmXCIgfSB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIDIuIEFzayB0aGUgcmVtb3RlIGRpcmVjdGx5IOKAlCBjb3JyZWN0IG9uIGEgc2luZ2xlLWJyYW5jaCBjbG9uZSwgYW5kIG9uIGFueVxuICAvLyAgICBjbG9uZSB3aG9zZSB0cmFja2luZyByZWYgd2FzIG5ldmVyIGZldGNoZWQgb3IgaGFzIGJlZW4gcHJ1bmVkLlxuICBjb25zdCBsc1JlbW90ZVJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wibHMtcmVtb3RlXCIsIFwiLS1oZWFkc1wiLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgXCJvcmlnaW5cIiwgYnJhbmNoTmFtZV0sXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFsc1JlbW90ZVJlc3VsdC5vaykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgQ2Fubm90IGRldGVybWluZSB0aGUgcmVtb3RlIGhlYWQgb2YgJyR7YnJhbmNoTmFtZX0nOiBgICtcbiAgICAgICAgICBgZ2l0IGxzLXJlbW90ZSBmYWlsZWQ6ICR7bHNSZW1vdGVSZXN1bHQuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGlmIChsc1JlbW90ZVJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBDYW5ub3QgZGV0ZXJtaW5lIHRoZSByZW1vdGUgaGVhZCBvZiAnJHticmFuY2hOYW1lfSc6IGAgK1xuICAgICAgICAgIGBnaXQgbHMtcmVtb3RlIGV4aXRlZCAke2xzUmVtb3RlUmVzdWx0LnZhbHVlLmNvZGV9OiBgICtcbiAgICAgICAgICBgJHtsc1JlbW90ZVJlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpIHx8IFwibm8gc3RkZXJyXCJ9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHNoYSA9IHBhcnNlTHNSZW1vdGVTaGEobHNSZW1vdGVSZXN1bHQudmFsdWUuc3Rkb3V0LCBicmFuY2hOYW1lKTtcbiAgaWYgKHNoYSA9PT0gbnVsbCkge1xuICAgIC8vIDMuIFRoZSBicmFuY2ggcmVhbGx5IGlzIG5vdCBvbiB0aGUgcmVtb3RlIHlldCAoZmlyc3QgcHVzaCkuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IHNoYTogbnVsbCwgc291cmNlOiBcImFic2VudFwiIH0gfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgc2hhLCBzb3VyY2U6IFwibHMtcmVtb3RlXCIgfSB9O1xufVxuXG4vKipcbiAqIEV4dHJhY3QgdGhlIFNIQSBmb3IgYHJlZnMvaGVhZHMvPGJyYW5jaE5hbWU+YCBmcm9tIGBnaXQgbHMtcmVtb3RlYCBvdXRwdXQuXG4gKlxuICogRXhwb3J0ZWQgZm9yIHRlc3Rpbmc6IHRoZSBvdXRwdXQgaXMgb25lIGA8c2hhPlxcdDxyZWY+YCBsaW5lIHBlciBtYXRjaGluZ1xuICogcmVmLCBhbmQgYC0taGVhZHMgPHBhdHRlcm4+YCBtYXRjaGVzIGJ5IHN1ZmZpeCwgc28gYGZlYXR1cmVgIHdvdWxkIGFsc29cbiAqIG1hdGNoIGByZWZzL2hlYWRzL290aGVyL2ZlYXR1cmVgIOKAlCBvbmx5IHRoZSBleGFjdCByZWYgY291bnRzLlxuICpcbiAqIEBwYXJhbSBzdGRvdXQgLSBSYXcgYGdpdCBscy1yZW1vdGVgIG91dHB1dFxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgYnJhbmNoIHdob3NlIHJlZiB0byBtYXRjaCBleGFjdGx5XG4gKiBAcmV0dXJucyBUaGUgU0hBLCBvciBudWxsIHdoZW4gdGhlIGV4YWN0IHJlZiBpcyBhYnNlbnRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlTHNSZW1vdGVTaGEoXG4gIHN0ZG91dDogc3RyaW5nLFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHN0ZG91dC5zcGxpdChcIlxcblwiKSkge1xuICAgIGNvbnN0IFtzaGEsIHJlZl0gPSBsaW5lLnRyaW0oKS5zcGxpdCgvXFxzKy8pO1xuICAgIGlmICghc2hhIHx8ICFyZWYpIGNvbnRpbnVlO1xuICAgIGlmIChyZWYgIT09IGByZWZzL2hlYWRzLyR7YnJhbmNoTmFtZX1gKSBjb250aW51ZTtcbiAgICBpZiAoIU9CSkVDVF9JRF9QQVRURVJOLnRlc3Qoc2hhKSkgY29udGludWU7XG4gICAgcmV0dXJuIHNoYTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIEhvdyBmYXIgYEhFQURgIGlzIGFoZWFkIG9mIHRoZSBicmFuY2gncyByZW1vdGUgaGVhZCAoSXNzdWUgIzIxMSkuICovXG5leHBvcnQgaW50ZXJmYWNlIFVucHVzaGVkU3RhdGUgZXh0ZW5kcyBSZW1vdGVCcmFuY2hIZWFkIHtcbiAgLyoqIENvbW1pdHMgb24gYEhFQURgIHRoZSByZW1vdGUgaGVhZCBkb2VzIG5vdCBoYXZlICgwID0gZnVsbHkgcHVzaGVkKS4gKi9cbiAgY291bnQ6IG51bWJlcjtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSByZW1vdGUgaGVhZCBvZiBhIGJyYW5jaCBhbmQgY291bnQgd2hhdCBgSEVBRGAgaGFzIGJleW9uZCBpdFxuICogKElzc3VlICMyMTEpLlxuICpcbiAqIENhbGxlcnMgdGhhdCBuZWVkIGJvdGggZmFjdHMgKHRoZSBwdXNoIHBhdGggbmVlZHMgdG8ga25vdyB3aGV0aGVyIHRoZSBicmFuY2hcbiAqIGV4aXN0cyByZW1vdGVseSBhdCBhbGwpIHVzZSB0aGlzIHRvIHBheSBmb3IgdGhlIHJlbW90ZSBsb29rdXAgb25jZS5cbiAqXG4gKiBAcGFyYW0gYnJhbmNoTmFtZSAtIFRoZSBicmFuY2ggYmVpbmcgcHVzaGVkICh1bnRydXN0ZWQgcG9zaXRpb25hbClcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkIHNlbGVjdHMgdGhlIHJlcG8pXG4gKiBAcmV0dXJucyBUaGUgcmVtb3RlIGhlYWQsIGl0cyBzb3VyY2UsIGFuZCB0aGUgdW5wdXNoZWQgY291bnQg4oCUIG9yIGFuIGVycm9yXG4gKiAgIFJlc3VsdCB3aGVuIHRoZSByZW1vdGUgc3RhdGUgY2Fubm90IGJlIGRldGVybWluZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkZXNjcmliZVVucHVzaGVkQ29tbWl0cyhcbiAgYnJhbmNoTmFtZTogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8VW5wdXNoZWRTdGF0ZT4+IHtcbiAgY29uc3QgaGVhZFJlc3VsdCA9IGF3YWl0IHJlc29sdmVSZW1vdGVCcmFuY2hIZWFkKGJyYW5jaE5hbWUsIG9wdGlvbnMpO1xuICBpZiAoIWhlYWRSZXN1bHQub2spIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBoZWFkUmVzdWx0LmVycm9yIH07XG4gIH1cblxuICBjb25zdCB7IHNoYSwgc291cmNlIH0gPSBoZWFkUmVzdWx0LnZhbHVlO1xuICBjb25zdCBjb3VudFJlc3VsdCA9IGF3YWl0IGNvdW50QWdhaW5zdFJlbW90ZUhlYWQoc2hhLCBicmFuY2hOYW1lLCBvcHRpb25zKTtcbiAgaWYgKCFjb3VudFJlc3VsdC5vaykge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGNvdW50UmVzdWx0LmVycm9yIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IHNoYSwgc291cmNlLCBjb3VudDogY291bnRSZXN1bHQudmFsdWUgfSB9O1xufVxuXG4vKipcbiAqIENvdW50IHRoZSBjb21taXRzIG9uIGBIRUFEYCB0aGF0IHRoZSBicmFuY2gncyByZW1vdGUgaGVhZCBkb2VzIG5vdCBoYXZlXG4gKiAoSXNzdWUgIzIxMSkuXG4gKlxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgYnJhbmNoIGJlaW5nIHB1c2hlZCAodW50cnVzdGVkIHBvc2l0aW9uYWwpXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCBzZWxlY3RzIHRoZSByZXBvKVxuICogQHJldHVybnMgVGhlIG51bWJlciBvZiB1bnB1c2hlZCBjb21taXRzICgwID0gZnVsbHkgcHVzaGVkKSwgb3IgYW4gZXJyb3JcbiAqICAgUmVzdWx0IHdoZW4gdGhlIHJlbW90ZSBzdGF0ZSBjYW5ub3QgYmUgZGV0ZXJtaW5lZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvdW50VW5wdXNoZWRDb21taXRzKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxudW1iZXI+PiB7XG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVzY3JpYmVVbnB1c2hlZENvbW1pdHMoYnJhbmNoTmFtZSwgb3B0aW9ucyk7XG4gIHJldHVybiBzdGF0ZS5vayA/IHsgb2s6IHRydWUsIHZhbHVlOiBzdGF0ZS52YWx1ZS5jb3VudCB9IDogc3RhdGU7XG59XG5cbi8qKlxuICogQ291bnQgYEhFQURgIGFnYWluc3QgYSByZXNvbHZlZCByZW1vdGUgaGVhZC5cbiAqXG4gKiBAcGFyYW0gc2hhIC0gVGhlIHJlbW90ZSBoZWFkIFNIQSwgb3IgbnVsbCB3aGVuIHRoZSBicmFuY2ggaXMgbm90IG9uIHRoZSByZW1vdGVcbiAqIEBwYXJhbSBicmFuY2hOYW1lIC0gVGhlIGJyYW5jaCBiZWluZyBjb3VudGVkIChmb3IgbWVzc2FnZXMgYW5kIHRoZSBmZXRjaClcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9uc1xuICogQHJldHVybnMgVGhlIHVucHVzaGVkIGNvbW1pdCBjb3VudFxuICovXG5hc3luYyBmdW5jdGlvbiBjb3VudEFnYWluc3RSZW1vdGVIZWFkKFxuICBzaGE6IHN0cmluZyB8IG51bGwsXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDxudW1iZXI+PiB7XG4gIC8vIFRoZSBicmFuY2ggaXMgbm90IG9uIHRoZSByZW1vdGUg4oCUIGV2ZXJ5dGhpbmcgbm90IHJlYWNoYWJsZSBmcm9tIGFuIG9yaWdpblxuICAvLyByZWYgaXMgdW5wdXNoZWQuIFRoaXMgaXMgdGhlIG9ubHkgY2FzZSBgLS1yZW1vdGVzPW9yaWdpbmAgYW5zd2Vyc1xuICAvLyBjb3JyZWN0bHksIGFuZCBpdCBpcyB0aGUgZmlyc3QtcHVzaCBjYXNlLlxuICBpZiAoc2hhID09PSBudWxsKSB7XG4gICAgcmV0dXJuIGF3YWl0IGNvdW50UmV2TGlzdChcbiAgICAgIFtcInJldi1saXN0XCIsIFwiLS1jb3VudFwiLCBcIkhFQURcIiwgXCItLW5vdFwiLCBcIi0tcmVtb3Rlcz1vcmlnaW5cIl0sXG4gICAgICBvcHRpb25zLFxuICAgICAgYGNvdW50IGNvbW1pdHMgbm90IHlldCBvbiBvcmlnaW4gZm9yICcke2JyYW5jaE5hbWV9J2AsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGxvY2FsSGVhZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wicmV2LXBhcnNlXCIsIFwiSEVBRFwiXSwgb3B0aW9ucyk7XG4gIGlmIChsb2NhbEhlYWQub2sgJiYgbG9jYWxIZWFkLnZhbHVlLmNvZGUgPT09IDApIHtcbiAgICBpZiAobG9jYWxIZWFkLnZhbHVlLnN0ZG91dC50cmltKCkgPT09IHNoYSkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiAwIH07XG4gIH1cblxuICAvLyBDb3VudCBhZ2FpbnN0IHRoZSByZW1vdGUgaGVhZC4gVGhlIG9iamVjdCBtYXkgYmUgbWlzc2luZyBsb2NhbGx5IG9uIGFcbiAgLy8gc2hhbGxvdyBjbG9uZSBvciB3aGVuIGEgc2libGluZyBwdXNoZWQgaXQsIHNvIGZldGNoIHRoZSBicmFuY2ggb25jZVxuICAvLyBiZWZvcmUgZ2l2aW5nIHVwLlxuICBjb25zdCBkaXJlY3QgPSBhd2FpdCBjb3VudFJldkxpc3QoXG4gICAgW1wicmV2LWxpc3RcIiwgXCItLWNvdW50XCIsIGAke3NoYX0uLkhFQURgXSxcbiAgICBvcHRpb25zLFxuICAgIGBjb3VudCBjb21taXRzIGFoZWFkIG9mIG9yaWdpbi8ke2JyYW5jaE5hbWV9YCxcbiAgKTtcbiAgaWYgKGRpcmVjdC5vaykgcmV0dXJuIGRpcmVjdDtcblxuICBjb25zdCBmZXRjaFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgYnVpbGRGZXRjaEFyZ3MoXCJvcmlnaW5cIiwgYnJhbmNoTmFtZSksXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFmZXRjaFJlc3VsdC5vayB8fCBmZXRjaFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZmV0Y2hSZXN1bHQub2tcbiAgICAgID8gZmV0Y2hSZXN1bHQudmFsdWUuc3RkZXJyLnRyaW0oKSB8fCBgZXhpdCAke2ZldGNoUmVzdWx0LnZhbHVlLmNvZGV9YFxuICAgICAgOiBmZXRjaFJlc3VsdC5lcnJvci5tZXNzYWdlO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgQ2Fubm90IGNvdW50IHVucHVzaGVkIGNvbW1pdHMgZm9yICcke2JyYW5jaE5hbWV9JzogdGhlIHJlbW90ZSBoZWFkIGAgK1xuICAgICAgICAgIGAke3NoYX0gaXMgbm90IHByZXNlbnQgbG9jYWxseSBhbmQgZmV0Y2hpbmcgaXQgZmFpbGVkOiAke2RldGFpbH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIGF3YWl0IGNvdW50UmV2TGlzdChcbiAgICBbXCJyZXYtbGlzdFwiLCBcIi0tY291bnRcIiwgYCR7c2hhfS4uSEVBRGBdLFxuICAgIG9wdGlvbnMsXG4gICAgYGNvdW50IGNvbW1pdHMgYWhlYWQgb2Ygb3JpZ2luLyR7YnJhbmNoTmFtZX0gYWZ0ZXIgZmV0Y2hgLFxuICApO1xufVxuXG4vKipcbiAqIFJ1biBhIGByZXYtbGlzdCAtLWNvdW50YCBhbmQgcGFyc2UgaXRzIG91dHB1dCwgZmFpbGluZyBsb3VkIG9uIGEgYmFkIGV4aXQuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBGdWxsIGdpdCBhcmd2XG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnNcbiAqIEBwYXJhbSB3aGF0IC0gU2hvcnQgZGVzY3JpcHRpb24gdXNlZCBpbiB0aGUgZXJyb3IgbWVzc2FnZVxuICogQHJldHVybnMgVGhlIHBhcnNlZCBjb3VudCwgb3IgYW4gZXJyb3IgUmVzdWx0IGNhcnJ5aW5nIGdpdCdzIHN0ZGVyclxuICovXG5hc3luYyBmdW5jdGlvbiBjb3VudFJldkxpc3QoXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbiAgd2hhdDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8bnVtYmVyPj4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKGFyZ3MsIG9wdGlvbnMpO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKGBGYWlsZWQgdG8gJHt3aGF0fTogJHtyZXN1bHQuZXJyb3IubWVzc2FnZX1gKSxcbiAgICB9O1xuICB9XG4gIGlmIChyZXN1bHQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgRmFpbGVkIHRvICR7d2hhdH06IGdpdCBleGl0ZWQgJHtyZXN1bHQudmFsdWUuY29kZX06IGAgK1xuICAgICAgICAgIGAke3Jlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpIHx8IFwibm8gc3RkZXJyXCJ9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBjb25zdCBwYXJzZWQgPSBwYXJzZUludChyZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSwgMTApO1xuICBpZiAoTnVtYmVyLmlzTmFOKHBhcnNlZCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byAke3doYXR9OiBnaXQgcHJpbnRlZCAnJHtyZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKX0nYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHBhcnNlZCB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTBCQyxHQUdELFNBQVMsZ0JBQWdCLEVBQUUsY0FBYyxRQUFRLG9CQUFvQjtBQUNyRSxTQUFTLGFBQWEsUUFBUSxtQkFBbUI7QUFHakQscURBQXFELEdBQ3JELE1BQU0sb0JBQW9CO0FBYTFCOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLGVBQWUsd0JBQ3BCLFVBQWtCLEVBQ2xCLFVBQTZCLENBQUMsQ0FBQztFQUUvQixJQUFJO0lBQ0YsaUJBQWlCLFlBQVk7RUFDL0IsRUFBRSxPQUFPLEtBQUs7SUFDWixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sZUFBZSxRQUFRLE1BQU0sSUFBSSxNQUFNLE9BQU87SUFDdkQ7RUFDRjtFQUVBLHdFQUF3RTtFQUN4RSxNQUFNLGlCQUFpQixNQUFNLGNBQzNCO0lBQUM7SUFBYTtJQUFZO0lBQVcsQ0FBQyxvQkFBb0IsRUFBRSxZQUFZO0dBQUMsRUFDekU7RUFFRixJQUFJLGVBQWUsRUFBRSxJQUFJLGVBQWUsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHO0lBQ3hELE1BQU0sTUFBTSxlQUFlLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSTtJQUM1QyxJQUFJLGtCQUFrQixJQUFJLENBQUMsTUFBTTtNQUMvQixPQUFPO1FBQUUsSUFBSTtRQUFNLE9BQU87VUFBRTtVQUFLLFFBQVE7UUFBZTtNQUFFO0lBQzVEO0VBQ0Y7RUFFQSw0RUFBNEU7RUFDNUUsb0VBQW9FO0VBQ3BFLE1BQU0saUJBQWlCLE1BQU0sY0FDM0I7SUFBQztJQUFhO0lBQVc7SUFBb0I7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
// denoCacheMetadata=2196921166987597087,15579924332045659045