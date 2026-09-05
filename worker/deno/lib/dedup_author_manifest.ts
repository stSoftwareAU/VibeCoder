/**
 * The shrink-only manifest of dedup searches that do **not** author-verify
 * their marker match (Issue #1097).
 *
 * A dedup search is the shape `gh issue list --search '"<MARKER>" in:body'`
 * (or `in:title`): find a marker somebody wrote, then decide whether to act.
 * On a public repository a body and a title are both text anyone who can
 * open an issue may write; only the **author** is authenticated. Trusting
 * the match on its own lets non-fleet content suppress the fleet's own
 * self-diagnostics — the defect #1095 closed for the five escalation
 * modules and #1100 closed for the ten sites whose marker drives a write.
 *
 * Fixing the instances does not fix the class. This shape spread by
 * copy-paste and nothing stopped the next copy: a new template that omits
 * `author` from its `--json` list looks exactly like the seventeen that
 * came before it. So this module holds the invariant instead —
 *
 * > every `--search` value carrying `in:body` or `in:title` must be paired
 * > with a `--json` field list that requests `author`
 *
 * — plus the explicit, **shrink-only** list of the sites that do not
 * satisfy it yet ({@link UNVERIFIED_DEDUP_MANIFEST}). The paired test
 * (`worker/deno/tests/dedup_author_manifest_test.ts`) fails in **both**
 * directions:
 *
 * - a dedup search that is neither author-verified nor on the manifest
 *   fails the build, so the class cannot grow back by copy-paste;
 * - a manifest entry whose site is now verified (or has gone away) fails
 *   the build as **stale**, so the list can only ever get shorter — fixing
 *   a site is not complete until its entry is deleted.
 *
 * {@link UNVERIFIED_DEDUP_SITE_CAP} states the remaining count as a number a
 * reviewer sees move in the diff. It may be lowered, never raised.
 *
 * **Scope, stated rather than implied.** The scanner reads `gh issue list`
 * and `gh pr list` argv arrays in the Deno source tree. It resolves a
 * `--search` value given inline or through a single-assignment `const` in
 * the same file; a search assembled at runtime from several fragments is
 * beyond a static scan and is not claimed to be covered. That boundary is
 * the reason the manifest carries a reason per entry rather than a bare
 * count — the list is the record of what is known, not proof that nothing
 * else exists.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/** Search qualifiers that make a match depend on untrusted text. */
export const UNTRUSTED_SEARCH_QUALIFIERS: readonly string[] = [
  "in:body",
  "in:title",
];

/**
 * Field-list constants known to request `author`.
 *
 * Both live in `alert_dedup_authors.ts`; a site passing one of them is
 * verified even though the literal string "author" is not at the call site.
 */
export const AUTHOR_CARRYING_FIELD_CONSTANTS: ReadonlySet<string> = new Set([
  "ALERT_DEDUP_JSON_FIELDS",
  "ALERT_DEDUP_TITLE_JSON_FIELDS",
]);

/** One dedup search found in the source tree. */
export interface DedupSearchSite {
  /** Repo-relative path of the file containing the search. */
  file: string;
  /** 1-based line of the `--search` value. */
  line: number;
  /** `issue`, `pr`, or `unknown` when the subcommand could not be read. */
  subcommand: string;
  /** The `--search` value, as written (interpolations included). */
  search: string;
  /** The `--json` value as written, or `null` when none was requested. */
  jsonFields: string | null;
  /** Whether the search requests `author` alongside the marker fields. */
  authorVerified: boolean;
}

/** One entry of the shrink-only manifest. */
export interface UnverifiedDedupEntry {
  /** Repo-relative path of the file containing the search. */
  file: string;
  /** The `--search` value, matched verbatim against the scanned site. */
  search: string;
  /** Why this site is not verified yet. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

/** A string literal or identifier lifted out of TypeScript source. */
interface SourceToken {
  kind: "string" | "ident";
  /** Literal text without the quotes, or the identifier name. */
  value: string;
  /** 1-based line the token starts on. */
  line: number;
}

/**
 * Read a quoted literal starting at `start`, returning its inner text.
 *
 * Handles backslash escapes and, for template literals, `${…}` spans so a
 * closing backtick inside an interpolation does not end the literal early.
 */
function readLiteral(
  source: string,
  start: number,
): { text: string; end: number } {
  const quote = source[start];
  let i = start + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`") {
      if (ch === "$" && source[i + 1] === "{") {
        depth++;
        i += 2;
        continue;
      }
      if (ch === "}" && depth > 0) {
        depth--;
        i++;
        continue;
      }
    }
    if (ch === quote && depth === 0) {
      return { text: source.slice(start + 1, i), end: i + 1 };
    }
    if (ch === "\n" && quote !== "`") {
      // Unterminated quoted string — bail rather than swallowing the file.
      return { text: source.slice(start + 1, i), end: i };
    }
    i++;
  }
  return { text: source.slice(start + 1), end: source.length };
}

