/**
 * Classify `gh` and `git` argument lists as GitHub mutations (Issue #2380).
 *
 * The audit journal only records mutations — commands that change GitHub
 * state (comment posted, PR opened/merged, label applied, issue
 * opened/closed/edited, milestone created via the REST API, commits
 * pushed). Read-only commands (`view`, `list`, `status`, a GET `gh api`,
 * etc.) return `null` so the journal is not polluted with reads.
 *
 * Keeping the classification in one place means the central `gh`/`git`
 * chokepoints stay one-liners and the mutation taxonomy has a single
 * source of truth.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { normaliseGhArgs } from "./gh_flag_parser.ts";

/**
 * How the mutation's target repo was — or was not — determined (Issue #3703).
 *
 * The write-repo allowlist keys its fail-closed decision on this: only
 * `explicit` can be compared against the allowlist, `cwd` and `non-repo`
 * are structurally safe, and `unknown` must be refused rather than
 * silently allowed.
 */
export type MutationScope =
  /** An `owner/repo` was named explicitly (`-R`, endpoint, positional). */
  | "explicit"
  /** `gh` resolves the repo from the current clone — the run's own repo. */
  | "cwd"
  /** A sanctioned mutation that touches no repository at all. */
  | "non-repo"
  /** Target undeterminable — callers must fail closed. */
  | "unknown";

/** A classified mutation: a verb plus optional repo/target context. */
export interface MutationInfo {
  /** Stable action verb, e.g. "issue-comment", "pr-merge", "git-push". */
  verb: string;
  /** owner/repo, when derivable from the arguments. */
  repo?: string;
  /** Target identifier (issue/PR number, branch, or API endpoint). */
  target?: string;
  /** How the target repo was determined (Issue #3703). */
  scope: MutationScope;
}

/** Mutating sub-verbs per `gh` root command. */
const GH_MUTATING_VERBS: Record<string, ReadonlySet<string>> = {
  issue: new Set([
    "comment",
    "create",
    "close",
    "reopen",
    "edit",
    "delete",
    "lock",
    "unlock",
    "pin",
    "unpin",
    "transfer",
  ]),
  pr: new Set([
    "create",
    "comment",
    "close",
    "reopen",
    "edit",
    "merge",
    "review",
    "ready",
    "lock",
    "unlock",
  ]),
  label: new Set(["create", "delete", "edit", "clone"]),
  release: new Set(["create", "delete", "edit", "upload"]),
  repo: new Set([
    "create",
    "delete",
    "edit",
    "fork",
    "rename",
    "archive",
    "unarchive",
  ]),
  secret: new Set(["set", "remove", "delete"]),
  variable: new Set(["set", "remove", "delete"]),
  workflow: new Set(["run", "enable", "disable"]),
  run: new Set(["cancel", "rerun", "delete"]),
  cache: new Set(["delete"]),
  gist: new Set(["create", "delete", "edit", "rename", "clone"]),
};

/**
 * Sub-verbs treated as mutating for a root command that is not in
 * {@link GH_MUTATING_VERBS} (Issue #3703).
 *
 * The per-root table above is a positive allowlist, so an unlisted root
 * (`gh ruleset …`, a root added by a future `gh` release) previously
 * classified every sub-verb as a read and slipped past both the write-repo
 * allowlist and the audit journal. Matching the conventional mutating
 * sub-verb names keeps unlisted roots covered without treating genuine
 * reads (`list`, `view`, `status`, `download`) as writes.
 */
const GH_GENERIC_MUTATING_VERBS: ReadonlySet<string> = new Set([
  "add",
  "archive",
  "cancel",
  "clone",
  "close",
  "create",
  "delete",
  "disable",
  "edit",
  "enable",
  "import",
  "lock",
  "merge",
  "remove",
  "rename",
  "rerun",
  "restore",
  "revoke",
  "reopen",
  "run",
  "set",
  "sync",
  "transfer",
  "unarchive",
  "unlock",
  "upload",
]);

/**
 * Root commands whose repo `gh` resolves from the current clone when no
 * `-R`/`--repo` is given. A mutation on one of these without an explicit
 * repo therefore targets the run's own repo, which is on the allowlist by
 * construction. Every other root (e.g. `gist`, which is not repo-scoped at
 * all) yields an undeterminable target and must fail closed.
 */
