/**
 * Export scrub gate: block the export when a private identifier survives in
 * the staged tree (Issue #4196, Phase 3 of the #4160 proving-ground plan).
 *
 * `export-public.sh` stages the allowlisted subset of the private tree, runs
 * the branding transform (#4197), then runs this gate over the **staged tree**
 * before anything is committed. Any unallowlisted finding fails the export;
 * there is no flag that disables the gate. The private tree itself is out of
 * scope — those strings are legitimate there; the gate's job is to stop them
 * crossing the boundary.
 *
 * Pattern classes:
 *
 *   From the identifiers file (`export/scrub-identifiers.txt`, kept in the
 *   private tree and never exported — so this source file can be published
 *   without carrying the operator's names):
 *   - `account`     operator account names (GitHub logins, host users)
 *   - `hostname`    internal host names
 *   - `telemetry`   the private telemetry repository's names and paths
 *   - `identifier`  anything else the operator lists
 *
 *   Built in (shape-based, no operator specifics):
 *   - `email`            an e-mail address, except RFC 2606 reserved
 *                        domains and well-known no-reply senders
 *   - `home-path`        `/Users/<name>` or `/home/<name>` unless `<name>`
 *                        is an obvious placeholder (`$VAR`, `<you>`,
 *                        `operator`, `runner`, all-caps, one or two letters)
 *   - `api-key`          a 32-hex imgbb-shaped key or a well-known token
 *                        prefix (`ghp_`, `github_pat_`, `sk-ant-`, `AKIA`,
 *                        `xox?-`, `glpat-`, a PEM private-key header)
 *   - `private-repo`     `stSoftwareAU/<repo>` — name, slug, clone path or
 *                        URL — for any repo not declared `public-repo:` in
 *                        the identifiers file (a *direct reference* in the
 *                        private-repo-reference audit's sense; concept-level
 *                        mentions and documentation placeholders such as
 *                        `stSoftwareAU/foo` do not match)
 *   - `branding-residue` the old product name in any casing/separator the
 *                        transform did not clear (the spaced generic phrase
 *                        "vibe coding" is not the product name and passes)
 *
 * Every finding carries path, 1-based line (0 for a hit in the path itself),
 * class, a mask of the match (first two and last two characters) and a short
 * excerpt in which **every** finding on that line is masked. The raw match
 * is used only to apply the allowlist and never leaves this module.
 *
 * Allowlist (`export/scrub-allowlist.txt`, stored beside the manifest so
 * exceptions are visible in review): one entry per line,
 * `<class> <path-or-dir/> <match|masked|*>`, and the line directly above
 * each entry must be a `#` comment justifying it — an entry without one is
 * a gate error, not a silent exemption.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  decodeTextOrNull,
  listTreeFiles,
  topLevelDirectory,
} from "./export_tree.ts";

/** Classes sourced from the identifiers file. */
export const IDENTIFIER_CLASSES = [
  "account",
  "hostname",
  "telemetry",
  "identifier",
] as const;

/** Built-in shape classes. */
export const BUILTIN_CLASSES = [
  "private-repo",
  "api-key",
  "email",
  "home-path",
  "branding-residue",
] as const;

export type IdentifierClass = (typeof IDENTIFIER_CLASSES)[number];
export type BuiltinClass = (typeof BUILTIN_CLASSES)[number];
export type FindingClass = IdentifierClass | BuiltinClass;

const ALL_CLASSES: readonly string[] = [
  ...IDENTIFIER_CLASSES,
  ...BUILTIN_CLASSES,
];

function isFindingClass(value: string): value is FindingClass {
  return ALL_CLASSES.includes(value);
}

// =============================================================================
// Identifiers file
// =============================================================================

/** One compiled operator pattern. */
export interface IdentifierPattern {
  klass: IdentifierClass;
  /** The entry as written, for error messages (never printed in the report). */
  source: string;
  regex: RegExp;
}

/**
 * How `stSoftwareAU/<name>` references are judged (Issue #4196):
 *
 * - `publicRepos` — public repositories; referenced freely.
 * - `placeholderRepos` — documentation/test fixture names (`foo`, `SomeRepo`,
 *   `repo-a`) that are not repositories at all; left as written.
 * - `privatePatterns` — the operator's private repositories; the redaction
 *   stage maps each to a numbered placeholder wherever the name appears.
 * - anything else is *unknown*: the gate blocks it (a new private repository
 *   must be classified, never assumed harmless), and the redaction stage
 *   still hides it in slug form.
 */
