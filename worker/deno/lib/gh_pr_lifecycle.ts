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
 */

import type { MutationInfo } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";

/**
 * `gh pr <verb>` sub-verbs that decide a pull request's fate.
 *
 * `create`, `comment`, `edit`, `view`, `list`, `diff` and `checks` are
 * deliberately absent — raising the PR and describing it is exactly what the
 * agent is for.
 */
export const PR_LIFECYCLE_VERBS: readonly string[] = [
  "merge",
  "close",
  "reopen",
  "ready",
  "review --approve",
];

/** Bare `gh pr <verb>` spellings refused outright, without reading flags. */
const PR_LIFECYCLE_VERB_SET: ReadonlySet<string> = new Set([
  "merge",
  "close",
  "reopen",
  "ready",
]);

/** The verb reported for an approving review, in either spelling. */
const REVIEW_APPROVE_VERB = "review --approve";

/** One classified attempt to decide a pull request's fate. */
export interface PrLifecycleAttempt {
  /** Bare lifecycle verb — `merge`, `close`, `review --approve`, … */
  verb: string;
  /**
   * `owner/repo` the attempt names, when the argv names one. Absent when
   * `gh` would resolve the repo from the current clone — which, during a
   * coding run, is the claimed repo.
   */
  repo?: string;
  /** Pull request number, when the argv names one. */
  prNumber?: number;
}

/** PR number at the end of a positional target (`12`, or a PR URL). */
function prNumberFromTarget(target: string | undefined): number | undefined {
  if (!target) return undefined;
  const match = target.replace(/\/+$/, "").match(/(\d+)$/);
  if (!match) return undefined;
  const num = parseInt(match[1]!, 10);
  return Number.isNaN(num) ? undefined : num;
}

/** `owner/repo` from a pull-request URL target, when the target is one. */
function repoFromPrUrl(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const match = target.match(
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/\d+/i,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Flags on `gh pr review` whose following token is a value, not a flag.
 *
 * Scanning without them reads the value of `--body -a` as an approve
 * shorthand and refuses a review that requests changes — a false refusal, and
 * a needless one.
 */
const REVIEW_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-R",
  "--repo",
]);

/**
 * Shorthand letters that take a value on `gh pr review`.
 *
 * `-b` is `--body` and `-F` is `--body-file`; `-R` is gh's global `--repo`.
 * pflag hands the first value-taking letter in a shorthand group the remainder
 * of the token, so the group walk stops there — `-ba` is `--body a`, not an
 * approval, while `-ac` is `--approve --comment`. Mirrors the reasoning in
 * `gh_flag_parser.ts`, at the one subcommand this module needs it for.
 */
const REVIEW_VALUE_SHORTHANDS: ReadonlySet<string> = new Set(["b", "F", "R"]);

/** pflag's false-y spellings for an explicit boolean flag value. */
const FALSEY: ReadonlySet<string> = new Set(["0", "f", "false"]);

/**
 * Whether a `gh pr review` argv approves the pull request.
 *
 * Covers `--approve`, `--approve=<bool>`, the `-a` shorthand, and `-a` inside a
 * shorthand group (`-ac`). Value-carrying flags take their following token with
 * them, and a group is walked only through letters pflag treats as boolean
 * here, so an `a` that is really part of a body is not mistaken for the flag.
 */
function approvesReview(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
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
    for (const letter of token.slice(1)) {
      if (letter === "a") return true;
      if (REVIEW_VALUE_SHORTHANDS.has(letter)) break;
    }
  }
  return false;
}

/** Every `key=value` field the argv supplies to `gh api`, lower-cased. */
function apiFieldValues(args: readonly string[]): string[] {
  const fields: string[] = [];
  const flags = new Set(["-f", "-F", "--field", "--raw-field"]);
  for (let i = 0; i < args.length; i++) {
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

/** REST endpoint path with any origin and leading/trailing slashes removed. */
function endpointPath(endpoint: string): string {
  return endpoint
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
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
 */
function classifyApiPrLifecycle(
  args: readonly string[],
  info: MutationInfo,
): PrLifecycleAttempt | undefined {
  const method = info.verb.slice("api-".length).toUpperCase();
  const path = endpointPath(info.target ?? "");
  const match = path.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/(.*))?$/);
  if (!match) return undefined;

  const owner = match[1]!;
  const name = match[2]!;
  const prNumber = parseInt(match[3]!, 10);
  const sub = match[5] ?? "";
  // `repos/{owner}/{repo}/…` is gh's own placeholder form, resolved from the
  // current clone — the claimed repo during a coding run.
  const repo = owner === "{owner}" || name === "{repo}"
    ? undefined
    : `${owner}/${name}`;
  const base = {
    ...(repo ? { repo } : {}),
    ...(Number.isNaN(prNumber) ? {} : { prNumber }),
  };

  if (sub === "merge") {
    return method === "PUT" ? { verb: "merge", ...base } : undefined;
  }
  if (sub === "reviews") {
    if (method !== "POST") return undefined;
    const event = apiFieldValues(args).find((f) => f.startsWith("event="));
    return event?.slice("event=".length).trim() === "approve"
      ? { verb: REVIEW_APPROVE_VERB, ...base }
      : undefined;
  }
  if (sub !== "") return undefined;
  if (method !== "PATCH") return undefined;

  const state = apiFieldValues(args).find((f) => f.startsWith("state="));
  if (state === undefined) return undefined;
  return {
    verb: state.endsWith("open") ? "reopen" : "close",
    ...base,
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
 */
export function classifyPrLifecycle(
  rawArgs: readonly string[],
  info: MutationInfo,
): PrLifecycleAttempt | undefined {
  const args = normaliseGhArgs(rawArgs);

  if (info.verb.startsWith("api-")) return classifyApiPrLifecycle(args, info);

  if (!info.verb.startsWith("pr-")) return undefined;
  const verb = info.verb.slice("pr-".length);

  let lifecycleVerb: string | undefined;
  if (PR_LIFECYCLE_VERB_SET.has(verb)) lifecycleVerb = verb;
  else if (verb === "review" && approvesReview(args)) {
    lifecycleVerb = REVIEW_APPROVE_VERB;
  }
  if (lifecycleVerb === undefined) return undefined;

  const repo = info.repo ?? repoFromPrUrl(info.target);
  const prNumber = prNumberFromTarget(info.target);
  return {
    verb: lifecycleVerb,
    ...(repo ? { repo } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
  };
}