const GH_CWD_SCOPED_ROOTS: ReadonlySet<string> = new Set([
  "issue",
  "pr",
  "label",
  "release",
  "repo",
  "secret",
  "variable",
  "workflow",
  "run",
  "cache",
  "ruleset",
]);

/**
 * GraphQL mutations sanctioned as touching no repository (Issue #3703).
 *
 * A GraphQL mutation carries no derivable `owner/repo`, so it fails closed
 * by default. This allowlist names the worker's own non-repo mutations —
 * `changeUserStatus` sets the worker account's profile status
 * (`github_status.ts`) and cannot write to any repository. Compared
 * lower-case.
 */
export const GH_SANCTIONED_GRAPHQL_MUTATIONS: ReadonlySet<string> = new Set([
  "changeuserstatus",
]);

/** `gh` flags whose following token is a value, not a positional argument. */
const GH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-X",
  "--method",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "-H",
  "--header",
  "--input",
  "--jq",
  "-q",
  "--template",
  "-t",
  "--cache",
  "-R",
  "--repo",
]);

/**
 * Extract `owner/repo` from a `-R`/`--repo` flag anywhere in the args.
 *
 * Issue #3867: `--repo` is a pflag string flag, so a repeated flag resolves to
 * its **last** occurrence — `-R allowed/repo -R attacker/evil` writes to
 * `attacker/evil`. Returning the first match both allowed the write and
 * journalled the wrong target. Attached shorthand spellings (`-Rowner/repo`)
 * are handled by {@link normaliseGhArgs} before this runs.
 */
function extractRepoFlag(args: readonly string[]): string | undefined {
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "-R" || token === "--repo") {
      // pflag consumes the following token as the value whatever it looks
      // like, so a dash-leading value is taken too — it can only ever fail
      // the allowlist, which is the safe direction.
      const value = args[i + 1];
      if (value !== undefined) {
        repo = value;
        i++;
      }
    } else if (token?.startsWith("--repo=")) {
      repo = token.slice("--repo=".length);
    }
  }
  return repo;
}

/**
 * Index of the first non-flag token at or after `from`.
 *
 * A known value-carrying flag takes its following token with it, so a value
 * such as the `owner/repo` of `-R owner/repo` is never mistaken for the root
 * command or the sub-verb.
 *
 * @param valueFlags - Value-carrying flags of the binary being parsed. Each
 *   binary owns its own table (Issue #3950 — git's globals were being matched
 *   against gh's table, so `git -C /repo push` scanned onto `/repo`).
 */
function firstNonFlag(
  args: readonly string[],
  from: number,
  valueFlags: ReadonlySet<string> = GH_VALUE_FLAGS,
): number {
  let i = from;
  while (args[i]?.startsWith("-")) {
    i += valueFlags.has(args[i]!) ? 2 : 1;
  }
  return i;
}

/**
 * The root command a `gh` argument vector names (`issue`, `api`, …).
 *
 * Shared with the agent-side guard (Issue #3866), which refuses a root it
 * does not recognise, so both derive the root the same way.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @returns The root command, or undefined when the vector names none
 *   (`gh`, `gh --version`).
 */
export function ghRootCommand(args: readonly string[]): string | undefined {
  return args[firstNonFlag(args, 0)];
}

/**
 * Strip an absolute API origin from an endpoint.
 *
 * `gh api` accepts a full URL as well as a path, so
 * `https://api.github.com/repos/o/r/issues` must resolve the same repo as
 * `repos/o/r/issues` (Issue #3703 — absolute endpoints previously derived no
 * repo and slipped past the allowlist).
 */
function stripEndpointOrigin(endpoint: string): string {
  return endpoint.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "");
}

/** Whether an endpoint path is repo-scoped via `{owner}/{repo}` placeholders. */
function isPlaceholderRepoEndpoint(endpoint: string): boolean {
  return /^\/?repos\/\{owner\}\/\{repo\}(\/|$)/.test(endpoint);
}

