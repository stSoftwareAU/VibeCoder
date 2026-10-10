/**
 * Refuses retargeting a pull request's base branch (Issue #3433).
 *
 * A milestone-fix PR targets its milestone branch, and a milestone child PR
 * targets a milestone branch too. Editing either PR's base to the default
 * branch (`gh pr edit --base main`, `PATCH`/`POST repos/o/r/pulls/N` with
 * `base=main`, or a GraphQL `updatePullRequest` mutation) lands that work on the default branch and auto-merges it there,
 * skipping the milestone's final review. The worker owns PR targeting, so:
 *
 *   - the agent guard (`gh_guard_decision.ts`) refuses every base change
 *     (it is pure and cannot look the PR up), and
 *   - the worker chokepoint (`gh_spawn.ts`) reads the PR's head and base first
 *     and applies {@link decidePrBaseChange}, failing closed when it cannot.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { classifyGhMutation } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";
import {
  isMilestoneBranch,
  isMilestoneFixBranch,
  milestoneFixPrefixFor,
} from "./milestone_branch_names.ts";

/** A request that changes a pull request's base branch. */
export interface PrBaseChange {
  /**
   * The base branch requested. `null` when the request carries a base change
   * whose target could not be read (an unreadable `--input` body) — callers
   * must fail closed.
   */
  newBase: string | null;
  /** `owner/repo`, when the argv names one. */
  repo?: string;
  /** PR number, URL or branch the argv selects, when it names one. */
  prSelector?: string;
}

/** Reads a request body file; throws when it cannot. */
export type PrBaseBodyReader = (path: string) => string;

/** `milestone-fix/<leaf>/pr-<N>-<discriminator>`. */
const MILESTONE_FIX_HEAD = /^milestone-fix\/([A-Za-z0-9._-]+)\/pr-([0-9]+)-.+$/;

/**
 * Parse a milestone-fix head branch into its leaf and milestone PR number.
 *
 * @returns undefined when the head does not have the fix-branch shape.
 */
export function parseMilestoneFixHead(
  head: string,
): { leaf: string; milestonePrNumber: number } | undefined {
  const match = head.match(MILESTONE_FIX_HEAD);
  if (!match) return undefined;
  const milestonePrNumber = Number(match[2]);
  if (!Number.isSafeInteger(milestonePrNumber) || milestonePrNumber <= 0) {
    return undefined;
  }
  return { leaf: match[1]!, milestonePrNumber };
}

/** `gh pr edit` flags whose following token is a value, not the selector. */
const PR_EDIT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--base",
  "-B",
  "--repo",
  "-R",
  "--title",
  "-t",
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--add-label",
  "--remove-label",
  "--add-assignee",
  "--remove-assignee",
  "--add-reviewer",
  "--remove-reviewer",
  "--add-project",
  "--remove-project",
  "--milestone",
  "-m",
]);

const FIELD_FLAGS: ReadonlySet<string> = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field",
]);

/** Last `--base`/`-B` value of a normalised `gh pr edit` argv, if any. */
function prEditBase(args: readonly string[]): string | undefined {
  let base: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") break;
    if (token === "--base" || token === "-B") {
      const value = args[i + 1];
      if (value !== undefined) base = value;
      i++;
    } else if (token.startsWith("--base=")) {
      base = token.slice("--base=".length);
    } else if (token.startsWith("-B") && !token.startsWith("--")) {
      const rest = token.slice(2);
      base = rest.startsWith("=") ? rest.slice(1) : rest;
    }
  }
  return base;
}

