/**
 * Pull-request-lifecycle classification for the agent-side `gh` guard
 * (Issue #1462).
 *
 * The sibling of `gh_issue_lifecycle.ts`, and it exists for the same reason at
 * one remove. That module stops the implementing agent deciding that an
 * **issue** is closed; this one stops it deciding that its own **pull request**
 * is merged. `classifyIssueLifecycle` deliberately returns `undefined` for a PR
 * operation (its own doc comment says so), and `gh pr merge` is otherwise a
 * mutation on the run's own claimed repo — which is on the write-repo allowlist
 * by construction. So it fell through every check in {@link evaluateGhCommand}
 * and was allowed.
 *
 * That matters because merging is not a call the agent makes anywhere in the
 * worker's design. The worker's merge chokepoint is `direct_merge.ts` (reached
 * via `merge_if_checks_passed.ts` / `pr_manager.ts`), which re-checks CI status
 * and branch freshness and applies the default-branch human-approval gate
 * documented in `docs/MERGE.md`. Those calls run in the worker's own Deno
 * process and never traverse this guard, so refusing the verb here costs the
 * merge path nothing. And `docs/MERGE.md` records that the GitHub-side ruleset
 * "wall" is not guaranteed present on every repo the worker operates — on a
 * repo where it is absent, this guard is the only backstop.
 *
 * ## Which verbs, and why not the others
 *
 * {@link PR_LIFECYCLE_VERBS} is deliberately short. `gh pr create` is the
 * agent's normal output and must stay allowed; `gh pr view` / `gh pr list` are
 * reads; `gh pr comment` and `gh pr edit` *record* an outcome rather than
 * deciding one, exactly as `gh issue comment` does on the issue side. Only
 * merge, close, reopen, ready and an approving review decide the PR's fate, and
 * none of those is the implementing agent's decision.
 *
 * `gh pr review` is classified only when it carries `--approve`: a review that
 * comments or requests changes is feedback, and the agent self-approving is the
 * escalation.
 *
 * Pure by design — like its sibling, it runs inside the guard's short-lived
 * child process with `--allow-read` and nothing else.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { normaliseGhArgs } from "./gh_flag_parser.ts";
/**
 * `gh pr <verb>` sub-verbs that decide a pull request's fate.
 *
 * `create`, `comment`, `edit`, `view`, `list`, `diff` and `checks` are
 * deliberately absent — they do not decide the PR's fate, so the agent may
 * use them. The worker raises the PR itself (Issue #4871), and an agent-raised
 * PR is still tolerated.
 */ export const PR_LIFECYCLE_VERBS = [
  "merge",
  "close",
  "reopen",
  "ready",
  "review --approve"
];
/** Bare `gh pr <verb>` spellings refused outright, without reading flags. */ const PR_LIFECYCLE_VERB_SET = new Set([
  "merge",
  "close",
  "reopen",
  "ready"
]);
/** The verb reported for an approving review, in either spelling. */ const REVIEW_APPROVE_VERB = "review --approve";
/** PR number at the end of a positional target (`12`, or a PR URL). */ function prNumberFromTarget(target) {
  if (!target) return undefined;
  const match = target.replace(/\/+$/, "").match(/(\d+)$/);
  if (!match) return undefined;
  const num = parseInt(match[1], 10);
  return Number.isNaN(num) ? undefined : num;
}
/** `owner/repo` from a pull-request URL target, when the target is one. */ function repoFromPrUrl(target) {
  if (!target) return undefined;
  const match = target.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/\d+/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}