export interface RepoPolicy {
  publicRepos: readonly string[];
  placeholderRepos: readonly string[];
  privatePatterns: readonly RegExp[];
}

/** Parsed identifiers file. */
export interface ParsedIdentifiers {
  patterns: IdentifierPattern[];
  /** `stSoftwareAU` repositories that are public and may be referenced. */
  publicRepos: string[];
  /** The full repository policy (public / placeholder / private / unknown). */
  repoPolicy: RepoPolicy;
  errors: string[];
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse `class: value` lines. A `/regex/` value (optional `i` flag) is used
 * as written; a plain literal matches as a whole word, case-insensitively.
 * `public-repo: Name` declares a public repository. Blank lines and `#`
 * comments are ignored. An empty pattern list is an error: a gate with no
 * operator identifiers is a weaker gate, never a passing one.
 */
export function parseIdentifiers(text: string): ParsedIdentifiers {
  const patterns: IdentifierPattern[] = [];
  const publicRepos: string[] = [];
  const placeholderRepos: string[] = [];
  const privatePatterns: RegExp[] = [];
  const errors: string[] = [];

  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const where = `identifiers line ${index + 1}`;
    const colon = line.indexOf(":");
    if (colon === -1) {
      errors.push(`${where}: expected "<class>: <value>"`);
      return;
    }
    const klass = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value === "") {
      errors.push(`${where}: empty value for class "${klass}"`);
      return;
    }
    if (klass === "public-repo") {
      publicRepos.push(value);
      return;
    }
    if (klass === "placeholder-repo") {
      placeholderRepos.push(value);
      return;
    }
    if (klass === "private-repo") {
      const compiled = compileRepoName(value);
      if (compiled === null) {
        errors.push(`${where}: invalid regular expression`);
        return;
      }
      privatePatterns.push(compiled);
      return;
    }
    if (!(IDENTIFIER_CLASSES as readonly string[]).includes(klass)) {
      errors.push(
        `${where}: unknown class "${klass}" (expected one of ` +
          `${
            IDENTIFIER_CLASSES.join(", ")
          }, public-repo, placeholder-repo, private-repo)`,
      );
      return;
    }
    const compiled = compileIdentifier(value);
    if (compiled === null) {
      errors.push(`${where}: invalid regular expression`);
      return;
    }
    patterns.push({
      klass: klass as IdentifierClass,
      source: line,
      regex: compiled,
    });
  });

  if (patterns.length === 0) {
    errors.push(
      "identifiers file declares no patterns — the gate needs at least one " +
        `${IDENTIFIER_CLASSES.join("/")} entry`,
    );
  }
  return {
    patterns,
    publicRepos,
    repoPolicy: { publicRepos, placeholderRepos, privatePatterns },
    errors,
  };
}

/** A repository-name value: `/regex/i` as written, or a whole-name literal. */
function compileRepoName(value: string): RegExp | null {
  const regexForm = /^\/(.+)\/(i?)$/.exec(value);
  try {
    // The value comes from the operator's private identifiers file, and a
    // literal is metacharacter-escaped before compilation.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    if (regexForm) return new RegExp(regexForm[1]!, regexForm[2] ?? "");
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    return new RegExp(`^${escapeRegExp(value)}$`, "i");
  } catch {
    return null;
  }
}

/**
 * Compile an identifiers-file value: `/regex/` (optional `i`) as written, a
 * plain literal as a whole word, case-insensitively. Shared with the
 * redaction transform (Issue #4197) so both read the same syntax.
 */
export function compileIdentifier(value: string): RegExp | null {
  const regexForm = /^\/(.+)\/(i?)$/.exec(value);
  try {
    if (regexForm) {
      return new RegExp(regexForm[1]!, `g${regexForm[2] ?? ""}`);
    }
    return new RegExp(
      `(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`,
      "gi",
    );
  } catch {
    return null;
  }
}

// =============================================================================
// Built-in shapes
// =============================================================================

const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Reserved / documentation domains (RFC 2606, RFC 6761) and no-reply senders. */
const EMAIL_EXEMPT_DOMAIN_SUFFIXES = [
  "example.com",
  "example.org",
  "example.net",
  ".example",
  ".invalid",
  ".test",
  ".localhost",
  // GitHub's per-user no-reply domain — an alias, never a mailbox.
  "users.noreply.github.com",
];
const EMAIL_EXEMPT_ADDRESSES = new Set([
  "noreply@github.com",
  "noreply@anthropic.com",
  "git@github.com",
  "git@gitlab.com",
  "git@bitbucket.org",
]);