/** Parse `owner/repo` out of a REST endpoint like `repos/o/r/issues`. */
function repoFromEndpoint(endpoint: string): string | undefined {
  const path = stripEndpointOrigin(endpoint);
  if (isPlaceholderRepoEndpoint(path)) return undefined;
  const match = path.match(/^\/?repos\/([^/]+)\/([^/]+)/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Top-level field names selected by a GraphQL mutation document, or `null`
 * when the document contains no mutation operation (i.e. it is a read).
 *
 * Only the depth-1 selections are returned, so a nested field name can never
 * be mistaken for the mutation being performed. Argument lists are skipped
 * wholesale, so an object literal inside `(input: {…})` does not perturb the
 * brace depth.
 *
 * @param document - The GraphQL document text.
 */
export function graphqlMutationFields(document: string): string[] | null {
  const start = /(^|[^A-Za-z0-9_])mutation(?![A-Za-z0-9_])/.exec(document);
  if (!start) return null;

  // Walk to the operation's selection set, skipping the variable definitions.
  let i = start.index + start[0].length;
  let parens = 0;
  for (; i < document.length; i++) {
    const ch = document[i];
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "{" && parens === 0) break;
  }
  if (i >= document.length) return [];

  const fields: string[] = [];
  let depth = 0;
  let token = "";
  parens = 0;
  for (; i < document.length; i++) {
    const ch = document[i]!;
    if (parens > 0) {
      if (ch === "(") parens++;
      else if (ch === ")") parens--;
      continue;
    }
    if (ch === "(") {
      if (depth === 1 && token) fields.push(token);
      token = "";
      parens = 1;
      continue;
    }
    if (ch === "{") {
      if (depth === 1 && token) fields.push(token);
      token = "";
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth === 1 && token) fields.push(token);
      token = "";
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      token += ch;
      continue;
    }
    // A separator (whitespace, comma, colon): an alias (`alias: field`) ends
    // here too, and the aliased field is captured by the next token.
    if (depth === 1 && token && ch !== ":") fields.push(token);
    token = "";
  }
  return fields;
}

/**
 * Classify a `gh api graphql` invocation (Issue #3703).
 *
 * `gh api graphql -f query=…` always looks like a POST, so every GraphQL
 * read was previously journalled as a mutation while every GraphQL
 * *mutation* passed the allowlist unchecked (no derivable repo). Read
 * documents now classify as reads, and a mutation document is a mutation
 * with an undeterminable target unless it is one of the sanctioned non-repo
 * mutations.
 *
 * Issue #3937: a document `gh` reads from a file (`-F query=@q.graphql`,
 * `--input body.json`) is not in the argv at all, so it can be neither read
 * nor dismissed as a read. Such a call is undeterminable rather than `null`,
 * which is what every downstream control short-circuits on.
 *
 * @param documents - Values of `query=` fields on the command line.
 * @param unreadable - Whether part of the request body is off the command line.
 */
function classifyGhGraphql(
  documents: string[],
  unreadable: boolean,
): MutationInfo | null {
  const fields: string[] = [];
  let isMutation = false;
  for (const document of documents) {
    const mutationFields = graphqlMutationFields(document);
    if (mutationFields === null) continue;
    isMutation = true;
    fields.push(...mutationFields);
  }
  if (!isMutation) {
    if (!unreadable) return null;
    return { verb: "api-graphql-unknown", target: "graphql", scope: "unknown" };
  }

  const sanctioned = !unreadable && fields.length > 0 &&
    fields.every((f) => GH_SANCTIONED_GRAPHQL_MUTATIONS.has(f.toLowerCase()));
  return {
    verb: "api-graphql-mutation",
    target: fields.length > 0 ? `graphql:${fields.join(",")}` : "graphql",
    scope: sanctioned ? "non-repo" : "unknown",
  };
}

/**
 * Classify a `gh api` invocation. Mutating when the effective HTTP method
 * is POST/PATCH/PUT/DELETE — explicit via `-X`/`--method`, or implied by a
 * request body: `gh` defaults to POST whenever fields (`-f`/`-F`) or an
 * `--input` body are set.
 *
 * Issue #3937: `--input` was skipped as a plain value flag, so
 * `gh api <endpoint> --input -` — a POST as far as `gh` is concerned —
 * classified as a GET read and bypassed the journal, the write-repo allowlist
 * and the reserved-label denylist in one go.
 */