/**
 * Lift the string literals and identifiers out of TypeScript source.
 *
 * Comments are skipped by the walk rather than stripped beforehand, so a
 * `//` inside a string literal cannot truncate it.
 *
 * @param source - Raw file text.
 * @returns Tokens in source order, each carrying its 1-based line.
 */
export function tokeniseSource(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      for (let j = i; j < end; j++) if (source[j] === "\n") line++;
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const startLine = line;
      const { text, end } = readLiteral(source, i);
      for (let j = i; j < end; j++) if (source[j] === "\n") line++;
      tokens.push({ kind: "string", value: text, line: startLine });
      i = end;
      continue;
    }
    if (ch !== undefined && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j] ?? "")) j++;
      tokens.push({ kind: "ident", value: source.slice(i, j), line });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** How far past `--search` a `--json` flag may sit and still be its pair. */
const JSON_FLAG_WINDOW = 12;
/** How far back from `--search` the `issue`/`pr` subcommand may sit. */
const SUBCOMMAND_WINDOW = 24;

/**
 * Does a `--json` field list request `author`?
 *
 * A field is the literal `author`, or an interpolation of one of the
 * {@link AUTHOR_CARRYING_FIELD_CONSTANTS} — `` `${ALERT_DEDUP_JSON_FIELDS},
 * labels` `` is how a site extends the shared list without losing the
 * author, and reading it as unverified would be wrong.
 *
 * @param fields - The `--json` value as written.
 * @returns True when the author travels with the match.
 */
export function fieldListRequestsAuthor(fields: string): boolean {
  return fields.split(",").map((field) => field.trim()).some((field) => {
    if (field === "author") return true;
    const interpolated = field.match(/^\$\{\s*([A-Za-z0-9_$]+)\s*\}$/)?.[1];
    return interpolated !== undefined &&
      AUTHOR_CARRYING_FIELD_CONSTANTS.has(interpolated);
  });
}

/** Map single-assignment `const NAME = "…"` string constants by name. */
function collectStringConstants(tokens: SourceToken[]): Map<string, string> {
  const constants = new Map<string, string>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    const keyword = tokens[i];
    const name = tokens[i + 1];
    const value = tokens[i + 2];
    if (!keyword || !name || !value) continue;
    if (keyword.kind !== "ident") continue;
    if (keyword.value !== "const" && keyword.value !== "let") continue;
    if (name.kind !== "ident" || value.kind !== "string") continue;
    // A name assigned twice is ambiguous; drop it rather than guess.
    constants.set(name.value, constants.has(name.value) ? "" : value.value);
  }
  return constants;
}

/** Resolve an argv token to its text, following a same-file `const`. */
function resolveArgText(
  token: SourceToken | undefined,
  constants: Map<string, string>,
): string | null {
  if (!token) return null;
  if (token.kind === "string") return token.value;
  return constants.get(token.value) ?? null;
}

/** Read the `issue` / `pr` subcommand preceding a `--search` flag. */
function readSubcommand(tokens: SourceToken[], searchIndex: number): string {
  const floor = Math.max(0, searchIndex - SUBCOMMAND_WINDOW);
  for (let i = searchIndex - 1; i > floor; i--) {
    const token = tokens[i];
    if (token?.kind !== "string" || token.value !== "list") continue;
    const before = tokens[i - 1];
    if (before?.kind === "string") return before.value;
    return "unknown";
  }
  return "unknown";
}

/**
 * Find every dedup search in one file's source.
 *
 * A site is a `--search` argument whose value carries `in:body` or
 * `in:title`. It counts as author-verified when the `--json` field list
 * paired with it requests `author` — literally, or through one of the
 * {@link AUTHOR_CARRYING_FIELD_CONSTANTS}. A search with no `--json` at all
 * cannot be verified and is reported unverified, not skipped: absence of a
 * field list is not evidence the author was checked.
 *
 * @param source - Raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each site.
 * @returns One entry per dedup search, in source order.
 */
