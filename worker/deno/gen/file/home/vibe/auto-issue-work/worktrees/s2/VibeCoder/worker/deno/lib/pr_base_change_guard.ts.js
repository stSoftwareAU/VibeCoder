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
 */ import { classifyGhMutation } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";
import { isMilestoneBranch, isMilestoneFixBranch, milestoneFixPrefixFor } from "./milestone_branch_names.ts";
/** `milestone-fix/<leaf>/pr-<N>-<discriminator>`. */ const MILESTONE_FIX_HEAD = /^milestone-fix\/([A-Za-z0-9._-]+)\/pr-([0-9]+)-.+$/;
/**
 * Parse a milestone-fix head branch into its leaf and milestone PR number.
 *
 * @returns undefined when the head does not have the fix-branch shape.
 */ export function parseMilestoneFixHead(head) {
  const match = head.match(MILESTONE_FIX_HEAD);
  if (!match) return undefined;
  const milestonePrNumber = Number(match[2]);
  if (!Number.isSafeInteger(milestonePrNumber) || milestonePrNumber <= 0) {
    return undefined;
  }
  return {
    leaf: match[1],
    milestonePrNumber
  };
}
/** `gh pr edit` flags whose following token is a value, not the selector. */ const PR_EDIT_VALUE_FLAGS = new Set([
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
  "-m"
]);
const FIELD_FLAGS = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field"
]);
/** Last `--base`/`-B` value of a normalised `gh pr edit` argv, if any. */ function prEditBase(args) {
  let base;
  for(let i = 0; i < args.length; i++){
    const token = args[i];
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
/** First positional after `edit`, skipping the values of value-taking flags. */ function prEditSelector(args) {
  const editAt = args.indexOf("edit");
  for(let i = editAt + 1; i < args.length; i++){
    const token = args[i];
    if (PR_EDIT_VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (!token.startsWith("-")) return token;
  }
  return undefined;
}
/** `owner/repo` from a pull-request URL. */ function repoFromPrUrl(target) {
  if (!target) return undefined;
  const match = target.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/\d+/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}
/**
 * REST endpoint path with any `?query`/`#fragment`, origin and leading/trailing
 * slashes removed. GitHub ignores unknown query parameters, so a suffix must
 * not stop the anchored endpoint match (PR #3514 review).
 */ function endpointPath(endpoint) {
  return endpoint.replace(/[?#].*$/s, "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "").replace(/^\/+/, "").replace(/\/+$/, "");
}
/**
 * The `base` field of a `gh api` argv: its value, `null` when the value is
 * read from a file (`@path`) and so cannot be seen, or `undefined` when absent.
 */ function apiBaseField(args) {
  let result;
  const take = (field, expandsAtFile)=>{
    const eq = field.indexOf("=");
    if (eq <= 0 || field.slice(0, eq) !== "base") return;
    const value = field.slice(eq + 1);
    result = expandsAtFile && value.startsWith("@") ? null : value;
  };
  for(let i = 0; i < args.length; i++){
    const token = args[i];
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
/** The `base` of an `--input` JSON body: string, undefined (absent) or null. */ function inputBodyBase(path, readBodyFile) {
  if (path === undefined || !readBodyFile) return null;
  try {
    const doc = JSON.parse(readBodyFile(path));
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      return null;
    }
    const base = doc.base;
    if (base === undefined) return undefined;
    return typeof base === "string" ? base : null;
  } catch  {
    return null;
  }
}
/** Matches the GraphQL mutation that can set `baseRefName`, case-insensitively. */ const UPDATE_PULL_REQUEST = /updatepullrequest/i;
/**
 * Whether a `gh api graphql` request may carry an `updatePullRequest`
 * mutation (PR #3514 review).
 *
 * Does not rely on the classifier's parsed depth-1 fields, which misread a
 * multi-operation document picked by `operationName` and a `#` comment holding
 * a brace. Instead the raw argv is searched for the name anywhere, and every
 * document `gh` reads off the command line (`-F query=@file`, `-F k=@-`,
 * `--input <file>`, `--input -`) is read and searched too; an `--input` JSON
 * body is searched decoded as well, since GitHub decodes `\uXXXX` escapes
 * before parsing the GraphQL. A source that cannot
 * be read — stdin, no reader, a read error — counts as a match: failing closed
 * is the only safe answer for a document nobody can see.
 */ function graphqlMayUpdatePullRequest(args, readBodyFile) {
  if (args.some((a)=>UPDATE_PULL_REQUEST.test(a))) return true;
  // `fieldFiles` hold raw GraphQL text; `inputFiles` are JSON bodies that GitHub
  // decodes (so `\uXXXX` escapes can spell the mutation name) before parsing.
  const fieldFiles = [];
  const inputFiles = [];
  const fromFieldValue = (value)=>{
    const eq = value?.indexOf("=") ?? -1;
    if (value === undefined || eq < 0) return;
    const fieldValue = value.slice(eq + 1);
    if (fieldValue.startsWith("@")) fieldFiles.push(fieldValue.slice(1));
  };
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if (token === "--") break;
    if (token === "-F" || token === "--field") {
      fromFieldValue(args[i + 1]);
      i++;
    } else if (token.startsWith("--field=")) {
      fromFieldValue(token.slice("--field=".length));
    } else if (token === "--input") {
      inputFiles.push(args[i + 1] ?? "-");
      i++;
    } else if (token.startsWith("--input=")) {
      inputFiles.push(token.slice("--input=".length));
    } else if (token === "-f" || token === "--raw-field") {
      i++; // a static string: `@` is not a file here
    }
  }
  const unseen = (path)=>path === "-" || !readBodyFile;
  const fieldHit = fieldFiles.some((path)=>{
    if (unseen(path)) return true;
    try {
      return UPDATE_PULL_REQUEST.test(readBodyFile(path));
    } catch  {
      return true;
    }
  });
  return fieldHit || inputFiles.some((path)=>{
    if (unseen(path)) return true;
    try {
      return inputBodyMayUpdatePullRequest(readBodyFile(path));
    } catch  {
      return true;
    }
  });
}
/** Every key and string value in a decoded JSON document. */ function jsonStrings(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v)=>jsonStrings(v, out));
  else if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)){
      out.push(key);
      jsonStrings(v, out);
    }
  }
  return out;
}
/**
 * Whether an `--input` JSON body names `updatePullRequest` once decoded.
 *
 * GitHub JSON-decodes the body before it parses the GraphQL, so a `\uXXXX`
 * escape in the mutation name hides it from a search of the raw text. The raw
 * text and every decoded key and value are searched; a body that is not valid
 * JSON counts as a match.
 */ function inputBodyMayUpdatePullRequest(text) {
  if (UPDATE_PULL_REQUEST.test(text)) return true;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch  {
    return true;
  }
  return jsonStrings(doc, []).some((s)=>UPDATE_PULL_REQUEST.test(s));
}
/**
 * Recognise a request that changes a PR's base branch.
 *
 * Covers `gh pr edit --base|-B`, `gh api repos/o/r/pulls/N` with a `base`
 * field (inline, or in an `--input` file) sent as PATCH or POST — POST being
 * what `gh api` uses when a field is given and `-X` is not — and any
 * `gh api graphql` (or `/graphql`, or the absolute `api.github.com/graphql`
 * URL) request that may carry an `updatePullRequest` mutation,
 * including one read from a file or stdin (`newBase: null`, so callers fail
 * closed).
 *
 * @returns undefined when the command changes no PR's base.
 */ export function classifyPrBaseChange(rawArgs, readBodyFile) {
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
      ...repo ? {
        repo
      } : {},
      ...prSelector ? {
        prSelector
      } : {}
    };
  }
  // GraphQL `updatePullRequest` sets `baseRefName`; the document's variables
  // can hide it, so every such mutation is treated as an unreadable base change
  // (PR #3514 review). That covers a document read from a file or stdin, which
  // the classifier reports as `api-graphql-unknown`. The worker's own GraphQL
  // calls pass the document inline, so failing closed costs it nothing, and
  // `gh pr edit` still covers the title and body.
  if ((info.verb === "api-graphql-mutation" || info.verb === "api-graphql-unknown") && graphqlMayUpdatePullRequest(args, readBodyFile)) {
    return {
      newBase: null
    };
  }
  // GitHub routes POST on `pulls/N` to the same update handler as PATCH, and
  // `gh api` sends POST whenever a field is given without `-X` (PR #3514 review).
  if (info.verb !== "api-patch" && info.verb !== "api-post") return undefined;
  // Match GitHub's route on the raw path, split on literal `/` only: its
  // router treats an encoded slash (`%2F`) as part of the segment, so decoding
  // first would invent a separator (PR #3514 review). Each segment is then
  // decoded on its own; invalid percent-encoding cannot be safely classified,
  // so both callers must fail closed.
  const raw = endpointPath(info.target ?? "").split("/");
  let segments;
  try {
    segments = raw.map((segment)=>decodeURIComponent(segment));
  } catch  {
    return {
      newBase: null
    };
  }
  // `repos/<owner>/<repo>/pulls/<n>`, or the same route addressed by
  // repository id, `repositories/<id>/pulls/<n>`, with nothing after the
  // number segment: child endpoints such as pulls/N/comments are not PR edits.
  const byName = segments.length === 5 && segments[0] === "repos" && segments[3] === "pulls";
  const byId = segments.length === 4 && segments[0] === "repositories" && /^\d+$/.test(segments[1]) && segments[2] === "pulls";
  if (!byName && !byId) return undefined;
  let base = apiBaseField(args);
  if (base === undefined && info.unreadableBody) {
    base = inputBodyBase(info.bodyFilePath, readBodyFile);
  }
  if (base === undefined) return undefined;
  // GitHub skips leading whitespace in the number segment and reads its
  // leading digits, whatever follows them (`.json`, letters, `;x`, an encoded
  // slash). A segment with no such number cannot be read, and a base change
  // that cannot be read fails closed rather than being enumerated spelling by
  // spelling (PR #3514 review).
  const number = segments[segments.length - 1].match(/^[ \t\n\v\f\r]*(\d+)/)?.[1];
  if (number === undefined) return {
    newBase: null
  };
  // A repository id names no `owner/repo` the lookup could pass to `--repo`,
  // so the PR cannot be read: report the base as unreadable (fail closed).
  if (byId) return {
    newBase: null,
    prSelector: number
  };
  const owner = segments[1];
  const name = segments[2];
  const placeholder = owner === "{owner}" || name === "{repo}";
  const repo = placeholder ? undefined : `${owner}/${name}`;
  return {
    newBase: base,
    ...repo ? {
      repo
    } : {},
    prSelector: number
  };
}
/**
 * Decide whether a PR may move from `currentBase` to `newBase`.
 *
 * A milestone-fix PR may only ever target its own milestone branch; any PR on
 * a milestone branch may only move to another milestone branch.
 */ export function decidePrBaseChange(input) {
  const { headRefName, currentBase, newBase } = input;
  if (newBase === null) {
    return {
      allowed: false,
      reason: "the requested base could not be read, failing closed"
    };
  }
  if (isMilestoneFixBranch(headRefName)) {
    const parsed = parseMilestoneFixHead(headRefName);
    const own = parsed !== undefined && isMilestoneBranch(newBase) && headRefName.startsWith(milestoneFixPrefixFor(newBase, parsed.milestonePrNumber));
    return own ? {
      allowed: true
    } : {
      allowed: false,
      reason: "milestone-fix PRs only ever target their milestone branch"
    };
  }
  if (isMilestoneBranch(currentBase) && !isMilestoneBranch(newBase)) {
    return {
      allowed: false,
      reason: "moving a PR off a milestone branch puts the milestone's work " + "on a non-milestone base without the milestone's final review"
    };
  }
  return {
    allowed: true
  };
}
/** Thrown when a base change is refused. */ export class PrBaseChangeRefusedError extends Error {
  constructor(message){
    super(message);
    this.name = "PrBaseChangeRefusedError";
  }
}
/**
 * Refuse a base change that would move a milestone PR off its milestone
 * branch. A no-op for any other command. A failed lookup refuses.
 *
 * @throws PrBaseChangeRefusedError when the change is refused.
 */ export async function enforcePrBaseChangeGuard(args, deps) {
  const change = classifyPrBaseChange(args, deps.readBodyFile);
  if (!change) return;
  let head = "<unknown>";
  let current = "<unknown>";
  let reason;
  try {
    const pr = await deps.lookup(change);
    head = pr.headRefName;
    current = pr.baseRefName;
    const verdict = decidePrBaseChange({
      headRefName: head,
      currentBase: current,
      newBase: change.newBase
    });
    if (!verdict.allowed) reason = verdict.reason;
  } catch (error) {
    reason = `could not read the PR's head and base (${error instanceof Error ? error.message : String(error)}), failing closed`;
  }
  if (reason === undefined) return;
  const line = `[SECURITY] [PR_BASE_CHANGE_REFUSED] repo=${change.repo ?? "<cwd>"} pr=${change.prSelector ?? "<cwd>"} head=${head} currentBase=${current} ` + `newBase=${change.newBase ?? "<unreadable>"} reason=${reason}`;
  deps.log(line);
  throw new PrBaseChangeRefusedError(line);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcl9iYXNlX2NoYW5nZV9ndWFyZC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlZnVzZXMgcmV0YXJnZXRpbmcgYSBwdWxsIHJlcXVlc3QncyBiYXNlIGJyYW5jaCAoSXNzdWUgIzM0MzMpLlxuICpcbiAqIEEgbWlsZXN0b25lLWZpeCBQUiB0YXJnZXRzIGl0cyBtaWxlc3RvbmUgYnJhbmNoLCBhbmQgYSBtaWxlc3RvbmUgY2hpbGQgUFJcbiAqIHRhcmdldHMgYSBtaWxlc3RvbmUgYnJhbmNoIHRvby4gRWRpdGluZyBlaXRoZXIgUFIncyBiYXNlIHRvIHRoZSBkZWZhdWx0XG4gKiBicmFuY2ggKGBnaCBwciBlZGl0IC0tYmFzZSBtYWluYCwgYFBBVENIYC9gUE9TVCByZXBvcy9vL3IvcHVsbHMvTmAgd2l0aFxuICogYGJhc2U9bWFpbmAsIG9yIGEgR3JhcGhRTCBgdXBkYXRlUHVsbFJlcXVlc3RgIG11dGF0aW9uKSBsYW5kcyB0aGF0IHdvcmsgb24gdGhlIGRlZmF1bHQgYnJhbmNoIGFuZCBhdXRvLW1lcmdlcyBpdCB0aGVyZSxcbiAqIHNraXBwaW5nIHRoZSBtaWxlc3RvbmUncyBmaW5hbCByZXZpZXcuIFRoZSB3b3JrZXIgb3ducyBQUiB0YXJnZXRpbmcsIHNvOlxuICpcbiAqICAgLSB0aGUgYWdlbnQgZ3VhcmQgKGBnaF9ndWFyZF9kZWNpc2lvbi50c2ApIHJlZnVzZXMgZXZlcnkgYmFzZSBjaGFuZ2VcbiAqICAgICAoaXQgaXMgcHVyZSBhbmQgY2Fubm90IGxvb2sgdGhlIFBSIHVwKSwgYW5kXG4gKiAgIC0gdGhlIHdvcmtlciBjaG9rZXBvaW50IChgZ2hfc3Bhd24udHNgKSByZWFkcyB0aGUgUFIncyBoZWFkIGFuZCBiYXNlIGZpcnN0XG4gKiAgICAgYW5kIGFwcGxpZXMge0BsaW5rIGRlY2lkZVByQmFzZUNoYW5nZX0sIGZhaWxpbmcgY2xvc2VkIHdoZW4gaXQgY2Fubm90LlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGNsYXNzaWZ5R2hNdXRhdGlvbiB9IGZyb20gXCIuL2F1ZGl0X211dGF0aW9uX2NsYXNzaWZpZXIudHNcIjtcbmltcG9ydCB7IG5vcm1hbGlzZUdoQXJncyB9IGZyb20gXCIuL2doX2ZsYWdfcGFyc2VyLnRzXCI7XG5pbXBvcnQge1xuICBpc01pbGVzdG9uZUJyYW5jaCxcbiAgaXNNaWxlc3RvbmVGaXhCcmFuY2gsXG4gIG1pbGVzdG9uZUZpeFByZWZpeEZvcixcbn0gZnJvbSBcIi4vbWlsZXN0b25lX2JyYW5jaF9uYW1lcy50c1wiO1xuXG4vKiogQSByZXF1ZXN0IHRoYXQgY2hhbmdlcyBhIHB1bGwgcmVxdWVzdCdzIGJhc2UgYnJhbmNoLiAqL1xuZXhwb3J0IGludGVyZmFjZSBQckJhc2VDaGFuZ2Uge1xuICAvKipcbiAgICogVGhlIGJhc2UgYnJhbmNoIHJlcXVlc3RlZC4gYG51bGxgIHdoZW4gdGhlIHJlcXVlc3QgY2FycmllcyBhIGJhc2UgY2hhbmdlXG4gICAqIHdob3NlIHRhcmdldCBjb3VsZCBub3QgYmUgcmVhZCAoYW4gdW5yZWFkYWJsZSBgLS1pbnB1dGAgYm9keSkg4oCUIGNhbGxlcnNcbiAgICogbXVzdCBmYWlsIGNsb3NlZC5cbiAgICovXG4gIG5ld0Jhc2U6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBgb3duZXIvcmVwb2AsIHdoZW4gdGhlIGFyZ3YgbmFtZXMgb25lLiAqL1xuICByZXBvPzogc3RyaW5nO1xuICAvKiogUFIgbnVtYmVyLCBVUkwgb3IgYnJhbmNoIHRoZSBhcmd2IHNlbGVjdHMsIHdoZW4gaXQgbmFtZXMgb25lLiAqL1xuICBwclNlbGVjdG9yPzogc3RyaW5nO1xufVxuXG4vKiogUmVhZHMgYSByZXF1ZXN0IGJvZHkgZmlsZTsgdGhyb3dzIHdoZW4gaXQgY2Fubm90LiAqL1xuZXhwb3J0IHR5cGUgUHJCYXNlQm9keVJlYWRlciA9IChwYXRoOiBzdHJpbmcpID0+IHN0cmluZztcblxuLyoqIGBtaWxlc3RvbmUtZml4LzxsZWFmPi9wci08Tj4tPGRpc2NyaW1pbmF0b3I+YC4gKi9cbmNvbnN0IE1JTEVTVE9ORV9GSVhfSEVBRCA9IC9ebWlsZXN0b25lLWZpeFxcLyhbQS1aYS16MC05Ll8tXSspXFwvcHItKFswLTldKyktLiskLztcblxuLyoqXG4gKiBQYXJzZSBhIG1pbGVzdG9uZS1maXggaGVhZCBicmFuY2ggaW50byBpdHMgbGVhZiBhbmQgbWlsZXN0b25lIFBSIG51bWJlci5cbiAqXG4gKiBAcmV0dXJucyB1bmRlZmluZWQgd2hlbiB0aGUgaGVhZCBkb2VzIG5vdCBoYXZlIHRoZSBmaXgtYnJhbmNoIHNoYXBlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VNaWxlc3RvbmVGaXhIZWFkKFxuICBoZWFkOiBzdHJpbmcsXG4pOiB7IGxlYWY6IHN0cmluZzsgbWlsZXN0b25lUHJOdW1iZXI6IG51bWJlciB9IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbWF0Y2ggPSBoZWFkLm1hdGNoKE1JTEVTVE9ORV9GSVhfSEVBRCk7XG4gIGlmICghbWF0Y2gpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG1pbGVzdG9uZVByTnVtYmVyID0gTnVtYmVyKG1hdGNoWzJdKTtcbiAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihtaWxlc3RvbmVQck51bWJlcikgfHwgbWlsZXN0b25lUHJOdW1iZXIgPD0gMCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIHsgbGVhZjogbWF0Y2hbMV0hLCBtaWxlc3RvbmVQck51bWJlciB9O1xufVxuXG4vKiogYGdoIHByIGVkaXRgIGZsYWdzIHdob3NlIGZvbGxvd2luZyB0b2tlbiBpcyBhIHZhbHVlLCBub3QgdGhlIHNlbGVjdG9yLiAqL1xuY29uc3QgUFJfRURJVF9WQUxVRV9GTEFHUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcIi0tYmFzZVwiLFxuICBcIi1CXCIsXG4gIFwiLS1yZXBvXCIsXG4gIFwiLVJcIixcbiAgXCItLXRpdGxlXCIsXG4gIFwiLXRcIixcbiAgXCItLWJvZHlcIixcbiAgXCItYlwiLFxuICBcIi0tYm9keS1maWxlXCIsXG4gIFwiLUZcIixcbiAgXCItLWFkZC1sYWJlbFwiLFxuICBcIi0tcmVtb3ZlLWxhYmVsXCIsXG4gIFwiLS1hZGQtYXNzaWduZWVcIixcbiAgXCItLXJlbW92ZS1hc3NpZ25lZVwiLFxuICBcIi0tYWRkLXJldmlld2VyXCIsXG4gIFwiLS1yZW1vdmUtcmV2aWV3ZXJcIixcbiAgXCItLWFkZC1wcm9qZWN0XCIsXG4gIFwiLS1yZW1vdmUtcHJvamVjdFwiLFxuICBcIi0tbWlsZXN0b25lXCIsXG4gIFwiLW1cIixcbl0pO1xuXG5jb25zdCBGSUVMRF9GTEFHUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcIi1mXCIsXG4gIFwiLUZcIixcbiAgXCItLWZpZWxkXCIsXG4gIFwiLS1yYXctZmllbGRcIixcbl0pO1xuXG4vKiogTGFzdCBgLS1iYXNlYC9gLUJgIHZhbHVlIG9mIGEgbm9ybWFsaXNlZCBgZ2ggcHIgZWRpdGAgYXJndiwgaWYgYW55LiAqL1xuZnVuY3Rpb24gcHJFZGl0QmFzZShhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGxldCBiYXNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRva2VuID0gYXJnc1tpXSE7XG4gICAgaWYgKHRva2VuID09PSBcIi0tXCIpIGJyZWFrO1xuICAgIGlmICh0b2tlbiA9PT0gXCItLWJhc2VcIiB8fCB0b2tlbiA9PT0gXCItQlwiKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGFyZ3NbaSArIDFdO1xuICAgICAgaWYgKHZhbHVlICE9PSB1bmRlZmluZWQpIGJhc2UgPSB2YWx1ZTtcbiAgICAgIGkrKztcbiAgICB9IGVsc2UgaWYgKHRva2VuLnN0YXJ0c1dpdGgoXCItLWJhc2U9XCIpKSB7XG4gICAgICBiYXNlID0gdG9rZW4uc2xpY2UoXCItLWJhc2U9XCIubGVuZ3RoKTtcbiAgICB9IGVsc2UgaWYgKHRva2VuLnN0YXJ0c1dpdGgoXCItQlwiKSAmJiAhdG9rZW4uc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBjb25zdCByZXN0ID0gdG9rZW4uc2xpY2UoMik7XG4gICAgICBiYXNlID0gcmVzdC5zdGFydHNXaXRoKFwiPVwiKSA/IHJlc3Quc2xpY2UoMSkgOiByZXN0O1xuICAgIH1cbiAgfVxuICByZXR1cm4gYmFzZTtcbn1cblxuLyoqIEZpcnN0IHBvc2l0aW9uYWwgYWZ0ZXIgYGVkaXRgLCBza2lwcGluZyB0aGUgdmFsdWVzIG9mIHZhbHVlLXRha2luZyBmbGFncy4gKi9cbmZ1bmN0aW9uIHByRWRpdFNlbGVjdG9yKGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgZWRpdEF0ID0gYXJncy5pbmRleE9mKFwiZWRpdFwiKTtcbiAgZm9yIChsZXQgaSA9IGVkaXRBdCArIDE7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdG9rZW4gPSBhcmdzW2ldITtcbiAgICBpZiAoUFJfRURJVF9WQUxVRV9GTEFHUy5oYXModG9rZW4pKSB7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCF0b2tlbi5zdGFydHNXaXRoKFwiLVwiKSkgcmV0dXJuIHRva2VuO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiBgb3duZXIvcmVwb2AgZnJvbSBhIHB1bGwtcmVxdWVzdCBVUkwuICovXG5mdW5jdGlvbiByZXBvRnJvbVByVXJsKHRhcmdldDogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG1hdGNoID0gdGFyZ2V0Lm1hdGNoKFxuICAgIC9eaHR0cHM/OlxcL1xcL1teL10rXFwvKFteL10rKVxcLyhbXi9dKylcXC9wdWxscz9cXC9cXGQrL2ksXG4gICk7XG4gIHJldHVybiBtYXRjaCA/IGAke21hdGNoWzFdfS8ke21hdGNoWzJdfWAgOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUkVTVCBlbmRwb2ludCBwYXRoIHdpdGggYW55IGA/cXVlcnlgL2AjZnJhZ21lbnRgLCBvcmlnaW4gYW5kIGxlYWRpbmcvdHJhaWxpbmdcbiAqIHNsYXNoZXMgcmVtb3ZlZC4gR2l0SHViIGlnbm9yZXMgdW5rbm93biBxdWVyeSBwYXJhbWV0ZXJzLCBzbyBhIHN1ZmZpeCBtdXN0XG4gKiBub3Qgc3RvcCB0aGUgYW5jaG9yZWQgZW5kcG9pbnQgbWF0Y2ggKFBSICMzNTE0IHJldmlldykuXG4gKi9cbmZ1bmN0aW9uIGVuZHBvaW50UGF0aChlbmRwb2ludDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVuZHBvaW50XG4gICAgLnJlcGxhY2UoL1s/I10uKiQvcywgXCJcIilcbiAgICAucmVwbGFjZSgvXlthLXpdW2EtejAtOSsuLV0qOlxcL1xcL1teL10rXFwvL2ksIFwiXCIpXG4gICAgLnJlcGxhY2UoL15cXC8rLywgXCJcIilcbiAgICAucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbn1cblxuLyoqXG4gKiBUaGUgYGJhc2VgIGZpZWxkIG9mIGEgYGdoIGFwaWAgYXJndjogaXRzIHZhbHVlLCBgbnVsbGAgd2hlbiB0aGUgdmFsdWUgaXNcbiAqIHJlYWQgZnJvbSBhIGZpbGUgKGBAcGF0aGApIGFuZCBzbyBjYW5ub3QgYmUgc2Vlbiwgb3IgYHVuZGVmaW5lZGAgd2hlbiBhYnNlbnQuXG4gKi9cbmZ1bmN0aW9uIGFwaUJhc2VGaWVsZChhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQge1xuICBsZXQgcmVzdWx0OiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkO1xuICBjb25zdCB0YWtlID0gKGZpZWxkOiBzdHJpbmcsIGV4cGFuZHNBdEZpbGU6IGJvb2xlYW4pOiB2b2lkID0+IHtcbiAgICBjb25zdCBlcSA9IGZpZWxkLmluZGV4T2YoXCI9XCIpO1xuICAgIGlmIChlcSA8PSAwIHx8IGZpZWxkLnNsaWNlKDAsIGVxKSAhPT0gXCJiYXNlXCIpIHJldHVybjtcbiAgICBjb25zdCB2YWx1ZSA9IGZpZWxkLnNsaWNlKGVxICsgMSk7XG4gICAgcmVzdWx0ID0gZXhwYW5kc0F0RmlsZSAmJiB2YWx1ZS5zdGFydHNXaXRoKFwiQFwiKSA/IG51bGwgOiB2YWx1ZTtcbiAgfTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdG9rZW4gPSBhcmdzW2ldITtcbiAgICBpZiAoRklFTERfRkxBR1MuaGFzKHRva2VuKSkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhcmdzW2kgKyAxXTtcbiAgICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRha2UodmFsdWUsIHRva2VuID09PSBcIi1GXCIgfHwgdG9rZW4gPT09IFwiLS1maWVsZFwiKTtcbiAgICAgIH1cbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBlcSA9IHRva2VuLmluZGV4T2YoXCI9XCIpO1xuICAgIGlmIChlcSA+IDAgJiYgRklFTERfRkxBR1MuaGFzKHRva2VuLnNsaWNlKDAsIGVxKSkpIHtcbiAgICAgIGNvbnN0IGZsYWcgPSB0b2tlbi5zbGljZSgwLCBlcSk7XG4gICAgICB0YWtlKHRva2VuLnNsaWNlKGVxICsgMSksIGZsYWcgPT09IFwiLUZcIiB8fCBmbGFnID09PSBcIi0tZmllbGRcIik7XG4gICAgfVxuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKiBUaGUgYGJhc2VgIG9mIGFuIGAtLWlucHV0YCBKU09OIGJvZHk6IHN0cmluZywgdW5kZWZpbmVkIChhYnNlbnQpIG9yIG51bGwuICovXG5mdW5jdGlvbiBpbnB1dEJvZHlCYXNlKFxuICBwYXRoOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHJlYWRCb2R5RmlsZTogUHJCYXNlQm9keVJlYWRlciB8IHVuZGVmaW5lZCxcbik6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQge1xuICBpZiAocGF0aCA9PT0gdW5kZWZpbmVkIHx8ICFyZWFkQm9keUZpbGUpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IGRvYzogdW5rbm93biA9IEpTT04ucGFyc2UocmVhZEJvZHlGaWxlKHBhdGgpKTtcbiAgICBpZiAoZG9jID09PSBudWxsIHx8IHR5cGVvZiBkb2MgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShkb2MpKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgYmFzZSA9IChkb2MgYXMgeyBiYXNlPzogdW5rbm93biB9KS5iYXNlO1xuICAgIGlmIChiYXNlID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIHR5cGVvZiBiYXNlID09PSBcInN0cmluZ1wiID8gYmFzZSA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBNYXRjaGVzIHRoZSBHcmFwaFFMIG11dGF0aW9uIHRoYXQgY2FuIHNldCBgYmFzZVJlZk5hbWVgLCBjYXNlLWluc2Vuc2l0aXZlbHkuICovXG5jb25zdCBVUERBVEVfUFVMTF9SRVFVRVNUID0gL3VwZGF0ZXB1bGxyZXF1ZXN0L2k7XG5cbi8qKlxuICogV2hldGhlciBhIGBnaCBhcGkgZ3JhcGhxbGAgcmVxdWVzdCBtYXkgY2FycnkgYW4gYHVwZGF0ZVB1bGxSZXF1ZXN0YFxuICogbXV0YXRpb24gKFBSICMzNTE0IHJldmlldykuXG4gKlxuICogRG9lcyBub3QgcmVseSBvbiB0aGUgY2xhc3NpZmllcidzIHBhcnNlZCBkZXB0aC0xIGZpZWxkcywgd2hpY2ggbWlzcmVhZCBhXG4gKiBtdWx0aS1vcGVyYXRpb24gZG9jdW1lbnQgcGlja2VkIGJ5IGBvcGVyYXRpb25OYW1lYCBhbmQgYSBgI2AgY29tbWVudCBob2xkaW5nXG4gKiBhIGJyYWNlLiBJbnN0ZWFkIHRoZSByYXcgYXJndiBpcyBzZWFyY2hlZCBmb3IgdGhlIG5hbWUgYW55d2hlcmUsIGFuZCBldmVyeVxuICogZG9jdW1lbnQgYGdoYCByZWFkcyBvZmYgdGhlIGNvbW1hbmQgbGluZSAoYC1GIHF1ZXJ5PUBmaWxlYCwgYC1GIGs9QC1gLFxuICogYC0taW5wdXQgPGZpbGU+YCwgYC0taW5wdXQgLWApIGlzIHJlYWQgYW5kIHNlYXJjaGVkIHRvbzsgYW4gYC0taW5wdXRgIEpTT05cbiAqIGJvZHkgaXMgc2VhcmNoZWQgZGVjb2RlZCBhcyB3ZWxsLCBzaW5jZSBHaXRIdWIgZGVjb2RlcyBgXFx1WFhYWGAgZXNjYXBlc1xuICogYmVmb3JlIHBhcnNpbmcgdGhlIEdyYXBoUUwuIEEgc291cmNlIHRoYXQgY2Fubm90XG4gKiBiZSByZWFkIOKAlCBzdGRpbiwgbm8gcmVhZGVyLCBhIHJlYWQgZXJyb3Ig4oCUIGNvdW50cyBhcyBhIG1hdGNoOiBmYWlsaW5nIGNsb3NlZFxuICogaXMgdGhlIG9ubHkgc2FmZSBhbnN3ZXIgZm9yIGEgZG9jdW1lbnQgbm9ib2R5IGNhbiBzZWUuXG4gKi9cbmZ1bmN0aW9uIGdyYXBocWxNYXlVcGRhdGVQdWxsUmVxdWVzdChcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHJlYWRCb2R5RmlsZTogUHJCYXNlQm9keVJlYWRlciB8IHVuZGVmaW5lZCxcbik6IGJvb2xlYW4ge1xuICBpZiAoYXJncy5zb21lKChhKSA9PiBVUERBVEVfUFVMTF9SRVFVRVNULnRlc3QoYSkpKSByZXR1cm4gdHJ1ZTtcblxuICAvLyBgZmllbGRGaWxlc2AgaG9sZCByYXcgR3JhcGhRTCB0ZXh0OyBgaW5wdXRGaWxlc2AgYXJlIEpTT04gYm9kaWVzIHRoYXQgR2l0SHViXG4gIC8vIGRlY29kZXMgKHNvIGBcXHVYWFhYYCBlc2NhcGVzIGNhbiBzcGVsbCB0aGUgbXV0YXRpb24gbmFtZSkgYmVmb3JlIHBhcnNpbmcuXG4gIGNvbnN0IGZpZWxkRmlsZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGlucHV0RmlsZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGZyb21GaWVsZFZhbHVlID0gKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkID0+IHtcbiAgICBjb25zdCBlcSA9IHZhbHVlPy5pbmRleE9mKFwiPVwiKSA/PyAtMTtcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCBlcSA8IDApIHJldHVybjtcbiAgICBjb25zdCBmaWVsZFZhbHVlID0gdmFsdWUuc2xpY2UoZXEgKyAxKTtcbiAgICBpZiAoZmllbGRWYWx1ZS5zdGFydHNXaXRoKFwiQFwiKSkgZmllbGRGaWxlcy5wdXNoKGZpZWxkVmFsdWUuc2xpY2UoMSkpO1xuICB9O1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0b2tlbiA9IGFyZ3NbaV0hO1xuICAgIGlmICh0b2tlbiA9PT0gXCItLVwiKSBicmVhaztcbiAgICBpZiAodG9rZW4gPT09IFwiLUZcIiB8fCB0b2tlbiA9PT0gXCItLWZpZWxkXCIpIHtcbiAgICAgIGZyb21GaWVsZFZhbHVlKGFyZ3NbaSArIDFdKTtcbiAgICAgIGkrKztcbiAgICB9IGVsc2UgaWYgKHRva2VuLnN0YXJ0c1dpdGgoXCItLWZpZWxkPVwiKSkge1xuICAgICAgZnJvbUZpZWxkVmFsdWUodG9rZW4uc2xpY2UoXCItLWZpZWxkPVwiLmxlbmd0aCkpO1xuICAgIH0gZWxzZSBpZiAodG9rZW4gPT09IFwiLS1pbnB1dFwiKSB7XG4gICAgICBpbnB1dEZpbGVzLnB1c2goYXJnc1tpICsgMV0gPz8gXCItXCIpO1xuICAgICAgaSsrO1xuICAgIH0gZWxzZSBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0taW5wdXQ9XCIpKSB7XG4gICAgICBpbnB1dEZpbGVzLnB1c2godG9rZW4uc2xpY2UoXCItLWlucHV0PVwiLmxlbmd0aCkpO1xuICAgIH0gZWxzZSBpZiAodG9rZW4gPT09IFwiLWZcIiB8fCB0b2tlbiA9PT0gXCItLXJhdy1maWVsZFwiKSB7XG4gICAgICBpKys7IC8vIGEgc3RhdGljIHN0cmluZzogYEBgIGlzIG5vdCBhIGZpbGUgaGVyZVxuICAgIH1cbiAgfVxuICBjb25zdCB1bnNlZW4gPSAocGF0aDogc3RyaW5nKTogYm9vbGVhbiA9PiBwYXRoID09PSBcIi1cIiB8fCAhcmVhZEJvZHlGaWxlO1xuICBjb25zdCBmaWVsZEhpdCA9IGZpZWxkRmlsZXMuc29tZSgocGF0aCkgPT4ge1xuICAgIGlmICh1bnNlZW4ocGF0aCkpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gVVBEQVRFX1BVTExfUkVRVUVTVC50ZXN0KHJlYWRCb2R5RmlsZSEocGF0aCkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGZpZWxkSGl0IHx8IGlucHV0RmlsZXMuc29tZSgocGF0aCkgPT4ge1xuICAgIGlmICh1bnNlZW4ocGF0aCkpIHJldHVybiB0cnVlO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gaW5wdXRCb2R5TWF5VXBkYXRlUHVsbFJlcXVlc3QocmVhZEJvZHlGaWxlIShwYXRoKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH0pO1xufVxuXG4vKiogRXZlcnkga2V5IGFuZCBzdHJpbmcgdmFsdWUgaW4gYSBkZWNvZGVkIEpTT04gZG9jdW1lbnQuICovXG5mdW5jdGlvbiBqc29uU3RyaW5ncyh2YWx1ZTogdW5rbm93biwgb3V0OiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikgb3V0LnB1c2godmFsdWUpO1xuICBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgdmFsdWUuZm9yRWFjaCgodikgPT4ganNvblN0cmluZ3Modiwgb3V0KSk7XG4gIGVsc2UgaWYgKHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikge1xuICAgIGZvciAoY29uc3QgW2tleSwgdl0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUpKSB7XG4gICAgICBvdXQucHVzaChrZXkpO1xuICAgICAganNvblN0cmluZ3Modiwgb3V0KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGFuIGAtLWlucHV0YCBKU09OIGJvZHkgbmFtZXMgYHVwZGF0ZVB1bGxSZXF1ZXN0YCBvbmNlIGRlY29kZWQuXG4gKlxuICogR2l0SHViIEpTT04tZGVjb2RlcyB0aGUgYm9keSBiZWZvcmUgaXQgcGFyc2VzIHRoZSBHcmFwaFFMLCBzbyBhIGBcXHVYWFhYYFxuICogZXNjYXBlIGluIHRoZSBtdXRhdGlvbiBuYW1lIGhpZGVzIGl0IGZyb20gYSBzZWFyY2ggb2YgdGhlIHJhdyB0ZXh0LiBUaGUgcmF3XG4gKiB0ZXh0IGFuZCBldmVyeSBkZWNvZGVkIGtleSBhbmQgdmFsdWUgYXJlIHNlYXJjaGVkOyBhIGJvZHkgdGhhdCBpcyBub3QgdmFsaWRcbiAqIEpTT04gY291bnRzIGFzIGEgbWF0Y2guXG4gKi9cbmZ1bmN0aW9uIGlucHV0Qm9keU1heVVwZGF0ZVB1bGxSZXF1ZXN0KHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoVVBEQVRFX1BVTExfUkVRVUVTVC50ZXN0KHRleHQpKSByZXR1cm4gdHJ1ZTtcbiAgbGV0IGRvYzogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBkb2MgPSBKU09OLnBhcnNlKHRleHQpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4ganNvblN0cmluZ3MoZG9jLCBbXSkuc29tZSgocykgPT4gVVBEQVRFX1BVTExfUkVRVUVTVC50ZXN0KHMpKTtcbn1cblxuLyoqXG4gKiBSZWNvZ25pc2UgYSByZXF1ZXN0IHRoYXQgY2hhbmdlcyBhIFBSJ3MgYmFzZSBicmFuY2guXG4gKlxuICogQ292ZXJzIGBnaCBwciBlZGl0IC0tYmFzZXwtQmAsIGBnaCBhcGkgcmVwb3Mvby9yL3B1bGxzL05gIHdpdGggYSBgYmFzZWBcbiAqIGZpZWxkIChpbmxpbmUsIG9yIGluIGFuIGAtLWlucHV0YCBmaWxlKSBzZW50IGFzIFBBVENIIG9yIFBPU1Qg4oCUIFBPU1QgYmVpbmdcbiAqIHdoYXQgYGdoIGFwaWAgdXNlcyB3aGVuIGEgZmllbGQgaXMgZ2l2ZW4gYW5kIGAtWGAgaXMgbm90IOKAlCBhbmQgYW55XG4gKiBgZ2ggYXBpIGdyYXBocWxgIChvciBgL2dyYXBocWxgLCBvciB0aGUgYWJzb2x1dGUgYGFwaS5naXRodWIuY29tL2dyYXBocWxgXG4gKiBVUkwpIHJlcXVlc3QgdGhhdCBtYXkgY2FycnkgYW4gYHVwZGF0ZVB1bGxSZXF1ZXN0YCBtdXRhdGlvbixcbiAqIGluY2x1ZGluZyBvbmUgcmVhZCBmcm9tIGEgZmlsZSBvciBzdGRpbiAoYG5ld0Jhc2U6IG51bGxgLCBzbyBjYWxsZXJzIGZhaWxcbiAqIGNsb3NlZCkuXG4gKlxuICogQHJldHVybnMgdW5kZWZpbmVkIHdoZW4gdGhlIGNvbW1hbmQgY2hhbmdlcyBubyBQUidzIGJhc2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGFzc2lmeVByQmFzZUNoYW5nZShcbiAgcmF3QXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHJlYWRCb2R5RmlsZT86IFByQmFzZUJvZHlSZWFkZXIsXG4pOiBQckJhc2VDaGFuZ2UgfCB1bmRlZmluZWQge1xuICBjb25zdCBhcmdzID0gbm9ybWFsaXNlR2hBcmdzKHJhd0FyZ3MpO1xuICBjb25zdCBpbmZvID0gY2xhc3NpZnlHaE11dGF0aW9uKHJhd0FyZ3MpO1xuICBpZiAoIWluZm8pIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgaWYgKGluZm8udmVyYiA9PT0gXCJwci1lZGl0XCIpIHtcbiAgICBjb25zdCBiYXNlID0gcHJFZGl0QmFzZShhcmdzKTtcbiAgICBpZiAoYmFzZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGNvbnN0IHByU2VsZWN0b3IgPSBpbmZvLnRhcmdldCA/PyBwckVkaXRTZWxlY3RvcihhcmdzKTtcbiAgICBjb25zdCByZXBvID0gaW5mby5yZXBvID8/IHJlcG9Gcm9tUHJVcmwocHJTZWxlY3Rvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5ld0Jhc2U6IGJhc2UsXG4gICAgICAuLi4ocmVwbyA/IHsgcmVwbyB9IDoge30pLFxuICAgICAgLi4uKHByU2VsZWN0b3IgPyB7IHByU2VsZWN0b3IgfSA6IHt9KSxcbiAgICB9O1xuICB9XG5cbiAgLy8gR3JhcGhRTCBgdXBkYXRlUHVsbFJlcXVlc3RgIHNldHMgYGJhc2VSZWZOYW1lYDsgdGhlIGRvY3VtZW50J3MgdmFyaWFibGVzXG4gIC8vIGNhbiBoaWRlIGl0LCBzbyBldmVyeSBzdWNoIG11dGF0aW9uIGlzIHRyZWF0ZWQgYXMgYW4gdW5yZWFkYWJsZSBiYXNlIGNoYW5nZVxuICAvLyAoUFIgIzM1MTQgcmV2aWV3KS4gVGhhdCBjb3ZlcnMgYSBkb2N1bWVudCByZWFkIGZyb20gYSBmaWxlIG9yIHN0ZGluLCB3aGljaFxuICAvLyB0aGUgY2xhc3NpZmllciByZXBvcnRzIGFzIGBhcGktZ3JhcGhxbC11bmtub3duYC4gVGhlIHdvcmtlcidzIG93biBHcmFwaFFMXG4gIC8vIGNhbGxzIHBhc3MgdGhlIGRvY3VtZW50IGlubGluZSwgc28gZmFpbGluZyBjbG9zZWQgY29zdHMgaXQgbm90aGluZywgYW5kXG4gIC8vIGBnaCBwciBlZGl0YCBzdGlsbCBjb3ZlcnMgdGhlIHRpdGxlIGFuZCBib2R5LlxuICBpZiAoXG4gICAgKGluZm8udmVyYiA9PT0gXCJhcGktZ3JhcGhxbC1tdXRhdGlvblwiIHx8XG4gICAgICBpbmZvLnZlcmIgPT09IFwiYXBpLWdyYXBocWwtdW5rbm93blwiKSAmJlxuICAgIGdyYXBocWxNYXlVcGRhdGVQdWxsUmVxdWVzdChhcmdzLCByZWFkQm9keUZpbGUpXG4gICkge1xuICAgIHJldHVybiB7IG5ld0Jhc2U6IG51bGwgfTtcbiAgfVxuXG4gIC8vIEdpdEh1YiByb3V0ZXMgUE9TVCBvbiBgcHVsbHMvTmAgdG8gdGhlIHNhbWUgdXBkYXRlIGhhbmRsZXIgYXMgUEFUQ0gsIGFuZFxuICAvLyBgZ2ggYXBpYCBzZW5kcyBQT1NUIHdoZW5ldmVyIGEgZmllbGQgaXMgZ2l2ZW4gd2l0aG91dCBgLVhgIChQUiAjMzUxNCByZXZpZXcpLlxuICBpZiAoaW5mby52ZXJiICE9PSBcImFwaS1wYXRjaFwiICYmIGluZm8udmVyYiAhPT0gXCJhcGktcG9zdFwiKSByZXR1cm4gdW5kZWZpbmVkO1xuICAvLyBNYXRjaCBHaXRIdWIncyByb3V0ZSBvbiB0aGUgcmF3IHBhdGgsIHNwbGl0IG9uIGxpdGVyYWwgYC9gIG9ubHk6IGl0c1xuICAvLyByb3V0ZXIgdHJlYXRzIGFuIGVuY29kZWQgc2xhc2ggKGAlMkZgKSBhcyBwYXJ0IG9mIHRoZSBzZWdtZW50LCBzbyBkZWNvZGluZ1xuICAvLyBmaXJzdCB3b3VsZCBpbnZlbnQgYSBzZXBhcmF0b3IgKFBSICMzNTE0IHJldmlldykuIEVhY2ggc2VnbWVudCBpcyB0aGVuXG4gIC8vIGRlY29kZWQgb24gaXRzIG93bjsgaW52YWxpZCBwZXJjZW50LWVuY29kaW5nIGNhbm5vdCBiZSBzYWZlbHkgY2xhc3NpZmllZCxcbiAgLy8gc28gYm90aCBjYWxsZXJzIG11c3QgZmFpbCBjbG9zZWQuXG4gIGNvbnN0IHJhdyA9IGVuZHBvaW50UGF0aChpbmZvLnRhcmdldCA/PyBcIlwiKS5zcGxpdChcIi9cIik7XG4gIGxldCBzZWdtZW50czogc3RyaW5nW107XG4gIHRyeSB7XG4gICAgc2VnbWVudHMgPSByYXcubWFwKChzZWdtZW50KSA9PiBkZWNvZGVVUklDb21wb25lbnQoc2VnbWVudCkpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBuZXdCYXNlOiBudWxsIH07XG4gIH1cbiAgLy8gYHJlcG9zLzxvd25lcj4vPHJlcG8+L3B1bGxzLzxuPmAsIG9yIHRoZSBzYW1lIHJvdXRlIGFkZHJlc3NlZCBieVxuICAvLyByZXBvc2l0b3J5IGlkLCBgcmVwb3NpdG9yaWVzLzxpZD4vcHVsbHMvPG4+YCwgd2l0aCBub3RoaW5nIGFmdGVyIHRoZVxuICAvLyBudW1iZXIgc2VnbWVudDogY2hpbGQgZW5kcG9pbnRzIHN1Y2ggYXMgcHVsbHMvTi9jb21tZW50cyBhcmUgbm90IFBSIGVkaXRzLlxuICBjb25zdCBieU5hbWUgPSBzZWdtZW50cy5sZW5ndGggPT09IDUgJiYgc2VnbWVudHNbMF0gPT09IFwicmVwb3NcIiAmJlxuICAgIHNlZ21lbnRzWzNdID09PSBcInB1bGxzXCI7XG4gIGNvbnN0IGJ5SWQgPSBzZWdtZW50cy5sZW5ndGggPT09IDQgJiYgc2VnbWVudHNbMF0gPT09IFwicmVwb3NpdG9yaWVzXCIgJiZcbiAgICAvXlxcZCskLy50ZXN0KHNlZ21lbnRzWzFdISkgJiYgc2VnbWVudHNbMl0gPT09IFwicHVsbHNcIjtcbiAgaWYgKCFieU5hbWUgJiYgIWJ5SWQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgbGV0IGJhc2UgPSBhcGlCYXNlRmllbGQoYXJncyk7XG4gIGlmIChiYXNlID09PSB1bmRlZmluZWQgJiYgaW5mby51bnJlYWRhYmxlQm9keSkge1xuICAgIGJhc2UgPSBpbnB1dEJvZHlCYXNlKGluZm8uYm9keUZpbGVQYXRoLCByZWFkQm9keUZpbGUpO1xuICB9XG4gIGlmIChiYXNlID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgLy8gR2l0SHViIHNraXBzIGxlYWRpbmcgd2hpdGVzcGFjZSBpbiB0aGUgbnVtYmVyIHNlZ21lbnQgYW5kIHJlYWRzIGl0c1xuICAvLyBsZWFkaW5nIGRpZ2l0cywgd2hhdGV2ZXIgZm9sbG93cyB0aGVtIChgLmpzb25gLCBsZXR0ZXJzLCBgO3hgLCBhbiBlbmNvZGVkXG4gIC8vIHNsYXNoKS4gQSBzZWdtZW50IHdpdGggbm8gc3VjaCBudW1iZXIgY2Fubm90IGJlIHJlYWQsIGFuZCBhIGJhc2UgY2hhbmdlXG4gIC8vIHRoYXQgY2Fubm90IGJlIHJlYWQgZmFpbHMgY2xvc2VkIHJhdGhlciB0aGFuIGJlaW5nIGVudW1lcmF0ZWQgc3BlbGxpbmcgYnlcbiAgLy8gc3BlbGxpbmcgKFBSICMzNTE0IHJldmlldykuXG4gIGNvbnN0IG51bWJlciA9IHNlZ21lbnRzW3NlZ21lbnRzLmxlbmd0aCAtIDFdIS5tYXRjaChcbiAgICAvXlsgXFx0XFxuXFx2XFxmXFxyXSooXFxkKykvLFxuICApPy5bMV07XG4gIGlmIChudW1iZXIgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgbmV3QmFzZTogbnVsbCB9O1xuXG4gIC8vIEEgcmVwb3NpdG9yeSBpZCBuYW1lcyBubyBgb3duZXIvcmVwb2AgdGhlIGxvb2t1cCBjb3VsZCBwYXNzIHRvIGAtLXJlcG9gLFxuICAvLyBzbyB0aGUgUFIgY2Fubm90IGJlIHJlYWQ6IHJlcG9ydCB0aGUgYmFzZSBhcyB1bnJlYWRhYmxlIChmYWlsIGNsb3NlZCkuXG4gIGlmIChieUlkKSByZXR1cm4geyBuZXdCYXNlOiBudWxsLCBwclNlbGVjdG9yOiBudW1iZXIgfTtcbiAgY29uc3Qgb3duZXIgPSBzZWdtZW50c1sxXSE7XG4gIGNvbnN0IG5hbWUgPSBzZWdtZW50c1syXSE7XG4gIGNvbnN0IHBsYWNlaG9sZGVyID0gb3duZXIgPT09IFwie293bmVyfVwiIHx8IG5hbWUgPT09IFwie3JlcG99XCI7XG4gIGNvbnN0IHJlcG8gPSBwbGFjZWhvbGRlciA/IHVuZGVmaW5lZCA6IGAke293bmVyfS8ke25hbWV9YDtcbiAgcmV0dXJuIHtcbiAgICBuZXdCYXNlOiBiYXNlLFxuICAgIC4uLihyZXBvID8geyByZXBvIH0gOiB7fSksXG4gICAgcHJTZWxlY3RvcjogbnVtYmVyLFxuICB9O1xufVxuXG4vKiogVmVyZGljdCBmb3IgYSByZXF1ZXN0ZWQgYmFzZSBjaGFuZ2UuICovXG5leHBvcnQgdHlwZSBQckJhc2VDaGFuZ2VEZWNpc2lvbiA9XG4gIHwgeyBhbGxvd2VkOiB0cnVlIH1cbiAgfCB7IGFsbG93ZWQ6IGZhbHNlOyByZWFzb246IHN0cmluZyB9O1xuXG4vKipcbiAqIERlY2lkZSB3aGV0aGVyIGEgUFIgbWF5IG1vdmUgZnJvbSBgY3VycmVudEJhc2VgIHRvIGBuZXdCYXNlYC5cbiAqXG4gKiBBIG1pbGVzdG9uZS1maXggUFIgbWF5IG9ubHkgZXZlciB0YXJnZXQgaXRzIG93biBtaWxlc3RvbmUgYnJhbmNoOyBhbnkgUFIgb25cbiAqIGEgbWlsZXN0b25lIGJyYW5jaCBtYXkgb25seSBtb3ZlIHRvIGFub3RoZXIgbWlsZXN0b25lIGJyYW5jaC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlY2lkZVByQmFzZUNoYW5nZShcbiAgaW5wdXQ6IHsgaGVhZFJlZk5hbWU6IHN0cmluZzsgY3VycmVudEJhc2U6IHN0cmluZzsgbmV3QmFzZTogc3RyaW5nIHwgbnVsbCB9LFxuKTogUHJCYXNlQ2hhbmdlRGVjaXNpb24ge1xuICBjb25zdCB7IGhlYWRSZWZOYW1lLCBjdXJyZW50QmFzZSwgbmV3QmFzZSB9ID0gaW5wdXQ7XG4gIGlmIChuZXdCYXNlID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFsbG93ZWQ6IGZhbHNlLFxuICAgICAgcmVhc29uOiBcInRoZSByZXF1ZXN0ZWQgYmFzZSBjb3VsZCBub3QgYmUgcmVhZCwgZmFpbGluZyBjbG9zZWRcIixcbiAgICB9O1xuICB9XG4gIGlmIChpc01pbGVzdG9uZUZpeEJyYW5jaChoZWFkUmVmTmFtZSkpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZU1pbGVzdG9uZUZpeEhlYWQoaGVhZFJlZk5hbWUpO1xuICAgIGNvbnN0IG93biA9IHBhcnNlZCAhPT0gdW5kZWZpbmVkICYmIGlzTWlsZXN0b25lQnJhbmNoKG5ld0Jhc2UpICYmXG4gICAgICBoZWFkUmVmTmFtZS5zdGFydHNXaXRoKFxuICAgICAgICBtaWxlc3RvbmVGaXhQcmVmaXhGb3IobmV3QmFzZSwgcGFyc2VkLm1pbGVzdG9uZVByTnVtYmVyKSxcbiAgICAgICk7XG4gICAgcmV0dXJuIG93biA/IHsgYWxsb3dlZDogdHJ1ZSB9IDoge1xuICAgICAgYWxsb3dlZDogZmFsc2UsXG4gICAgICByZWFzb246IFwibWlsZXN0b25lLWZpeCBQUnMgb25seSBldmVyIHRhcmdldCB0aGVpciBtaWxlc3RvbmUgYnJhbmNoXCIsXG4gICAgfTtcbiAgfVxuICBpZiAoaXNNaWxlc3RvbmVCcmFuY2goY3VycmVudEJhc2UpICYmICFpc01pbGVzdG9uZUJyYW5jaChuZXdCYXNlKSkge1xuICAgIHJldHVybiB7XG4gICAgICBhbGxvd2VkOiBmYWxzZSxcbiAgICAgIHJlYXNvbjogXCJtb3ZpbmcgYSBQUiBvZmYgYSBtaWxlc3RvbmUgYnJhbmNoIHB1dHMgdGhlIG1pbGVzdG9uZSdzIHdvcmsgXCIgK1xuICAgICAgICBcIm9uIGEgbm9uLW1pbGVzdG9uZSBiYXNlIHdpdGhvdXQgdGhlIG1pbGVzdG9uZSdzIGZpbmFsIHJldmlld1wiLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgYWxsb3dlZDogdHJ1ZSB9O1xufVxuXG4vKiogVGhyb3duIHdoZW4gYSBiYXNlIGNoYW5nZSBpcyByZWZ1c2VkLiAqL1xuZXhwb3J0IGNsYXNzIFByQmFzZUNoYW5nZVJlZnVzZWRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJQckJhc2VDaGFuZ2VSZWZ1c2VkRXJyb3JcIjtcbiAgfVxufVxuXG4vKiogRGVwZW5kZW5jaWVzIG9mIHtAbGluayBlbmZvcmNlUHJCYXNlQ2hhbmdlR3VhcmR9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBQckJhc2VDaGFuZ2VHdWFyZERlcHMge1xuICAvKiogUmVhZHMgdGhlIFBSJ3MgY3VycmVudCBoZWFkIGFuZCBiYXNlOyBtYXkgdGhyb3cuICovXG4gIGxvb2t1cDogKFxuICAgIGNoYW5nZTogUHJCYXNlQ2hhbmdlLFxuICApID0+IFByb21pc2U8eyBoZWFkUmVmTmFtZTogc3RyaW5nOyBiYXNlUmVmTmFtZTogc3RyaW5nIH0+O1xuICByZWFkQm9keUZpbGU/OiBQckJhc2VCb2R5UmVhZGVyO1xuICBsb2c6IChsaW5lOiBzdHJpbmcpID0+IHZvaWQ7XG59XG5cbi8qKlxuICogUmVmdXNlIGEgYmFzZSBjaGFuZ2UgdGhhdCB3b3VsZCBtb3ZlIGEgbWlsZXN0b25lIFBSIG9mZiBpdHMgbWlsZXN0b25lXG4gKiBicmFuY2guIEEgbm8tb3AgZm9yIGFueSBvdGhlciBjb21tYW5kLiBBIGZhaWxlZCBsb29rdXAgcmVmdXNlcy5cbiAqXG4gKiBAdGhyb3dzIFByQmFzZUNoYW5nZVJlZnVzZWRFcnJvciB3aGVuIHRoZSBjaGFuZ2UgaXMgcmVmdXNlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuZm9yY2VQckJhc2VDaGFuZ2VHdWFyZChcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGRlcHM6IFByQmFzZUNoYW5nZUd1YXJkRGVwcyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjaGFuZ2UgPSBjbGFzc2lmeVByQmFzZUNoYW5nZShhcmdzLCBkZXBzLnJlYWRCb2R5RmlsZSk7XG4gIGlmICghY2hhbmdlKSByZXR1cm47XG5cbiAgbGV0IGhlYWQgPSBcIjx1bmtub3duPlwiO1xuICBsZXQgY3VycmVudCA9IFwiPHVua25vd24+XCI7XG4gIGxldCByZWFzb246IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBwciA9IGF3YWl0IGRlcHMubG9va3VwKGNoYW5nZSk7XG4gICAgaGVhZCA9IHByLmhlYWRSZWZOYW1lO1xuICAgIGN1cnJlbnQgPSBwci5iYXNlUmVmTmFtZTtcbiAgICBjb25zdCB2ZXJkaWN0ID0gZGVjaWRlUHJCYXNlQ2hhbmdlKHtcbiAgICAgIGhlYWRSZWZOYW1lOiBoZWFkLFxuICAgICAgY3VycmVudEJhc2U6IGN1cnJlbnQsXG4gICAgICBuZXdCYXNlOiBjaGFuZ2UubmV3QmFzZSxcbiAgICB9KTtcbiAgICBpZiAoIXZlcmRpY3QuYWxsb3dlZCkgcmVhc29uID0gdmVyZGljdC5yZWFzb247XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmVhc29uID0gYGNvdWxkIG5vdCByZWFkIHRoZSBQUidzIGhlYWQgYW5kIGJhc2UgKCR7XG4gICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICB9KSwgZmFpbGluZyBjbG9zZWRgO1xuICB9XG4gIGlmIChyZWFzb24gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuXG4gIGNvbnN0IGxpbmUgPVxuICAgIGBbU0VDVVJJVFldIFtQUl9CQVNFX0NIQU5HRV9SRUZVU0VEXSByZXBvPSR7Y2hhbmdlLnJlcG8gPz8gXCI8Y3dkPlwifSBwcj0ke1xuICAgICAgY2hhbmdlLnByU2VsZWN0b3IgPz8gXCI8Y3dkPlwiXG4gICAgfSBoZWFkPSR7aGVhZH0gY3VycmVudEJhc2U9JHtjdXJyZW50fSBgICtcbiAgICBgbmV3QmFzZT0ke2NoYW5nZS5uZXdCYXNlID8/IFwiPHVucmVhZGFibGU+XCJ9IHJlYXNvbj0ke3JlYXNvbn1gO1xuICBkZXBzLmxvZyhsaW5lKTtcbiAgdGhyb3cgbmV3IFByQmFzZUNoYW5nZVJlZnVzZWRFcnJvcihsaW5lKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUMsR0FFRCxTQUFTLGtCQUFrQixRQUFRLGlDQUFpQztBQUNwRSxTQUFTLGVBQWUsUUFBUSxzQkFBc0I7QUFDdEQsU0FDRSxpQkFBaUIsRUFDakIsb0JBQW9CLEVBQ3BCLHFCQUFxQixRQUNoQiw4QkFBOEI7QUFtQnJDLG1EQUFtRCxHQUNuRCxNQUFNLHFCQUFxQjtBQUUzQjs7OztDQUlDLEdBQ0QsT0FBTyxTQUFTLHNCQUNkLElBQVk7RUFFWixNQUFNLFFBQVEsS0FBSyxLQUFLLENBQUM7RUFDekIsSUFBSSxDQUFDLE9BQU8sT0FBTztFQUNuQixN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
// denoCacheMetadata=4530945187962088237,6893124497379285892