function classifyGhApi(
  args: readonly string[],
  start: number,
): MutationInfo | null {
  let method: string | undefined;
  let hasBody = false;
  let endpoint: string | undefined;
  let skipNext = false;
  /** A body component the argv cannot show: `--input`, or a `@file` value. */
  let unreadableBody = false;
  const queryDocuments: string[] = [];

  /**
   * Record a `query=…` field value — the GraphQL document.
   *
   * `gh` reads a field value beginning with `@` from that file (`@-` from
   * stdin), so the document itself never reaches the argv and the call must
   * fail closed rather than read as a mutation-free document.
   */
  const noteField = (value: string | undefined): void => {
    if (!value?.startsWith("query=")) return;
    const document = value.slice("query=".length);
    if (document.startsWith("@")) unreadableBody = true;
    else queryDocuments.push(document);
  };

  for (let i = start; i < args.length; i++) {
    const token = args[i];
    if (token === undefined) continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "-X" || token === "--method") {
      method = args[i + 1];
      skipNext = true;
      continue;
    }
    if (token.startsWith("--method=")) {
      method = token.slice("--method=".length);
      continue;
    }
    if (
      token === "-f" || token === "-F" || token === "--field" ||
      token === "--raw-field"
    ) {
      hasBody = true;
      noteField(args[i + 1]);
      skipNext = true;
      continue;
    }
    if (token.startsWith("--field=")) {
      hasBody = true;
      noteField(token.slice("--field=".length));
      continue;
    }
    if (token.startsWith("--raw-field=")) {
      hasBody = true;
      noteField(token.slice("--raw-field=".length));
      continue;
    }
    if (token === "--input") {
      hasBody = true;
      unreadableBody = true;
      skipNext = true;
      continue;
    }
    if (token.startsWith("--input=")) {
      hasBody = true;
      unreadableBody = true;
      continue;
    }
    if (GH_VALUE_FLAGS.has(token)) {
      skipNext = true;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (endpoint === undefined) endpoint = token;
  }

  if (endpoint === "graphql") {
    return classifyGhGraphql(queryDocuments, unreadableBody);
  }

  const effectiveMethod = (method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(effectiveMethod)) {
    return null;
  }
  const repo = endpoint ? repoFromEndpoint(endpoint) : undefined;
  // Issue #3703: an endpoint that names no repo (`gists`, `orgs/…`, `user/…`)
  // cannot be checked against the allowlist, so it fails closed. The
  // `repos/{owner}/{repo}/…` placeholder form is resolved by `gh` from the
  // current clone and is therefore cwd-scoped.
  const scope: MutationScope = repo
    ? "explicit"
    : (endpoint && isPlaceholderRepoEndpoint(stripEndpointOrigin(endpoint)))
    ? "cwd"
    : "unknown";
  return {
    verb: `api-${effectiveMethod.toLowerCase()}`,
    ...(repo ? { repo } : {}),
    ...(endpoint ? { target: endpoint } : {}),
    scope,
  };
}

/**
 * Classify a `gh` argument list as a GitHub mutation, or `null` for reads.
 *
 * @param args - Arguments passed to the `gh` binary
 */