export function scanContentForDedupSearches(
  source: string,
  repoRelPath: string,
): DedupSearchSite[] {
  const tokens = tokeniseSource(source);
  const constants = collectStringConstants(tokens);
  const sites: DedupSearchSite[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.kind !== "string" || token.value !== "--search") continue;
    const search = resolveArgText(tokens[i + 1], constants);
    if (search === null) continue;
    if (!UNTRUSTED_SEARCH_QUALIFIERS.some((q) => search.includes(q))) continue;

    let jsonFields: string | null = null;
    let authorVerified = false;
    const ceiling = Math.min(tokens.length, i + JSON_FLAG_WINDOW);
    for (let j = i + 2; j < ceiling; j++) {
      const flag = tokens[j];
      if (flag?.kind !== "string" || flag.value !== "--json") continue;
      const value = tokens[j + 1];
      if (!value) break;
      jsonFields = value.value;
      authorVerified = value.kind === "string"
        ? fieldListRequestsAuthor(value.value)
        : AUTHOR_CARRYING_FIELD_CONSTANTS.has(value.value);
      break;
    }

    sites.push({
      file: repoRelPath,
      line: tokens[i + 1]?.line ?? token.line,
      subcommand: readSubcommand(tokens, i),
      search,
      jsonFields,
      authorVerified,
    });
  }

  return sites;
}

/** Recursively walk a directory yielding `.ts` file paths (absolute). */
async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(fullPath);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}

/**
 * Scan the given repo-relative directories for dedup searches.
 *
 * @param repoRoot - Absolute repo root (trailing slash optional).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Every dedup search found, sorted by file then line.
 */
export async function scanDirectoriesForDedupSearches(
  repoRoot: string,
  relDirs: readonly string[],
): Promise<DedupSearchSite[]> {
  const root = repoRoot.replace(/\/$/, "");
  const sites: DedupSearchSite[] = [];
  for (const relDir of relDirs) {
    for await (const absFile of walkTsFiles(`${root}/${relDir}`)) {
      const repoRel = absFile.slice(root.length + 1);
      const content = await Deno.readTextFile(absFile);
      sites.push(...scanContentForDedupSearches(content, repoRel));
    }
  }
  sites.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
  );
  return sites;
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** Directories the manifest audit covers. */
export const DEDUP_SCAN_DIRS: readonly string[] = [
  "worker/deno/lib",
  "worker/deno/commands",
  "worker/deno/setup",
];

/** Shared reason: an idle-task wrapper dedup keyed on the issue title. */
const IDLE_TASK_WRAPPER_REASON =
  "Idle-task wrapper dedup keyed on the issue title; an unverified match " +
  "stands the scan down for that repository (silence class, as #1095). " +
  "Queued behind the escalation and action sites fixed in #1095/#1100.";

/** One idle-task wrapper entry — the seventeen differ only by title. */
function idleTaskWrapper(module: string, title: string): UnverifiedDedupEntry {
  return {
    file: `worker/deno/lib/idle_task_templates/${module}`,
    search: `"\${${title}}" in:title`,
    reason: IDLE_TASK_WRAPPER_REASON,
  };
}

/**
 * The dedup searches that do not author-verify their match yet.
 *
 * **Shrink-only.** Add nothing here: a new dedup search must request
 * `author` from the start. Remove an entry the moment its site is fixed —
 * the paired test fails on a stale entry as loudly as on an unlisted site,
 * and {@link UNVERIFIED_DEDUP_SITE_CAP} must be lowered to match.
 *
 * Draining this list to zero is tracked by Issue #1106.
 */
