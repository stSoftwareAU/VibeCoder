/**
 * Issue-lifecycle classification for the agent-side `gh` guard (Issue #222).
 *
 * The implementing agent may comment on the issue it is working, label it, and
 * edit its body — but deciding that an issue is **closed**, **reopened**,
 * **moved** or **locked** is the worker's call or a human's, never the agent's.
 * VibeCoder#222 records what happens when it is not: an agent that correctly
 * diagnosed a hard dependency block ran
 * `gh issue close … --reason "not planned"` on its own claimed issue, and the
 * worker's no-changes handler then mislabelled the run analysis-only.
 *
 * `gh issue close` is already classified as a mutation by
 * `audit_mutation_classifier.ts`, so it is journalled — but the write-repo
 * allowlist allows it, because the claimed repo is by construction on the
 * allowlist. This module supplies the missing distinction: *which* mutations
 * are issue-lifecycle changes, so {@link evaluateGhCommand} can refuse them for
 * the claimed repo unless the run explicitly permits the verb.
 *
 * Pure by design — it runs inside the guard's short-lived child process with
 * `--allow-read` and nothing else.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { MutationInfo } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";

/**
 * `gh issue <verb>` sub-verbs that change an issue's lifecycle state.
 *
 * `comment` and `create` are deliberately absent: posting the hand-off comment
 * and filing a follow-up issue are exactly what a blocked agent *should* do.
 */
export const ISSUE_LIFECYCLE_VERBS: readonly string[] = [
  "close",
  "reopen",
  "edit",
  "delete",
  "transfer",
  "lock",
  "unlock",
  "pin",
  "unpin",
];

/** Lifecycle verbs the run permits by default — see {@link ClaimedIssue}. */
const LIFECYCLE_VERB_SET: ReadonlySet<string> = new Set(ISSUE_LIFECYCLE_VERBS);

/** One classified attempt to change an issue's lifecycle state. */
export interface IssueLifecycleAttempt {
  /** Bare lifecycle verb — `close`, `edit`, `lock`, … */
  verb: string;
  /**
   * `owner/repo` the attempt names, when the argv names one. Absent when
   * `gh` would resolve the repo from the current clone — which, during a
   * coding run, is the claimed repo.
   */
  repo?: string;
  /** Issue number, when the argv names one. */
  issueNumber?: number;
}

/** Issue number at the end of a positional target (`94`, or an issue URL). */
function issueNumberFromTarget(target: string | undefined): number | undefined {
  if (!target) return undefined;
  const match = target.replace(/\/+$/, "").match(/(\d+)$/);
  if (!match) return undefined;
  const num = parseInt(match[1]!, 10);
  return Number.isNaN(num) ? undefined : num;
}

/** `owner/repo` from an issue URL target, when the target is one. */
function repoFromIssueUrl(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const match = target.match(
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/\d+/i,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** REST endpoint path with any origin and leading slash removed. */
function endpointPath(endpoint: string): string {
  return endpoint
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
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

/**
 * Classify a REST mutation on `repos/{owner}/{repo}/issues/{n}` (Issue #222).
 *
 * `gh api -X PATCH repos/o/r/issues/94 -f state=closed` closes an issue just as
 * surely as `gh issue close 94`, so the guard reads the endpoint too. Only the
 * lifecycle shapes are claimed: a PATCH carrying `state=` (close/reopen), a
 * PATCH without one (a title/body edit), and the `/lock` sub-resource.
 * `/comments`, `/labels` and `/assignees` are not lifecycle changes and return
 * `undefined`, so they stay allowed.
 */
function classifyApiLifecycle(
  args: readonly string[],
  info: MutationInfo,
): IssueLifecycleAttempt | undefined {
  const method = info.verb.slice("api-".length).toUpperCase();
  const path = endpointPath(info.target ?? "");
  const match = path.match(/^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/(.*))?$/);
  if (!match) return undefined;

  const owner = match[1]!;
  const name = match[2]!;
  const issueNumber = parseInt(match[3]!, 10);
  const sub = match[5] ?? "";
  // `repos/{owner}/{repo}/…` is gh's own placeholder form, resolved from the
  // current clone — the claimed repo during a coding run.
  const repo = owner === "{owner}" || name === "{repo}"
    ? undefined
    : `${owner}/${name}`;
  const base = {
    ...(repo ? { repo } : {}),
    ...(Number.isNaN(issueNumber) ? {} : { issueNumber }),
  };

  if (sub === "lock") {
    if (method === "PUT") return { verb: "lock", ...base };
    if (method === "DELETE") return { verb: "unlock", ...base };
    return undefined;
  }
  if (sub !== "") return undefined;
  if (method !== "PATCH") return undefined;

  const state = apiFieldValues(args).find((f) => f.startsWith("state="));
  if (state === undefined) return { verb: "edit", ...base };
  return {
    verb: state.endsWith("open") ? "reopen" : "close",
    ...base,
  };
}

/**
 * Classify one already-classified `gh` mutation as an issue-lifecycle change.
 *
 * @param rawArgs - Arguments passed to the `gh` binary.
 * @param info - The mutation as classified by `classifyGhMutation`.
 * @returns The attempt, or `undefined` when the command changes no issue's
 *   lifecycle state (a comment, a label, a read, a PR operation).
 */
export function classifyIssueLifecycle(
  rawArgs: readonly string[],
  info: MutationInfo,
): IssueLifecycleAttempt | undefined {
  const args = normaliseGhArgs(rawArgs);

  if (info.verb.startsWith("api-")) return classifyApiLifecycle(args, info);

  if (!info.verb.startsWith("issue-")) return undefined;
  const verb = info.verb.slice("issue-".length);
  if (!LIFECYCLE_VERB_SET.has(verb)) return undefined;

  const repo = info.repo ?? repoFromIssueUrl(info.target);
  const issueNumber = issueNumberFromTarget(info.target);
  return {
    verb,
    ...(repo ? { repo } : {}),
    ...(issueNumber !== undefined ? { issueNumber } : {}),
  };
}
