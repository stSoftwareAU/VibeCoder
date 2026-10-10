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
  /**
   * True when part of the request body is not visible in argv (Issue #11).
   *
   * Set by `gh api --input`/`--input=<file>` and by an `@file`-sourced
   * `query=` field value, so a caller can tell an argv-visible body from one
   * the argv cannot show. Left absent when the body is fully argv-visible.
   */
  unreadableBody?: boolean;
  /**
   * Path of a readable `--input <file>` body, when the argv names one
   * (Issue #91). Absent for `--input -` (stdin) and `@file`-sourced field
   * values, which are unscannable by construction. Present so a caller with a
   * filesystem reader can scan the file for reserved labels rather than
   * failing closed on every `--input` mutation.
   */
  bodyFilePath?: string;
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
 * Root spellings of the `gh extension` command (Issue #1396).
 *
 * The real binary accepts all three, so anything that reasons about the root
 * must accept all three or the odd spelling walks past it. Exported as the
 * single source of these aliases: `gh_local_state_guard.ts` normalises the
 * agent-side refusal against this same set, so a spelling added here cannot
 * be honoured by one and missed by the other.
 */
export const GH_EXTENSION_ROOTS: ReadonlySet<string> = new Set([
  "extension",
  "extensions",
  "ext",
]);

/**
 * `gh extension` sub-verbs that change the **local tool**, not GitHub
 * (Issue #1396).
 *
 * Nothing under the `extension` root writes to a repository: an install
 * downloads and unpacks an extension into `GH_CONFIG_DIR`, an upgrade
 * replaces it, a remove deletes it, a create scaffolds one locally. They are
 * still mutations worth journalling — `software_updates.ts` installs pinned
 * extensions on the worker's own host — so they classify as `non-repo` rather
 * than as reads: recorded by the audit journal, and allowed by the write-repo
 * allowlist because there is no write target to compare against it.
 *
 * Before this the root was split across both tables by accident: `install` and
 * `upgrade` matched no mutating verb at all and classified as reads, so the
 * worker's own extension upgrades were never journalled, while `remove` and
 * `create` matched {@link GH_GENERIC_MUTATING_VERBS} against a root that is
 * not cwd-scoped and so failed closed as an undeterminable repo write. One
 * root, two opposite answers, neither of them right — which is what kept the
 * `gh extension` caller outside the `spawnGh` chokepoint.
 *
 * Reads (`list`, `browse`, `search`) and `exec` — which runs an installed
 * extension rather than changing the installed set — are not mutations here.
 * The verb list therefore differs from `GH_LOCAL_STATE_VERBS.extension` in
 * `gh_local_state_guard.ts` on purpose, and the two are not one list: this one
 * answers "did the local tool change, and should the journal say so", which
 * takes in `create` and leaves out `exec`; the guard's answers "may the agent
 * run this at all", which refuses `exec` — an extension the guard cannot see
 * inside — and has no reason to name `create`. The agent is refused every
 * verb in the guard's list whatever this one says (Issue #187); this
 * classification governs the worker's own calls.
 */
const GH_EXTENSION_LOCAL_VERBS: ReadonlySet<string> = new Set([
  "install",
  "upgrade",
  "remove",
  "create",
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
  // `gh api --hostname <host>`: the host is a value, not the endpoint (Issue #3540).
  "--hostname",
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
 * The sub-verb following the root command (`login` in `gh auth login`).
 *
 * Derived exactly as {@link classifyGhMutation} derives it, so the agent-side
 * local-state guard (Issue #187) and the mutation classifier cannot disagree
 * about which token is the verb.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @returns The sub-verb, or undefined when the vector names none
 *   (`gh auth`, `gh --version`).
 */
export function ghSubVerb(args: readonly string[]): string | undefined {
  const rootIdx = firstNonFlag(args, 0);
  if (args[rootIdx] === undefined) return undefined;
  return args[firstNonFlag(args, rootIdx + 1)];
}

/**
 * The only host a `gh api` endpoint may name and still be classified from its
 * path (Issue #1420).
 *
 * A GitHub Enterprise deployment answers on its own host. Naming it here is
 * the one edit that would extend this, and it is deliberately not read from
 * `GH_HOST`: that variable reaches this classifier through the same argv-
 * adjacent environment the guard exists to distrust. An enterprise fleet's
 * ABSOLUTE endpoints therefore classify as `unknown` and are refused —
 * fail-closed, and the relative form every normal call uses is unaffected.
 */
export const GITHUB_API_HOST = "api.github.com";

/** The only `gh api --hostname` value classified from its path (Issue #1420). */
const GITHUB_HOST = "github.com";

/** Does this endpoint carry a `scheme://` origin at all? */
const ABSOLUTE_ENDPOINT = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The path part of a `gh api` endpoint, or `undefined` when the endpoint
 * addresses a host this run cannot vouch for (Issue #1420).
 *
 * `gh api` accepts a full URL as well as a path, so
 * `https://api.github.com/repos/o/r/issues` must resolve the same repo as
 * `repos/o/r/issues` (Issue #3703 — absolute endpoints previously derived no
 * repo and slipped past the allowlist). That strip took ANY scheme and ANY
 * host, so the origin was discarded without being looked at: a URL whose path
 * named an allowed repository classified as an allowed on-repo write however
 * far from GitHub it actually pointed, and `gh` then sent the request — field
 * and body data included — to that host. The allowlist decides *where* a
 * write may go, and such a request never reaches GitHub, so nothing
 * server-side stands behind it either.
 *
 * The host is therefore compared, and compared as a parsed **hostname**: a
 * substring or prefix test on the raw URL is fooled by userinfo
 * (`https://api.github.com@elsewhere.example/…`, whose host is
 * `elsewhere.example`) and by a suffix (`evil-api.github.com.attacker.example`).
 *
 * The path is taken from the ORIGINAL text rather than from `URL.pathname`,
 * because URL parsing percent-encodes the braces in the
 * `repos/{owner}/{repo}/…` placeholder form and that must keep matching.
 *
 * @param endpoint - The endpoint argument as written on the command line.
 * @returns The path with any leading `/` removed, or `undefined` when the
 *   endpoint is absolute and does not address {@link GITHUB_API_HOST}.
 */
function endpointPath(endpoint: string): string | undefined {
  if (!ABSOLUTE_ENDPOINT.test(endpoint)) return endpoint;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // An origin we cannot parse is an origin we cannot vouch for.
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname.toLowerCase() !== GITHUB_API_HOST) return undefined;

  const afterScheme = endpoint.slice(endpoint.indexOf("://") + 3);
  const slash = afterScheme.indexOf("/");
  return slash < 0 ? "" : afterScheme.slice(slash + 1);
}

/** Whether an endpoint path is repo-scoped via `{owner}/{repo}` placeholders. */
function isPlaceholderRepoEndpoint(endpoint: string): boolean {
  return /^\/?repos\/\{owner\}\/\{repo\}(\/|$)/.test(endpoint);
}

/** Parse `owner/repo` out of a REST endpoint like `repos/o/r/issues`. */
function repoFromEndpoint(endpoint: string): string | undefined {
  const path = endpointPath(endpoint);
  if (path === undefined) return undefined;
  if (isPlaceholderRepoEndpoint(path)) return undefined;
  const match = path.match(/^\/?repos\/([^/]+)\/([^/]+)/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** Result of scanning a GraphQL document for mutation operations. */
export interface GraphqlScan {
  /** Depth-1 field names of every `mutation` operation, in document order. */
  fields: string[];
  /** Whether at least one `mutation` operation was seen. */
  hasMutation: boolean;
  /**
   * Whether the document parsed cleanly: strings terminated, brackets
   * balanced, only GraphQL characters. A document that is not clean can never
   * be vouched for, whatever fields were found before it broke.
   */
  clean: boolean;
}

const GRAPHQL_OPERATION_KEYWORDS: ReadonlySet<string> = new Set([
  "mutation",
  "query",
  "subscription",
  "fragment",
]);

/** Characters GraphQL permits outside strings and comments (besides names). */
const GRAPHQL_PUNCTUATION = ' \t\n\r\uFEFF,!$&().:=@[]{|}-+"#';

function isGraphqlNameChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") || ch === "_";
}

/** Whether the next token after `from` (past blanks, commas, comments) starts a name. */
function nextSignificantIsNameStart(document: string, from: number): boolean {
  let i = from;
  while (i < document.length) {
    const ch = document[i]!;
    if (ch === "#") {
      while (
        i < document.length && document[i] !== "\n" && document[i] !== "\r"
      ) i++;
    } else if (
      ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "," ||
      ch === "\uFEFF"
    ) {
      i++;
    } else {
      return isGraphqlNameChar(ch) && !(ch >= "0" && ch <= "9");
    }
  }
  return false;
}

/**
 * Scan a GraphQL document with a single-pass character scanner (no regex, so
 * no backtracking) and collect the depth-1 fields of every mutation
 * operation (Issue #3549).
 *
 * `#` comments, `"…"` strings and `"""…"""` block strings are skipped in every
 * context, so a brace or the word `mutation` inside one cannot move the
 * depth count. A bracket stack tracks `(`/`{` over the whole document;
 * argument lists and variable definitions are skipped wholesale. Aliases
 * (`alias: field`) yield the field; directive names (`@x`) are ignored.
 *
 * @param document - The GraphQL document text.
 */
export function scanGraphqlMutations(document: string): GraphqlScan {
  const fields: string[] = [];
  const stack: string[] = [];
  let hasMutation = false;
  let clean = true;
  /** Keyword of the operation whose selection set has not opened yet. */
  let pendingKind: string | undefined;
  /** Kind of the operation whose selection set is currently open. */
  let openKind: string | undefined;
  let token = "";
  let afterDirectiveMark = false;
  let sawSelectionSet = false;

  const flush = (terminator: string): void => {
    if (!token) return;
    const name = token;
    token = "";
    if (afterDirectiveMark) {
      afterDirectiveMark = false;
      return;
    }
    if (stack.length === 0) {
      if (pendingKind !== undefined) return;
      const keyword = name.toLowerCase();
      if (name === keyword && GRAPHQL_OPERATION_KEYWORDS.has(keyword)) {
        pendingKind = keyword;
        if (keyword === "mutation") hasMutation = true;
      } else {
        clean = false;
      }
    } else if (
      stack.length === 1 && openKind === "mutation" && terminator !== ":"
    ) {
      fields.push(name);
    }
  };

  const n = document.length;
  let i = 0;
  while (i < n) {
    const ch = document[i]!;
    if (isGraphqlNameChar(ch)) {
      token += ch;
      i++;
      continue;
    }
    flush(ch);
    if (ch === "#") {
      while (i < n && document[i] !== "\n" && document[i] !== "\r") i++;
      continue;
    }
    if (ch === '"') {
      if (document.startsWith('"""', i)) {
        i += 3;
        let closed = false;
        while (i < n) {
          if (document.startsWith('\\"""', i)) i += 4;
          else if (document.startsWith('"""', i)) {
            i += 3;
            closed = true;
            break;
          } else i++;
        }
        if (!closed) clean = false;
        continue;
      }
      i++;
      let closed = false;
      while (i < n) {
        const c = document[i]!;
        if (c === "\\") i += 2;
        else if (c === '"') {
          i++;
          closed = true;
          break;
        } else if (c === "\n" || c === "\r") break;
        else i++;
      }
      if (!closed) clean = false;
      continue;
    }
    if (ch === "(" || ch === "{") {
      if (ch === "{") sawSelectionSet = true;
      if (ch === "{" && stack.length === 0) {
        openKind = pendingKind ?? "query";
        pendingKind = undefined;
      }
      stack.push(ch);
    } else if (ch === ")" || ch === "}") {
      const open = stack.pop();
      if (open !== (ch === ")" ? "(" : "{")) {
        clean = false;
        // Keep the stack consistent: a mismatched closer is not consumed.
        if (open !== undefined) stack.push(open);
      } else if (stack.length === 0) {
        openKind = undefined;
      }
    } else if (ch === "@") {
      // A directive name must follow; otherwise the mark would swallow the
      // next real field name (Issue #3549).
      if (nextSignificantIsNameStart(document, i + 1)) {
        afterDirectiveMark = true;
      } else {
        afterDirectiveMark = false;
        clean = false;
      }
    } else if (ch === "." && stack.length === 1 && openKind === "mutation") {
      // A spread or inline fragment at the mutation root can select further
      // mutation fields below depth 1; refuse to vouch for it (Issue #3549).
      clean = false;
    } else if (!GRAPHQL_PUNCTUATION.includes(ch)) {
      clean = false;
    }
    i++;
  }
  flush("");
  // An operation keyword never followed by a selection set, an open bracket
  // or an unterminated string all mean the text was not understood.
  if (stack.length > 0 || pendingKind !== undefined) clean = false;
  // With no mutation keyword and no `{` at all, nothing is executable (GitHub
  // rejects it), so garbage such as `@/tmp/q.graphql` is inert, not a mutation.
  if (!hasMutation && !sawSelectionSet) clean = true;
  return { fields, hasMutation, clean };
}

/**
 * Top-level field names selected by the mutation operations of a GraphQL
 * document, or `null` when the document provably contains no mutation
 * operation (i.e. it is a read).
 *
 * Issue #3549: every `mutation` operation is collected, not just the first,
 * and comments and strings are skipped (see {@link scanGraphqlMutations}). A
 * document that does not parse cleanly is never `null`: it cannot be proven a
 * read, so the (possibly empty) field list is returned and callers must use
 * {@link scanGraphqlMutations} to learn whether it may be sanctioned.
 *
 * @param document - The GraphQL document text.
 */
export function graphqlMutationFields(document: string): string[] | null {
  const scan = scanGraphqlMutations(document);
  if (scan.clean && !scan.hasMutation) return null;
  return scan.fields;
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
 * Issue #3549: a document is sanctioned as non-repo only when it parses
 * cleanly and every field of every mutation operation is sanctioned. A
 * malformed document (unterminated string, unbalanced brackets) falls to
 * `unknown`, since the parser cannot know what GitHub would execute.
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
  let allClean = true;
  for (const document of documents) {
    const scan = scanGraphqlMutations(document);
    if (scan.clean && !scan.hasMutation) continue;
    isMutation = true;
    if (!scan.clean) allClean = false;
    fields.push(...scan.fields);
  }
  if (!isMutation) {
    if (!unreadable) return null;
    return { verb: "api-graphql-unknown", target: "graphql", scope: "unknown" };
  }

  const sanctioned = !unreadable && allClean && fields.length > 0 &&
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
  /** Last `--hostname` value; `gh` sends the request to that host (Issue #1420). */
  let hostname: string | undefined;
  /** A body component the argv cannot show: `--input`, or a `@file` value. */
  let unreadableBody = false;
  /** Path of a readable `--input <file>` body (Issue #91); `-` stays absent. */
  let bodyFilePath: string | undefined;
  const queryDocuments: string[] = [];

  /**
   * Record a `key=value` field.
   *
   * `gh` reads a field value beginning with `@` from that file (`@-` from
   * stdin), so it never reaches the argv — the label/label-scan and GraphQL
   * checks cannot see what it carries, and the call must fail closed. Verified
   * against gh 2.97.0: only `-F`/`--field` expand a leading `@` (its help says
   * `use "@<path>" or "@-" to read value from file or stdin`); `-f`/
   * `--raw-field` add a *static string* and never expand `@` (Issue #93). The
   * caller passes `expandsAtFile` so a literal `@name` on `-f` is not mistaken
   * for a file.
   */
  const noteField = (
    value: string | undefined,
    expandsAtFile: boolean,
  ): void => {
    if (value === undefined) return;
    const eq = value.indexOf("=");
    if (eq < 0) return;
    if (expandsAtFile && value.slice(eq + 1).startsWith("@")) {
      unreadableBody = true;
      return;
    }
    if (value.slice(0, eq) === "query") {
      queryDocuments.push(value.slice(eq + 1));
    }
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
      noteField(args[i + 1], token === "-F" || token === "--field");
      skipNext = true;
      continue;
    }
    if (token.startsWith("--field=")) {
      hasBody = true;
      noteField(token.slice("--field=".length), true);
      continue;
    }
    if (token.startsWith("--raw-field=")) {
      hasBody = true;
      noteField(token.slice("--raw-field=".length), false);
      continue;
    }
    if (token === "--input") {
      hasBody = true;
      unreadableBody = true;
      skipNext = true;
      const path = args[i + 1];
      if (path !== undefined && path !== "-") bodyFilePath = path;
      continue;
    }
    if (token.startsWith("--input=")) {
      hasBody = true;
      unreadableBody = true;
      const path = token.slice("--input=".length);
      if (path !== "-") bodyFilePath = path;
      continue;
    }
    // pflag: a repeated string flag resolves to its last occurrence.
    if (token === "--hostname") {
      hostname = args[i + 1] ?? "";
      skipNext = true;
      continue;
    }
    if (token.startsWith("--hostname=")) {
      hostname = token.slice("--hostname=".length);
      continue;
    }
    if (GH_VALUE_FLAGS.has(token)) {
      skipNext = true;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (endpoint === undefined) endpoint = token;
  }

  // Issue #1420: a request bound for a host other than github.com carries its
  // field and body data there, so the path's repo says nothing about where the
  // write lands. Derive no repo and fail closed, as for an absolute endpoint
  // on another host. A `--hostname` with no value is unusable and fails closed.
  const foreignHost = hostname !== undefined &&
    hostname.toLowerCase() !== GITHUB_HOST;

  if (endpoint === "graphql") {
    const info = classifyGhGraphql(queryDocuments, unreadableBody);
    return info && foreignHost ? { ...info, scope: "unknown" } : info;
  }

  const effectiveMethod = (method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(effectiveMethod)) {
    return null;
  }
  const repo = endpoint && !foreignHost
    ? repoFromEndpoint(endpoint)
    : undefined;
  // Issue #3703: an endpoint that names no repo (`gists`, `orgs/…`, `user/…`)
  // cannot be checked against the allowlist, so it fails closed. The
  // `repos/{owner}/{repo}/…` placeholder form is resolved by `gh` from the
  // current clone and is therefore cwd-scoped.
  // Issue #1420: the placeholder branch is host-checked too. `gh` resolves
  // `repos/{owner}/{repo}/…` from the current clone, which is why it is
  // cwd-scoped and needs no allowlist comparison — but that reasoning holds
  // only for a request actually bound for GitHub's API. Pointed elsewhere,
  // the same path is a write to somebody else's host.
  const path = endpoint ? endpointPath(endpoint) : undefined;
  const scope: MutationScope = repo
    ? "explicit"
    : (!foreignHost && path !== undefined && isPlaceholderRepoEndpoint(path))
    ? "cwd"
    : "unknown";
  return {
    verb: `api-${effectiveMethod.toLowerCase()}`,
    ...(repo ? { repo } : {}),
    ...(endpoint ? { target: endpoint } : {}),
    scope,
    // Issue #11: surface a body the argv cannot show. Left absent — never
    // `false` — when the body is fully argv-visible.
    ...(unreadableBody ? { unreadableBody: true } : {}),
    ...(bodyFilePath !== undefined ? { bodyFilePath } : {}),
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

  // Issue #1396: `gh extension` changes the local tool, never a repository,
  // so it is classified explicitly rather than left to the tables below —
  // journalled as a `non-repo` mutation, and never refused as an
  // undeterminable repo write.
  if (GH_EXTENSION_ROOTS.has(root.toLowerCase())) {
    if (!GH_EXTENSION_LOCAL_VERBS.has(verb.toLowerCase())) return null;
    const extTarget = args[verbIdx + 1];
    return {
      verb: `extension-${verb.toLowerCase()}`,
      ...(extTarget && !extTarget.startsWith("-") ? { target: extTarget } : {}),
      scope: "non-repo",
    };
  }

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