/**
 * Flags on `gh pr review` whose following token is a value, not a flag.
 *
 * Scanning without them reads the value of `--body -a` as an approve
 * shorthand and refuses a review that requests changes — a false refusal, and
 * a needless one.
 */ const REVIEW_VALUE_FLAGS = new Set([
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-R",
  "--repo"
]);
/**
 * Shorthand letters that take a value on `gh pr review`.
 *
 * `-b` is `--body` and `-F` is `--body-file`; `-R` is gh's global `--repo`.
 * pflag hands the first value-taking letter in a shorthand group the remainder
 * of the token, so the group walk stops there — `-ba` is `--body a`, not an
 * approval, while `-ac` is `--approve --comment`. Mirrors the reasoning in
 * `gh_flag_parser.ts`, at the one subcommand this module needs it for.
 */ const REVIEW_VALUE_SHORTHANDS = new Set([
  "b",
  "F",
  "R"
]);
/** pflag's false-y spellings for an explicit boolean flag value. */ const FALSEY = new Set([
  "0",
  "f",
  "false"
]);
/**
 * Whether a `gh pr review` argv approves the pull request.
 *
 * Covers `--approve`, `--approve=<bool>`, the `-a` shorthand, and `-a` inside a
 * shorthand group (`-ac`). Value-carrying flags take their following token with
 * them, and a group is walked only through letters pflag treats as boolean
 * here, so an `a` that is really part of a body is not mistaken for the flag.
 */ function approvesReview(args) {
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if (token === undefined) continue;
    if (token === "--approve") return true;
    if (token.startsWith("--approve=")) {
      return !FALSEY.has(token.slice("--approve=".length).toLowerCase());
    }
    if (REVIEW_VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (!token.startsWith("-") || token.startsWith("--")) continue;
    for (const letter of token.slice(1)){
      if (letter === "a") return true;
      if (REVIEW_VALUE_SHORTHANDS.has(letter)) break;
    }
  }
  return false;
}
/** Every `key=value` field the argv supplies to `gh api`, lower-cased. */ function apiFieldValues(args) {
  const fields = [];
  const flags = new Set([
    "-f",
    "-F",
    "--field",
    "--raw-field"
  ]);
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if (token === undefined) continue;
    if (flags.has(token)) {
      const value = args[i + 1];
      if (value !== undefined) {
        fields.push(value.toLowerCase());
        i++;
      }
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0 && flags.has(token.slice(0, eq))) {
      fields.push(token.slice(eq + 1).toLowerCase());
    }
  }
  return fields;
}
/** REST endpoint path with any origin and leading/trailing slashes removed. */ function endpointPath(endpoint) {
  return endpoint.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "").replace(/^\/+/, "").replace(/\/+$/, "");
}
/**
 * Classify a REST mutation on `repos/{owner}/{repo}/pulls/{n}` (Issue #1462).
 *
 * Covering the argv alone would leave the obvious bypass: `gh api -X PUT
 * repos/o/r/pulls/12/merge` merges the PR just as surely as `gh pr merge 12`,
 * and `gh api -X PATCH repos/o/r/pulls/12 -f state=closed` closes it. Only the
 * fate-deciding shapes are claimed — the merge sub-resource, a PATCH carrying
 * `state=`, and a review POST whose `event` is an approval. A PATCH with no
 * `state=` is a title/body edit and returns `undefined`, as do `/comments`,
 * `/requested_reviewers` and the rest, so they stay allowed.
 *
 * `gh pr ready` has no REST spelling — GitHub exposes it only as the GraphQL
 * `markPullRequestReadyForReview` mutation, and an unsanctioned GraphQL
 * mutation already fails closed as `WRITE_TARGET_UNDETERMINABLE`.
 */ function classifyApiPrLifecycle(args, info) {
  const method = info.verb.slice("api-".length).toUpperCase();
  const path = endpointPath(info.target ?? "");
  const match = path.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/(.*))?$/);
  if (!match) return undefined;
  const owner = match[1];
  const name = match[2];
  const prNumber = parseInt(match[3], 10);
  const sub = match[5] ?? "";
  // `repos/{owner}/{repo}/…` is gh's own placeholder form, resolved from the
  // current clone — the claimed repo during a coding run.
  const repo = owner === "{owner}" || name === "{repo}" ? undefined : `${owner}/${name}`;
  const base = {
    ...repo ? {
      repo
    } : {},
    ...Number.isNaN(prNumber) ? {} : {
      prNumber
    }
  };
  if (sub === "merge") {
    return method === "PUT" ? {
      verb: "merge",
      ...base
    } : undefined;
  }
  if (sub === "reviews") {
    if (method !== "POST") return undefined;
    const event = apiFieldValues(args).find((f)=>f.startsWith("event="));
    return event?.slice("event=".length).trim() === "approve" ? {
      verb: REVIEW_APPROVE_VERB,
      ...base
    } : undefined;
  }
  if (sub !== "") return undefined;
  if (method !== "PATCH") return undefined;
  const state = apiFieldValues(args).find((f)=>f.startsWith("state="));
  if (state === undefined) return undefined;
  return {
    verb: state.endsWith("open") ? "reopen" : "close",
    ...base
  };
}
/**
 * Classify one already-classified `gh` mutation as a PR-lifecycle decision.
 *
 * @param rawArgs - Arguments passed to the `gh` binary.
 * @param info - The mutation as classified by `classifyGhMutation`.
 * @returns The attempt, or `undefined` when the command decides no pull
 *   request's fate (a `pr create`, a comment, an edit, a read, an issue
 *   operation).
 */ export function classifyPrLifecycle(rawArgs, info) {
  const args = normaliseGhArgs(rawArgs);
  if (info.verb.startsWith("api-")) return classifyApiPrLifecycle(args, info);
  if (!info.verb.startsWith("pr-")) return undefined;
  const verb = info.verb.slice("pr-".length);
  let lifecycleVerb;
  if (PR_LIFECYCLE_VERB_SET.has(verb)) lifecycleVerb = verb;
  else if (verb === "review" && approvesReview(args)) {
    lifecycleVerb = REVIEW_APPROVE_VERB;
  }
  if (lifecycleVerb === undefined) return undefined;
  const repo = info.repo ?? repoFromPrUrl(info.target);
  const prNumber = prNumberFromTarget(info.target);
  return {
    verb: lifecycleVerb,
    ...repo ? {
      repo
    } : {},
    ...prNumber !== undefined ? {
      prNumber
    } : {}
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9wcl9saWZlY3ljbGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQdWxsLXJlcXVlc3QtbGlmZWN5Y2xlIGNsYXNzaWZpY2F0aW9uIGZvciB0aGUgYWdlbnQtc2lkZSBgZ2hgIGd1YXJkXG4gKiAoSXNzdWUgIzE0NjIpLlxuICpcbiAqIFRoZSBzaWJsaW5nIG9mIGBnaF9pc3N1ZV9saWZlY3ljbGUudHNgLCBhbmQgaXQgZXhpc3RzIGZvciB0aGUgc2FtZSByZWFzb24gYXRcbiAqIG9uZSByZW1vdmUuIFRoYXQgbW9kdWxlIHN0b3BzIHRoZSBpbXBsZW1lbnRpbmcgYWdlbnQgZGVjaWRpbmcgdGhhdCBhblxuICogKippc3N1ZSoqIGlzIGNsb3NlZDsgdGhpcyBvbmUgc3RvcHMgaXQgZGVjaWRpbmcgdGhhdCBpdHMgb3duICoqcHVsbCByZXF1ZXN0KipcbiAqIGlzIG1lcmdlZC4gYGNsYXNzaWZ5SXNzdWVMaWZlY3ljbGVgIGRlbGliZXJhdGVseSByZXR1cm5zIGB1bmRlZmluZWRgIGZvciBhIFBSXG4gKiBvcGVyYXRpb24gKGl0cyBvd24gZG9jIGNvbW1lbnQgc2F5cyBzbyksIGFuZCBgZ2ggcHIgbWVyZ2VgIGlzIG90aGVyd2lzZSBhXG4gKiBtdXRhdGlvbiBvbiB0aGUgcnVuJ3Mgb3duIGNsYWltZWQgcmVwbyDigJQgd2hpY2ggaXMgb24gdGhlIHdyaXRlLXJlcG8gYWxsb3dsaXN0XG4gKiBieSBjb25zdHJ1Y3Rpb24uIFNvIGl0IGZlbGwgdGhyb3VnaCBldmVyeSBjaGVjayBpbiB7QGxpbmsgZXZhbHVhdGVHaENvbW1hbmR9XG4gKiBhbmQgd2FzIGFsbG93ZWQuXG4gKlxuICogVGhhdCBtYXR0ZXJzIGJlY2F1c2UgbWVyZ2luZyBpcyBub3QgYSBjYWxsIHRoZSBhZ2VudCBtYWtlcyBhbnl3aGVyZSBpbiB0aGVcbiAqIHdvcmtlcidzIGRlc2lnbi4gVGhlIHdvcmtlcidzIG1lcmdlIGNob2tlcG9pbnQgaXMgYGRpcmVjdF9tZXJnZS50c2AgKHJlYWNoZWRcbiAqIHZpYSBgbWVyZ2VfaWZfY2hlY2tzX3Bhc3NlZC50c2AgLyBgcHJfbWFuYWdlci50c2ApLCB3aGljaCByZS1jaGVja3MgQ0kgc3RhdHVzXG4gKiBhbmQgYnJhbmNoIGZyZXNobmVzcyBhbmQgYXBwbGllcyB0aGUgZGVmYXVsdC1icmFuY2ggaHVtYW4tYXBwcm92YWwgZ2F0ZVxuICogZG9jdW1lbnRlZCBpbiBgZG9jcy9NRVJHRS5tZGAuIFRob3NlIGNhbGxzIHJ1biBpbiB0aGUgd29ya2VyJ3Mgb3duIERlbm9cbiAqIHByb2Nlc3MgYW5kIG5ldmVyIHRyYXZlcnNlIHRoaXMgZ3VhcmQsIHNvIHJlZnVzaW5nIHRoZSB2ZXJiIGhlcmUgY29zdHMgdGhlXG4gKiBtZXJnZSBwYXRoIG5vdGhpbmcuIEFuZCBgZG9jcy9NRVJHRS5tZGAgcmVjb3JkcyB0aGF0IHRoZSBHaXRIdWItc2lkZSBydWxlc2V0XG4gKiBcIndhbGxcIiBpcyBub3QgZ3VhcmFudGVlZCBwcmVzZW50IG9uIGV2ZXJ5IHJlcG8gdGhlIHdvcmtlciBvcGVyYXRlcyDigJQgb24gYVxuICogcmVwbyB3aGVyZSBpdCBpcyBhYnNlbnQsIHRoaXMgZ3VhcmQgaXMgdGhlIG9ubHkgYmFja3N0b3AuXG4gKlxuICogIyMgV2hpY2ggdmVyYnMsIGFuZCB3aHkgbm90IHRoZSBvdGhlcnNcbiAqXG4gKiB7QGxpbmsgUFJfTElGRUNZQ0xFX1ZFUkJTfSBpcyBkZWxpYmVyYXRlbHkgc2hvcnQuIGBnaCBwciBjcmVhdGVgIGlzIHRoZVxuICogYWdlbnQncyBub3JtYWwgb3V0cHV0IGFuZCBtdXN0IHN0YXkgYWxsb3dlZDsgYGdoIHByIHZpZXdgIC8gYGdoIHByIGxpc3RgIGFyZVxuICogcmVhZHM7IGBnaCBwciBjb21tZW50YCBhbmQgYGdoIHByIGVkaXRgICpyZWNvcmQqIGFuIG91dGNvbWUgcmF0aGVyIHRoYW5cbiAqIGRlY2lkaW5nIG9uZSwgZXhhY3RseSBhcyBgZ2ggaXNzdWUgY29tbWVudGAgZG9lcyBvbiB0aGUgaXNzdWUgc2lkZS4gT25seVxuICogbWVyZ2UsIGNsb3NlLCByZW9wZW4sIHJlYWR5IGFuZCBhbiBhcHByb3ZpbmcgcmV2aWV3IGRlY2lkZSB0aGUgUFIncyBmYXRlLCBhbmRcbiAqIG5vbmUgb2YgdGhvc2UgaXMgdGhlIGltcGxlbWVudGluZyBhZ2VudCdzIGRlY2lzaW9uLlxuICpcbiAqIGBnaCBwciByZXZpZXdgIGlzIGNsYXNzaWZpZWQgb25seSB3aGVuIGl0IGNhcnJpZXMgYC0tYXBwcm92ZWA6IGEgcmV2aWV3IHRoYXRcbiAqIGNvbW1lbnRzIG9yIHJlcXVlc3RzIGNoYW5nZXMgaXMgZmVlZGJhY2ssIGFuZCB0aGUgYWdlbnQgc2VsZi1hcHByb3ZpbmcgaXMgdGhlXG4gKiBlc2NhbGF0aW9uLlxuICpcbiAqIFB1cmUgYnkgZGVzaWduIOKAlCBsaWtlIGl0cyBzaWJsaW5nLCBpdCBydW5zIGluc2lkZSB0aGUgZ3VhcmQncyBzaG9ydC1saXZlZFxuICogY2hpbGQgcHJvY2VzcyB3aXRoIGAtLWFsbG93LXJlYWRgIGFuZCBub3RoaW5nIGVsc2UuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBNdXRhdGlvbkluZm8gfSBmcm9tIFwiLi9hdWRpdF9tdXRhdGlvbl9jbGFzc2lmaWVyLnRzXCI7XG5pbXBvcnQgeyBub3JtYWxpc2VHaEFyZ3MgfSBmcm9tIFwiLi9naF9mbGFnX3BhcnNlci50c1wiO1xuXG4vKipcbiAqIGBnaCBwciA8dmVyYj5gIHN1Yi12ZXJicyB0aGF0IGRlY2lkZSBhIHB1bGwgcmVxdWVzdCdzIGZhdGUuXG4gKlxuICogYGNyZWF0ZWAsIGBjb21tZW50YCwgYGVkaXRgLCBgdmlld2AsIGBsaXN0YCwgYGRpZmZgIGFuZCBgY2hlY2tzYCBhcmVcbiAqIGRlbGliZXJhdGVseSBhYnNlbnQg4oCUIHRoZXkgZG8gbm90IGRlY2lkZSB0aGUgUFIncyBmYXRlLCBzbyB0aGUgYWdlbnQgbWF5XG4gKiB1c2UgdGhlbS4gVGhlIHdvcmtlciByYWlzZXMgdGhlIFBSIGl0c2VsZiAoSXNzdWUgIzQ4NzEpLCBhbmQgYW4gYWdlbnQtcmFpc2VkXG4gKiBQUiBpcyBzdGlsbCB0b2xlcmF0ZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBQUl9MSUZFQ1lDTEVfVkVSQlM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcIm1lcmdlXCIsXG4gIFwiY2xvc2VcIixcbiAgXCJyZW9wZW5cIixcbiAgXCJyZWFkeVwiLFxuICBcInJldmlldyAtLWFwcHJvdmVcIixcbl07XG5cbi8qKiBCYXJlIGBnaCBwciA8dmVyYj5gIHNwZWxsaW5ncyByZWZ1c2VkIG91dHJpZ2h0LCB3aXRob3V0IHJlYWRpbmcgZmxhZ3MuICovXG5jb25zdCBQUl9MSUZFQ1lDTEVfVkVSQl9TRVQ6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCJtZXJnZVwiLFxuICBcImNsb3NlXCIsXG4gIFwicmVvcGVuXCIsXG4gIFwicmVhZHlcIixcbl0pO1xuXG4vKiogVGhlIHZlcmIgcmVwb3J0ZWQgZm9yIGFuIGFwcHJvdmluZyByZXZpZXcsIGluIGVpdGhlciBzcGVsbGluZy4gKi9cbmNvbnN0IFJFVklFV19BUFBST1ZFX1ZFUkIgPSBcInJldmlldyAtLWFwcHJvdmVcIjtcblxuLyoqIE9uZSBjbGFzc2lmaWVkIGF0dGVtcHQgdG8gZGVjaWRlIGEgcHVsbCByZXF1ZXN0J3MgZmF0ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJMaWZlY3ljbGVBdHRlbXB0IHtcbiAgLyoqIEJhcmUgbGlmZWN5Y2xlIHZlcmIg4oCUIGBtZXJnZWAsIGBjbG9zZWAsIGByZXZpZXcgLS1hcHByb3ZlYCwg4oCmICovXG4gIHZlcmI6IHN0cmluZztcbiAgLyoqXG4gICAqIGBvd25lci9yZXBvYCB0aGUgYXR0ZW1wdCBuYW1lcywgd2hlbiB0aGUgYXJndiBuYW1lcyBvbmUuIEFic2VudCB3aGVuXG4gICAqIGBnaGAgd291bGQgcmVzb2x2ZSB0aGUgcmVwbyBmcm9tIHRoZSBjdXJyZW50IGNsb25lIOKAlCB3aGljaCwgZHVyaW5nIGFcbiAgICogY29kaW5nIHJ1biwgaXMgdGhlIGNsYWltZWQgcmVwby5cbiAgICovXG4gIHJlcG8/OiBzdHJpbmc7XG4gIC8qKiBQdWxsIHJlcXVlc3QgbnVtYmVyLCB3aGVuIHRoZSBhcmd2IG5hbWVzIG9uZS4gKi9cbiAgcHJOdW1iZXI/OiBudW1iZXI7XG59XG5cbi8qKiBQUiBudW1iZXIgYXQgdGhlIGVuZCBvZiBhIHBvc2l0aW9uYWwgdGFyZ2V0IChgMTJgLCBvciBhIFBSIFVSTCkuICovXG5mdW5jdGlvbiBwck51bWJlckZyb21UYXJnZXQodGFyZ2V0OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIgfCB1bmRlZmluZWQge1xuICBpZiAoIXRhcmdldCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbWF0Y2ggPSB0YXJnZXQucmVwbGFjZSgvXFwvKyQvLCBcIlwiKS5tYXRjaCgvKFxcZCspJC8pO1xuICBpZiAoIW1hdGNoKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBudW0gPSBwYXJzZUludChtYXRjaFsxXSEsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc05hTihudW0pID8gdW5kZWZpbmVkIDogbnVtO1xufVxuXG4vKiogYG93bmVyL3JlcG9gIGZyb20gYSBwdWxsLXJlcXVlc3QgVVJMIHRhcmdldCwgd2hlbiB0aGUgdGFyZ2V0IGlzIG9uZS4gKi9cbmZ1bmN0aW9uIHJlcG9Gcm9tUHJVcmwodGFyZ2V0OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIXRhcmdldCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbWF0Y2ggPSB0YXJnZXQubWF0Y2goXG4gICAgL15odHRwcz86XFwvXFwvW14vXStcXC8oW14vXSspXFwvKFteL10rKVxcL3B1bGxzP1xcL1xcZCsvaSxcbiAgKTtcbiAgcmV0dXJuIG1hdGNoID8gYCR7bWF0Y2hbMV19LyR7bWF0Y2hbMl19YCA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBGbGFncyBvbiBgZ2ggcHIgcmV2aWV3YCB3aG9zZSBmb2xsb3dpbmcgdG9rZW4gaXMgYSB2YWx1ZSwgbm90IGEgZmxhZy5cbiAqXG4gKiBTY2FubmluZyB3aXRob3V0IHRoZW0gcmVhZHMgdGhlIHZhbHVlIG9mIGAtLWJvZHkgLWFgIGFzIGFuIGFwcHJvdmVcbiAqIHNob3J0aGFuZCBhbmQgcmVmdXNlcyBhIHJldmlldyB0aGF0IHJlcXVlc3RzIGNoYW5nZXMg4oCUIGEgZmFsc2UgcmVmdXNhbCwgYW5kXG4gKiBhIG5lZWRsZXNzIG9uZS5cbiAqL1xuY29uc3QgUkVWSUVXX1ZBTFVFX0ZMQUdTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiLWJcIixcbiAgXCItLWJvZHlcIixcbiAgXCItRlwiLFxuICBcIi0tYm9keS1maWxlXCIsXG4gIFwiLVJcIixcbiAgXCItLXJlcG9cIixcbl0pO1xuXG4vKipcbiAqIFNob3J0aGFuZCBsZXR0ZXJzIHRoYXQgdGFrZSBhIHZhbHVlIG9uIGBnaCBwciByZXZpZXdgLlxuICpcbiAqIGAtYmAgaXMgYC0tYm9keWAgYW5kIGAtRmAgaXMgYC0tYm9keS1maWxlYDsgYC1SYCBpcyBnaCdzIGdsb2JhbCBgLS1yZXBvYC5cbiAqIHBmbGFnIGhhbmRzIHRoZSBmaXJzdCB2YWx1ZS10YWtpbmcgbGV0dGVyIGluIGEgc2hvcnRoYW5kIGdyb3VwIHRoZSByZW1haW5kZXJcbiAqIG9mIHRoZSB0b2tlbiwgc28gdGhlIGdyb3VwIHdhbGsgc3RvcHMgdGhlcmUg4oCUIGAtYmFgIGlzIGAtLWJvZHkgYWAsIG5vdCBhblxuICogYXBwcm92YWwsIHdoaWxlIGAtYWNgIGlzIGAtLWFwcHJvdmUgLS1jb21tZW50YC4gTWlycm9ycyB0aGUgcmVhc29uaW5nIGluXG4gKiBgZ2hfZmxhZ19wYXJzZXIudHNgLCBhdCB0aGUgb25lIHN1YmNvbW1hbmQgdGhpcyBtb2R1bGUgbmVlZHMgaXQgZm9yLlxuICovXG5jb25zdCBSRVZJRVdfVkFMVUVfU0hPUlRIQU5EUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1wiYlwiLCBcIkZcIiwgXCJSXCJdKTtcblxuLyoqIHBmbGFnJ3MgZmFsc2UteSBzcGVsbGluZ3MgZm9yIGFuIGV4cGxpY2l0IGJvb2xlYW4gZmxhZyB2YWx1ZS4gKi9cbmNvbnN0IEZBTFNFWTogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1wiMFwiLCBcImZcIiwgXCJmYWxzZVwiXSk7XG5cbi8qKlxuICogV2hldGhlciBhIGBnaCBwciByZXZpZXdgIGFyZ3YgYXBwcm92ZXMgdGhlIHB1bGwgcmVxdWVzdC5cbiAqXG4gKiBDb3ZlcnMgYC0tYXBwcm92ZWAsIGAtLWFwcHJvdmU9PGJvb2w+YCwgdGhlIGAtYWAgc2hvcnRoYW5kLCBhbmQgYC1hYCBpbnNpZGUgYVxuICogc2hvcnRoYW5kIGdyb3VwIChgLWFjYCkuIFZhbHVlLWNhcnJ5aW5nIGZsYWdzIHRha2UgdGhlaXIgZm9sbG93aW5nIHRva2VuIHdpdGhcbiAqIHRoZW0sIGFuZCBhIGdyb3VwIGlzIHdhbGtlZCBvbmx5IHRocm91Z2ggbGV0dGVycyBwZmxhZyB0cmVhdHMgYXMgYm9vbGVhblxuICogaGVyZSwgc28gYW4gYGFgIHRoYXQgaXMgcmVhbGx5IHBhcnQgb2YgYSBib2R5IGlzIG5vdCBtaXN0YWtlbiBmb3IgdGhlIGZsYWcuXG4gKi9cbmZ1bmN0aW9uIGFwcHJvdmVzUmV2aWV3KGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRva2VuID0gYXJnc1tpXTtcbiAgICBpZiAodG9rZW4gPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgaWYgKHRva2VuID09PSBcIi0tYXBwcm92ZVwiKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0tYXBwcm92ZT1cIikpIHtcbiAgICAgIHJldHVybiAhRkFMU0VZLmhhcyh0b2tlbi5zbGljZShcIi0tYXBwcm92ZT1cIi5sZW5ndGgpLnRvTG93ZXJDYXNlKCkpO1xuICAgIH1cbiAgICBpZiAoUkVWSUVXX1ZBTFVFX0ZMQUdTLmhhcyh0b2tlbikpIHtcbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIXRva2VuLnN0YXJ0c1dpdGgoXCItXCIpIHx8IHRva2VuLnN0YXJ0c1dpdGgoXCItLVwiKSkgY29udGludWU7XG4gICAgZm9yIChjb25zdCBsZXR0ZXIgb2YgdG9rZW4uc2xpY2UoMSkpIHtcbiAgICAgIGlmIChsZXR0ZXIgPT09IFwiYVwiKSByZXR1cm4gdHJ1ZTtcbiAgICAgIGlmIChSRVZJRVdfVkFMVUVfU0hPUlRIQU5EUy5oYXMobGV0dGVyKSkgYnJlYWs7XG4gICAgfVxuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqIEV2ZXJ5IGBrZXk9dmFsdWVgIGZpZWxkIHRoZSBhcmd2IHN1cHBsaWVzIHRvIGBnaCBhcGlgLCBsb3dlci1jYXNlZC4gKi9cbmZ1bmN0aW9uIGFwaUZpZWxkVmFsdWVzKGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBmaWVsZHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGZsYWdzID0gbmV3IFNldChbXCItZlwiLCBcIi1GXCIsIFwiLS1maWVsZFwiLCBcIi0tcmF3LWZpZWxkXCJdKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdG9rZW4gPSBhcmdzW2ldO1xuICAgIGlmICh0b2tlbiA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBpZiAoZmxhZ3MuaGFzKHRva2VuKSkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhcmdzW2kgKyAxXTtcbiAgICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGZpZWxkcy5wdXNoKHZhbHVlLnRvTG93ZXJDYXNlKCkpO1xuICAgICAgICBpKys7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgZXEgPSB0b2tlbi5pbmRleE9mKFwiPVwiKTtcbiAgICBpZiAoZXEgPiAwICYmIGZsYWdzLmhhcyh0b2tlbi5zbGljZSgwLCBlcSkpKSB7XG4gICAgICBmaWVsZHMucHVzaCh0b2tlbi5zbGljZShlcSArIDEpLnRvTG93ZXJDYXNlKCkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmllbGRzO1xufVxuXG4vKiogUkVTVCBlbmRwb2ludCBwYXRoIHdpdGggYW55IG9yaWdpbiBhbmQgbGVhZGluZy90cmFpbGluZyBzbGFzaGVzIHJlbW92ZWQuICovXG5mdW5jdGlvbiBlbmRwb2ludFBhdGgoZW5kcG9pbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBlbmRwb2ludFxuICAgIC5yZXBsYWNlKC9eW2Etel1bYS16MC05Ky4tXSo6XFwvXFwvW14vXStcXC8vaSwgXCJcIilcbiAgICAucmVwbGFjZSgvXlxcLysvLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IGEgUkVTVCBtdXRhdGlvbiBvbiBgcmVwb3Mve293bmVyfS97cmVwb30vcHVsbHMve259YCAoSXNzdWUgIzE0NjIpLlxuICpcbiAqIENvdmVyaW5nIHRoZSBhcmd2IGFsb25lIHdvdWxkIGxlYXZlIHRoZSBvYnZpb3VzIGJ5cGFzczogYGdoIGFwaSAtWCBQVVRcbiAqIHJlcG9zL28vci9wdWxscy8xMi9tZXJnZWAgbWVyZ2VzIHRoZSBQUiBqdXN0IGFzIHN1cmVseSBhcyBgZ2ggcHIgbWVyZ2UgMTJgLFxuICogYW5kIGBnaCBhcGkgLVggUEFUQ0ggcmVwb3Mvby9yL3B1bGxzLzEyIC1mIHN0YXRlPWNsb3NlZGAgY2xvc2VzIGl0LiBPbmx5IHRoZVxuICogZmF0ZS1kZWNpZGluZyBzaGFwZXMgYXJlIGNsYWltZWQg4oCUIHRoZSBtZXJnZSBzdWItcmVzb3VyY2UsIGEgUEFUQ0ggY2FycnlpbmdcbiAqIGBzdGF0ZT1gLCBhbmQgYSByZXZpZXcgUE9TVCB3aG9zZSBgZXZlbnRgIGlzIGFuIGFwcHJvdmFsLiBBIFBBVENIIHdpdGggbm9cbiAqIGBzdGF0ZT1gIGlzIGEgdGl0bGUvYm9keSBlZGl0IGFuZCByZXR1cm5zIGB1bmRlZmluZWRgLCBhcyBkbyBgL2NvbW1lbnRzYCxcbiAqIGAvcmVxdWVzdGVkX3Jldmlld2Vyc2AgYW5kIHRoZSByZXN0LCBzbyB0aGV5IHN0YXkgYWxsb3dlZC5cbiAqXG4gKiBgZ2ggcHIgcmVhZHlgIGhhcyBubyBSRVNUIHNwZWxsaW5nIOKAlCBHaXRIdWIgZXhwb3NlcyBpdCBvbmx5IGFzIHRoZSBHcmFwaFFMXG4gKiBgbWFya1B1bGxSZXF1ZXN0UmVhZHlGb3JSZXZpZXdgIG11dGF0aW9uLCBhbmQgYW4gdW5zYW5jdGlvbmVkIEdyYXBoUUxcbiAqIG11dGF0aW9uIGFscmVhZHkgZmFpbHMgY2xvc2VkIGFzIGBXUklURV9UQVJHRVRfVU5ERVRFUk1JTkFCTEVgLlxuICovXG5mdW5jdGlvbiBjbGFzc2lmeUFwaVByTGlmZWN5Y2xlKFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgaW5mbzogTXV0YXRpb25JbmZvLFxuKTogUHJMaWZlY3ljbGVBdHRlbXB0IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbWV0aG9kID0gaW5mby52ZXJiLnNsaWNlKFwiYXBpLVwiLmxlbmd0aCkudG9VcHBlckNhc2UoKTtcbiAgY29uc3QgcGF0aCA9IGVuZHBvaW50UGF0aChpbmZvLnRhcmdldCA/PyBcIlwiKTtcbiAgY29uc3QgbWF0Y2ggPSBwYXRoLm1hdGNoKC9ecmVwb3NcXC8oW14vXSspXFwvKFteL10rKVxcL3B1bGxzXFwvKFxcZCspKFxcLyguKikpPyQvKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBjb25zdCBvd25lciA9IG1hdGNoWzFdITtcbiAgY29uc3QgbmFtZSA9IG1hdGNoWzJdITtcbiAgY29uc3QgcHJOdW1iZXIgPSBwYXJzZUludChtYXRjaFszXSEsIDEwKTtcbiAgY29uc3Qgc3ViID0gbWF0Y2hbNV0gPz8gXCJcIjtcbiAgLy8gYHJlcG9zL3tvd25lcn0ve3JlcG99L+KApmAgaXMgZ2gncyBvd24gcGxhY2Vob2xkZXIgZm9ybSwgcmVzb2x2ZWQgZnJvbSB0aGVcbiAgLy8gY3VycmVudCBjbG9uZSDigJQgdGhlIGNsYWltZWQgcmVwbyBkdXJpbmcgYSBjb2RpbmcgcnVuLlxuICBjb25zdCByZXBvID0gb3duZXIgPT09IFwie293bmVyfVwiIHx8IG5hbWUgPT09IFwie3JlcG99XCJcbiAgICA/IHVuZGVmaW5lZFxuICAgIDogYCR7b3duZXJ9LyR7bmFtZX1gO1xuICBjb25zdCBiYXNlID0ge1xuICAgIC4uLihyZXBvID8geyByZXBvIH0gOiB7fSksXG4gICAgLi4uKE51bWJlci5pc05hTihwck51bWJlcikgPyB7fSA6IHsgcHJOdW1iZXIgfSksXG4gIH07XG5cbiAgaWYgKHN1YiA9PT0gXCJtZXJnZVwiKSB7XG4gICAgcmV0dXJuIG1ldGhvZCA9PT0gXCJQVVRcIiA/IHsgdmVyYjogXCJtZXJnZVwiLCAuLi5iYXNlIH0gOiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKHN1YiA9PT0gXCJyZXZpZXdzXCIpIHtcbiAgICBpZiAobWV0aG9kICE9PSBcIlBPU1RcIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBjb25zdCBldmVudCA9IGFwaUZpZWxkVmFsdWVzKGFyZ3MpLmZpbmQoKGYpID0+IGYuc3RhcnRzV2l0aChcImV2ZW50PVwiKSk7XG4gICAgcmV0dXJuIGV2ZW50Py5zbGljZShcImV2ZW50PVwiLmxlbmd0aCkudHJpbSgpID09PSBcImFwcHJvdmVcIlxuICAgICAgPyB7IHZlcmI6IFJFVklFV19BUFBST1ZFX1ZFUkIsIC4uLmJhc2UgfVxuICAgICAgOiB1bmRlZmluZWQ7XG4gIH1cbiAgaWYgKHN1YiAhPT0gXCJcIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKG1ldGhvZCAhPT0gXCJQQVRDSFwiKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHN0YXRlID0gYXBpRmllbGRWYWx1ZXMoYXJncykuZmluZCgoZikgPT4gZi5zdGFydHNXaXRoKFwic3RhdGU9XCIpKTtcbiAgaWYgKHN0YXRlID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiB7XG4gICAgdmVyYjogc3RhdGUuZW5kc1dpdGgoXCJvcGVuXCIpID8gXCJyZW9wZW5cIiA6IFwiY2xvc2VcIixcbiAgICAuLi5iYXNlLFxuICB9O1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IG9uZSBhbHJlYWR5LWNsYXNzaWZpZWQgYGdoYCBtdXRhdGlvbiBhcyBhIFBSLWxpZmVjeWNsZSBkZWNpc2lvbi5cbiAqXG4gKiBAcGFyYW0gcmF3QXJncyAtIEFyZ3VtZW50cyBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHBhcmFtIGluZm8gLSBUaGUgbXV0YXRpb24gYXMgY2xhc3NpZmllZCBieSBgY2xhc3NpZnlHaE11dGF0aW9uYC5cbiAqIEByZXR1cm5zIFRoZSBhdHRlbXB0LCBvciBgdW5kZWZpbmVkYCB3aGVuIHRoZSBjb21tYW5kIGRlY2lkZXMgbm8gcHVsbFxuICogICByZXF1ZXN0J3MgZmF0ZSAoYSBgcHIgY3JlYXRlYCwgYSBjb21tZW50LCBhbiBlZGl0LCBhIHJlYWQsIGFuIGlzc3VlXG4gKiAgIG9wZXJhdGlvbikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGFzc2lmeVByTGlmZWN5Y2xlKFxuICByYXdBcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgaW5mbzogTXV0YXRpb25JbmZvLFxuKTogUHJMaWZlY3ljbGVBdHRlbXB0IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgYXJncyA9IG5vcm1hbGlzZUdoQXJncyhyYXdBcmdzKTtcblxuICBpZiAoaW5mby52ZXJiLnN0YXJ0c1dpdGgoXCJhcGktXCIpKSByZXR1cm4gY2xhc3NpZnlBcGlQckxpZmVjeWNsZShhcmdzLCBpbmZvKTtcblxuICBpZiAoIWluZm8udmVyYi5zdGFydHNXaXRoKFwicHItXCIpKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCB2ZXJiID0gaW5mby52ZXJiLnNsaWNlKFwicHItXCIubGVuZ3RoKTtcblxuICBsZXQgbGlmZWN5Y2xlVmVyYjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBpZiAoUFJfTElGRUNZQ0xFX1ZFUkJfU0VULmhhcyh2ZXJiKSkgbGlmZWN5Y2xlVmVyYiA9IHZlcmI7XG4gIGVsc2UgaWYgKHZlcmIgPT09IFwicmV2aWV3XCIgJiYgYXBwcm92ZXNSZXZpZXcoYXJncykpIHtcbiAgICBsaWZlY3ljbGVWZXJiID0gUkVWSUVXX0FQUFJPVkVfVkVSQjtcbiAgfVxuICBpZiAobGlmZWN5Y2xlVmVyYiA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHJlcG8gPSBpbmZvLnJlcG8gPz8gcmVwb0Zyb21QclVybChpbmZvLnRhcmdldCk7XG4gIGNvbnN0IHByTnVtYmVyID0gcHJOdW1iZXJGcm9tVGFyZ2V0KGluZm8udGFyZ2V0KTtcbiAgcmV0dXJuIHtcbiAgICB2ZXJiOiBsaWZlY3ljbGVWZXJiLFxuICAgIC4uLihyZXBvID8geyByZXBvIH0gOiB7fSksXG4gICAgLi4uKHByTnVtYmVyICE9PSB1bmRlZmluZWQgPyB7IHByTnVtYmVyIH0gOiB7fSksXG4gIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F3Q0MsR0FHRCxTQUFTLGVBQWUsUUFBUSxzQkFBc0I7QUFFdEQ7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sTUFBTSxxQkFBd0M7RUFDbkQ7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNELENBQUM7QUFFRiwyRUFBMkUsR0FDM0UsTUFBTSx3QkFBNkMsSUFBSSxJQUFJO0VBQ3pEO0VBQ0E7RUFDQTtFQUNB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
// denoCacheMetadata=15700048982591868860,15379339799171444876