export const UNVERIFIED_DEDUP_MANIFEST: readonly UnverifiedDedupEntry[] = [
  {
    file: "worker/deno/lib/audit_failure_notifier.ts",
    search: "${title} in:title",
    reason:
      "Audit-failure alert dedup keyed on the issue title; an unverified " +
      "match suppresses the alert (silence class, as #1095).",
  },
  {
    file: "worker/deno/lib/baseline_carryover_tracker.ts",
    search: '"${title}" in:title',
    reason: "Quality-gate carryover tracker dedup keyed on the title; an " +
      "unverified match suppresses the needs-human tracker.",
  },
  {
    file: "worker/deno/lib/idle_task_backfill.ts",
    search: '"${queriedTitle}" in:title',
    reason:
      "Orphan-wrapper backfill: the title match selects which issue gets " +
      "the idle-task label written, so an unverified match drives a write " +
      "rather than silence. The label check and the timeline " +
      "deliberate-removal guard narrow it; neither authenticates the author.",
  },
  {
    file: "worker/deno/lib/issue_query.ts",
    search: "in:title (#${issueNumber}) OR in:title (Issue #${issueNumber})",
    reason:
      "PR-title search deciding whether work is already in progress. The " +
      "row is a PR, not an issue, so the fix is `--json author` on " +
      "`gh pr list` plus a head-branch check rather than the issue helper.",
  },
  {
    file: "worker/deno/setup/best_practices_sync.ts",
    search: '"${BEST_PRACTICES_MARKER}" in:body',
    reason:
      "Sibling of setup/best_practices_relabel.ts (fixed in #1100): the " +
      "marker selects the issue the sync comments on and updates, so an " +
      "unverified match redirects a write onto an issue the fleet never " +
      "opened. The highest-value entry to remove next.",
  },
  idleTaskWrapper("alert_feed_template.ts", "ALERT_FEED_ISSUE_TITLE"),
  idleTaskWrapper(
    "bash_script_refs_template.ts",
    "BASH_SCRIPT_REFS_ISSUE_TITLE",
  ),
  idleTaskWrapper(
    "bash_syntax_audit_template.ts",
    "BASH_SYNTAX_AUDIT_ISSUE_TITLE",
  ),
  idleTaskWrapper("best_practices_template.ts", "BEST_PRACTICES_ISSUE_TITLE"),
  idleTaskWrapper("dead_code_template.ts", "DEAD_CODE_ISSUE_TITLE"),
  idleTaskWrapper("deprecated_api_template.ts", "DEPRECATED_API_ISSUE_TITLE"),
  idleTaskWrapper("doc_coverage_template.ts", "DOC_COVERAGE_ISSUE_TITLE"),
  idleTaskWrapper(
    "documentation_audit_template.ts",
    "DOCUMENTATION_AUDIT_ISSUE_TITLE",
  ),
  idleTaskWrapper(
    "duplicated_knowledge_template.ts",
    "DUPLICATED_KNOWLEDGE_ISSUE_TITLE",
  ),
  idleTaskWrapper("format_drift_template.ts", "FORMAT_DRIFT_ISSUE_TITLE"),
  idleTaskWrapper(
    "github_actions_audit_template.ts",
    "GITHUB_ACTIONS_AUDIT_ISSUE_TITLE",
  ),
  idleTaskWrapper("orphan_deps_template.ts", "ORPHAN_DEPS_ISSUE_TITLE"),
  idleTaskWrapper(
    "private_repo_reference_template.ts",
    "PRIVATE_REPO_REFERENCE_ISSUE_TITLE",
  ),
  idleTaskWrapper("retro_template.ts", "RETRO_ISSUE_TITLE"),
  idleTaskWrapper(
    "supply_chain_readiness_template.ts",
    "SUPPLY_CHAIN_READINESS_ISSUE_TITLE",
  ),
  idleTaskWrapper("test_audit_template.ts", "TEST_AUDIT_ISSUE_TITLE"),
  idleTaskWrapper(
    "workflow_annotation_scan_template.ts",
    "WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE",
  ),
];

/**
 * The number of unverified dedup searches this codebase still carries.
 *
 * A literal, not `UNVERIFIED_DEDUP_MANIFEST.length` — derived from the list
 * it would agree with the list by construction and assert nothing. Written
 * out, the number moves visibly in the diff whenever the list does.
 *
 * **May be lowered, never raised.**
 */
export const UNVERIFIED_DEDUP_SITE_CAP = 22;

/** The outcome of auditing scanned sites against the manifest. */
export interface DedupManifestAudit {
  /** Unverified sites with no manifest entry — the class growing back. */
  unlisted: DedupSearchSite[];
  /** Manifest entries with no matching unverified site — now stale. */
  stale: UnverifiedDedupEntry[];
}

/**
 * Audit scanned dedup searches against the shrink-only manifest.
 *
 * Both directions are reported, because both are failures: an unlisted
 * unverified site is the class spreading again, and a stale entry is a fix
 * that never shrank the list it was supposed to shrink.
 *
 * @param sites - Sites found by the scanner.
 * @param manifest - The shrink-only manifest to audit against.
 * @returns Unlisted sites and stale entries.
 */
export function auditDedupManifest(
  sites: readonly DedupSearchSite[],
  manifest: readonly UnverifiedDedupEntry[] = UNVERIFIED_DEDUP_MANIFEST,
): DedupManifestAudit {
  const key = (file: string, search: string) => `${file} ${search}`;
  const unverified = new Set(
    sites.filter((s) => !s.authorVerified).map((s) => key(s.file, s.search)),
  );
  const listed = new Set(manifest.map((e) => key(e.file, e.search)));

  return {
    unlisted: sites.filter(
      (s) => !s.authorVerified && !listed.has(key(s.file, s.search)),
    ),
    stale: manifest.filter((e) => !unverified.has(key(e.file, e.search))),
  };
}