/** First positional after `edit`, skipping the values of value-taking flags. */
function prEditSelector(args: readonly string[]): string | undefined {
  const editAt = args.indexOf("edit");
  for (let i = editAt + 1; i < args.length; i++) {
    const token = args[i]!;
    if (PR_EDIT_VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (!token.startsWith("-")) return token;
  }
  return undefined;
}

/** `owner/repo` from a pull-request URL. */
function repoFromPrUrl(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const match = target.match(
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/\d+/i,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * REST endpoint path with any `?query`/`#fragment`, origin and leading/trailing
 * slashes removed. GitHub ignores unknown query parameters, so a suffix must
 * not stop the anchored endpoint match (PR #3514 review).
 */
function endpointPath(endpoint: string): string {
  return endpoint
    .replace(/[?#].*$/s, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * The `base` field of a `gh api` argv: its value, `null` when the value is
 * read from a file (`@path`) and so cannot be seen, or `undefined` when absent.
 */
function apiBaseField(args: readonly string[]): string | null | undefined {
  let result: string | null | undefined;
  const take = (field: string, expandsAtFile: boolean): void => {
    const eq = field.indexOf("=");
    if (eq <= 0 || field.slice(0, eq) !== "base") return;
    const value = field.slice(eq + 1);
    result = expandsAtFile && value.startsWith("@") ? null : value;
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (FIELD_FLAGS.has(token)) {
      const value = args[i + 1];
      if (value !== undefined) {
        take(value, token === "-F" || token === "--field");
      }
      i++;
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0 && FIELD_FLAGS.has(token.slice(0, eq))) {
      const flag = token.slice(0, eq);
      take(token.slice(eq + 1), flag === "-F" || flag === "--field");
    }
  }
  return result;
}

/** The `base` of an `--input` JSON body: string, undefined (absent) or null. */
function inputBodyBase(
  path: string | undefined,
  readBodyFile: PrBaseBodyReader | undefined,
): string | null | undefined {
  if (path === undefined || !readBodyFile) return null;
  try {
    const doc: unknown = JSON.parse(readBodyFile(path));
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      return null;
    }
    const base = (doc as { base?: unknown }).base;
    if (base === undefined) return undefined;
    return typeof base === "string" ? base : null;
  } catch {
    return null;
  }
}

/** Matches the GraphQL mutation that can set `baseRefName`, case-insensitively. */
const UPDATE_PULL_REQUEST = /updatepullrequest/i;

/**
 * Whether a `gh api graphql` request may carry an `updatePullRequest`
 * mutation (PR #3514 review).
 *
 * Does not rely on the classifier's parsed depth-1 fields, which misread a
 * multi-operation document picked by `operationName` and a `#` comment holding
 * a brace. Instead the raw argv is searched for the name anywhere, and every
 * document `gh` reads off the command line (`-F query=@file`, `-F k=@-`,
 * `--input <file>`, `--input -`) is read and searched too. A source that cannot
 * be read — stdin, no reader, a read error — counts as a match: failing closed
 * is the only safe answer for a document nobody can see.
 */
function graphqlMayUpdatePullRequest(
  args: readonly string[],
  readBodyFile: PrBaseBodyReader | undefined,
): boolean {
  if (args.some((a) => UPDATE_PULL_REQUEST.test(a))) return true;

  const sources: string[] = [];
  const fromFieldValue = (value: string | undefined): void => {
    const eq = value?.indexOf("=") ?? -1;
    if (value === undefined || eq < 0) return;
    const fieldValue = value.slice(eq + 1);
    if (fieldValue.startsWith("@")) sources.push(fieldValue.slice(1));
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") break;
    if (token === "-F" || token === "--field") {
      fromFieldValue(args[i + 1]);
      i++;
    } else if (token.startsWith("--field=")) {
      fromFieldValue(token.slice("--field=".length));
    } else if (token === "--input") {
      sources.push(args[i + 1] ?? "-");
      i++;
    } else if (token.startsWith("--input=")) {
      sources.push(token.slice("--input=".length));
    } else if (token === "-f" || token === "--raw-field") {
      i++; // a static string: `@` is not a file here
    }
  }
  return sources.some((path) => {
    if (path === "-" || !readBodyFile) return true;
    try {
      return UPDATE_PULL_REQUEST.test(readBodyFile(path));
    } catch {
      return true;
    }
  });
}

/**
 * Recognise a request that changes a PR's base branch.
 *
 * Covers `gh pr edit --base|-B`, `gh api repos/o/r/pulls/N` with a `base`
 * field (inline, or in an `--input` file) sent as PATCH or POST — POST being
 * what `gh api` uses when a field is given and `-X` is not — and any
 * `gh api graphql` request that may carry an `updatePullRequest` mutation,
 * including one read from a file or stdin (`newBase: null`, so callers fail
 * closed).
 *
 * @returns undefined when the command changes no PR's base.
 */
export function classifyPrBaseChange(
  rawArgs: readonly string[],
  readBodyFile?: PrBaseBodyReader,
): PrBaseChange | undefined {
  const args = normaliseGhArgs(rawArgs);
  const info = classifyGhMutation(rawArgs);
  if (!info) return undefined;

  if (info.verb === "pr-edit") {
    const base = prEditBase(args);
    if (base === undefined) return undefined;
    const prSelector = info.target ?? prEditSelector(args);
    const repo = info.repo ?? repoFromPrUrl(prSelector);
    return {
      newBase: base,
      ...(repo ? { repo } : {}),
      ...(prSelector ? { prSelector } : {}),
    };
  }

  // GraphQL `updatePullRequest` sets `baseRefName`; the document's variables
  // can hide it, so every such mutation is treated as an unreadable base change
  // (PR #3514 review). That covers a document read from a file or stdin, which
  // the classifier reports as `api-graphql-unknown`. The worker's own GraphQL
  // calls pass the document inline, so failing closed costs it nothing, and
  // `gh pr edit` still covers the title and body.
  if (
    (info.verb === "api-graphql-mutation" ||
      info.verb === "api-graphql-unknown") &&
    graphqlMayUpdatePullRequest(args, readBodyFile)
  ) {
    return { newBase: null };
  }

  // GitHub routes POST on `pulls/N` to the same update handler as PATCH, and
  // `gh api` sends POST whenever a field is given without `-X` (PR #3514 review).
  if (info.verb !== "api-patch" && info.verb !== "api-post") return undefined;
  const match = endpointPath(info.target ?? "").match(
    /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/,
  );
  if (!match) return undefined;

  let base = apiBaseField(args);
  if (base === undefined && info.unreadableBody) {
    base = inputBodyBase(info.bodyFilePath, readBodyFile);
  }
  if (base === undefined) return undefined;

  const owner = match[1]!;
  const name = match[2]!;
  const placeholder = owner === "{owner}" || name === "{repo}";
  const repo = placeholder ? undefined : `${owner}/${name}`;
  return {
    newBase: base,
    ...(repo ? { repo } : {}),
    prSelector: match[3]!,
  };
}

/** Verdict for a requested base change. */
export type PrBaseChangeDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide whether a PR may move from `currentBase` to `newBase`.
 *
 * A milestone-fix PR may only ever target its own milestone branch; any PR on
 * a milestone branch may only move to another milestone branch.
 */
export function decidePrBaseChange(
  input: { headRefName: string; currentBase: string; newBase: string | null },
): PrBaseChangeDecision {
  const { headRefName, currentBase, newBase } = input;
  if (newBase === null) {
    return {
      allowed: false,
      reason: "the requested base could not be read, failing closed",
    };
  }
  if (isMilestoneFixBranch(headRefName)) {
    const parsed = parseMilestoneFixHead(headRefName);
    const own = parsed !== undefined && isMilestoneBranch(newBase) &&
      headRefName.startsWith(
        milestoneFixPrefixFor(newBase, parsed.milestonePrNumber),
      );
    return own ? { allowed: true } : {
      allowed: false,
      reason: "milestone-fix PRs only ever target their milestone branch",
    };
  }
  if (isMilestoneBranch(currentBase) && !isMilestoneBranch(newBase)) {
    return {
      allowed: false,
      reason: "moving a PR off a milestone branch puts the milestone's work " +
        "on a non-milestone base without the milestone's final review",
    };
  }
  return { allowed: true };
}

/** Thrown when a base change is refused. */
export class PrBaseChangeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrBaseChangeRefusedError";
  }
}

/** Dependencies of {@link enforcePrBaseChangeGuard}. */
export interface PrBaseChangeGuardDeps {
  /** Reads the PR's current head and base; may throw. */
  lookup: (
    change: PrBaseChange,
  ) => Promise<{ headRefName: string; baseRefName: string }>;
  readBodyFile?: PrBaseBodyReader;
  log: (line: string) => void;
}

/**
 * Refuse a base change that would move a milestone PR off its milestone
 * branch. A no-op for any other command. A failed lookup refuses.
 *
 * @throws PrBaseChangeRefusedError when the change is refused.
 */
export async function enforcePrBaseChangeGuard(
  args: readonly string[],
  deps: PrBaseChangeGuardDeps,
): Promise<void> {
  const change = classifyPrBaseChange(args, deps.readBodyFile);
  if (!change) return;

  let head = "<unknown>";
  let current = "<unknown>";
  let reason: string | undefined;
  try {
    const pr = await deps.lookup(change);
    head = pr.headRefName;
    current = pr.baseRefName;
    const verdict = decidePrBaseChange({
      headRefName: head,
      currentBase: current,
      newBase: change.newBase,
    });
    if (!verdict.allowed) reason = verdict.reason;
  } catch (error) {
    reason = `could not read the PR's head and base (${
      error instanceof Error ? error.message : String(error)
    }), failing closed`;
  }
  if (reason === undefined) return;

  const line =
    `[SECURITY] [PR_BASE_CHANGE_REFUSED] repo=${change.repo ?? "<cwd>"} pr=${
      change.prSelector ?? "<cwd>"
    } head=${head} currentBase=${current} ` +
    `newBase=${change.newBase ?? "<unreadable>"} reason=${reason}`;
  deps.log(line);
  throw new PrBaseChangeRefusedError(line);
}