export function classifyGhMutation(
  rawArgs: readonly string[],
): MutationInfo | null {
  // Issue #3867: pflag's attached shorthand spellings (`-Rowner/repo`,
  // `-X=POST`) are rewritten to their separated form first, so every match
  // below sees the one spelling.
  const args = normaliseGhArgs(rawArgs);
  const rootIdx = firstNonFlag(args, 0);
  const root = args[rootIdx];
  if (!root) return null;

  if (root === "api") {
    return classifyGhApi(args, rootIdx + 1);
  }

  const verbIdx = firstNonFlag(args, rootIdx + 1);
  const verb = args[verbIdx];
  if (!verb) return null;

  const mutatingVerbs = GH_MUTATING_VERBS[root];
  const mutating = mutatingVerbs
    ? mutatingVerbs.has(verb)
    : GH_GENERIC_MUTATING_VERBS.has(verb);
  if (!mutating) return null;

  const repoFlag = extractRepoFlag(args);
  // The target (issue/PR number) is the positional immediately following
  // the verb in the common shape `gh <root> <verb> <number> [flags]`.
  const targetCandidate = args[verbIdx + 1];
  const target = targetCandidate && !targetCandidate.startsWith("-")
    ? targetCandidate
    : undefined;

  // Issue #3703: `gh repo <verb> owner/name` names its target positionally
  // rather than via `-R`, so honour that form too.
  const positionalRepo = root === "repo" && target?.includes("/")
    ? target
    : undefined;
  const repo = repoFlag ?? positionalRepo;

  // Fail closed unless the target is either explicit or resolved by `gh`
  // from the current clone. A bare `gh repo create <name>` names a repo in
  // the authenticated account's namespace that cannot be verified, so it is
  // undeterminable rather than cwd-scoped.
  const cwdResolvable = GH_CWD_SCOPED_ROOTS.has(root) &&
    !(root === "repo" && verb === "create");
  const scope: MutationScope = repo
    ? "explicit"
    : cwdResolvable
    ? "cwd"
    : "unknown";

  return {
    verb: `${root}-${verb}`,
    ...(repo ? { repo } : {}),
    ...(target ? { target } : {}),
    scope,
  };
}

/**
 * `git` globals whose following token is a value, not the sub-command.
 *
 * Issue #3950: these were previously matched against {@link GH_VALUE_FLAGS},
 * which holds none of them, so `git -C /repo push` scanned onto `/repo` and
 * the push was never journalled.
 */
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
  "--config-env",
  "--super-prefix",
]);

/** `git` globals that stand alone — they never consume a following token. */
const GIT_BOOLEAN_GLOBALS: ReadonlySet<string> = new Set([
  "-p",
  "-P",
  "--paginate",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-advice",
  "--html-path",
  "--man-path",
  "--info-path",
  "-v",
  "--version",
  "-h",
  "--help",
]);

/** Whether a leading `git` token is a global whose arity we know. */
function isKnownGitGlobal(token: string): boolean {
  if (GIT_VALUE_FLAGS.has(token) || GIT_BOOLEAN_GLOBALS.has(token)) return true;
  // Attached spellings carry their own value: `--git-dir=/repo/.git`, `-C/repo`.
  const attachedLong = token.match(/^(--[a-z-]+)=/);
  if (attachedLong && GIT_VALUE_FLAGS.has(attachedLong[1]!)) return true;
  return /^-[Cc]./.test(token);
}

/** Where the `git` sub-command sits, and whether the scan can be trusted. */
interface GitSubcommandScan {
  /** Index of the first token taken to be the sub-command. */
  index: number;
  /** An unrecognised global was passed, so `index` may overshoot. */
  ambiguous: boolean;
}

function scanGitSubcommand(args: readonly string[]): GitSubcommandScan {
  let index = 0;
  let ambiguous = false;
  while (args[index]?.startsWith("-")) {
    const token = args[index]!;
    if (GIT_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    if (!isKnownGitGlobal(token)) ambiguous = true;
    index += 1;
  }
  return { index, ambiguous };
}

/**
 * Classify a `git` argument list as a GitHub mutation, or `null`.
 *
 * Only `git push` mutates remote GitHub state; every other git
 * sub-command is local and is not journalled.
 *
 * @param args - Arguments passed to the `git` binary
 */
export function classifyGitMutation(
  args: readonly string[],
): MutationInfo | null {
  const { index, ambiguous } = scanGitSubcommand(args);
  // Issue #3950: an unrecognised global may carry a value the scan did not
  // skip, so the sub-command position cannot be trusted. Fail closed — a push
  // anywhere in the vector is journalled rather than silently dropped.
  const subIdx = args[index] === "push"
    ? index
    : ambiguous
    ? args.indexOf("push")
    : -1;
  if (subIdx < 0) return null;

  const positionals = args.slice(subIdx + 1).filter((a) => !a.startsWith("-"));
  const target = positionals[positionals.length - 1];
  // A push always targets a remote of the current clone — the run's own repo.
  return { verb: "git-push", ...(target ? { target } : {}), scope: "cwd" };
}