/**
 * `scheme://user:secret@host` is URL userinfo, not an e-mail address; the
 * redaction fixtures use that shape deliberately and the api-key class is
 * the one that judges credential material.
 */
function isUrlUserinfo(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 96), index);
  return /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/@]*$/.test(before);
}

function isExemptEmail(address: string): boolean {
  const lower = address.toLowerCase();
  if (EMAIL_EXEMPT_ADDRESSES.has(lower)) return true;
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return EMAIL_EXEMPT_DOMAIN_SUFFIXES.some((suffix) =>
    suffix.startsWith(".") ? domain.endsWith(suffix) : domain === suffix ||
      domain.endsWith(`.${suffix}`)
  );
}

const HOME_PATH_RE = /\/(?:Users|home)\/([^/\s"'`<>|;:,)}\]]+)/g;

/** Role words that name a placeholder user, not a person. */
const HOME_PLACEHOLDER_NAMES = new Set([
  "operator",
  "op",
  "user",
  "username",
  "users",
  "you",
  "me",
  "worker",
  "vibe",
  "vibe-coder",
  "vibecoder",
  "bot",
  "runner",
  "admin",
  "root",
  "ubuntu",
  "ci",
  "example",
  "someone",
  "anyone",
  "name",
  "yourname",
  "your-name",
  "your_name",
  "dev",
  "developer",
  "test",
  "tester",
  "alice",
  "bob",
  "default",
  "logs",
  "home",
]);

function isPlaceholderHome(name: string): boolean {
  if (name.length <= 2) return true;
  if (/^[${<%*~[.]/.test(name)) return true;
  if (/^[A-Z0-9_-]+$/.test(name)) return true;
  return HOME_PLACEHOLDER_NAMES.has(name.toLowerCase());
}

const API_KEY_RES: readonly RegExp[] = [
  // imgbb-shaped: exactly 32 lowercase hex, not part of a longer hex run.
  /(?<![0-9a-fA-F])[0-9a-f]{32}(?![0-9a-fA-F])/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

/** `stSoftwareAU/<name>` — the organisation is public; the name may not be. */
export const PRIVATE_REPO_RE = /\bstSoftwareAU\/([A-Za-z0-9_.-]+)/gi;

/** Repository names that are documentation placeholders, not repositories. */
const PRIVATE_REPO_PLACEHOLDERS = new Set([
  "foo",
  "bar",
  "baz",
  "repo",
  "repo-name",
  "my-repo",
  "your-repo",
  "some-repo",
  "example",
  "project",
  "name",
  "owner",
  // CI folder syntax: `job/<org>/job/<name>` — `job` is a keyword, not
  // a repository.
  "job",
]);

const BRANDING_RESIDUE_RE = /vibe[-_]?coding/gi;

/**
 * How an `stSoftwareAU/<name>` reference is classed: a declared public
 * repository, a documentation placeholder (`foo`, `repo-a`…), or private.
 * Shared with the redaction transform so it never renames a public one.
 */
export function classifyRepoName(
  name: string,
  policy: RepoPolicy | readonly string[],
): "public" | "placeholder" | "private" | "unknown" {
  const p: RepoPolicy = Array.isArray(policy)
    ? { publicRepos: policy, placeholderRepos: [], privatePatterns: [] }
    : policy as RepoPolicy;
  const bare = name.replace(/\.git$/i, "").replace(/\.+$/, "");
  const repo = bare.toLowerCase();
  if (repo === "") return "placeholder";
  if (p.publicRepos.some((r) => r.toLowerCase() === repo)) return "public";
  if (PRIVATE_REPO_PLACEHOLDERS.has(repo)) return "placeholder";
  if (p.placeholderRepos.some((r) => r.toLowerCase() === repo)) {
    return "placeholder";
  }
  // The redaction stage's own output: a numbered placeholder is not a name.
  if (/^private-repo-\d+$/.test(repo)) return "placeholder";
  if (p.privatePatterns.some((re) => re.test(bare))) return "private";
  return "unknown";
}

// =============================================================================
// Scanning
// =============================================================================

/** A finding with its raw match — internal to scanning and allowlisting. */
export interface RawFinding {
  path: string;
  /** 1-based line; 0 when the hit is in the path itself. */
  line: number;
  klass: FindingClass;
  /** Column (0-based) within the line. */
  column: number;
  /** The matched text. Never printed; used only for the allowlist. */
  match: string;
  /** Mask of the match: first two and last two characters. */
  masked: string;
  /** Short context with every finding on the line masked. */
  excerpt: string;
  allowlisted: boolean;
}

/** Mask a matched value: `ac…ot`; one visible character for short values. */
export function maskMatch(value: string): string {
  if (value.length <= 4) return `${value.slice(0, 1)}…`;
  return `${value.slice(0, 2)}…${value.slice(-2)}`;
}

interface Span {
  klass: FindingClass;
  start: number;
  end: number;
}

function collectSpans(
  line: string,
  patterns: IdentifierPattern[],
  policy: RepoPolicy | readonly string[],
): Span[] {
  const spans: Span[] = [];
  const add = (klass: FindingClass, start: number, end: number): void => {
    for (const s of spans) {
      if (start < s.end && end > s.start) return; // overlaps an earlier class
    }
    spans.push({ klass, start, end });
  };
  const forEach = (
    re: RegExp,
    klass: FindingClass,
    keep: (m: RegExpMatchArray) => boolean = () => true,
  ): void => {
    for (const m of line.matchAll(re)) {
      if (!keep(m)) continue;
      const start = m.index ?? 0;
      add(klass, start, start + m[0].length);
    }
  };

  // Operator identifiers first, in file order (the more specific entry wins
  // an overlap when the operator lists it first).
  for (const p of patterns) forEach(p.regex, p.klass);

  forEach(
    PRIVATE_REPO_RE,
    "private-repo",
    (m) => {
      const kind = classifyRepoName(m[1] ?? "", policy);
      return kind === "private" || kind === "unknown";
    },
  );
  for (const re of API_KEY_RES) forEach(re, "api-key");
  forEach(
    EMAIL_RE,
    "email",
    (m) => !isExemptEmail(m[0]) && !isUrlUserinfo(line, m.index ?? 0),
  );
  forEach(HOME_PATH_RE, "home-path", (m) => !isPlaceholderHome(m[1] ?? ""));
  forEach(BRANDING_RESIDUE_RE, "branding-residue");

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

const EXCERPT_CONTEXT = 16;

/** Build the masked excerpts for every span on a line. */
function excerptsFor(line: string, spans: Span[]): string[] {
  // Rebuild the line with each span replaced by its mask, remembering where
  // each mask landed so the excerpt can be centred on it.
  let masked = "";
  let cursor = 0;
  const positions: { start: number; end: number }[] = [];
  for (const span of spans) {
    masked += line.slice(cursor, span.start);
    const mask = maskMatch(line.slice(span.start, span.end));
    positions.push({ start: masked.length, end: masked.length + mask.length });
    masked += mask;
    cursor = span.end;
  }
  masked += line.slice(cursor);
  masked = masked.replace(/\s+/g, " ");

  return positions.map(({ start, end }) => {
    const from = Math.max(0, start - EXCERPT_CONTEXT);
    const to = Math.min(masked.length, end + EXCERPT_CONTEXT);
    return (from > 0 ? "…" : "") + masked.slice(from, to) +
      (to < masked.length ? "…" : "");
  });
}

/** Scan one file's text. Pure: no I/O. */
export function scanText(
  text: string,
  path: string,
  patterns: IdentifierPattern[],
  policy: RepoPolicy | readonly string[],
): RawFinding[] {
  const findings: RawFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const spans = collectSpans(line, patterns, policy);
    if (spans.length === 0) continue;
    const excerpts = excerptsFor(line, spans);
    spans.forEach((span, n) => {
      const match = line.slice(span.start, span.end);
      findings.push({
        path,
        line: i + 1,
        klass: span.klass,
        column: span.start,
        match,
        masked: maskMatch(match),
        excerpt: excerpts[n]!,
        allowlisted: false,
      });
    });
  }
  return findings;
}

/** Scan a staged path itself (reported at line 0). Pure: no I/O. */
export function scanPath(
  path: string,
  patterns: IdentifierPattern[],
  policy: RepoPolicy | readonly string[],
): RawFinding[] {
  const spans = collectSpans(path, patterns, policy);
  const excerpts = excerptsFor(path, spans);
  return spans.map((span, n) => {
    const match = path.slice(span.start, span.end);
    return {
      path,
      line: 0,
      klass: span.klass,
      column: span.start,
      match,
      masked: maskMatch(match),
      excerpt: excerpts[n]!,
      allowlisted: false,
    };
  });
}

// =============================================================================
// Allowlist
// =============================================================================

/** One reviewed exception. */
export interface AllowlistEntry {
  klass: FindingClass;
  /** Exact staged path, or a directory prefix ending in `/`. */
  path: string;
  /** The exact match, its masked form, or `*` for any value. */
  match: string;
  /** 1-based line in the allowlist file. */
  line: number;
  /** The justifying comment directly above the entry. */
  comment: string;
}

/** Parsed allowlist. */
export interface ParsedAllowlist {
  entries: AllowlistEntry[];
  errors: string[];
}

/**
 * Parse the allowlist. Every entry must have a `#` comment on the line
 * directly above it — a blank line or another entry in between does not
 * count, so each exception carries its own justification.
 */
export function parseAllowlist(text: string): ParsedAllowlist {
  const entries: AllowlistEntry[] = [];
  const errors: string[] = [];
  const lines = text.split("\n");

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const where = `allowlist line ${index + 1}`;
    const above = index > 0 ? lines[index - 1]!.trim() : "";
    if (!above.startsWith("#")) {
      errors.push(
        `${where}: entry has no justifying comment on the line directly ` +
          `above it`,
      );
      return;
    }
    const tokens = line.split(/\s+/);
    if (tokens.length < 3) {
      errors.push(`${where}: expected "<class> <path> <match>"`);
      return;
    }
    const [klass, path] = [tokens[0]!, tokens[1]!];
    const match = tokens.slice(2).join(" ");
    if (!isFindingClass(klass)) {
      errors.push(`${where}: unknown class "${klass}"`);
      return;
    }
    if (path.startsWith("/") || path.split("/").includes("..")) {
      errors.push(`${where}: path must be staged-tree relative: ${path}`);
      return;
    }
    entries.push({
      klass,
      path,
      match,
      line: index + 1,
      comment: above.replace(/^#\s*/, ""),
    });
  });
  return { entries, errors };
}

function entryCovers(entry: AllowlistEntry, finding: RawFinding): boolean {
  if (entry.klass !== finding.klass) return false;
  const pathMatches = entry.path.endsWith("/")
    ? finding.path.startsWith(entry.path)
    : finding.path === entry.path;
  if (!pathMatches) return false;
  return entry.match === "*" || entry.match === finding.match ||
    entry.match === finding.masked;
}

/** Result of {@link applyAllowlist}. */
export interface AllowlistOutcome {
  findings: RawFinding[];
  /** Entries that covered nothing — stale, reported for tidying. */
  unused: AllowlistEntry[];
}

/** Mark the findings the allowlist covers. */
export function applyAllowlist(
  findings: RawFinding[],
  entries: AllowlistEntry[],
): AllowlistOutcome {
  const used = new Set<AllowlistEntry>();
  const marked = findings.map((finding) => {
    let allowlisted = false;
    for (const entry of entries) {
      if (entryCovers(entry, finding)) {
        allowlisted = true;
        used.add(entry);
      }
    }
    return { ...finding, allowlisted };
  });
  return {
    findings: marked,
    unused: entries.filter((entry) => !used.has(entry)),
  };
}

// =============================================================================
// Tree scan and report
// =============================================================================

/** A finding as reported — the raw match is not carried. */
export interface GateFinding {
  path: string;
  line: number;
  klass: FindingClass;
  masked: string;
  excerpt: string;
  allowlisted: boolean;
}

/** The gate report. Safe to print and to serialise: no raw values. */
export interface GateReport {
  tree: string;
  filesScanned: number;
  filesSkippedBinary: number;
  findings: GateFinding[];
  blocking: number;
  allowlisted: number;
  /** Identifier-file and allowlist errors; any of these fails the gate. */
  errors: string[];
  allowlistEntries: number;
  unusedAllowlist: AllowlistEntry[];
  /** Blocking findings per class. */
  perClass: Record<string, number>;
  /** Blocking findings per top-level directory, per class. */
  perTopDir: Record<string, Record<string, number>>;
}

/** Options for {@link scanTree}. */
export interface ScanTreeOptions {
  tree: string;
  identifiersText: string;
  allowlistText?: string;
}

/** True when the report lets the export proceed. */
export function gatePasses(report: GateReport): boolean {
  return report.errors.length === 0 && report.blocking === 0;
}

/** Scan every text file (and every path) beneath `tree`. */
export async function scanTree(options: ScanTreeOptions): Promise<GateReport> {
  const identifiers = parseIdentifiers(options.identifiersText);
  const allowlist = parseAllowlist(options.allowlistText ?? "");
  const errors = [...identifiers.errors, ...allowlist.errors];

  const raw: RawFinding[] = [];
  let filesScanned = 0;
  let filesSkippedBinary = 0;
  for (const rel of await listTreeFiles(options.tree)) {
    raw.push(...scanPath(rel, identifiers.patterns, identifiers.repoPolicy));
    const text = decodeTextOrNull(
      await Deno.readFile(`${options.tree}/${rel}`),
    );
    if (text === null) {
      filesSkippedBinary++;
      continue;
    }
    filesScanned++;
    raw.push(
      ...scanText(text, rel, identifiers.patterns, identifiers.repoPolicy),
    );
  }

  const outcome = applyAllowlist(raw, allowlist.entries);
  const perClass: Record<string, number> = {};
  const perTopDir: Record<string, Record<string, number>> = {};
  let blocking = 0;
  let allowlisted = 0;
  const findings: GateFinding[] = outcome.findings.map((f) => {
    if (f.allowlisted) {
      allowlisted++;
    } else {
      blocking++;
      perClass[f.klass] = (perClass[f.klass] ?? 0) + 1;
      const top = topLevelDirectory(f.path);
      const bucket = perTopDir[top] ?? (perTopDir[top] = {});
      bucket[f.klass] = (bucket[f.klass] ?? 0) + 1;
    }
    return {
      path: f.path,
      line: f.line,
      klass: f.klass,
      masked: f.masked,
      excerpt: f.excerpt,
      allowlisted: f.allowlisted,
    };
  });

  return {
    tree: options.tree,
    filesScanned,
    filesSkippedBinary,
    findings,
    blocking,
    allowlisted,
    errors,
    allowlistEntries: allowlist.entries.length,
    unusedAllowlist: outcome.unused,
    perClass,
    perTopDir,
  };
}

function classCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([klass, n]) => `${klass}=${n}`)
    .join(" ");
}

/** Render the report for the operator. Never prints a raw match. */
export function formatGateReport(report: GateReport): string {
  const lines: string[] = [
    "Scrub gate report (Issue #4196)",
    `tree: ${report.tree}`,
    `files-scanned: ${report.filesScanned}`,
    `files-skipped-binary: ${report.filesSkippedBinary}`,
    `findings: ${report.findings.length} total, ${report.blocking} blocking, ` +
    `${report.allowlisted} allowlisted`,
    `allowlist: ${report.allowlistEntries} entries, ` +
    `${report.unusedAllowlist.length} unused`,
  ];
  if (report.errors.length > 0) {
    lines.push(`verdict: BLOCKED (${report.errors.length} gate error(s))`);
  } else if (report.blocking > 0) {
    lines.push(
      `verdict: BLOCKED (${report.blocking} blocking finding(s): ` +
        `${classCounts(report.perClass)})`,
    );
  } else {
    lines.push("verdict: PASS (0 blocking findings)");
  }
  lines.push("");

  if (report.errors.length > 0) {
    lines.push("--- Gate errors ---");
    for (const e of report.errors) lines.push(`  ${e}`);
    lines.push("");
  }

  const blocking = report.findings.filter((f) => !f.allowlisted);
  if (blocking.length > 0) {
    lines.push(
      "--- Blocking findings (path:line, class, redacted excerpt) ---",
    );
    for (const f of blocking) {
      lines.push(`  [${f.klass}] ${f.path}:${f.line}  ${f.excerpt}`);
    }
    lines.push("");
    lines.push("--- Blocking findings per top-level directory ---");
    for (
      const [dir, counts] of Object.entries(report.perTopDir).sort(([a], [b]) =>
        a.localeCompare(b)
      )
    ) {
      lines.push(`  ${dir}: ${classCounts(counts)}`);
    }
    lines.push("");
  }

  const allowed = report.findings.filter((f) => f.allowlisted);
  if (allowed.length > 0) {
    lines.push("--- Allowlisted findings ---");
    for (const f of allowed) {
      lines.push(
        `  [${f.klass}] ${f.path}:${f.line}  ${f.excerpt}  (allowlisted)`,
      );
    }
    lines.push("");
  }

  if (report.unusedAllowlist.length > 0) {
    lines.push("--- Unused allowlist entries (stale; consider removing) ---");
    for (const e of report.unusedAllowlist) {
      lines.push(`  line ${e.line}: ${e.klass} ${e.path}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
