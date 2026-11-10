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
 */ import { GH_SEPARATED_VALUE_FLAGS } from "./gh_argv.ts";
import { canonicaliseGhArgs, GITHUB_API_HOST } from "./gh_argv_canonical.ts";
/** Mutating sub-verbs per `gh` root command. */ const GH_MUTATING_VERBS = {
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
    "transfer"
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
    "unlock"
  ]),
  label: new Set([
    "create",
    "delete",
    "edit",
    "clone"
  ]),
  release: new Set([
    "create",
    "delete",
    "edit",
    "upload"
  ]),
  repo: new Set([
    "create",
    "delete",
    "edit",
    "fork",
    "rename",
    "archive",
    "unarchive"
  ]),
  secret: new Set([
    "set",
    "remove",
    "delete"
  ]),
  variable: new Set([
    "set",
    "remove",
    "delete"
  ]),
  workflow: new Set([
    "run",
    "enable",
    "disable"
  ]),
  run: new Set([
    "cancel",
    "rerun",
    "delete"
  ]),
  cache: new Set([
    "delete"
  ]),
  gist: new Set([
    "create",
    "delete",
    "edit",
    "rename",
    "clone"
  ])
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
 */ const GH_GENERIC_MUTATING_VERBS = new Set([
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
  "upload"
]);
/**
 * Root commands whose repo `gh` resolves from the current clone when no
 * `-R`/`--repo` is given. A mutation on one of these without an explicit
 * repo therefore targets the run's own repo, which is on the allowlist by
 * construction. Every other root (e.g. `gist`, which is not repo-scoped at
 * all) yields an undeterminable target and must fail closed.
 */ const GH_CWD_SCOPED_ROOTS = new Set([
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
  "ruleset"
]);
/**
 * Root spellings of the `gh extension` command (Issue #1396).
 *
 * The real binary accepts all three, so anything that reasons about the root
 * must accept all three or the odd spelling walks past it. Exported as the
 * single source of these aliases: `gh_local_state_guard.ts` normalises the
 * agent-side refusal against this same set, so a spelling added here cannot
 * be honoured by one and missed by the other.
 */ export const GH_EXTENSION_ROOTS = new Set([
  "extension",
  "extensions",
  "ext"
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
 */ const GH_EXTENSION_LOCAL_VERBS = new Set([
  "install",
  "upgrade",
  "remove",
  "create"
]);
/**
 * GraphQL mutations sanctioned as touching no repository (Issue #3703).
 *
 * A GraphQL mutation carries no derivable `owner/repo`, so it fails closed
 * by default. This allowlist names the worker's own non-repo mutations —
 * `changeUserStatus` sets the worker account's profile status
 * (`github_status.ts`) and cannot write to any repository. Compared
 * lower-case.
 */ export const GH_SANCTIONED_GRAPHQL_MUTATIONS = new Set([
  "changeuserstatus"
]);
/**
 * `gh` flags whose following token is a value, not a positional argument.
 *
 * Derived from the one table every `gh` argv walker shares (Issue #3568):
 * this classifier used to keep its own copy, which lacked `-p`/`--preview`,
 * so a preview name was read as the endpoint (Issue #3561).
 */ const GH_VALUE_FLAGS = GH_SEPARATED_VALUE_FLAGS;
/**
 * gh's placeholder syntax (cli/cli `pkg/cmd/api` `fillPlaceholders`): it
 * rewrites these in a magic field's value (`-F`/`--field`) with the current
 * repository's owner, name or checked-out branch — after this classifier has
 * read the value, and the agent chooses the branch (Issue #3566).
 */ const GH_FIELD_PLACEHOLDER = /:(?:owner|repo|branch)\b|\{[a-z]+\}/;
/**
 * Magic-field keys whose substituted value could change what the guard
 * decided: the GraphQL document and operation name (a branch name can close a
 * string and add an operation), and label names (Issue #3566).
 */ function isPlaceholderSensitiveKey(key) {
  const k = key.trim().toLowerCase();
  return k === "query" || k === "operationname" || k === "name" || k === "new_name" || k.startsWith("labels");
}
/**
 * Extract `owner/repo` from a `-R`/`--repo` flag anywhere in the args.
 *
 * Issue #3867: `--repo` is a pflag string flag, so a repeated flag resolves to
 * its **last** occurrence — `-R allowed/repo -R attacker/evil` writes to
 * `attacker/evil`. Returning the first match both allowed the write and
 * journalled the wrong target. Attached shorthand spellings (`-Rowner/repo`)
 * are handled by {@link normaliseGhArgs} before this runs.
 */ function extractRepoFlag(args) {
  let repo;
  for(let i = 0; i < args.length; i++){
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
 */ function firstNonFlag(args, from, valueFlags = GH_VALUE_FLAGS) {
  let i = from;
  while(args[i]?.startsWith("-")){
    i += valueFlags.has(args[i]) ? 2 : 1;
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
 */ export function ghRootCommand(args) {
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
 */ export function ghSubVerb(args) {
  const rootIdx = firstNonFlag(args, 0);
  if (args[rootIdx] === undefined) return undefined;
  return args[firstNonFlag(args, rootIdx + 1)];
}
/**
 * The only host a `gh api` endpoint may name and still be classified from its
 * path (Issue #1420).
 *
 * Defined in `gh_argv_canonical.ts`, whose endpoint canonicaliser shares it
 * (Issue #3568), and re-exported here. A GitHub Enterprise deployment answers
 * on its own host. Naming it there is the one edit that would extend this,
 * and it is deliberately not read from
 * `GH_HOST`: that variable reaches this classifier through the same argv-
 * adjacent environment the guard exists to distrust. An enterprise fleet's
 * ABSOLUTE endpoints therefore classify as `unknown` and are refused —
 * fail-closed, and the relative form every normal call uses is unaffected.
 */ export { GITHUB_API_HOST };
/** The only `gh api --hostname` value classified from its path (Issue #1420). */ const GITHUB_HOST = "github.com";
/** Does this endpoint carry a `scheme://` origin at all? */ const ABSOLUTE_ENDPOINT = /^[a-z][a-z0-9+.-]*:\/\//i;
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
 */ function endpointPath(endpoint) {
  if (!ABSOLUTE_ENDPOINT.test(endpoint)) return endpoint;
  let url;
  try {
    url = new URL(endpoint);
  } catch  {
    // An origin we cannot parse is an origin we cannot vouch for.
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname.toLowerCase() !== GITHUB_API_HOST) return undefined;
  const afterScheme = endpoint.slice(endpoint.indexOf("://") + 3);
  const slash = afterScheme.indexOf("/");
  return slash < 0 ? "" : afterScheme.slice(slash + 1);
}
/**
 * Whether a `gh api` endpoint addresses GitHub's GraphQL endpoint.
 *
 * `gh` itself special-cases only the bare word `graphql`, but `/graphql`,
 * `graphql?x=1` and `https://api.github.com/graphql` all POST a `{"query": …}`
 * body to the same endpoint, and GitHub runs it (PR #3514 review). An absolute
 * URL counts only when {@link endpointPath} vouches for its host.
 */ function isGraphqlEndpoint(endpoint) {
  const path = endpointPath(endpoint);
  if (path === undefined) return false;
  const cut = path.search(/[?#]/);
  const bare = cut < 0 ? path : path.slice(0, cut);
  // Slice rather than `/\/+$/`, which is quadratic on a long run of slashes.
  let start = 0;
  let end = bare.length;
  while(start < end && bare[start] === "/")start++;
  while(end > start && bare[end - 1] === "/")end--;
  return bare.slice(start, end) === "graphql";
}
/** Whether an endpoint path is repo-scoped via `{owner}/{repo}` placeholders. */ function isPlaceholderRepoEndpoint(endpoint) {
  return /^\/?repos\/\{owner\}\/\{repo\}(\/|$)/.test(endpoint);
}
/** Parse `owner/repo` out of a REST endpoint like `repos/o/r/issues`. */ function repoFromEndpoint(endpoint) {
  const path = endpointPath(endpoint);
  if (path === undefined) return undefined;
  if (isPlaceholderRepoEndpoint(path)) return undefined;
  const match = path.match(/^\/?repos\/([^/]+)\/([^/]+)/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}
const GRAPHQL_OPERATION_KEYWORDS = new Set([
  "mutation",
  "query",
  "subscription",
  "fragment"
]);
/** Characters GraphQL permits outside strings and comments (besides names). */ const GRAPHQL_PUNCTUATION = ' \t\n\r\uFEFF,!$&().:=@[]{|}-+"#';
function isGraphqlNameChar(ch) {
  return ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch >= "0" && ch <= "9" || ch === "_";
}
/** Whether the next token after `from` (past blanks, commas, comments) starts a name. */ function nextSignificantIsNameStart(document, from) {
  let i = from;
  while(i < document.length){
    const ch = document[i];
    if (ch === "#") {
      while(i < document.length && document[i] !== "\n" && document[i] !== "\r")i++;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "," || ch === "\uFEFF") {
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
 */ export function scanGraphqlMutations(document) {
  const fields = [];
  const stack = [];
  let hasMutation = false;
  let clean = true;
  /** Keyword of the operation whose selection set has not opened yet. */ let pendingKind;
  /** Kind of the operation whose selection set is currently open. */ let openKind;
  let token = "";
  let afterDirectiveMark = false;
  let sawSelectionSet = false;
  const flush = (terminator)=>{
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
    } else if (stack.length === 1 && openKind === "mutation" && terminator !== ":") {
      fields.push(name);
    }
  };
  const n = document.length;
  let i = 0;
  while(i < n){
    const ch = document[i];
    if (isGraphqlNameChar(ch)) {
      token += ch;
      i++;
      continue;
    }
    flush(ch);
    if (ch === "#") {
      while(i < n && document[i] !== "\n" && document[i] !== "\r")i++;
      continue;
    }
    if (ch === '"') {
      if (document.startsWith('"""', i)) {
        i += 3;
        let closed = false;
        while(i < n){
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
      while(i < n){
        const c = document[i];
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
  return {
    fields,
    hasMutation,
    clean
  };
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
 */ export function graphqlMutationFields(document) {
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
 */ function classifyGhGraphql(documents, unreadable) {
  const fields = [];
  let isMutation = false;
  let allClean = true;
  for (const document of documents){
    const scan = scanGraphqlMutations(document);
    if (scan.clean && !scan.hasMutation) continue;
    isMutation = true;
    if (!scan.clean) allClean = false;
    fields.push(...scan.fields);
  }
  if (!isMutation) {
    if (!unreadable) return null;
    return {
      verb: "api-graphql-unknown",
      target: "graphql",
      scope: "unknown"
    };
  }
  const sanctioned = !unreadable && allClean && fields.length > 0 && fields.every((f)=>GH_SANCTIONED_GRAPHQL_MUTATIONS.has(f.toLowerCase()));
  return {
    verb: "api-graphql-mutation",
    target: fields.length > 0 ? `graphql:${fields.join(",")}` : "graphql",
    scope: sanctioned ? "non-repo" : "unknown"
  };
}
/**
 * The last `--hostname` value among the tokens before the `api` root, or
 * undefined when there is none. `gh --hostname=evil.invalid api …` sends the
 * request to that host exactly as the after-`api` spelling does. A bare
 * `--hostname` with no value yields "" so it fails closed.
 */ function hostnameBeforeRoot(args, rootIdx) {
  let host;
  for(let i = 0; i < rootIdx; i++){
    const token = args[i] ?? "";
    if (token === "--hostname") {
      host = args[i + 1] ?? "";
      i++;
    } else if (token.startsWith("--hostname=")) {
      host = token.slice("--hostname=".length);
    } else if (GH_VALUE_FLAGS.has(token)) {
      i++;
    }
  }
  return host;
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
 */ function classifyGhApi(args, start) {
  let method;
  let hasBody = false;
  let endpoint;
  let skipNext = false;
  /**
   * Last `--hostname` value; `gh` sends the request to that host (Issue #1420).
   * Seeded from the tokens before the `api` root: `gh` honours the flag there
   * too, and the tokens after it still win (pflag's last-occurrence rule).
   */ let hostname = hostnameBeforeRoot(args, start - 1);
  /** A body component the argv cannot show: `--input`, or a `@file` value. */ let unreadableBody = false;
  /** Path of a readable `--input <file>` body (Issue #91); `-` stays absent. */ let bodyFilePath;
  const queryDocuments = [];
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
   */ const noteField = (value, expandsAtFile)=>{
    if (value === undefined) return;
    const eq = value.indexOf("=");
    if (eq < 0) return;
    if (expandsAtFile && value.slice(eq + 1).startsWith("@")) {
      unreadableBody = true;
      return;
    }
    // Issue #3566: gh fills placeholders in a magic field after this read, so
    // the text classified is not the text sent — fail closed.
    if (expandsAtFile && isPlaceholderSensitiveKey(value.slice(0, eq)) && GH_FIELD_PLACEHOLDER.test(value.slice(eq + 1))) {
      unreadableBody = true;
      return;
    }
    if (value.slice(0, eq) === "query") {
      queryDocuments.push(value.slice(eq + 1));
    }
  };
  for(let i = start; i < args.length; i++){
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
    if (token === "-f" || token === "-F" || token === "--field" || token === "--raw-field") {
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
  const foreignHost = hostname !== undefined && hostname.toLowerCase() !== GITHUB_HOST;
  if (endpoint !== undefined && isGraphqlEndpoint(endpoint)) {
    const info = classifyGhGraphql(queryDocuments, unreadableBody);
    return info && foreignHost ? {
      ...info,
      scope: "unknown"
    } : info;
  }
  const effectiveMethod = (method ?? (hasBody ? "POST" : "GET")).toUpperCase();
  if (![
    "POST",
    "PATCH",
    "PUT",
    "DELETE"
  ].includes(effectiveMethod)) {
    return null;
  }
  const repo = endpoint && !foreignHost ? repoFromEndpoint(endpoint) : undefined;
  // Issue #3703: an endpoint that names no repo (`gists`, `orgs/…`, `user/…`)
  // cannot be checked against the allowlist, so it fails closed. The
  // `repos/{owner}/{repo}/…` placeholder form is resolved by `gh` from the
  // current clone and is therefore cwd-scoped.
  // Issue #1420: the placeholder branch is host-checked too. `gh` resolves
  // `repos/{owner}/{repo}/…` from the current clone, which is why it is
  // cwd-scoped and needs no allowlist comparison — but that reasoning holds
  // only for a request actually bound for GitHub's API. Pointed elsewhere,
  // the same path is a write to somebody else's host.
  const path = endpoint && !foreignHost ? endpointPath(endpoint) : undefined;
  const scope = repo ? "explicit" : !foreignHost && path !== undefined && isPlaceholderRepoEndpoint(path) ? "cwd" : "unknown";
  return {
    verb: `api-${effectiveMethod.toLowerCase()}`,
    ...repo ? {
      repo
    } : {},
    ...endpoint ? {
      target: endpoint
    } : {},
    scope,
    // Issue #11: surface a body the argv cannot show. Left absent — never
    // `false` — when the body is fully argv-visible.
    ...unreadableBody ? {
      unreadableBody: true
    } : {},
    ...bodyFilePath !== undefined ? {
      bodyFilePath
    } : {}
  };
}
/**
 * Classify a `gh` argument list as a GitHub mutation, or `null` for reads.
 *
 * @param args - Arguments passed to the `gh` binary
 */ export function classifyGhMutation(rawArgs) {
  // Issue #3867: pflag's attached shorthand spellings (`-Rowner/repo`,
  // `-X=POST`) are rewritten to their separated form first, so every match
  // below sees the one spelling. Issue #3568: a `gh api` call is further
  // rewritten to its canonical form — flags after the root, an explicit
  // method, the endpoint as GitHub routes it — so no equivalent spelling
  // classifies differently.
  const args = canonicaliseGhArgs(rawArgs);
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
      ...extTarget && !extTarget.startsWith("-") ? {
        target: extTarget
      } : {},
      scope: "non-repo"
    };
  }
  const mutatingVerbs = GH_MUTATING_VERBS[root];
  const mutating = mutatingVerbs ? mutatingVerbs.has(verb) : GH_GENERIC_MUTATING_VERBS.has(verb);
  if (!mutating) return null;
  const repoFlag = extractRepoFlag(args);
  // The target (issue/PR number) is the positional immediately following
  // the verb in the common shape `gh <root> <verb> <number> [flags]`.
  const targetCandidate = args[verbIdx + 1];
  const target = targetCandidate && !targetCandidate.startsWith("-") ? targetCandidate : undefined;
  // Issue #3703: `gh repo <verb> owner/name` names its target positionally
  // rather than via `-R`, so honour that form too.
  const positionalRepo = root === "repo" && target?.includes("/") ? target : undefined;
  const repo = repoFlag ?? positionalRepo;
  // Fail closed unless the target is either explicit or resolved by `gh`
  // from the current clone. A bare `gh repo create <name>` names a repo in
  // the authenticated account's namespace that cannot be verified, so it is
  // undeterminable rather than cwd-scoped.
  const cwdResolvable = GH_CWD_SCOPED_ROOTS.has(root) && !(root === "repo" && verb === "create");
  const scope = repo ? "explicit" : cwdResolvable ? "cwd" : "unknown";
  return {
    verb: `${root}-${verb}`,
    ...repo ? {
      repo
    } : {},
    ...target ? {
      target
    } : {},
    scope
  };
}
/**
 * `git` globals whose following token is a value, not the sub-command.
 *
 * Issue #3950: these were previously matched against {@link GH_VALUE_FLAGS},
 * which holds none of them, so `git -C /repo push` scanned onto `/repo` and
 * the push was never journalled.
 */ const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
  "--config-env",
  "--super-prefix"
]);
/** `git` globals that stand alone — they never consume a following token. */ const GIT_BOOLEAN_GLOBALS = new Set([
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
  "--help"
]);
/** Whether a leading `git` token is a global whose arity we know. */ function isKnownGitGlobal(token) {
  if (GIT_VALUE_FLAGS.has(token) || GIT_BOOLEAN_GLOBALS.has(token)) return true;
  // Attached spellings carry their own value: `--git-dir=/repo/.git`, `-C/repo`.
  const attachedLong = token.match(/^(--[a-z-]+)=/);
  if (attachedLong && GIT_VALUE_FLAGS.has(attachedLong[1])) return true;
  return /^-[Cc]./.test(token);
}
function scanGitSubcommand(args) {
  let index = 0;
  let ambiguous = false;
  while(args[index]?.startsWith("-")){
    const token = args[index];
    if (GIT_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    if (!isKnownGitGlobal(token)) ambiguous = true;
    index += 1;
  }
  return {
    index,
    ambiguous
  };
}
/**
 * Classify a `git` argument list as a GitHub mutation, or `null`.
 *
 * Only `git push` mutates remote GitHub state; every other git
 * sub-command is local and is not journalled.
 *
 * @param args - Arguments passed to the `git` binary
 */ export function classifyGitMutation(args) {
  const { index, ambiguous } = scanGitSubcommand(args);
  // Issue #3950: an unrecognised global may carry a value the scan did not
  // skip, so the sub-command position cannot be trusted. Fail closed — a push
  // anywhere in the vector is journalled rather than silently dropped.
  const subIdx = args[index] === "push" ? index : ambiguous ? args.indexOf("push") : -1;
  if (subIdx < 0) return null;
  const positionals = args.slice(subIdx + 1).filter((a)=>!a.startsWith("-"));
  const target = positionals[positionals.length - 1];
  // A push always targets a remote of the current clone — the run's own repo.
  return {
    verb: "git-push",
    ...target ? {
      target
    } : {},
    scope: "cwd"
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hdWRpdF9tdXRhdGlvbl9jbGFzc2lmaWVyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ2xhc3NpZnkgYGdoYCBhbmQgYGdpdGAgYXJndW1lbnQgbGlzdHMgYXMgR2l0SHViIG11dGF0aW9ucyAoSXNzdWUgIzIzODApLlxuICpcbiAqIFRoZSBhdWRpdCBqb3VybmFsIG9ubHkgcmVjb3JkcyBtdXRhdGlvbnMg4oCUIGNvbW1hbmRzIHRoYXQgY2hhbmdlIEdpdEh1YlxuICogc3RhdGUgKGNvbW1lbnQgcG9zdGVkLCBQUiBvcGVuZWQvbWVyZ2VkLCBsYWJlbCBhcHBsaWVkLCBpc3N1ZVxuICogb3BlbmVkL2Nsb3NlZC9lZGl0ZWQsIG1pbGVzdG9uZSBjcmVhdGVkIHZpYSB0aGUgUkVTVCBBUEksIGNvbW1pdHNcbiAqIHB1c2hlZCkuIFJlYWQtb25seSBjb21tYW5kcyAoYHZpZXdgLCBgbGlzdGAsIGBzdGF0dXNgLCBhIEdFVCBgZ2ggYXBpYCxcbiAqIGV0Yy4pIHJldHVybiBgbnVsbGAgc28gdGhlIGpvdXJuYWwgaXMgbm90IHBvbGx1dGVkIHdpdGggcmVhZHMuXG4gKlxuICogS2VlcGluZyB0aGUgY2xhc3NpZmljYXRpb24gaW4gb25lIHBsYWNlIG1lYW5zIHRoZSBjZW50cmFsIGBnaGAvYGdpdGBcbiAqIGNob2tlcG9pbnRzIHN0YXkgb25lLWxpbmVycyBhbmQgdGhlIG11dGF0aW9uIHRheG9ub215IGhhcyBhIHNpbmdsZVxuICogc291cmNlIG9mIHRydXRoLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IEdIX1NFUEFSQVRFRF9WQUxVRV9GTEFHUyB9IGZyb20gXCIuL2doX2FyZ3YudHNcIjtcbmltcG9ydCB7IGNhbm9uaWNhbGlzZUdoQXJncywgR0lUSFVCX0FQSV9IT1NUIH0gZnJvbSBcIi4vZ2hfYXJndl9jYW5vbmljYWwudHNcIjtcblxuLyoqXG4gKiBIb3cgdGhlIG11dGF0aW9uJ3MgdGFyZ2V0IHJlcG8gd2FzIOKAlCBvciB3YXMgbm90IOKAlCBkZXRlcm1pbmVkIChJc3N1ZSAjMzcwMykuXG4gKlxuICogVGhlIHdyaXRlLXJlcG8gYWxsb3dsaXN0IGtleXMgaXRzIGZhaWwtY2xvc2VkIGRlY2lzaW9uIG9uIHRoaXM6IG9ubHlcbiAqIGBleHBsaWNpdGAgY2FuIGJlIGNvbXBhcmVkIGFnYWluc3QgdGhlIGFsbG93bGlzdCwgYGN3ZGAgYW5kIGBub24tcmVwb2BcbiAqIGFyZSBzdHJ1Y3R1cmFsbHkgc2FmZSwgYW5kIGB1bmtub3duYCBtdXN0IGJlIHJlZnVzZWQgcmF0aGVyIHRoYW5cbiAqIHNpbGVudGx5IGFsbG93ZWQuXG4gKi9cbmV4cG9ydCB0eXBlIE11dGF0aW9uU2NvcGUgPVxuICAvKiogQW4gYG93bmVyL3JlcG9gIHdhcyBuYW1lZCBleHBsaWNpdGx5IChgLVJgLCBlbmRwb2ludCwgcG9zaXRpb25hbCkuICovXG4gIHwgXCJleHBsaWNpdFwiXG4gIC8qKiBgZ2hgIHJlc29sdmVzIHRoZSByZXBvIGZyb20gdGhlIGN1cnJlbnQgY2xvbmUg4oCUIHRoZSBydW4ncyBvd24gcmVwby4gKi9cbiAgfCBcImN3ZFwiXG4gIC8qKiBBIHNhbmN0aW9uZWQgbXV0YXRpb24gdGhhdCB0b3VjaGVzIG5vIHJlcG9zaXRvcnkgYXQgYWxsLiAqL1xuICB8IFwibm9uLXJlcG9cIlxuICAvKiogVGFyZ2V0IHVuZGV0ZXJtaW5hYmxlIOKAlCBjYWxsZXJzIG11c3QgZmFpbCBjbG9zZWQuICovXG4gIHwgXCJ1bmtub3duXCI7XG5cbi8qKiBBIGNsYXNzaWZpZWQgbXV0YXRpb246IGEgdmVyYiBwbHVzIG9wdGlvbmFsIHJlcG8vdGFyZ2V0IGNvbnRleHQuICovXG5leHBvcnQgaW50ZXJmYWNlIE11dGF0aW9uSW5mbyB7XG4gIC8qKiBTdGFibGUgYWN0aW9uIHZlcmIsIGUuZy4gXCJpc3N1ZS1jb21tZW50XCIsIFwicHItbWVyZ2VcIiwgXCJnaXQtcHVzaFwiLiAqL1xuICB2ZXJiOiBzdHJpbmc7XG4gIC8qKiBvd25lci9yZXBvLCB3aGVuIGRlcml2YWJsZSBmcm9tIHRoZSBhcmd1bWVudHMuICovXG4gIHJlcG8/OiBzdHJpbmc7XG4gIC8qKiBUYXJnZXQgaWRlbnRpZmllciAoaXNzdWUvUFIgbnVtYmVyLCBicmFuY2gsIG9yIEFQSSBlbmRwb2ludCkuICovXG4gIHRhcmdldD86IHN0cmluZztcbiAgLyoqIEhvdyB0aGUgdGFyZ2V0IHJlcG8gd2FzIGRldGVybWluZWQgKElzc3VlICMzNzAzKS4gKi9cbiAgc2NvcGU6IE11dGF0aW9uU2NvcGU7XG4gIC8qKlxuICAgKiBUcnVlIHdoZW4gcGFydCBvZiB0aGUgcmVxdWVzdCBib2R5IGlzIG5vdCB2aXNpYmxlIGluIGFyZ3YgKElzc3VlICMxMSkuXG4gICAqXG4gICAqIFNldCBieSBgZ2ggYXBpIC0taW5wdXRgL2AtLWlucHV0PTxmaWxlPmAgYW5kIGJ5IGFuIGBAZmlsZWAtc291cmNlZFxuICAgKiBgcXVlcnk9YCBmaWVsZCB2YWx1ZSwgc28gYSBjYWxsZXIgY2FuIHRlbGwgYW4gYXJndi12aXNpYmxlIGJvZHkgZnJvbSBvbmVcbiAgICogdGhlIGFyZ3YgY2Fubm90IHNob3cuIExlZnQgYWJzZW50IHdoZW4gdGhlIGJvZHkgaXMgZnVsbHkgYXJndi12aXNpYmxlLlxuICAgKi9cbiAgdW5yZWFkYWJsZUJvZHk/OiBib29sZWFuO1xuICAvKipcbiAgICogUGF0aCBvZiBhIHJlYWRhYmxlIGAtLWlucHV0IDxmaWxlPmAgYm9keSwgd2hlbiB0aGUgYXJndiBuYW1lcyBvbmVcbiAgICogKElzc3VlICM5MSkuIEFic2VudCBmb3IgYC0taW5wdXQgLWAgKHN0ZGluKSBhbmQgYEBmaWxlYC1zb3VyY2VkIGZpZWxkXG4gICAqIHZhbHVlcywgd2hpY2ggYXJlIHVuc2Nhbm5hYmxlIGJ5IGNvbnN0cnVjdGlvbi4gUHJlc2VudCBzbyBhIGNhbGxlciB3aXRoIGFcbiAgICogZmlsZXN5c3RlbSByZWFkZXIgY2FuIHNjYW4gdGhlIGZpbGUgZm9yIHJlc2VydmVkIGxhYmVscyByYXRoZXIgdGhhblxuICAgKiBmYWlsaW5nIGNsb3NlZCBvbiBldmVyeSBgLS1pbnB1dGAgbXV0YXRpb24uXG4gICAqL1xuICBib2R5RmlsZVBhdGg/OiBzdHJpbmc7XG59XG5cbi8qKiBNdXRhdGluZyBzdWItdmVyYnMgcGVyIGBnaGAgcm9vdCBjb21tYW5kLiAqL1xuY29uc3QgR0hfTVVUQVRJTkdfVkVSQlM6IFJlY29yZDxzdHJpbmcsIFJlYWRvbmx5U2V0PHN0cmluZz4+ID0ge1xuICBpc3N1ZTogbmV3IFNldChbXG4gICAgXCJjb21tZW50XCIsXG4gICAgXCJjcmVhdGVcIixcbiAgICBcImNsb3NlXCIsXG4gICAgXCJyZW9wZW5cIixcbiAgICBcImVkaXRcIixcbiAgICBcImRlbGV0ZVwiLFxuICAgIFwibG9ja1wiLFxuICAgIFwidW5sb2NrXCIsXG4gICAgXCJwaW5cIixcbiAgICBcInVucGluXCIsXG4gICAgXCJ0cmFuc2ZlclwiLFxuICBdKSxcbiAgcHI6IG5ldyBTZXQoW1xuICAgIFwiY3JlYXRlXCIsXG4gICAgXCJjb21tZW50XCIsXG4gICAgXCJjbG9zZVwiLFxuICAgIFwicmVvcGVuXCIsXG4gICAgXCJlZGl0XCIsXG4gICAgXCJtZXJnZVwiLFxuICAgIFwicmV2aWV3XCIsXG4gICAgXCJyZWFkeVwiLFxuICAgIFwibG9ja1wiLFxuICAgIFwidW5sb2NrXCIsXG4gIF0pLFxuICBsYWJlbDogbmV3IFNldChbXCJjcmVhdGVcIiwgXCJkZWxldGVcIiwgXCJlZGl0XCIsIFwiY2xvbmVcIl0pLFxuICByZWxlYXNlOiBuZXcgU2V0KFtcImNyZWF0ZVwiLCBcImRlbGV0ZVwiLCBcImVkaXRcIiwgXCJ1cGxvYWRcIl0pLFxuICByZXBvOiBuZXcgU2V0KFtcbiAgICBcImNyZWF0ZVwiLFxuICAgIFwiZGVsZXRlXCIsXG4gICAgXCJlZGl0XCIsXG4gICAgXCJmb3JrXCIsXG4gICAgXCJyZW5hbWVcIixcbiAgICBcImFyY2hpdmVcIixcbiAgICBcInVuYXJjaGl2ZVwiLFxuICBdKSxcbiAgc2VjcmV0OiBuZXcgU2V0KFtcInNldFwiLCBcInJlbW92ZVwiLCBcImRlbGV0ZVwiXSksXG4gIHZhcmlhYmxlOiBuZXcgU2V0KFtcInNldFwiLCBcInJlbW92ZVwiLCBcImRlbGV0ZVwiXSksXG4gIHdvcmtmbG93OiBuZXcgU2V0KFtcInJ1blwiLCBcImVuYWJsZVwiLCBcImRpc2FibGVcIl0pLFxuICBydW46IG5ldyBTZXQoW1wiY2FuY2VsXCIsIFwicmVydW5cIiwgXCJkZWxldGVcIl0pLFxuICBjYWNoZTogbmV3IFNldChbXCJkZWxldGVcIl0pLFxuICBnaXN0OiBuZXcgU2V0KFtcImNyZWF0ZVwiLCBcImRlbGV0ZVwiLCBcImVkaXRcIiwgXCJyZW5hbWVcIiwgXCJjbG9uZVwiXSksXG59O1xuXG4vKipcbiAqIFN1Yi12ZXJicyB0cmVhdGVkIGFzIG11dGF0aW5nIGZvciBhIHJvb3QgY29tbWFuZCB0aGF0IGlzIG5vdCBpblxuICoge0BsaW5rIEdIX01VVEFUSU5HX1ZFUkJTfSAoSXNzdWUgIzM3MDMpLlxuICpcbiAqIFRoZSBwZXItcm9vdCB0YWJsZSBhYm92ZSBpcyBhIHBvc2l0aXZlIGFsbG93bGlzdCwgc28gYW4gdW5saXN0ZWQgcm9vdFxuICogKGBnaCBydWxlc2V0IOKApmAsIGEgcm9vdCBhZGRlZCBieSBhIGZ1dHVyZSBgZ2hgIHJlbGVhc2UpIHByZXZpb3VzbHlcbiAqIGNsYXNzaWZpZWQgZXZlcnkgc3ViLXZlcmIgYXMgYSByZWFkIGFuZCBzbGlwcGVkIHBhc3QgYm90aCB0aGUgd3JpdGUtcmVwb1xuICogYWxsb3dsaXN0IGFuZCB0aGUgYXVkaXQgam91cm5hbC4gTWF0Y2hpbmcgdGhlIGNvbnZlbnRpb25hbCBtdXRhdGluZ1xuICogc3ViLXZlcmIgbmFtZXMga2VlcHMgdW5saXN0ZWQgcm9vdHMgY292ZXJlZCB3aXRob3V0IHRyZWF0aW5nIGdlbnVpbmVcbiAqIHJlYWRzIChgbGlzdGAsIGB2aWV3YCwgYHN0YXR1c2AsIGBkb3dubG9hZGApIGFzIHdyaXRlcy5cbiAqL1xuY29uc3QgR0hfR0VORVJJQ19NVVRBVElOR19WRVJCUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcImFkZFwiLFxuICBcImFyY2hpdmVcIixcbiAgXCJjYW5jZWxcIixcbiAgXCJjbG9uZVwiLFxuICBcImNsb3NlXCIsXG4gIFwiY3JlYXRlXCIsXG4gIFwiZGVsZXRlXCIsXG4gIFwiZGlzYWJsZVwiLFxuICBcImVkaXRcIixcbiAgXCJlbmFibGVcIixcbiAgXCJpbXBvcnRcIixcbiAgXCJsb2NrXCIsXG4gIFwibWVyZ2VcIixcbiAgXCJyZW1vdmVcIixcbiAgXCJyZW5hbWVcIixcbiAgXCJyZXJ1blwiLFxuICBcInJlc3RvcmVcIixcbiAgXCJyZXZva2VcIixcbiAgXCJyZW9wZW5cIixcbiAgXCJydW5cIixcbiAgXCJzZXRcIixcbiAgXCJzeW5jXCIsXG4gIFwidHJhbnNmZXJcIixcbiAgXCJ1bmFyY2hpdmVcIixcbiAgXCJ1bmxvY2tcIixcbiAgXCJ1cGxvYWRcIixcbl0pO1xuXG4vKipcbiAqIFJvb3QgY29tbWFuZHMgd2hvc2UgcmVwbyBgZ2hgIHJlc29sdmVzIGZyb20gdGhlIGN1cnJlbnQgY2xvbmUgd2hlbiBub1xuICogYC1SYC9gLS1yZXBvYCBpcyBnaXZlbi4gQSBtdXRhdGlvbiBvbiBvbmUgb2YgdGhlc2Ugd2l0aG91dCBhbiBleHBsaWNpdFxuICogcmVwbyB0aGVyZWZvcmUgdGFyZ2V0cyB0aGUgcnVuJ3Mgb3duIHJlcG8sIHdoaWNoIGlzIG9uIHRoZSBhbGxvd2xpc3QgYnlcbiAqIGNvbnN0cnVjdGlvbi4gRXZlcnkgb3RoZXIgcm9vdCAoZS5nLiBgZ2lzdGAsIHdoaWNoIGlzIG5vdCByZXBvLXNjb3BlZCBhdFxuICogYWxsKSB5aWVsZHMgYW4gdW5kZXRlcm1pbmFibGUgdGFyZ2V0IGFuZCBtdXN0IGZhaWwgY2xvc2VkLlxuICovXG5jb25zdCBHSF9DV0RfU0NPUEVEX1JPT1RTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiaXNzdWVcIixcbiAgXCJwclwiLFxuICBcImxhYmVsXCIsXG4gIFwicmVsZWFzZVwiLFxuICBcInJlcG9cIixcbiAgXCJzZWNyZXRcIixcbiAgXCJ2YXJpYWJsZVwiLFxuICBcIndvcmtmbG93XCIsXG4gIFwicnVuXCIsXG4gIFwiY2FjaGVcIixcbiAgXCJydWxlc2V0XCIsXG5dKTtcblxuLyoqXG4gKiBSb290IHNwZWxsaW5ncyBvZiB0aGUgYGdoIGV4dGVuc2lvbmAgY29tbWFuZCAoSXNzdWUgIzEzOTYpLlxuICpcbiAqIFRoZSByZWFsIGJpbmFyeSBhY2NlcHRzIGFsbCB0aHJlZSwgc28gYW55dGhpbmcgdGhhdCByZWFzb25zIGFib3V0IHRoZSByb290XG4gKiBtdXN0IGFjY2VwdCBhbGwgdGhyZWUgb3IgdGhlIG9kZCBzcGVsbGluZyB3YWxrcyBwYXN0IGl0LiBFeHBvcnRlZCBhcyB0aGVcbiAqIHNpbmdsZSBzb3VyY2Ugb2YgdGhlc2UgYWxpYXNlczogYGdoX2xvY2FsX3N0YXRlX2d1YXJkLnRzYCBub3JtYWxpc2VzIHRoZVxuICogYWdlbnQtc2lkZSByZWZ1c2FsIGFnYWluc3QgdGhpcyBzYW1lIHNldCwgc28gYSBzcGVsbGluZyBhZGRlZCBoZXJlIGNhbm5vdFxuICogYmUgaG9ub3VyZWQgYnkgb25lIGFuZCBtaXNzZWQgYnkgdGhlIG90aGVyLlxuICovXG5leHBvcnQgY29uc3QgR0hfRVhURU5TSU9OX1JPT1RTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiZXh0ZW5zaW9uXCIsXG4gIFwiZXh0ZW5zaW9uc1wiLFxuICBcImV4dFwiLFxuXSk7XG5cbi8qKlxuICogYGdoIGV4dGVuc2lvbmAgc3ViLXZlcmJzIHRoYXQgY2hhbmdlIHRoZSAqKmxvY2FsIHRvb2wqKiwgbm90IEdpdEh1YlxuICogKElzc3VlICMxMzk2KS5cbiAqXG4gKiBOb3RoaW5nIHVuZGVyIHRoZSBgZXh0ZW5zaW9uYCByb290IHdyaXRlcyB0byBhIHJlcG9zaXRvcnk6IGFuIGluc3RhbGxcbiAqIGRvd25sb2FkcyBhbmQgdW5wYWNrcyBhbiBleHRlbnNpb24gaW50byBgR0hfQ09ORklHX0RJUmAsIGFuIHVwZ3JhZGVcbiAqIHJlcGxhY2VzIGl0LCBhIHJlbW92ZSBkZWxldGVzIGl0LCBhIGNyZWF0ZSBzY2FmZm9sZHMgb25lIGxvY2FsbHkuIFRoZXkgYXJlXG4gKiBzdGlsbCBtdXRhdGlvbnMgd29ydGggam91cm5hbGxpbmcg4oCUIGBzb2Z0d2FyZV91cGRhdGVzLnRzYCBpbnN0YWxscyBwaW5uZWRcbiAqIGV4dGVuc2lvbnMgb24gdGhlIHdvcmtlcidzIG93biBob3N0IOKAlCBzbyB0aGV5IGNsYXNzaWZ5IGFzIGBub24tcmVwb2AgcmF0aGVyXG4gKiB0aGFuIGFzIHJlYWRzOiByZWNvcmRlZCBieSB0aGUgYXVkaXQgam91cm5hbCwgYW5kIGFsbG93ZWQgYnkgdGhlIHdyaXRlLXJlcG9cbiAqIGFsbG93bGlzdCBiZWNhdXNlIHRoZXJlIGlzIG5vIHdyaXRlIHRhcmdldCB0byBjb21wYXJlIGFnYWluc3QgaXQuXG4gKlxuICogQmVmb3JlIHRoaXMgdGhlIHJvb3Qgd2FzIHNwbGl0IGFjcm9zcyBib3RoIHRhYmxlcyBieSBhY2NpZGVudDogYGluc3RhbGxgIGFuZFxuICogYHVwZ3JhZGVgIG1hdGNoZWQgbm8gbXV0YXRpbmcgdmVyYiBhdCBhbGwgYW5kIGNsYXNzaWZpZWQgYXMgcmVhZHMsIHNvIHRoZVxuICogd29ya2VyJ3Mgb3duIGV4dGVuc2lvbiB1cGdyYWRlcyB3ZXJlIG5ldmVyIGpvdXJuYWxsZWQsIHdoaWxlIGByZW1vdmVgIGFuZFxuICogYGNyZWF0ZWAgbWF0Y2hlZCB7QGxpbmsgR0hfR0VORVJJQ19NVVRBVElOR19WRVJCU30gYWdhaW5zdCBhIHJvb3QgdGhhdCBpc1xuICogbm90IGN3ZC1zY29wZWQgYW5kIHNvIGZhaWxlZCBjbG9zZWQgYXMgYW4gdW5kZXRlcm1pbmFibGUgcmVwbyB3cml0ZS4gT25lXG4gKiByb290LCB0d28gb3Bwb3NpdGUgYW5zd2VycywgbmVpdGhlciBvZiB0aGVtIHJpZ2h0IOKAlCB3aGljaCBpcyB3aGF0IGtlcHQgdGhlXG4gKiBgZ2ggZXh0ZW5zaW9uYCBjYWxsZXIgb3V0c2lkZSB0aGUgYHNwYXduR2hgIGNob2tlcG9pbnQuXG4gKlxuICogUmVhZHMgKGBsaXN0YCwgYGJyb3dzZWAsIGBzZWFyY2hgKSBhbmQgYGV4ZWNgIOKAlCB3aGljaCBydW5zIGFuIGluc3RhbGxlZFxuICogZXh0ZW5zaW9uIHJhdGhlciB0aGFuIGNoYW5naW5nIHRoZSBpbnN0YWxsZWQgc2V0IOKAlCBhcmUgbm90IG11dGF0aW9ucyBoZXJlLlxuICogVGhlIHZlcmIgbGlzdCB0aGVyZWZvcmUgZGlmZmVycyBmcm9tIGBHSF9MT0NBTF9TVEFURV9WRVJCUy5leHRlbnNpb25gIGluXG4gKiBgZ2hfbG9jYWxfc3RhdGVfZ3VhcmQudHNgIG9uIHB1cnBvc2UsIGFuZCB0aGUgdHdvIGFyZSBub3Qgb25lIGxpc3Q6IHRoaXMgb25lXG4gKiBhbnN3ZXJzIFwiZGlkIHRoZSBsb2NhbCB0b29sIGNoYW5nZSwgYW5kIHNob3VsZCB0aGUgam91cm5hbCBzYXkgc29cIiwgd2hpY2hcbiAqIHRha2VzIGluIGBjcmVhdGVgIGFuZCBsZWF2ZXMgb3V0IGBleGVjYDsgdGhlIGd1YXJkJ3MgYW5zd2VycyBcIm1heSB0aGUgYWdlbnRcbiAqIHJ1biB0aGlzIGF0IGFsbFwiLCB3aGljaCByZWZ1c2VzIGBleGVjYCDigJQgYW4gZXh0ZW5zaW9uIHRoZSBndWFyZCBjYW5ub3Qgc2VlXG4gKiBpbnNpZGUg4oCUIGFuZCBoYXMgbm8gcmVhc29uIHRvIG5hbWUgYGNyZWF0ZWAuIFRoZSBhZ2VudCBpcyByZWZ1c2VkIGV2ZXJ5XG4gKiB2ZXJiIGluIHRoZSBndWFyZCdzIGxpc3Qgd2hhdGV2ZXIgdGhpcyBvbmUgc2F5cyAoSXNzdWUgIzE4Nyk7IHRoaXNcbiAqIGNsYXNzaWZpY2F0aW9uIGdvdmVybnMgdGhlIHdvcmtlcidzIG93biBjYWxscy5cbiAqL1xuY29uc3QgR0hfRVhURU5TSU9OX0xPQ0FMX1ZFUkJTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiaW5zdGFsbFwiLFxuICBcInVwZ3JhZGVcIixcbiAgXCJyZW1vdmVcIixcbiAgXCJjcmVhdGVcIixcbl0pO1xuXG4vKipcbiAqIEdyYXBoUUwgbXV0YXRpb25zIHNhbmN0aW9uZWQgYXMgdG91Y2hpbmcgbm8gcmVwb3NpdG9yeSAoSXNzdWUgIzM3MDMpLlxuICpcbiAqIEEgR3JhcGhRTCBtdXRhdGlvbiBjYXJyaWVzIG5vIGRlcml2YWJsZSBgb3duZXIvcmVwb2AsIHNvIGl0IGZhaWxzIGNsb3NlZFxuICogYnkgZGVmYXVsdC4gVGhpcyBhbGxvd2xpc3QgbmFtZXMgdGhlIHdvcmtlcidzIG93biBub24tcmVwbyBtdXRhdGlvbnMg4oCUXG4gKiBgY2hhbmdlVXNlclN0YXR1c2Agc2V0cyB0aGUgd29ya2VyIGFjY291bnQncyBwcm9maWxlIHN0YXR1c1xuICogKGBnaXRodWJfc3RhdHVzLnRzYCkgYW5kIGNhbm5vdCB3cml0ZSB0byBhbnkgcmVwb3NpdG9yeS4gQ29tcGFyZWRcbiAqIGxvd2VyLWNhc2UuXG4gKi9cbmV4cG9ydCBjb25zdCBHSF9TQU5DVElPTkVEX0dSQVBIUUxfTVVUQVRJT05TOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiY2hhbmdldXNlcnN0YXR1c1wiLFxuXSk7XG5cbi8qKlxuICogYGdoYCBmbGFncyB3aG9zZSBmb2xsb3dpbmcgdG9rZW4gaXMgYSB2YWx1ZSwgbm90IGEgcG9zaXRpb25hbCBhcmd1bWVudC5cbiAqXG4gKiBEZXJpdmVkIGZyb20gdGhlIG9uZSB0YWJsZSBldmVyeSBgZ2hgIGFyZ3Ygd2Fsa2VyIHNoYXJlcyAoSXNzdWUgIzM1NjgpOlxuICogdGhpcyBjbGFzc2lmaWVyIHVzZWQgdG8ga2VlcCBpdHMgb3duIGNvcHksIHdoaWNoIGxhY2tlZCBgLXBgL2AtLXByZXZpZXdgLFxuICogc28gYSBwcmV2aWV3IG5hbWUgd2FzIHJlYWQgYXMgdGhlIGVuZHBvaW50IChJc3N1ZSAjMzU2MSkuXG4gKi9cbmNvbnN0IEdIX1ZBTFVFX0ZMQUdTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gR0hfU0VQQVJBVEVEX1ZBTFVFX0ZMQUdTO1xuXG4vKipcbiAqIGdoJ3MgcGxhY2Vob2xkZXIgc3ludGF4IChjbGkvY2xpIGBwa2cvY21kL2FwaWAgYGZpbGxQbGFjZWhvbGRlcnNgKTogaXRcbiAqIHJld3JpdGVzIHRoZXNlIGluIGEgbWFnaWMgZmllbGQncyB2YWx1ZSAoYC1GYC9gLS1maWVsZGApIHdpdGggdGhlIGN1cnJlbnRcbiAqIHJlcG9zaXRvcnkncyBvd25lciwgbmFtZSBvciBjaGVja2VkLW91dCBicmFuY2gg4oCUIGFmdGVyIHRoaXMgY2xhc3NpZmllciBoYXNcbiAqIHJlYWQgdGhlIHZhbHVlLCBhbmQgdGhlIGFnZW50IGNob29zZXMgdGhlIGJyYW5jaCAoSXNzdWUgIzM1NjYpLlxuICovXG5jb25zdCBHSF9GSUVMRF9QTEFDRUhPTERFUiA9IC86KD86b3duZXJ8cmVwb3xicmFuY2gpXFxifFxce1thLXpdK1xcfS87XG5cbi8qKlxuICogTWFnaWMtZmllbGQga2V5cyB3aG9zZSBzdWJzdGl0dXRlZCB2YWx1ZSBjb3VsZCBjaGFuZ2Ugd2hhdCB0aGUgZ3VhcmRcbiAqIGRlY2lkZWQ6IHRoZSBHcmFwaFFMIGRvY3VtZW50IGFuZCBvcGVyYXRpb24gbmFtZSAoYSBicmFuY2ggbmFtZSBjYW4gY2xvc2UgYVxuICogc3RyaW5nIGFuZCBhZGQgYW4gb3BlcmF0aW9uKSwgYW5kIGxhYmVsIG5hbWVzIChJc3N1ZSAjMzU2NikuXG4gKi9cbmZ1bmN0aW9uIGlzUGxhY2Vob2xkZXJTZW5zaXRpdmVLZXkoa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgayA9IGtleS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIGsgPT09IFwicXVlcnlcIiB8fCBrID09PSBcIm9wZXJhdGlvbm5hbWVcIiB8fCBrID09PSBcIm5hbWVcIiB8fFxuICAgIGsgPT09IFwibmV3X25hbWVcIiB8fCBrLnN0YXJ0c1dpdGgoXCJsYWJlbHNcIik7XG59XG5cbi8qKlxuICogRXh0cmFjdCBgb3duZXIvcmVwb2AgZnJvbSBhIGAtUmAvYC0tcmVwb2AgZmxhZyBhbnl3aGVyZSBpbiB0aGUgYXJncy5cbiAqXG4gKiBJc3N1ZSAjMzg2NzogYC0tcmVwb2AgaXMgYSBwZmxhZyBzdHJpbmcgZmxhZywgc28gYSByZXBlYXRlZCBmbGFnIHJlc29sdmVzIHRvXG4gKiBpdHMgKipsYXN0Kiogb2NjdXJyZW5jZSDigJQgYC1SIGFsbG93ZWQvcmVwbyAtUiBhdHRhY2tlci9ldmlsYCB3cml0ZXMgdG9cbiAqIGBhdHRhY2tlci9ldmlsYC4gUmV0dXJuaW5nIHRoZSBmaXJzdCBtYXRjaCBib3RoIGFsbG93ZWQgdGhlIHdyaXRlIGFuZFxuICogam91cm5hbGxlZCB0aGUgd3JvbmcgdGFyZ2V0LiBBdHRhY2hlZCBzaG9ydGhhbmQgc3BlbGxpbmdzIChgLVJvd25lci9yZXBvYClcbiAqIGFyZSBoYW5kbGVkIGJ5IHtAbGluayBub3JtYWxpc2VHaEFyZ3N9IGJlZm9yZSB0aGlzIHJ1bnMuXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RSZXBvRmxhZyhhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGxldCByZXBvOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRva2VuID0gYXJnc1tpXTtcbiAgICBpZiAodG9rZW4gPT09IFwiLVJcIiB8fCB0b2tlbiA9PT0gXCItLXJlcG9cIikge1xuICAgICAgLy8gcGZsYWcgY29uc3VtZXMgdGhlIGZvbGxvd2luZyB0b2tlbiBhcyB0aGUgdmFsdWUgd2hhdGV2ZXIgaXQgbG9va3NcbiAgICAgIC8vIGxpa2UsIHNvIGEgZGFzaC1sZWFkaW5nIHZhbHVlIGlzIHRha2VuIHRvbyDigJQgaXQgY2FuIG9ubHkgZXZlciBmYWlsXG4gICAgICAvLyB0aGUgYWxsb3dsaXN0LCB3aGljaCBpcyB0aGUgc2FmZSBkaXJlY3Rpb24uXG4gICAgICBjb25zdCB2YWx1ZSA9IGFyZ3NbaSArIDFdO1xuICAgICAgaWYgKHZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmVwbyA9IHZhbHVlO1xuICAgICAgICBpKys7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0b2tlbj8uc3RhcnRzV2l0aChcIi0tcmVwbz1cIikpIHtcbiAgICAgIHJlcG8gPSB0b2tlbi5zbGljZShcIi0tcmVwbz1cIi5sZW5ndGgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVwbztcbn1cblxuLyoqXG4gKiBJbmRleCBvZiB0aGUgZmlyc3Qgbm9uLWZsYWcgdG9rZW4gYXQgb3IgYWZ0ZXIgYGZyb21gLlxuICpcbiAqIEEga25vd24gdmFsdWUtY2FycnlpbmcgZmxhZyB0YWtlcyBpdHMgZm9sbG93aW5nIHRva2VuIHdpdGggaXQsIHNvIGEgdmFsdWVcbiAqIHN1Y2ggYXMgdGhlIGBvd25lci9yZXBvYCBvZiBgLVIgb3duZXIvcmVwb2AgaXMgbmV2ZXIgbWlzdGFrZW4gZm9yIHRoZSByb290XG4gKiBjb21tYW5kIG9yIHRoZSBzdWItdmVyYi5cbiAqXG4gKiBAcGFyYW0gdmFsdWVGbGFncyAtIFZhbHVlLWNhcnJ5aW5nIGZsYWdzIG9mIHRoZSBiaW5hcnkgYmVpbmcgcGFyc2VkLiBFYWNoXG4gKiAgIGJpbmFyeSBvd25zIGl0cyBvd24gdGFibGUgKElzc3VlICMzOTUwIOKAlCBnaXQncyBnbG9iYWxzIHdlcmUgYmVpbmcgbWF0Y2hlZFxuICogICBhZ2FpbnN0IGdoJ3MgdGFibGUsIHNvIGBnaXQgLUMgL3JlcG8gcHVzaGAgc2Nhbm5lZCBvbnRvIGAvcmVwb2ApLlxuICovXG5mdW5jdGlvbiBmaXJzdE5vbkZsYWcoXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBmcm9tOiBudW1iZXIsXG4gIHZhbHVlRmxhZ3M6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBHSF9WQUxVRV9GTEFHUyxcbik6IG51bWJlciB7XG4gIGxldCBpID0gZnJvbTtcbiAgd2hpbGUgKGFyZ3NbaV0/LnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgaSArPSB2YWx1ZUZsYWdzLmhhcyhhcmdzW2ldISkgPyAyIDogMTtcbiAgfVxuICByZXR1cm4gaTtcbn1cblxuLyoqXG4gKiBUaGUgcm9vdCBjb21tYW5kIGEgYGdoYCBhcmd1bWVudCB2ZWN0b3IgbmFtZXMgKGBpc3N1ZWAsIGBhcGlgLCDigKYpLlxuICpcbiAqIFNoYXJlZCB3aXRoIHRoZSBhZ2VudC1zaWRlIGd1YXJkIChJc3N1ZSAjMzg2NiksIHdoaWNoIHJlZnVzZXMgYSByb290IGl0XG4gKiBkb2VzIG5vdCByZWNvZ25pc2UsIHNvIGJvdGggZGVyaXZlIHRoZSByb290IHRoZSBzYW1lIHdheS5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHJldHVybnMgVGhlIHJvb3QgY29tbWFuZCwgb3IgdW5kZWZpbmVkIHdoZW4gdGhlIHZlY3RvciBuYW1lcyBub25lXG4gKiAgIChgZ2hgLCBgZ2ggLS12ZXJzaW9uYCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnaFJvb3RDb21tYW5kKGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIGFyZ3NbZmlyc3ROb25GbGFnKGFyZ3MsIDApXTtcbn1cblxuLyoqXG4gKiBUaGUgc3ViLXZlcmIgZm9sbG93aW5nIHRoZSByb290IGNvbW1hbmQgKGBsb2dpbmAgaW4gYGdoIGF1dGggbG9naW5gKS5cbiAqXG4gKiBEZXJpdmVkIGV4YWN0bHkgYXMge0BsaW5rIGNsYXNzaWZ5R2hNdXRhdGlvbn0gZGVyaXZlcyBpdCwgc28gdGhlIGFnZW50LXNpZGVcbiAqIGxvY2FsLXN0YXRlIGd1YXJkIChJc3N1ZSAjMTg3KSBhbmQgdGhlIG11dGF0aW9uIGNsYXNzaWZpZXIgY2Fubm90IGRpc2FncmVlXG4gKiBhYm91dCB3aGljaCB0b2tlbiBpcyB0aGUgdmVyYi5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHJldHVybnMgVGhlIHN1Yi12ZXJiLCBvciB1bmRlZmluZWQgd2hlbiB0aGUgdmVjdG9yIG5hbWVzIG5vbmVcbiAqICAgKGBnaCBhdXRoYCwgYGdoIC0tdmVyc2lvbmApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2hTdWJWZXJiKGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3Qgcm9vdElkeCA9IGZpcnN0Tm9uRmxhZyhhcmdzLCAwKTtcbiAgaWYgKGFyZ3Nbcm9vdElkeF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIGFyZ3NbZmlyc3ROb25GbGFnKGFyZ3MsIHJvb3RJZHggKyAxKV07XG59XG5cbi8qKlxuICogVGhlIG9ubHkgaG9zdCBhIGBnaCBhcGlgIGVuZHBvaW50IG1heSBuYW1lIGFuZCBzdGlsbCBiZSBjbGFzc2lmaWVkIGZyb20gaXRzXG4gKiBwYXRoIChJc3N1ZSAjMTQyMCkuXG4gKlxuICogRGVmaW5lZCBpbiBgZ2hfYXJndl9jYW5vbmljYWwudHNgLCB3aG9zZSBlbmRwb2ludCBjYW5vbmljYWxpc2VyIHNoYXJlcyBpdFxuICogKElzc3VlICMzNTY4KSwgYW5kIHJlLWV4cG9ydGVkIGhlcmUuIEEgR2l0SHViIEVudGVycHJpc2UgZGVwbG95bWVudCBhbnN3ZXJzXG4gKiBvbiBpdHMgb3duIGhvc3QuIE5hbWluZyBpdCB0aGVyZSBpcyB0aGUgb25lIGVkaXQgdGhhdCB3b3VsZCBleHRlbmQgdGhpcyxcbiAqIGFuZCBpdCBpcyBkZWxpYmVyYXRlbHkgbm90IHJlYWQgZnJvbVxuICogYEdIX0hPU1RgOiB0aGF0IHZhcmlhYmxlIHJlYWNoZXMgdGhpcyBjbGFzc2lmaWVyIHRocm91Z2ggdGhlIHNhbWUgYXJndi1cbiAqIGFkamFjZW50IGVudmlyb25tZW50IHRoZSBndWFyZCBleGlzdHMgdG8gZGlzdHJ1c3QuIEFuIGVudGVycHJpc2UgZmxlZXQnc1xuICogQUJTT0xVVEUgZW5kcG9pbnRzIHRoZXJlZm9yZSBjbGFzc2lmeSBhcyBgdW5rbm93bmAgYW5kIGFyZSByZWZ1c2VkIOKAlFxuICogZmFpbC1jbG9zZWQsIGFuZCB0aGUgcmVsYXRpdmUgZm9ybSBldmVyeSBub3JtYWwgY2FsbCB1c2VzIGlzIHVuYWZmZWN0ZWQuXG4gKi9cbmV4cG9ydCB7IEdJVEhVQl9BUElfSE9TVCB9O1xuXG4vKiogVGhlIG9ubHkgYGdoIGFwaSAtLWhvc3RuYW1lYCB2YWx1ZSBjbGFzc2lmaWVkIGZyb20gaXRzIHBhdGggKElzc3VlICMxNDIwKS4gKi9cbmNvbnN0IEdJVEhVQl9IT1NUID0gXCJnaXRodWIuY29tXCI7XG5cbi8qKiBEb2VzIHRoaXMgZW5kcG9pbnQgY2FycnkgYSBgc2NoZW1lOi8vYCBvcmlnaW4gYXQgYWxsPyAqL1xuY29uc3QgQUJTT0xVVEVfRU5EUE9JTlQgPSAvXlthLXpdW2EtejAtOSsuLV0qOlxcL1xcLy9pO1xuXG4vKipcbiAqIFRoZSBwYXRoIHBhcnQgb2YgYSBgZ2ggYXBpYCBlbmRwb2ludCwgb3IgYHVuZGVmaW5lZGAgd2hlbiB0aGUgZW5kcG9pbnRcbiAqIGFkZHJlc3NlcyBhIGhvc3QgdGhpcyBydW4gY2Fubm90IHZvdWNoIGZvciAoSXNzdWUgIzE0MjApLlxuICpcbiAqIGBnaCBhcGlgIGFjY2VwdHMgYSBmdWxsIFVSTCBhcyB3ZWxsIGFzIGEgcGF0aCwgc29cbiAqIGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zL28vci9pc3N1ZXNgIG11c3QgcmVzb2x2ZSB0aGUgc2FtZSByZXBvIGFzXG4gKiBgcmVwb3Mvby9yL2lzc3Vlc2AgKElzc3VlICMzNzAzIOKAlCBhYnNvbHV0ZSBlbmRwb2ludHMgcHJldmlvdXNseSBkZXJpdmVkIG5vXG4gKiByZXBvIGFuZCBzbGlwcGVkIHBhc3QgdGhlIGFsbG93bGlzdCkuIFRoYXQgc3RyaXAgdG9vayBBTlkgc2NoZW1lIGFuZCBBTllcbiAqIGhvc3QsIHNvIHRoZSBvcmlnaW4gd2FzIGRpc2NhcmRlZCB3aXRob3V0IGJlaW5nIGxvb2tlZCBhdDogYSBVUkwgd2hvc2UgcGF0aFxuICogbmFtZWQgYW4gYWxsb3dlZCByZXBvc2l0b3J5IGNsYXNzaWZpZWQgYXMgYW4gYWxsb3dlZCBvbi1yZXBvIHdyaXRlIGhvd2V2ZXJcbiAqIGZhciBmcm9tIEdpdEh1YiBpdCBhY3R1YWxseSBwb2ludGVkLCBhbmQgYGdoYCB0aGVuIHNlbnQgdGhlIHJlcXVlc3Qg4oCUIGZpZWxkXG4gKiBhbmQgYm9keSBkYXRhIGluY2x1ZGVkIOKAlCB0byB0aGF0IGhvc3QuIFRoZSBhbGxvd2xpc3QgZGVjaWRlcyAqd2hlcmUqIGFcbiAqIHdyaXRlIG1heSBnbywgYW5kIHN1Y2ggYSByZXF1ZXN0IG5ldmVyIHJlYWNoZXMgR2l0SHViLCBzbyBub3RoaW5nXG4gKiBzZXJ2ZXItc2lkZSBzdGFuZHMgYmVoaW5kIGl0IGVpdGhlci5cbiAqXG4gKiBUaGUgaG9zdCBpcyB0aGVyZWZvcmUgY29tcGFyZWQsIGFuZCBjb21wYXJlZCBhcyBhIHBhcnNlZCAqKmhvc3RuYW1lKio6IGFcbiAqIHN1YnN0cmluZyBvciBwcmVmaXggdGVzdCBvbiB0aGUgcmF3IFVSTCBpcyBmb29sZWQgYnkgdXNlcmluZm9cbiAqIChgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbUBlbHNld2hlcmUuZXhhbXBsZS/igKZgLCB3aG9zZSBob3N0IGlzXG4gKiBgZWxzZXdoZXJlLmV4YW1wbGVgKSBhbmQgYnkgYSBzdWZmaXggKGBldmlsLWFwaS5naXRodWIuY29tLmF0dGFja2VyLmV4YW1wbGVgKS5cbiAqXG4gKiBUaGUgcGF0aCBpcyB0YWtlbiBmcm9tIHRoZSBPUklHSU5BTCB0ZXh0IHJhdGhlciB0aGFuIGZyb20gYFVSTC5wYXRobmFtZWAsXG4gKiBiZWNhdXNlIFVSTCBwYXJzaW5nIHBlcmNlbnQtZW5jb2RlcyB0aGUgYnJhY2VzIGluIHRoZVxuICogYHJlcG9zL3tvd25lcn0ve3JlcG99L+KApmAgcGxhY2Vob2xkZXIgZm9ybSBhbmQgdGhhdCBtdXN0IGtlZXAgbWF0Y2hpbmcuXG4gKlxuICogQHBhcmFtIGVuZHBvaW50IC0gVGhlIGVuZHBvaW50IGFyZ3VtZW50IGFzIHdyaXR0ZW4gb24gdGhlIGNvbW1hbmQgbGluZS5cbiAqIEByZXR1cm5zIFRoZSBwYXRoIHdpdGggYW55IGxlYWRpbmcgYC9gIHJlbW92ZWQsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlXG4gKiAgIGVuZHBvaW50IGlzIGFic29sdXRlIGFuZCBkb2VzIG5vdCBhZGRyZXNzIHtAbGluayBHSVRIVUJfQVBJX0hPU1R9LlxuICovXG5mdW5jdGlvbiBlbmRwb2ludFBhdGgoZW5kcG9pbnQ6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmICghQUJTT0xVVEVfRU5EUE9JTlQudGVzdChlbmRwb2ludCkpIHJldHVybiBlbmRwb2ludDtcblxuICBsZXQgdXJsOiBVUkw7XG4gIHRyeSB7XG4gICAgdXJsID0gbmV3IFVSTChlbmRwb2ludCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIEFuIG9yaWdpbiB3ZSBjYW5ub3QgcGFyc2UgaXMgYW4gb3JpZ2luIHdlIGNhbm5vdCB2b3VjaCBmb3IuXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAodXJsLnByb3RvY29sICE9PSBcImh0dHBzOlwiICYmIHVybC5wcm90b2NvbCAhPT0gXCJodHRwOlwiKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAodXJsLmhvc3RuYW1lLnRvTG93ZXJDYXNlKCkgIT09IEdJVEhVQl9BUElfSE9TVCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBjb25zdCBhZnRlclNjaGVtZSA9IGVuZHBvaW50LnNsaWNlKGVuZHBvaW50LmluZGV4T2YoXCI6Ly9cIikgKyAzKTtcbiAgY29uc3Qgc2xhc2ggPSBhZnRlclNjaGVtZS5pbmRleE9mKFwiL1wiKTtcbiAgcmV0dXJuIHNsYXNoIDwgMCA/IFwiXCIgOiBhZnRlclNjaGVtZS5zbGljZShzbGFzaCArIDEpO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYSBgZ2ggYXBpYCBlbmRwb2ludCBhZGRyZXNzZXMgR2l0SHViJ3MgR3JhcGhRTCBlbmRwb2ludC5cbiAqXG4gKiBgZ2hgIGl0c2VsZiBzcGVjaWFsLWNhc2VzIG9ubHkgdGhlIGJhcmUgd29yZCBgZ3JhcGhxbGAsIGJ1dCBgL2dyYXBocWxgLFxuICogYGdyYXBocWw/eD0xYCBhbmQgYGh0dHBzOi8vYXBpLmdpdGh1Yi5jb20vZ3JhcGhxbGAgYWxsIFBPU1QgYSBge1wicXVlcnlcIjog4oCmfWBcbiAqIGJvZHkgdG8gdGhlIHNhbWUgZW5kcG9pbnQsIGFuZCBHaXRIdWIgcnVucyBpdCAoUFIgIzM1MTQgcmV2aWV3KS4gQW4gYWJzb2x1dGVcbiAqIFVSTCBjb3VudHMgb25seSB3aGVuIHtAbGluayBlbmRwb2ludFBhdGh9IHZvdWNoZXMgZm9yIGl0cyBob3N0LlxuICovXG5mdW5jdGlvbiBpc0dyYXBocWxFbmRwb2ludChlbmRwb2ludDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHBhdGggPSBlbmRwb2ludFBhdGgoZW5kcG9pbnQpO1xuICBpZiAocGF0aCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGN1dCA9IHBhdGguc2VhcmNoKC9bPyNdLyk7XG4gIGNvbnN0IGJhcmUgPSBjdXQgPCAwID8gcGF0aCA6IHBhdGguc2xpY2UoMCwgY3V0KTtcbiAgLy8gU2xpY2UgcmF0aGVyIHRoYW4gYC9cXC8rJC9gLCB3aGljaCBpcyBxdWFkcmF0aWMgb24gYSBsb25nIHJ1biBvZiBzbGFzaGVzLlxuICBsZXQgc3RhcnQgPSAwO1xuICBsZXQgZW5kID0gYmFyZS5sZW5ndGg7XG4gIHdoaWxlIChzdGFydCA8IGVuZCAmJiBiYXJlW3N0YXJ0XSA9PT0gXCIvXCIpIHN0YXJ0Kys7XG4gIHdoaWxlIChlbmQgPiBzdGFydCAmJiBiYXJlW2VuZCAtIDFdID09PSBcIi9cIikgZW5kLS07XG4gIHJldHVybiBiYXJlLnNsaWNlKHN0YXJ0LCBlbmQpID09PSBcImdyYXBocWxcIjtcbn1cblxuLyoqIFdoZXRoZXIgYW4gZW5kcG9pbnQgcGF0aCBpcyByZXBvLXNjb3BlZCB2aWEgYHtvd25lcn0ve3JlcG99YCBwbGFjZWhvbGRlcnMuICovXG5mdW5jdGlvbiBpc1BsYWNlaG9sZGVyUmVwb0VuZHBvaW50KGVuZHBvaW50OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIC9eXFwvP3JlcG9zXFwvXFx7b3duZXJcXH1cXC9cXHtyZXBvXFx9KFxcL3wkKS8udGVzdChlbmRwb2ludCk7XG59XG5cbi8qKiBQYXJzZSBgb3duZXIvcmVwb2Agb3V0IG9mIGEgUkVTVCBlbmRwb2ludCBsaWtlIGByZXBvcy9vL3IvaXNzdWVzYC4gKi9cbmZ1bmN0aW9uIHJlcG9Gcm9tRW5kcG9pbnQoZW5kcG9pbnQ6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHBhdGggPSBlbmRwb2ludFBhdGgoZW5kcG9pbnQpO1xuICBpZiAocGF0aCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAoaXNQbGFjZWhvbGRlclJlcG9FbmRwb2ludChwYXRoKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbWF0Y2ggPSBwYXRoLm1hdGNoKC9eXFwvP3JlcG9zXFwvKFteL10rKVxcLyhbXi9dKykvKTtcbiAgcmV0dXJuIG1hdGNoID8gYCR7bWF0Y2hbMV19LyR7bWF0Y2hbMl19YCA6IHVuZGVmaW5lZDtcbn1cblxuLyoqIFJlc3VsdCBvZiBzY2FubmluZyBhIEdyYXBoUUwgZG9jdW1lbnQgZm9yIG11dGF0aW9uIG9wZXJhdGlvbnMuICovXG5leHBvcnQgaW50ZXJmYWNlIEdyYXBocWxTY2FuIHtcbiAgLyoqIERlcHRoLTEgZmllbGQgbmFtZXMgb2YgZXZlcnkgYG11dGF0aW9uYCBvcGVyYXRpb24sIGluIGRvY3VtZW50IG9yZGVyLiAqL1xuICBmaWVsZHM6IHN0cmluZ1tdO1xuICAvKiogV2hldGhlciBhdCBsZWFzdCBvbmUgYG11dGF0aW9uYCBvcGVyYXRpb24gd2FzIHNlZW4uICovXG4gIGhhc011dGF0aW9uOiBib29sZWFuO1xuICAvKipcbiAgICogV2hldGhlciB0aGUgZG9jdW1lbnQgcGFyc2VkIGNsZWFubHk6IHN0cmluZ3MgdGVybWluYXRlZCwgYnJhY2tldHNcbiAgICogYmFsYW5jZWQsIG9ubHkgR3JhcGhRTCBjaGFyYWN0ZXJzLiBBIGRvY3VtZW50IHRoYXQgaXMgbm90IGNsZWFuIGNhbiBuZXZlclxuICAgKiBiZSB2b3VjaGVkIGZvciwgd2hhdGV2ZXIgZmllbGRzIHdlcmUgZm91bmQgYmVmb3JlIGl0IGJyb2tlLlxuICAgKi9cbiAgY2xlYW46IGJvb2xlYW47XG59XG5cbmNvbnN0IEdSQVBIUUxfT1BFUkFUSU9OX0tFWVdPUkRTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwibXV0YXRpb25cIixcbiAgXCJxdWVyeVwiLFxuICBcInN1YnNjcmlwdGlvblwiLFxuICBcImZyYWdtZW50XCIsXG5dKTtcblxuLyoqIENoYXJhY3RlcnMgR3JhcGhRTCBwZXJtaXRzIG91dHNpZGUgc3RyaW5ncyBhbmQgY29tbWVudHMgKGJlc2lkZXMgbmFtZXMpLiAqL1xuY29uc3QgR1JBUEhRTF9QVU5DVFVBVElPTiA9ICcgXFx0XFxuXFxyXFx1RkVGRiwhJCYoKS46PUBbXXt8fS0rXCIjJztcblxuZnVuY3Rpb24gaXNHcmFwaHFsTmFtZUNoYXIoY2g6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gKGNoID49IFwiYVwiICYmIGNoIDw9IFwielwiKSB8fCAoY2ggPj0gXCJBXCIgJiYgY2ggPD0gXCJaXCIpIHx8XG4gICAgKGNoID49IFwiMFwiICYmIGNoIDw9IFwiOVwiKSB8fCBjaCA9PT0gXCJfXCI7XG59XG5cbi8qKiBXaGV0aGVyIHRoZSBuZXh0IHRva2VuIGFmdGVyIGBmcm9tYCAocGFzdCBibGFua3MsIGNvbW1hcywgY29tbWVudHMpIHN0YXJ0cyBhIG5hbWUuICovXG5mdW5jdGlvbiBuZXh0U2lnbmlmaWNhbnRJc05hbWVTdGFydChkb2N1bWVudDogc3RyaW5nLCBmcm9tOiBudW1iZXIpOiBib29sZWFuIHtcbiAgbGV0IGkgPSBmcm9tO1xuICB3aGlsZSAoaSA8IGRvY3VtZW50Lmxlbmd0aCkge1xuICAgIGNvbnN0IGNoID0gZG9jdW1lbnRbaV0hO1xuICAgIGlmIChjaCA9PT0gXCIjXCIpIHtcbiAgICAgIHdoaWxlIChcbiAgICAgICAgaSA8IGRvY3VtZW50Lmxlbmd0aCAmJiBkb2N1bWVudFtpXSAhPT0gXCJcXG5cIiAmJiBkb2N1bWVudFtpXSAhPT0gXCJcXHJcIlxuICAgICAgKSBpKys7XG4gICAgfSBlbHNlIGlmIChcbiAgICAgIGNoID09PSBcIiBcIiB8fCBjaCA9PT0gXCJcXHRcIiB8fCBjaCA9PT0gXCJcXG5cIiB8fCBjaCA9PT0gXCJcXHJcIiB8fCBjaCA9PT0gXCIsXCIgfHxcbiAgICAgIGNoID09PSBcIlxcdUZFRkZcIlxuICAgICkge1xuICAgICAgaSsrO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gaXNHcmFwaHFsTmFtZUNoYXIoY2gpICYmICEoY2ggPj0gXCIwXCIgJiYgY2ggPD0gXCI5XCIpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogU2NhbiBhIEdyYXBoUUwgZG9jdW1lbnQgd2l0aCBhIHNpbmdsZS1wYXNzIGNoYXJhY3RlciBzY2FubmVyIChubyByZWdleCwgc29cbiAqIG5vIGJhY2t0cmFja2luZykgYW5kIGNvbGxlY3QgdGhlIGRlcHRoLTEgZmllbGRzIG9mIGV2ZXJ5IG11dGF0aW9uXG4gKiBvcGVyYXRpb24gKElzc3VlICMzNTQ5KS5cbiAqXG4gKiBgI2AgY29tbWVudHMsIGBcIuKAplwiYCBzdHJpbmdzIGFuZCBgXCJcIlwi4oCmXCJcIlwiYCBibG9jayBzdHJpbmdzIGFyZSBza2lwcGVkIGluIGV2ZXJ5XG4gKiBjb250ZXh0LCBzbyBhIGJyYWNlIG9yIHRoZSB3b3JkIGBtdXRhdGlvbmAgaW5zaWRlIG9uZSBjYW5ub3QgbW92ZSB0aGVcbiAqIGRlcHRoIGNvdW50LiBBIGJyYWNrZXQgc3RhY2sgdHJhY2tzIGAoYC9ge2Agb3ZlciB0aGUgd2hvbGUgZG9jdW1lbnQ7XG4gKiBhcmd1bWVudCBsaXN0cyBhbmQgdmFyaWFibGUgZGVmaW5pdGlvbnMgYXJlIHNraXBwZWQgd2hvbGVzYWxlLiBBbGlhc2VzXG4gKiAoYGFsaWFzOiBmaWVsZGApIHlpZWxkIHRoZSBmaWVsZDsgZGlyZWN0aXZlIG5hbWVzIChgQHhgKSBhcmUgaWdub3JlZC5cbiAqXG4gKiBAcGFyYW0gZG9jdW1lbnQgLSBUaGUgR3JhcGhRTCBkb2N1bWVudCB0ZXh0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhbkdyYXBocWxNdXRhdGlvbnMoZG9jdW1lbnQ6IHN0cmluZyk6IEdyYXBocWxTY2FuIHtcbiAgY29uc3QgZmllbGRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzdGFjazogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGhhc011dGF0aW9uID0gZmFsc2U7XG4gIGxldCBjbGVhbiA9IHRydWU7XG4gIC8qKiBLZXl3b3JkIG9mIHRoZSBvcGVyYXRpb24gd2hvc2Ugc2VsZWN0aW9uIHNldCBoYXMgbm90IG9wZW5lZCB5ZXQuICovXG4gIGxldCBwZW5kaW5nS2luZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogS2luZCBvZiB0aGUgb3BlcmF0aW9uIHdob3NlIHNlbGVjdGlvbiBzZXQgaXMgY3VycmVudGx5IG9wZW4uICovXG4gIGxldCBvcGVuS2luZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgdG9rZW4gPSBcIlwiO1xuICBsZXQgYWZ0ZXJEaXJlY3RpdmVNYXJrID0gZmFsc2U7XG4gIGxldCBzYXdTZWxlY3Rpb25TZXQgPSBmYWxzZTtcblxuICBjb25zdCBmbHVzaCA9ICh0ZXJtaW5hdG9yOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBpZiAoIXRva2VuKSByZXR1cm47XG4gICAgY29uc3QgbmFtZSA9IHRva2VuO1xuICAgIHRva2VuID0gXCJcIjtcbiAgICBpZiAoYWZ0ZXJEaXJlY3RpdmVNYXJrKSB7XG4gICAgICBhZnRlckRpcmVjdGl2ZU1hcmsgPSBmYWxzZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHN0YWNrLmxlbmd0aCA9PT0gMCkge1xuICAgICAgaWYgKHBlbmRpbmdLaW5kICE9PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICAgIGNvbnN0IGtleXdvcmQgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gICAgICBpZiAobmFtZSA9PT0ga2V5d29yZCAmJiBHUkFQSFFMX09QRVJBVElPTl9LRVlXT1JEUy5oYXMoa2V5d29yZCkpIHtcbiAgICAgICAgcGVuZGluZ0tpbmQgPSBrZXl3b3JkO1xuICAgICAgICBpZiAoa2V5d29yZCA9PT0gXCJtdXRhdGlvblwiKSBoYXNNdXRhdGlvbiA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjbGVhbiA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoXG4gICAgICBzdGFjay5sZW5ndGggPT09IDEgJiYgb3BlbktpbmQgPT09IFwibXV0YXRpb25cIiAmJiB0ZXJtaW5hdG9yICE9PSBcIjpcIlxuICAgICkge1xuICAgICAgZmllbGRzLnB1c2gobmFtZSk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IG4gPSBkb2N1bWVudC5sZW5ndGg7XG4gIGxldCBpID0gMDtcbiAgd2hpbGUgKGkgPCBuKSB7XG4gICAgY29uc3QgY2ggPSBkb2N1bWVudFtpXSE7XG4gICAgaWYgKGlzR3JhcGhxbE5hbWVDaGFyKGNoKSkge1xuICAgICAgdG9rZW4gKz0gY2g7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZmx1c2goY2gpO1xuICAgIGlmIChjaCA9PT0gXCIjXCIpIHtcbiAgICAgIHdoaWxlIChpIDwgbiAmJiBkb2N1bWVudFtpXSAhPT0gXCJcXG5cIiAmJiBkb2N1bWVudFtpXSAhPT0gXCJcXHJcIikgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gJ1wiJykge1xuICAgICAgaWYgKGRvY3VtZW50LnN0YXJ0c1dpdGgoJ1wiXCJcIicsIGkpKSB7XG4gICAgICAgIGkgKz0gMztcbiAgICAgICAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAgICAgICB3aGlsZSAoaSA8IG4pIHtcbiAgICAgICAgICBpZiAoZG9jdW1lbnQuc3RhcnRzV2l0aCgnXFxcXFwiXCJcIicsIGkpKSBpICs9IDQ7XG4gICAgICAgICAgZWxzZSBpZiAoZG9jdW1lbnQuc3RhcnRzV2l0aCgnXCJcIlwiJywgaSkpIHtcbiAgICAgICAgICAgIGkgKz0gMztcbiAgICAgICAgICAgIGNsb3NlZCA9IHRydWU7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9IGVsc2UgaSsrO1xuICAgICAgICB9XG4gICAgICAgIGlmICghY2xvc2VkKSBjbGVhbiA9IGZhbHNlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGkrKztcbiAgICAgIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgICAgIHdoaWxlIChpIDwgbikge1xuICAgICAgICBjb25zdCBjID0gZG9jdW1lbnRbaV0hO1xuICAgICAgICBpZiAoYyA9PT0gXCJcXFxcXCIpIGkgKz0gMjtcbiAgICAgICAgZWxzZSBpZiAoYyA9PT0gJ1wiJykge1xuICAgICAgICAgIGkrKztcbiAgICAgICAgICBjbG9zZWQgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9IGVsc2UgaWYgKGMgPT09IFwiXFxuXCIgfHwgYyA9PT0gXCJcXHJcIikgYnJlYWs7XG4gICAgICAgIGVsc2UgaSsrO1xuICAgICAgfVxuICAgICAgaWYgKCFjbG9zZWQpIGNsZWFuID0gZmFsc2U7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNoID09PSBcIihcIiB8fCBjaCA9PT0gXCJ7XCIpIHtcbiAgICAgIGlmIChjaCA9PT0gXCJ7XCIpIHNhd1NlbGVjdGlvblNldCA9IHRydWU7XG4gICAgICBpZiAoY2ggPT09IFwie1wiICYmIHN0YWNrLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBvcGVuS2luZCA9IHBlbmRpbmdLaW5kID8/IFwicXVlcnlcIjtcbiAgICAgICAgcGVuZGluZ0tpbmQgPSB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgICBzdGFjay5wdXNoKGNoKTtcbiAgICB9IGVsc2UgaWYgKGNoID09PSBcIilcIiB8fCBjaCA9PT0gXCJ9XCIpIHtcbiAgICAgIGNvbnN0IG9wZW4gPSBzdGFjay5wb3AoKTtcbiAgICAgIGlmIChvcGVuICE9PSAoY2ggPT09IFwiKVwiID8gXCIoXCIgOiBcIntcIikpIHtcbiAgICAgICAgY2xlYW4gPSBmYWxzZTtcbiAgICAgICAgLy8gS2VlcCB0aGUgc3RhY2sgY29uc2lzdGVudDogYSBtaXNtYXRjaGVkIGNsb3NlciBpcyBub3QgY29uc3VtZWQuXG4gICAgICAgIGlmIChvcGVuICE9PSB1bmRlZmluZWQpIHN0YWNrLnB1c2gob3Blbik7XG4gICAgICB9IGVsc2UgaWYgKHN0YWNrLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBvcGVuS2luZCA9IHVuZGVmaW5lZDtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGNoID09PSBcIkBcIikge1xuICAgICAgLy8gQSBkaXJlY3RpdmUgbmFtZSBtdXN0IGZvbGxvdzsgb3RoZXJ3aXNlIHRoZSBtYXJrIHdvdWxkIHN3YWxsb3cgdGhlXG4gICAgICAvLyBuZXh0IHJlYWwgZmllbGQgbmFtZSAoSXNzdWUgIzM1NDkpLlxuICAgICAgaWYgKG5leHRTaWduaWZpY2FudElzTmFtZVN0YXJ0KGRvY3VtZW50LCBpICsgMSkpIHtcbiAgICAgICAgYWZ0ZXJEaXJlY3RpdmVNYXJrID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFmdGVyRGlyZWN0aXZlTWFyayA9IGZhbHNlO1xuICAgICAgICBjbGVhbiA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoY2ggPT09IFwiLlwiICYmIHN0YWNrLmxlbmd0aCA9PT0gMSAmJiBvcGVuS2luZCA9PT0gXCJtdXRhdGlvblwiKSB7XG4gICAgICAvLyBBIHNwcmVhZCBvciBpbmxpbmUgZnJhZ21lbnQgYXQgdGhlIG11dGF0aW9uIHJvb3QgY2FuIHNlbGVjdCBmdXJ0aGVyXG4gICAgICAvLyBtdXRhdGlvbiBmaWVsZHMgYmVsb3cgZGVwdGggMTsgcmVmdXNlIHRvIHZvdWNoIGZvciBpdCAoSXNzdWUgIzM1NDkpLlxuICAgICAgY2xlYW4gPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKCFHUkFQSFFMX1BVTkNUVUFUSU9OLmluY2x1ZGVzKGNoKSkge1xuICAgICAgY2xlYW4gPSBmYWxzZTtcbiAgICB9XG4gICAgaSsrO1xuICB9XG4gIGZsdXNoKFwiXCIpO1xuICAvLyBBbiBvcGVyYXRpb24ga2V5d29yZCBuZXZlciBmb2xsb3dlZCBieSBhIHNlbGVjdGlvbiBzZXQsIGFuIG9wZW4gYnJhY2tldFxuICAvLyBvciBhbiB1bnRlcm1pbmF0ZWQgc3RyaW5nIGFsbCBtZWFuIHRoZSB0ZXh0IHdhcyBub3QgdW5kZXJzdG9vZC5cbiAgaWYgKHN0YWNrLmxlbmd0aCA+IDAgfHwgcGVuZGluZ0tpbmQgIT09IHVuZGVmaW5lZCkgY2xlYW4gPSBmYWxzZTtcbiAgLy8gV2l0aCBubyBtdXRhdGlvbiBrZXl3b3JkIGFuZCBubyBge2AgYXQgYWxsLCBub3RoaW5nIGlzIGV4ZWN1dGFibGUgKEdpdEh1YlxuICAvLyByZWplY3RzIGl0KSwgc28gZ2FyYmFnZSBzdWNoIGFzIGBAL3RtcC9xLmdyYXBocWxgIGlzIGluZXJ0LCBub3QgYSBtdXRhdGlvbi5cbiAgaWYgKCFoYXNNdXRhdGlvbiAmJiAhc2F3U2VsZWN0aW9uU2V0KSBjbGVhbiA9IHRydWU7XG4gIHJldHVybiB7IGZpZWxkcywgaGFzTXV0YXRpb24sIGNsZWFuIH07XG59XG5cbi8qKlxuICogVG9wLWxldmVsIGZpZWxkIG5hbWVzIHNlbGVjdGVkIGJ5IHRoZSBtdXRhdGlvbiBvcGVyYXRpb25zIG9mIGEgR3JhcGhRTFxuICogZG9jdW1lbnQsIG9yIGBudWxsYCB3aGVuIHRoZSBkb2N1bWVudCBwcm92YWJseSBjb250YWlucyBubyBtdXRhdGlvblxuICogb3BlcmF0aW9uIChpLmUuIGl0IGlzIGEgcmVhZCkuXG4gKlxuICogSXNzdWUgIzM1NDk6IGV2ZXJ5IGBtdXRhdGlvbmAgb3BlcmF0aW9uIGlzIGNvbGxlY3RlZCwgbm90IGp1c3QgdGhlIGZpcnN0LFxuICogYW5kIGNvbW1lbnRzIGFuZCBzdHJpbmdzIGFyZSBza2lwcGVkIChzZWUge0BsaW5rIHNjYW5HcmFwaHFsTXV0YXRpb25zfSkuIEFcbiAqIGRvY3VtZW50IHRoYXQgZG9lcyBub3QgcGFyc2UgY2xlYW5seSBpcyBuZXZlciBgbnVsbGA6IGl0IGNhbm5vdCBiZSBwcm92ZW4gYVxuICogcmVhZCwgc28gdGhlIChwb3NzaWJseSBlbXB0eSkgZmllbGQgbGlzdCBpcyByZXR1cm5lZCBhbmQgY2FsbGVycyBtdXN0IHVzZVxuICoge0BsaW5rIHNjYW5HcmFwaHFsTXV0YXRpb25zfSB0byBsZWFybiB3aGV0aGVyIGl0IG1heSBiZSBzYW5jdGlvbmVkLlxuICpcbiAqIEBwYXJhbSBkb2N1bWVudCAtIFRoZSBHcmFwaFFMIGRvY3VtZW50IHRleHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBncmFwaHFsTXV0YXRpb25GaWVsZHMoZG9jdW1lbnQ6IHN0cmluZyk6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGNvbnN0IHNjYW4gPSBzY2FuR3JhcGhxbE11dGF0aW9ucyhkb2N1bWVudCk7XG4gIGlmIChzY2FuLmNsZWFuICYmICFzY2FuLmhhc011dGF0aW9uKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHNjYW4uZmllbGRzO1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IGEgYGdoIGFwaSBncmFwaHFsYCBpbnZvY2F0aW9uIChJc3N1ZSAjMzcwMykuXG4gKlxuICogYGdoIGFwaSBncmFwaHFsIC1mIHF1ZXJ5PeKApmAgYWx3YXlzIGxvb2tzIGxpa2UgYSBQT1NULCBzbyBldmVyeSBHcmFwaFFMXG4gKiByZWFkIHdhcyBwcmV2aW91c2x5IGpvdXJuYWxsZWQgYXMgYSBtdXRhdGlvbiB3aGlsZSBldmVyeSBHcmFwaFFMXG4gKiAqbXV0YXRpb24qIHBhc3NlZCB0aGUgYWxsb3dsaXN0IHVuY2hlY2tlZCAobm8gZGVyaXZhYmxlIHJlcG8pLiBSZWFkXG4gKiBkb2N1bWVudHMgbm93IGNsYXNzaWZ5IGFzIHJlYWRzLCBhbmQgYSBtdXRhdGlvbiBkb2N1bWVudCBpcyBhIG11dGF0aW9uXG4gKiB3aXRoIGFuIHVuZGV0ZXJtaW5hYmxlIHRhcmdldCB1bmxlc3MgaXQgaXMgb25lIG9mIHRoZSBzYW5jdGlvbmVkIG5vbi1yZXBvXG4gKiBtdXRhdGlvbnMuXG4gKlxuICogSXNzdWUgIzM5Mzc6IGEgZG9jdW1lbnQgYGdoYCByZWFkcyBmcm9tIGEgZmlsZSAoYC1GIHF1ZXJ5PUBxLmdyYXBocWxgLFxuICogYC0taW5wdXQgYm9keS5qc29uYCkgaXMgbm90IGluIHRoZSBhcmd2IGF0IGFsbCwgc28gaXQgY2FuIGJlIG5laXRoZXIgcmVhZFxuICogbm9yIGRpc21pc3NlZCBhcyBhIHJlYWQuIFN1Y2ggYSBjYWxsIGlzIHVuZGV0ZXJtaW5hYmxlIHJhdGhlciB0aGFuIGBudWxsYCxcbiAqIHdoaWNoIGlzIHdoYXQgZXZlcnkgZG93bnN0cmVhbSBjb250cm9sIHNob3J0LWNpcmN1aXRzIG9uLlxuICpcbiAqIElzc3VlICMzNTQ5OiBhIGRvY3VtZW50IGlzIHNhbmN0aW9uZWQgYXMgbm9uLXJlcG8gb25seSB3aGVuIGl0IHBhcnNlc1xuICogY2xlYW5seSBhbmQgZXZlcnkgZmllbGQgb2YgZXZlcnkgbXV0YXRpb24gb3BlcmF0aW9uIGlzIHNhbmN0aW9uZWQuIEFcbiAqIG1hbGZvcm1lZCBkb2N1bWVudCAodW50ZXJtaW5hdGVkIHN0cmluZywgdW5iYWxhbmNlZCBicmFja2V0cykgZmFsbHMgdG9cbiAqIGB1bmtub3duYCwgc2luY2UgdGhlIHBhcnNlciBjYW5ub3Qga25vdyB3aGF0IEdpdEh1YiB3b3VsZCBleGVjdXRlLlxuICpcbiAqIEBwYXJhbSBkb2N1bWVudHMgLSBWYWx1ZXMgb2YgYHF1ZXJ5PWAgZmllbGRzIG9uIHRoZSBjb21tYW5kIGxpbmUuXG4gKiBAcGFyYW0gdW5yZWFkYWJsZSAtIFdoZXRoZXIgcGFydCBvZiB0aGUgcmVxdWVzdCBib2R5IGlzIG9mZiB0aGUgY29tbWFuZCBsaW5lLlxuICovXG5mdW5jdGlvbiBjbGFzc2lmeUdoR3JhcGhxbChcbiAgZG9jdW1lbnRzOiBzdHJpbmdbXSxcbiAgdW5yZWFkYWJsZTogYm9vbGVhbixcbik6IE11dGF0aW9uSW5mbyB8IG51bGwge1xuICBjb25zdCBmaWVsZHM6IHN0cmluZ1tdID0gW107XG4gIGxldCBpc011dGF0aW9uID0gZmFsc2U7XG4gIGxldCBhbGxDbGVhbiA9IHRydWU7XG4gIGZvciAoY29uc3QgZG9jdW1lbnQgb2YgZG9jdW1lbnRzKSB7XG4gICAgY29uc3Qgc2NhbiA9IHNjYW5HcmFwaHFsTXV0YXRpb25zKGRvY3VtZW50KTtcbiAgICBpZiAoc2Nhbi5jbGVhbiAmJiAhc2Nhbi5oYXNNdXRhdGlvbikgY29udGludWU7XG4gICAgaXNNdXRhdGlvbiA9IHRydWU7XG4gICAgaWYgKCFzY2FuLmNsZWFuKSBhbGxDbGVhbiA9IGZhbHNlO1xuICAgIGZpZWxkcy5wdXNoKC4uLnNjYW4uZmllbGRzKTtcbiAgfVxuICBpZiAoIWlzTXV0YXRpb24pIHtcbiAgICBpZiAoIXVucmVhZGFibGUpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB7IHZlcmI6IFwiYXBpLWdyYXBocWwtdW5rbm93blwiLCB0YXJnZXQ6IFwiZ3JhcGhxbFwiLCBzY29wZTogXCJ1bmtub3duXCIgfTtcbiAgfVxuXG4gIGNvbnN0IHNhbmN0aW9uZWQgPSAhdW5yZWFkYWJsZSAmJiBhbGxDbGVhbiAmJiBmaWVsZHMubGVuZ3RoID4gMCAmJlxuICAgIGZpZWxkcy5ldmVyeSgoZikgPT4gR0hfU0FOQ1RJT05FRF9HUkFQSFFMX01VVEFUSU9OUy5oYXMoZi50b0xvd2VyQ2FzZSgpKSk7XG4gIHJldHVybiB7XG4gICAgdmVyYjogXCJhcGktZ3JhcGhxbC1tdXRhdGlvblwiLFxuICAgIHRhcmdldDogZmllbGRzLmxlbmd0aCA+IDAgPyBgZ3JhcGhxbDoke2ZpZWxkcy5qb2luKFwiLFwiKX1gIDogXCJncmFwaHFsXCIsXG4gICAgc2NvcGU6IHNhbmN0aW9uZWQgPyBcIm5vbi1yZXBvXCIgOiBcInVua25vd25cIixcbiAgfTtcbn1cblxuLyoqXG4gKiBUaGUgbGFzdCBgLS1ob3N0bmFtZWAgdmFsdWUgYW1vbmcgdGhlIHRva2VucyBiZWZvcmUgdGhlIGBhcGlgIHJvb3QsIG9yXG4gKiB1bmRlZmluZWQgd2hlbiB0aGVyZSBpcyBub25lLiBgZ2ggLS1ob3N0bmFtZT1ldmlsLmludmFsaWQgYXBpIOKApmAgc2VuZHMgdGhlXG4gKiByZXF1ZXN0IHRvIHRoYXQgaG9zdCBleGFjdGx5IGFzIHRoZSBhZnRlci1gYXBpYCBzcGVsbGluZyBkb2VzLiBBIGJhcmVcbiAqIGAtLWhvc3RuYW1lYCB3aXRoIG5vIHZhbHVlIHlpZWxkcyBcIlwiIHNvIGl0IGZhaWxzIGNsb3NlZC5cbiAqL1xuZnVuY3Rpb24gaG9zdG5hbWVCZWZvcmVSb290KFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgcm9vdElkeDogbnVtYmVyLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgbGV0IGhvc3Q6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCByb290SWR4OyBpKyspIHtcbiAgICBjb25zdCB0b2tlbiA9IGFyZ3NbaV0gPz8gXCJcIjtcbiAgICBpZiAodG9rZW4gPT09IFwiLS1ob3N0bmFtZVwiKSB7XG4gICAgICBob3N0ID0gYXJnc1tpICsgMV0gPz8gXCJcIjtcbiAgICAgIGkrKztcbiAgICB9IGVsc2UgaWYgKHRva2VuLnN0YXJ0c1dpdGgoXCItLWhvc3RuYW1lPVwiKSkge1xuICAgICAgaG9zdCA9IHRva2VuLnNsaWNlKFwiLS1ob3N0bmFtZT1cIi5sZW5ndGgpO1xuICAgIH0gZWxzZSBpZiAoR0hfVkFMVUVfRkxBR1MuaGFzKHRva2VuKSkge1xuICAgICAgaSsrO1xuICAgIH1cbiAgfVxuICByZXR1cm4gaG9zdDtcbn1cblxuLyoqXG4gKiBDbGFzc2lmeSBhIGBnaCBhcGlgIGludm9jYXRpb24uIE11dGF0aW5nIHdoZW4gdGhlIGVmZmVjdGl2ZSBIVFRQIG1ldGhvZFxuICogaXMgUE9TVC9QQVRDSC9QVVQvREVMRVRFIOKAlCBleHBsaWNpdCB2aWEgYC1YYC9gLS1tZXRob2RgLCBvciBpbXBsaWVkIGJ5IGFcbiAqIHJlcXVlc3QgYm9keTogYGdoYCBkZWZhdWx0cyB0byBQT1NUIHdoZW5ldmVyIGZpZWxkcyAoYC1mYC9gLUZgKSBvciBhblxuICogYC0taW5wdXRgIGJvZHkgYXJlIHNldC5cbiAqXG4gKiBJc3N1ZSAjMzkzNzogYC0taW5wdXRgIHdhcyBza2lwcGVkIGFzIGEgcGxhaW4gdmFsdWUgZmxhZywgc29cbiAqIGBnaCBhcGkgPGVuZHBvaW50PiAtLWlucHV0IC1gIOKAlCBhIFBPU1QgYXMgZmFyIGFzIGBnaGAgaXMgY29uY2VybmVkIOKAlFxuICogY2xhc3NpZmllZCBhcyBhIEdFVCByZWFkIGFuZCBieXBhc3NlZCB0aGUgam91cm5hbCwgdGhlIHdyaXRlLXJlcG8gYWxsb3dsaXN0XG4gKiBhbmQgdGhlIHJlc2VydmVkLWxhYmVsIGRlbnlsaXN0IGluIG9uZSBnby5cbiAqL1xuZnVuY3Rpb24gY2xhc3NpZnlHaEFwaShcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHN0YXJ0OiBudW1iZXIsXG4pOiBNdXRhdGlvbkluZm8gfCBudWxsIHtcbiAgbGV0IG1ldGhvZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgaGFzQm9keSA9IGZhbHNlO1xuICBsZXQgZW5kcG9pbnQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IHNraXBOZXh0ID0gZmFsc2U7XG4gIC8qKlxuICAgKiBMYXN0IGAtLWhvc3RuYW1lYCB2YWx1ZTsgYGdoYCBzZW5kcyB0aGUgcmVxdWVzdCB0byB0aGF0IGhvc3QgKElzc3VlICMxNDIwKS5cbiAgICogU2VlZGVkIGZyb20gdGhlIHRva2VucyBiZWZvcmUgdGhlIGBhcGlgIHJvb3Q6IGBnaGAgaG9ub3VycyB0aGUgZmxhZyB0aGVyZVxuICAgKiB0b28sIGFuZCB0aGUgdG9rZW5zIGFmdGVyIGl0IHN0aWxsIHdpbiAocGZsYWcncyBsYXN0LW9jY3VycmVuY2UgcnVsZSkuXG4gICAqL1xuICBsZXQgaG9zdG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCA9IGhvc3RuYW1lQmVmb3JlUm9vdChhcmdzLCBzdGFydCAtIDEpO1xuICAvKiogQSBib2R5IGNvbXBvbmVudCB0aGUgYXJndiBjYW5ub3Qgc2hvdzogYC0taW5wdXRgLCBvciBhIGBAZmlsZWAgdmFsdWUuICovXG4gIGxldCB1bnJlYWRhYmxlQm9keSA9IGZhbHNlO1xuICAvKiogUGF0aCBvZiBhIHJlYWRhYmxlIGAtLWlucHV0IDxmaWxlPmAgYm9keSAoSXNzdWUgIzkxKTsgYC1gIHN0YXlzIGFic2VudC4gKi9cbiAgbGV0IGJvZHlGaWxlUGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb25zdCBxdWVyeURvY3VtZW50czogc3RyaW5nW10gPSBbXTtcblxuICAvKipcbiAgICogUmVjb3JkIGEgYGtleT12YWx1ZWAgZmllbGQuXG4gICAqXG4gICAqIGBnaGAgcmVhZHMgYSBmaWVsZCB2YWx1ZSBiZWdpbm5pbmcgd2l0aCBgQGAgZnJvbSB0aGF0IGZpbGUgKGBALWAgZnJvbVxuICAgKiBzdGRpbiksIHNvIGl0IG5ldmVyIHJlYWNoZXMgdGhlIGFyZ3Yg4oCUIHRoZSBsYWJlbC9sYWJlbC1zY2FuIGFuZCBHcmFwaFFMXG4gICAqIGNoZWNrcyBjYW5ub3Qgc2VlIHdoYXQgaXQgY2FycmllcywgYW5kIHRoZSBjYWxsIG11c3QgZmFpbCBjbG9zZWQuIFZlcmlmaWVkXG4gICAqIGFnYWluc3QgZ2ggMi45Ny4wOiBvbmx5IGAtRmAvYC0tZmllbGRgIGV4cGFuZCBhIGxlYWRpbmcgYEBgIChpdHMgaGVscCBzYXlzXG4gICAqIGB1c2UgXCJAPHBhdGg+XCIgb3IgXCJALVwiIHRvIHJlYWQgdmFsdWUgZnJvbSBmaWxlIG9yIHN0ZGluYCk7IGAtZmAvXG4gICAqIGAtLXJhdy1maWVsZGAgYWRkIGEgKnN0YXRpYyBzdHJpbmcqIGFuZCBuZXZlciBleHBhbmQgYEBgIChJc3N1ZSAjOTMpLiBUaGVcbiAgICogY2FsbGVyIHBhc3NlcyBgZXhwYW5kc0F0RmlsZWAgc28gYSBsaXRlcmFsIGBAbmFtZWAgb24gYC1mYCBpcyBub3QgbWlzdGFrZW5cbiAgICogZm9yIGEgZmlsZS5cbiAgICovXG4gIGNvbnN0IG5vdGVGaWVsZCA9IChcbiAgICB2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgIGV4cGFuZHNBdEZpbGU6IGJvb2xlYW4sXG4gICk6IHZvaWQgPT4ge1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgY29uc3QgZXEgPSB2YWx1ZS5pbmRleE9mKFwiPVwiKTtcbiAgICBpZiAoZXEgPCAwKSByZXR1cm47XG4gICAgaWYgKGV4cGFuZHNBdEZpbGUgJiYgdmFsdWUuc2xpY2UoZXEgKyAxKS5zdGFydHNXaXRoKFwiQFwiKSkge1xuICAgICAgdW5yZWFkYWJsZUJvZHkgPSB0cnVlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICAvLyBJc3N1ZSAjMzU2NjogZ2ggZmlsbHMgcGxhY2Vob2xkZXJzIGluIGEgbWFnaWMgZmllbGQgYWZ0ZXIgdGhpcyByZWFkLCBzb1xuICAgIC8vIHRoZSB0ZXh0IGNsYXNzaWZpZWQgaXMgbm90IHRoZSB0ZXh0IHNlbnQg4oCUIGZhaWwgY2xvc2VkLlxuICAgIGlmIChcbiAgICAgIGV4cGFuZHNBdEZpbGUgJiYgaXNQbGFjZWhvbGRlclNlbnNpdGl2ZUtleSh2YWx1ZS5zbGljZSgwLCBlcSkpICYmXG4gICAgICBHSF9GSUVMRF9QTEFDRUhPTERFUi50ZXN0KHZhbHVlLnNsaWNlKGVxICsgMSkpXG4gICAgKSB7XG4gICAgICB1bnJlYWRhYmxlQm9keSA9IHRydWU7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh2YWx1ZS5zbGljZSgwLCBlcSkgPT09IFwicXVlcnlcIikge1xuICAgICAgcXVlcnlEb2N1bWVudHMucHVzaCh2YWx1ZS5zbGljZShlcSArIDEpKTtcbiAgICB9XG4gIH07XG5cbiAgZm9yIChsZXQgaSA9IHN0YXJ0OyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRva2VuID0gYXJnc1tpXTtcbiAgICBpZiAodG9rZW4gPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgaWYgKHNraXBOZXh0KSB7XG4gICAgICBza2lwTmV4dCA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0b2tlbiA9PT0gXCItWFwiIHx8IHRva2VuID09PSBcIi0tbWV0aG9kXCIpIHtcbiAgICAgIG1ldGhvZCA9IGFyZ3NbaSArIDFdO1xuICAgICAgc2tpcE5leHQgPSB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0b2tlbi5zdGFydHNXaXRoKFwiLS1tZXRob2Q9XCIpKSB7XG4gICAgICBtZXRob2QgPSB0b2tlbi5zbGljZShcIi0tbWV0aG9kPVwiLmxlbmd0aCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgdG9rZW4gPT09IFwiLWZcIiB8fCB0b2tlbiA9PT0gXCItRlwiIHx8IHRva2VuID09PSBcIi0tZmllbGRcIiB8fFxuICAgICAgdG9rZW4gPT09IFwiLS1yYXctZmllbGRcIlxuICAgICkge1xuICAgICAgaGFzQm9keSA9IHRydWU7XG4gICAgICBub3RlRmllbGQoYXJnc1tpICsgMV0sIHRva2VuID09PSBcIi1GXCIgfHwgdG9rZW4gPT09IFwiLS1maWVsZFwiKTtcbiAgICAgIHNraXBOZXh0ID0gdHJ1ZTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0tZmllbGQ9XCIpKSB7XG4gICAgICBoYXNCb2R5ID0gdHJ1ZTtcbiAgICAgIG5vdGVGaWVsZCh0b2tlbi5zbGljZShcIi0tZmllbGQ9XCIubGVuZ3RoKSwgdHJ1ZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRva2VuLnN0YXJ0c1dpdGgoXCItLXJhdy1maWVsZD1cIikpIHtcbiAgICAgIGhhc0JvZHkgPSB0cnVlO1xuICAgICAgbm90ZUZpZWxkKHRva2VuLnNsaWNlKFwiLS1yYXctZmllbGQ9XCIubGVuZ3RoKSwgZmFsc2UpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0b2tlbiA9PT0gXCItLWlucHV0XCIpIHtcbiAgICAgIGhhc0JvZHkgPSB0cnVlO1xuICAgICAgdW5yZWFkYWJsZUJvZHkgPSB0cnVlO1xuICAgICAgc2tpcE5leHQgPSB0cnVlO1xuICAgICAgY29uc3QgcGF0aCA9IGFyZ3NbaSArIDFdO1xuICAgICAgaWYgKHBhdGggIT09IHVuZGVmaW5lZCAmJiBwYXRoICE9PSBcIi1cIikgYm9keUZpbGVQYXRoID0gcGF0aDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0taW5wdXQ9XCIpKSB7XG4gICAgICBoYXNCb2R5ID0gdHJ1ZTtcbiAgICAgIHVucmVhZGFibGVCb2R5ID0gdHJ1ZTtcbiAgICAgIGNvbnN0IHBhdGggPSB0b2tlbi5zbGljZShcIi0taW5wdXQ9XCIubGVuZ3RoKTtcbiAgICAgIGlmIChwYXRoICE9PSBcIi1cIikgYm9keUZpbGVQYXRoID0gcGF0aDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBwZmxhZzogYSByZXBlYXRlZCBzdHJpbmcgZmxhZyByZXNvbHZlcyB0byBpdHMgbGFzdCBvY2N1cnJlbmNlLlxuICAgIGlmICh0b2tlbiA9PT0gXCItLWhvc3RuYW1lXCIpIHtcbiAgICAgIGhvc3RuYW1lID0gYXJnc1tpICsgMV0gPz8gXCJcIjtcbiAgICAgIHNraXBOZXh0ID0gdHJ1ZTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0taG9zdG5hbWU9XCIpKSB7XG4gICAgICBob3N0bmFtZSA9IHRva2VuLnNsaWNlKFwiLS1ob3N0bmFtZT1cIi5sZW5ndGgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChHSF9WQUxVRV9GTEFHUy5oYXModG9rZW4pKSB7XG4gICAgICBza2lwTmV4dCA9IHRydWU7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRva2VuLnN0YXJ0c1dpdGgoXCItXCIpKSBjb250aW51ZTtcbiAgICBpZiAoZW5kcG9pbnQgPT09IHVuZGVmaW5lZCkgZW5kcG9pbnQgPSB0b2tlbjtcbiAgfVxuXG4gIC8vIElzc3VlICMxNDIwOiBhIHJlcXVlc3QgYm91bmQgZm9yIGEgaG9zdCBvdGhlciB0aGFuIGdpdGh1Yi5jb20gY2FycmllcyBpdHNcbiAgLy8gZmllbGQgYW5kIGJvZHkgZGF0YSB0aGVyZSwgc28gdGhlIHBhdGgncyByZXBvIHNheXMgbm90aGluZyBhYm91dCB3aGVyZSB0aGVcbiAgLy8gd3JpdGUgbGFuZHMuIERlcml2ZSBubyByZXBvIGFuZCBmYWlsIGNsb3NlZCwgYXMgZm9yIGFuIGFic29sdXRlIGVuZHBvaW50XG4gIC8vIG9uIGFub3RoZXIgaG9zdC4gQSBgLS1ob3N0bmFtZWAgd2l0aCBubyB2YWx1ZSBpcyB1bnVzYWJsZSBhbmQgZmFpbHMgY2xvc2VkLlxuICBjb25zdCBmb3JlaWduSG9zdCA9IGhvc3RuYW1lICE9PSB1bmRlZmluZWQgJiZcbiAgICBob3N0bmFtZS50b0xvd2VyQ2FzZSgpICE9PSBHSVRIVUJfSE9TVDtcblxuICBpZiAoZW5kcG9pbnQgIT09IHVuZGVmaW5lZCAmJiBpc0dyYXBocWxFbmRwb2ludChlbmRwb2ludCkpIHtcbiAgICBjb25zdCBpbmZvID0gY2xhc3NpZnlHaEdyYXBocWwocXVlcnlEb2N1bWVudHMsIHVucmVhZGFibGVCb2R5KTtcbiAgICByZXR1cm4gaW5mbyAmJiBmb3JlaWduSG9zdCA/IHsgLi4uaW5mbywgc2NvcGU6IFwidW5rbm93blwiIH0gOiBpbmZvO1xuICB9XG5cbiAgY29uc3QgZWZmZWN0aXZlTWV0aG9kID0gKG1ldGhvZCA/PyAoaGFzQm9keSA/IFwiUE9TVFwiIDogXCJHRVRcIikpLnRvVXBwZXJDYXNlKCk7XG4gIGlmICghW1wiUE9TVFwiLCBcIlBBVENIXCIsIFwiUFVUXCIsIFwiREVMRVRFXCJdLmluY2x1ZGVzKGVmZmVjdGl2ZU1ldGhvZCkpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCByZXBvID0gZW5kcG9pbnQgJiYgIWZvcmVpZ25Ib3N0XG4gICAgPyByZXBvRnJvbUVuZHBvaW50KGVuZHBvaW50KVxuICAgIDogdW5kZWZpbmVkO1xuICAvLyBJc3N1ZSAjMzcwMzogYW4gZW5kcG9pbnQgdGhhdCBuYW1lcyBubyByZXBvIChgZ2lzdHNgLCBgb3Jncy/igKZgLCBgdXNlci/igKZgKVxuICAvLyBjYW5ub3QgYmUgY2hlY2tlZCBhZ2FpbnN0IHRoZSBhbGxvd2xpc3QsIHNvIGl0IGZhaWxzIGNsb3NlZC4gVGhlXG4gIC8vIGByZXBvcy97b3duZXJ9L3tyZXBvfS/igKZgIHBsYWNlaG9sZGVyIGZvcm0gaXMgcmVzb2x2ZWQgYnkgYGdoYCBmcm9tIHRoZVxuICAvLyBjdXJyZW50IGNsb25lIGFuZCBpcyB0aGVyZWZvcmUgY3dkLXNjb3BlZC5cbiAgLy8gSXNzdWUgIzE0MjA6IHRoZSBwbGFjZWhvbGRlciBicmFuY2ggaXMgaG9zdC1jaGVja2VkIHRvby4gYGdoYCByZXNvbHZlc1xuICAvLyBgcmVwb3Mve293bmVyfS97cmVwb30v4oCmYCBmcm9tIHRoZSBjdXJyZW50IGNsb25lLCB3aGljaCBpcyB3aHkgaXQgaXNcbiAgLy8gY3dkLXNjb3BlZCBhbmQgbmVlZHMgbm8gYWxsb3dsaXN0IGNvbXBhcmlzb24g4oCUIGJ1dCB0aGF0IHJlYXNvbmluZyBob2xkc1xuICAvLyBvbmx5IGZvciBhIHJlcXVlc3QgYWN0dWFsbHkgYm91bmQgZm9yIEdpdEh1YidzIEFQSS4gUG9pbnRlZCBlbHNld2hlcmUsXG4gIC8vIHRoZSBzYW1lIHBhdGggaXMgYSB3cml0ZSB0byBzb21lYm9keSBlbHNlJ3MgaG9zdC5cbiAgY29uc3QgcGF0aCA9IGVuZHBvaW50ICYmICFmb3JlaWduSG9zdCA/IGVuZHBvaW50UGF0aChlbmRwb2ludCkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHNjb3BlOiBNdXRhdGlvblNjb3BlID0gcmVwb1xuICAgID8gXCJleHBsaWNpdFwiXG4gICAgOiAoIWZvcmVpZ25Ib3N0ICYmIHBhdGggIT09IHVuZGVmaW5lZCAmJiBpc1BsYWNlaG9sZGVyUmVwb0VuZHBvaW50KHBhdGgpKVxuICAgID8gXCJjd2RcIlxuICAgIDogXCJ1bmtub3duXCI7XG4gIHJldHVybiB7XG4gICAgdmVyYjogYGFwaS0ke2VmZmVjdGl2ZU1ldGhvZC50b0xvd2VyQ2FzZSgpfWAsXG4gICAgLi4uKHJlcG8gPyB7IHJlcG8gfSA6IHt9KSxcbiAgICAuLi4oZW5kcG9pbnQgPyB7IHRhcmdldDogZW5kcG9pbnQgfSA6IHt9KSxcbiAgICBzY29wZSxcbiAgICAvLyBJc3N1ZSAjMTE6IHN1cmZhY2UgYSBib2R5IHRoZSBhcmd2IGNhbm5vdCBzaG93LiBMZWZ0IGFic2VudCDigJQgbmV2ZXJcbiAgICAvLyBgZmFsc2VgIOKAlCB3aGVuIHRoZSBib2R5IGlzIGZ1bGx5IGFyZ3YtdmlzaWJsZS5cbiAgICAuLi4odW5yZWFkYWJsZUJvZHkgPyB7IHVucmVhZGFibGVCb2R5OiB0cnVlIH0gOiB7fSksXG4gICAgLi4uKGJvZHlGaWxlUGF0aCAhPT0gdW5kZWZpbmVkID8geyBib2R5RmlsZVBhdGggfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBDbGFzc2lmeSBhIGBnaGAgYXJndW1lbnQgbGlzdCBhcyBhIEdpdEh1YiBtdXRhdGlvbiwgb3IgYG51bGxgIGZvciByZWFkcy5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGFzc2lmeUdoTXV0YXRpb24oXG4gIHJhd0FyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogTXV0YXRpb25JbmZvIHwgbnVsbCB7XG4gIC8vIElzc3VlICMzODY3OiBwZmxhZydzIGF0dGFjaGVkIHNob3J0aGFuZCBzcGVsbGluZ3MgKGAtUm93bmVyL3JlcG9gLFxuICAvLyBgLVg9UE9TVGApIGFyZSByZXdyaXR0ZW4gdG8gdGhlaXIgc2VwYXJhdGVkIGZvcm0gZmlyc3QsIHNvIGV2ZXJ5IG1hdGNoXG4gIC8vIGJlbG93IHNlZXMgdGhlIG9uZSBzcGVsbGluZy4gSXNzdWUgIzM1Njg6IGEgYGdoIGFwaWAgY2FsbCBpcyBmdXJ0aGVyXG4gIC8vIHJld3JpdHRlbiB0byBpdHMgY2Fub25pY2FsIGZvcm0g4oCUIGZsYWdzIGFmdGVyIHRoZSByb290LCBhbiBleHBsaWNpdFxuICAvLyBtZXRob2QsIHRoZSBlbmRwb2ludCBhcyBHaXRIdWIgcm91dGVzIGl0IOKAlCBzbyBubyBlcXVpdmFsZW50IHNwZWxsaW5nXG4gIC8vIGNsYXNzaWZpZXMgZGlmZmVyZW50bHkuXG4gIGNvbnN0IGFyZ3MgPSBjYW5vbmljYWxpc2VHaEFyZ3MocmF3QXJncyk7XG4gIGNvbnN0IHJvb3RJZHggPSBmaXJzdE5vbkZsYWcoYXJncywgMCk7XG4gIGNvbnN0IHJvb3QgPSBhcmdzW3Jvb3RJZHhdO1xuICBpZiAoIXJvb3QpIHJldHVybiBudWxsO1xuXG4gIGlmIChyb290ID09PSBcImFwaVwiKSB7XG4gICAgcmV0dXJuIGNsYXNzaWZ5R2hBcGkoYXJncywgcm9vdElkeCArIDEpO1xuICB9XG5cbiAgY29uc3QgdmVyYklkeCA9IGZpcnN0Tm9uRmxhZyhhcmdzLCByb290SWR4ICsgMSk7XG4gIGNvbnN0IHZlcmIgPSBhcmdzW3ZlcmJJZHhdO1xuICBpZiAoIXZlcmIpIHJldHVybiBudWxsO1xuXG4gIC8vIElzc3VlICMxMzk2OiBgZ2ggZXh0ZW5zaW9uYCBjaGFuZ2VzIHRoZSBsb2NhbCB0b29sLCBuZXZlciBhIHJlcG9zaXRvcnksXG4gIC8vIHNvIGl0IGlzIGNsYXNzaWZpZWQgZXhwbGljaXRseSByYXRoZXIgdGhhbiBsZWZ0IHRvIHRoZSB0YWJsZXMgYmVsb3cg4oCUXG4gIC8vIGpvdXJuYWxsZWQgYXMgYSBgbm9uLXJlcG9gIG11dGF0aW9uLCBhbmQgbmV2ZXIgcmVmdXNlZCBhcyBhblxuICAvLyB1bmRldGVybWluYWJsZSByZXBvIHdyaXRlLlxuICBpZiAoR0hfRVhURU5TSU9OX1JPT1RTLmhhcyhyb290LnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgaWYgKCFHSF9FWFRFTlNJT05fTE9DQUxfVkVSQlMuaGFzKHZlcmIudG9Mb3dlckNhc2UoKSkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGV4dFRhcmdldCA9IGFyZ3NbdmVyYklkeCArIDFdO1xuICAgIHJldHVybiB7XG4gICAgICB2ZXJiOiBgZXh0ZW5zaW9uLSR7dmVyYi50b0xvd2VyQ2FzZSgpfWAsXG4gICAgICAuLi4oZXh0VGFyZ2V0ICYmICFleHRUYXJnZXQuc3RhcnRzV2l0aChcIi1cIikgPyB7IHRhcmdldDogZXh0VGFyZ2V0IH0gOiB7fSksXG4gICAgICBzY29wZTogXCJub24tcmVwb1wiLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBtdXRhdGluZ1ZlcmJzID0gR0hfTVVUQVRJTkdfVkVSQlNbcm9vdF07XG4gIGNvbnN0IG11dGF0aW5nID0gbXV0YXRpbmdWZXJic1xuICAgID8gbXV0YXRpbmdWZXJicy5oYXModmVyYilcbiAgICA6IEdIX0dFTkVSSUNfTVVUQVRJTkdfVkVSQlMuaGFzKHZlcmIpO1xuICBpZiAoIW11dGF0aW5nKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCByZXBvRmxhZyA9IGV4dHJhY3RSZXBvRmxhZyhhcmdzKTtcbiAgLy8gVGhlIHRhcmdldCAoaXNzdWUvUFIgbnVtYmVyKSBpcyB0aGUgcG9zaXRpb25hbCBpbW1lZGlhdGVseSBmb2xsb3dpbmdcbiAgLy8gdGhlIHZlcmIgaW4gdGhlIGNvbW1vbiBzaGFwZSBgZ2ggPHJvb3Q+IDx2ZXJiPiA8bnVtYmVyPiBbZmxhZ3NdYC5cbiAgY29uc3QgdGFyZ2V0Q2FuZGlkYXRlID0gYXJnc1t2ZXJiSWR4ICsgMV07XG4gIGNvbnN0IHRhcmdldCA9IHRhcmdldENhbmRpZGF0ZSAmJiAhdGFyZ2V0Q2FuZGlkYXRlLnN0YXJ0c1dpdGgoXCItXCIpXG4gICAgPyB0YXJnZXRDYW5kaWRhdGVcbiAgICA6IHVuZGVmaW5lZDtcblxuICAvLyBJc3N1ZSAjMzcwMzogYGdoIHJlcG8gPHZlcmI+IG93bmVyL25hbWVgIG5hbWVzIGl0cyB0YXJnZXQgcG9zaXRpb25hbGx5XG4gIC8vIHJhdGhlciB0aGFuIHZpYSBgLVJgLCBzbyBob25vdXIgdGhhdCBmb3JtIHRvby5cbiAgY29uc3QgcG9zaXRpb25hbFJlcG8gPSByb290ID09PSBcInJlcG9cIiAmJiB0YXJnZXQ/LmluY2x1ZGVzKFwiL1wiKVxuICAgID8gdGFyZ2V0XG4gICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJlcG8gPSByZXBvRmxhZyA/PyBwb3NpdGlvbmFsUmVwbztcblxuICAvLyBGYWlsIGNsb3NlZCB1bmxlc3MgdGhlIHRhcmdldCBpcyBlaXRoZXIgZXhwbGljaXQgb3IgcmVzb2x2ZWQgYnkgYGdoYFxuICAvLyBmcm9tIHRoZSBjdXJyZW50IGNsb25lLiBBIGJhcmUgYGdoIHJlcG8gY3JlYXRlIDxuYW1lPmAgbmFtZXMgYSByZXBvIGluXG4gIC8vIHRoZSBhdXRoZW50aWNhdGVkIGFjY291bnQncyBuYW1lc3BhY2UgdGhhdCBjYW5ub3QgYmUgdmVyaWZpZWQsIHNvIGl0IGlzXG4gIC8vIHVuZGV0ZXJtaW5hYmxlIHJhdGhlciB0aGFuIGN3ZC1zY29wZWQuXG4gIGNvbnN0IGN3ZFJlc29sdmFibGUgPSBHSF9DV0RfU0NPUEVEX1JPT1RTLmhhcyhyb290KSAmJlxuICAgICEocm9vdCA9PT0gXCJyZXBvXCIgJiYgdmVyYiA9PT0gXCJjcmVhdGVcIik7XG4gIGNvbnN0IHNjb3BlOiBNdXRhdGlvblNjb3BlID0gcmVwb1xuICAgID8gXCJleHBsaWNpdFwiXG4gICAgOiBjd2RSZXNvbHZhYmxlXG4gICAgPyBcImN3ZFwiXG4gICAgOiBcInVua25vd25cIjtcblxuICByZXR1cm4ge1xuICAgIHZlcmI6IGAke3Jvb3R9LSR7dmVyYn1gLFxuICAgIC4uLihyZXBvID8geyByZXBvIH0gOiB7fSksXG4gICAgLi4uKHRhcmdldCA/IHsgdGFyZ2V0IH0gOiB7fSksXG4gICAgc2NvcGUsXG4gIH07XG59XG5cbi8qKlxuICogYGdpdGAgZ2xvYmFscyB3aG9zZSBmb2xsb3dpbmcgdG9rZW4gaXMgYSB2YWx1ZSwgbm90IHRoZSBzdWItY29tbWFuZC5cbiAqXG4gKiBJc3N1ZSAjMzk1MDogdGhlc2Ugd2VyZSBwcmV2aW91c2x5IG1hdGNoZWQgYWdhaW5zdCB7QGxpbmsgR0hfVkFMVUVfRkxBR1N9LFxuICogd2hpY2ggaG9sZHMgbm9uZSBvZiB0aGVtLCBzbyBgZ2l0IC1DIC9yZXBvIHB1c2hgIHNjYW5uZWQgb250byBgL3JlcG9gIGFuZFxuICogdGhlIHB1c2ggd2FzIG5ldmVyIGpvdXJuYWxsZWQuXG4gKi9cbmNvbnN0IEdJVF9WQUxVRV9GTEFHUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcIi1DXCIsXG4gIFwiLWNcIixcbiAgXCItLWdpdC1kaXJcIixcbiAgXCItLXdvcmstdHJlZVwiLFxuICBcIi0tZXhlYy1wYXRoXCIsXG4gIFwiLS1uYW1lc3BhY2VcIixcbiAgXCItLWNvbmZpZy1lbnZcIixcbiAgXCItLXN1cGVyLXByZWZpeFwiLFxuXSk7XG5cbi8qKiBgZ2l0YCBnbG9iYWxzIHRoYXQgc3RhbmQgYWxvbmUg4oCUIHRoZXkgbmV2ZXIgY29uc3VtZSBhIGZvbGxvd2luZyB0b2tlbi4gKi9cbmNvbnN0IEdJVF9CT09MRUFOX0dMT0JBTFM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCItcFwiLFxuICBcIi1QXCIsXG4gIFwiLS1wYWdpbmF0ZVwiLFxuICBcIi0tbm8tcGFnZXJcIixcbiAgXCItLWJhcmVcIixcbiAgXCItLW5vLXJlcGxhY2Utb2JqZWN0c1wiLFxuICBcIi0tbGl0ZXJhbC1wYXRoc3BlY3NcIixcbiAgXCItLWdsb2ItcGF0aHNwZWNzXCIsXG4gIFwiLS1ub2dsb2ItcGF0aHNwZWNzXCIsXG4gIFwiLS1pY2FzZS1wYXRoc3BlY3NcIixcbiAgXCItLW5vLW9wdGlvbmFsLWxvY2tzXCIsXG4gIFwiLS1uby1sYXp5LWZldGNoXCIsXG4gIFwiLS1uby1hZHZpY2VcIixcbiAgXCItLWh0bWwtcGF0aFwiLFxuICBcIi0tbWFuLXBhdGhcIixcbiAgXCItLWluZm8tcGF0aFwiLFxuICBcIi12XCIsXG4gIFwiLS12ZXJzaW9uXCIsXG4gIFwiLWhcIixcbiAgXCItLWhlbHBcIixcbl0pO1xuXG4vKiogV2hldGhlciBhIGxlYWRpbmcgYGdpdGAgdG9rZW4gaXMgYSBnbG9iYWwgd2hvc2UgYXJpdHkgd2Uga25vdy4gKi9cbmZ1bmN0aW9uIGlzS25vd25HaXRHbG9iYWwodG9rZW46IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoR0lUX1ZBTFVFX0ZMQUdTLmhhcyh0b2tlbikgfHwgR0lUX0JPT0xFQU5fR0xPQkFMUy5oYXModG9rZW4pKSByZXR1cm4gdHJ1ZTtcbiAgLy8gQXR0YWNoZWQgc3BlbGxpbmdzIGNhcnJ5IHRoZWlyIG93biB2YWx1ZTogYC0tZ2l0LWRpcj0vcmVwby8uZ2l0YCwgYC1DL3JlcG9gLlxuICBjb25zdCBhdHRhY2hlZExvbmcgPSB0b2tlbi5tYXRjaCgvXigtLVthLXotXSspPS8pO1xuICBpZiAoYXR0YWNoZWRMb25nICYmIEdJVF9WQUxVRV9GTEFHUy5oYXMoYXR0YWNoZWRMb25nWzFdISkpIHJldHVybiB0cnVlO1xuICByZXR1cm4gL14tW0NjXS4vLnRlc3QodG9rZW4pO1xufVxuXG4vKiogV2hlcmUgdGhlIGBnaXRgIHN1Yi1jb21tYW5kIHNpdHMsIGFuZCB3aGV0aGVyIHRoZSBzY2FuIGNhbiBiZSB0cnVzdGVkLiAqL1xuaW50ZXJmYWNlIEdpdFN1YmNvbW1hbmRTY2FuIHtcbiAgLyoqIEluZGV4IG9mIHRoZSBmaXJzdCB0b2tlbiB0YWtlbiB0byBiZSB0aGUgc3ViLWNvbW1hbmQuICovXG4gIGluZGV4OiBudW1iZXI7XG4gIC8qKiBBbiB1bnJlY29nbmlzZWQgZ2xvYmFsIHdhcyBwYXNzZWQsIHNvIGBpbmRleGAgbWF5IG92ZXJzaG9vdC4gKi9cbiAgYW1iaWd1b3VzOiBib29sZWFuO1xufVxuXG5mdW5jdGlvbiBzY2FuR2l0U3ViY29tbWFuZChhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IEdpdFN1YmNvbW1hbmRTY2FuIHtcbiAgbGV0IGluZGV4ID0gMDtcbiAgbGV0IGFtYmlndW91cyA9IGZhbHNlO1xuICB3aGlsZSAoYXJnc1tpbmRleF0/LnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgY29uc3QgdG9rZW4gPSBhcmdzW2luZGV4XSE7XG4gICAgaWYgKEdJVF9WQUxVRV9GTEFHUy5oYXModG9rZW4pKSB7XG4gICAgICBpbmRleCArPSAyO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghaXNLbm93bkdpdEdsb2JhbCh0b2tlbikpIGFtYmlndW91cyA9IHRydWU7XG4gICAgaW5kZXggKz0gMTtcbiAgfVxuICByZXR1cm4geyBpbmRleCwgYW1iaWd1b3VzIH07XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgYSBgZ2l0YCBhcmd1bWVudCBsaXN0IGFzIGEgR2l0SHViIG11dGF0aW9uLCBvciBgbnVsbGAuXG4gKlxuICogT25seSBgZ2l0IHB1c2hgIG11dGF0ZXMgcmVtb3RlIEdpdEh1YiBzdGF0ZTsgZXZlcnkgb3RoZXIgZ2l0XG4gKiBzdWItY29tbWFuZCBpcyBsb2NhbCBhbmQgaXMgbm90IGpvdXJuYWxsZWQuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBBcmd1bWVudHMgcGFzc2VkIHRvIHRoZSBgZ2l0YCBiaW5hcnlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYXNzaWZ5R2l0TXV0YXRpb24oXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogTXV0YXRpb25JbmZvIHwgbnVsbCB7XG4gIGNvbnN0IHsgaW5kZXgsIGFtYmlndW91cyB9ID0gc2NhbkdpdFN1YmNvbW1hbmQoYXJncyk7XG4gIC8vIElzc3VlICMzOTUwOiBhbiB1bnJlY29nbmlzZWQgZ2xvYmFsIG1heSBjYXJyeSBhIHZhbHVlIHRoZSBzY2FuIGRpZCBub3RcbiAgLy8gc2tpcCwgc28gdGhlIHN1Yi1jb21tYW5kIHBvc2l0aW9uIGNhbm5vdCBiZSB0cnVzdGVkLiBGYWlsIGNsb3NlZCDigJQgYSBwdXNoXG4gIC8vIGFueXdoZXJlIGluIHRoZSB2ZWN0b3IgaXMgam91cm5hbGxlZCByYXRoZXIgdGhhbiBzaWxlbnRseSBkcm9wcGVkLlxuICBjb25zdCBzdWJJZHggPSBhcmdzW2luZGV4XSA9PT0gXCJwdXNoXCJcbiAgICA/IGluZGV4XG4gICAgOiBhbWJpZ3VvdXNcbiAgICA/IGFyZ3MuaW5kZXhPZihcInB1c2hcIilcbiAgICA6IC0xO1xuICBpZiAoc3ViSWR4IDwgMCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcG9zaXRpb25hbHMgPSBhcmdzLnNsaWNlKHN1YklkeCArIDEpLmZpbHRlcigoYSkgPT4gIWEuc3RhcnRzV2l0aChcIi1cIikpO1xuICBjb25zdCB0YXJnZXQgPSBwb3NpdGlvbmFsc1twb3NpdGlvbmFscy5sZW5ndGggLSAxXTtcbiAgLy8gQSBwdXNoIGFsd2F5cyB0YXJnZXRzIGEgcmVtb3RlIG9mIHRoZSBjdXJyZW50IGNsb25lIOKAlCB0aGUgcnVuJ3Mgb3duIHJlcG8uXG4gIHJldHVybiB7IHZlcmI6IFwiZ2l0LXB1c2hcIiwgLi4uKHRhcmdldCA/IHsgdGFyZ2V0IH0gOiB7fSksIHNjb3BlOiBcImN3ZFwiIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7O0NBY0MsR0FFRCxTQUFTLHdCQUF3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
// denoCacheMetadata=10859801834051399600,2904474239322343052