/**
 * Parser for in-code suppression comments.
 *
 * Recognises two finding families:
 *   - `security-scan` — finding IDs use the `SEC-<hex>` prefix.
 *   - `best-practices` — finding IDs use the `BP-` prefix, either
 *     `BP-<hex>` or a prefix-style id such as
 *     `BP-SHA-PIN-<owner>-<action-slug>` (Issue #2501). The
 *     `best-practices`, `test-audit`, `github-actions-audit`,
 *     `supply-chain-readiness`, and `orphan-deps` scans all share this
 *     `BP-` id space — a per-template discriminator baked into the hash
 *     keeps their ids disjoint, so a `BP-` suppression only ever silences
 *     the one finding whose id matches (Issue #2908).
 *
 * Each family has the same set of recognised marker forms (keyword
 * matching is case-insensitive; `SEC-` ids are lowercase hex, `BP-` ids
 * accept `[A-Za-z0-9-]`). The `best-practices` family additionally
 * accepts an `orphan-deps-ignore` keyword as a synonym for
 * `best-practice-ignore` so an orphan-dependency finding can be silenced
 * with an explicitly-named marker (Issue #2908):
 *
 *   `# noqa: <ID> — reason`                          (hash-comment langs)
 *   `// eslint-disable-next-line <ID> — reason`      (slash-comment langs)
 *   `// security-scan-ignore: <ID> — reason`         (security-scan family)
 *   `# security-scan-ignore: <ID> — reason`          (security-scan family)
 *   `/* security-scan-ignore: <ID> — reason *\/`     (security-scan family)
 *   `// best-practice-ignore: <ID> — reason`         (best-practices family)
 *   `# best-practice-ignore: <ID> — reason`          (best-practices family)
 *   `/* best-practice-ignore: <ID> — reason *\/`     (best-practices family)
 *   `// orphan-deps-ignore: <ID> — reason`           (best-practices family)
 *   `# orphan-deps-ignore: <ID> — reason`            (best-practices family)
 *   `/* orphan-deps-ignore: <ID> — reason *\/`       (best-practices family)
 *
 * Each suppression record carries the `family` it belongs to so a
 * scanner only sees suppressions targeting its own findings and a
 * `security-scan-ignore` does not silently hide a best-practices
 * finding (and vice versa). Issue #2146.
 *
 * ## Governance (Issue #3712)
 *
 * A marker used to need nothing but a finding id, so an unattributed,
 * unexplained, never-expiring waiver could silence a finding forever. The
 * reason text is now a structured trailer and every field is mandatory:
 *
 *   `// security-scan-ignore: SEC-<id> — author=<login> expires=<YYYY-MM-DD> <reason>`
 *
 * A marker missing any of author / expiry / reason, carrying a malformed
 * or past expiry, or naming an author outside the configured allowlist,
 * still **parses** — it is recorded and reported — but never suppresses
 * anything ({@link isSuppressed} honours only `valid` records). The
 * allowlist fails closed (Issue #3941): with no allowlist configured at
 * all — neither on the policy nor via
 * {@link setSuppressionAuthorAllowlist} — every marker is rejected,
 * because an unverifiable `author=` field is no attribution. Every
 * parsed marker also lands in a process-scoped registry so each scan run
 * can report which waivers are active ({@link renderSuppressionSummary}).
 *
 * Pure functions apart from that registry. Uses Australian English
 * throughout.
 */

export type SupportedLanguage =
  | "ts"
  | "js"
  | "py"
  | "go"
  | "rs"
  | "java"
  | "rb"
  | "sh"
  | "unknown";

/** Which scanner family this suppression belongs to. */
export type FindingFamily = "security-scan" | "best-practices";

export interface SuppressionRecord {
  /** The finding ID this suppression targets — `SEC-<hex>` or `BP-…`. */
  id: string;
  /** 1-based line number where the suppression comment appears. */
  line: number;
  /** Free-form reason text, with the `author=`/`expires=` fields removed. */
  reason: string;
  /** Which scanner family this suppression applies to. */
  family: FindingFamily;
  /** GitHub login from the `author=` field, when present. */
  author?: string;
  /** Expiry date (`YYYY-MM-DD`) from the `expires=` field, when present. */
  expiry?: string;
  /** Source file the marker was found in, when the caller supplied one. */
  file?: string;
  /** True only when author, expiry and reason all satisfy the policy. */
  valid: boolean;
  /** Why the marker was rejected, when `valid` is false. */
  invalidReason?: string;
}

/** Governance policy applied to every parsed marker (Issue #3712). */
export interface SuppressionPolicy {
  /** Reference date (`YYYY-MM-DD`) expiry is compared against. */
  today?: string;
  /**
   * Logins authorised to author a suppression, matched case-insensitively.
   * When absent or empty the process-wide allowlist configured via
   * {@link setSuppressionAuthorAllowlist} applies instead; when neither
   * names any login, every marker is rejected — an unauthenticated
   * `author=` field is attribution theatre, not attribution, so the gate
   * fails closed (Issue #3941).
   */
  allowedAuthors?: readonly string[];
  /** Source file recorded on each record (and in the run report). */
  file?: string;
}

// ---------------------------------------------------------------------------
// Comment-marker capability per language
// ---------------------------------------------------------------------------

const SLASH_LANGS = new Set<SupportedLanguage>([
  "ts",
  "js",
  "go",
  "rs",
  "java",
]);
const HASH_LANGS = new Set<SupportedLanguage>(["py", "rb", "sh"]);
const BLOCK_LANGS = new Set<SupportedLanguage>([
  "ts",
  "js",
  "go",
  "rs",
  "java",
]);

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------
//
// Each pattern captures: (1) the finding ID, (2) the reason text after an
// optional separator. The keyword is matched case-insensitively; `SEC-`
// ids are restricted to lowercase hex, while `BP-` ids accept the broader
// `[A-Za-z0-9-]` charset so prefix-style ids (BP-SHA-PIN-…) are matched.
//
// The separator between ID and reason may be an em-dash, double hyphen,
// single hyphen, or just whitespace. Patterns are written as regex literals
// (not `new RegExp(variable)`) to avoid the detect-non-literal-regexp
// semgrep finding.
//
// Block comments are matched by a *prefix* pattern that stops at the finding
// id (Issue #3942). The previous single pattern spanned the whole comment —
// `…(?:(?:\s*(?:—|--|-)\s*|\s+)(.*?))?\s*\*\/` — whose three ambiguous
// whitespace quantifiers could all match the same characters, so an
// unterminated `/*` marker followed by a long whitespace run backtracked
// cubically and stalled the single-threaded worker. The closing `*/` and the
// reason text are now located with `indexOf` and two anchored, linear
// separator patterns instead.

interface FamilyPatterns {
  family: FindingFamily;
  hashNoqa: RegExp;
  hashGeneric: RegExp;
  slashEslint: RegExp;
  slashGeneric: RegExp;
  /** Matches `/* keyword: <id>` only — see {@link matchBlock}. */
  blockPrefix: RegExp;
}

// Security-scan family — SEC-<hex> IDs
const SECURITY_SCAN_PATTERNS: FamilyPatterns = {
  family: "security-scan",
  hashNoqa: /#\s*noqa\s*:\s*(SEC-[a-f0-9]+)(?:(?:\s*(?:—|--|-)\s*|\s+)(.*))?$/i,
  hashGeneric:
    /#\s*security-scan-ignore\s*:\s*(SEC-[a-f0-9]+)(?:(?:\s*(?:—|--|-)\s*|\s+)(.*))?$/i,
  slashEslint:
    /\/\/\s*eslint-disable-next-line\s+(SEC-[a-f0-9]+)(?:(?:\s*(?:—|--|-)\s*|\s+)(.*))?$/i,
  slashGeneric:
    /\/\/\s*security-scan-ignore\s*:\s*(SEC-[a-f0-9]+)(?:(?:\s*(?:—|--|-)\s*|\s+)(.*))?$/i,
  blockPrefix:
    /\/\*\s*security-scan-ignore\s*:\s*(SEC-[a-f0-9]+)(?=[\s*—-]|$)/i,
};

// Best-practices family — BP-<hex> and prefix-style ids
// (e.g. BP-SHA-PIN-<owner>-<action-slug>, BP-STALE-ACTION-…). The id
// charset is `[A-Za-z0-9-]` rather than hex-only so the native pre-filer
// findings whose ids carry an upper-case prefix and hyphens are
// suppressible too (Issue #2501). The separator group keeps reason text
// after a space, em-dash, `-`, or `--` out of the captured id.
// The keyword is a non-capturing alternation so an orphan-dependency
// finding can be silenced with the explicitly-named `orphan-deps-ignore`
// synonym as well as `best-practice-ignore` (Issue #2908) — both target
// the shared `BP-` id space.
const BEST_PRACTICES_PATTERNS: FamilyPatterns = {
  family: "best-practices",
  hashNoqa:
    /#\s*noqa\s*:\s*(BP-[A-Za-z0-9-]+)(?:(?:\s*(?:—|--|-)\s*|\s+)(.*))?$/i,
  hashGeneric:
    /#\s*(?:best-practice-ignore|orphan-deps-ignore)\s*:\s*(BP-[A-Za-z0-9-]+)(?:(?:\s*(?:—|--|-)\s*|\s+)(.*))?$/i,
  slashEslint:
    /\/\/\s*eslint-disable-next-line\s+(BP-[A-Za-z0-9-]+)(?:(?:\s*(?:—|--|-)\s*|\s+)(.*))?$/i,
  slashGeneric:
    /\/\/\s*(?:best-practice-ignore|orphan-deps-ignore)\s*:\s*(BP-[A-Za-z0-9-]+)(?:(?:\s*(?:—|--|-)\s*|\s+)(.*))?$/i,
  blockPrefix:
    /\/\*\s*(?:best-practice-ignore|orphan-deps-ignore)\s*:\s*(BP-[A-Za-z0-9-]+)(?=[\s*—-]|$)/i,
};

const ALL_PATTERNS: readonly FamilyPatterns[] = [
  SECURITY_SCAN_PATTERNS,
  BEST_PRACTICES_PATTERNS,
];

/**
 * Longest line a suppression marker may live on (Issue #3942).
 *
 * Defence in depth behind the linear-time patterns above: the parser is fed
 * attacker-influenced text — every line of a fork's lockfile, on the worker's
 * only thread — so the per-line cost is bounded by a cap as well as by the
 * patterns. A real marker (keyword, id, author, expiry, reason) is well under
 * 2,000 characters; a longer line is minified or generated output, never a
 * hand-written waiver.
 *
 * Skipping the whole line is the fail-safe direction: a suppression that is
 * not parsed leaves its finding **visible**, so an over-long line can never
 * be used to hide one.
 */
export const MAX_SUPPRESSION_LINE_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Governance — author, expiry, reason (Issue #3712)
// ---------------------------------------------------------------------------

/** `author=<login>` field. GitHub logins are `[A-Za-z0-9-]`. */
const AUTHOR_FIELD = /(?:^|\s)author\s*=\s*([A-Za-z0-9][A-Za-z0-9-]*)/i;
/** `expires=<value>` / `expiry=<value>` field — value validated separately. */
const EXPIRY_FIELD = /(?:^|\s)(?:expires|expiry)\s*=\s*(\S+)/i;
/** Strict `YYYY-MM-DD` shape; calendar validity is checked in code. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is `value` a real calendar date in `YYYY-MM-DD` form? */
function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

/** Today in UTC as `YYYY-MM-DD`. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Process-wide suppression author allowlist (Issue #3941).
 *
 * Set once at config load from the worker's trusted-author list, so every
 * call path — including the deep pure helpers that never see a
 * `WorkerConfig` — enforces the same allowlist. A per-call
 * `SuppressionPolicy.allowedAuthors` overrides it.
 */
let configuredAuthorAllowlist: readonly string[] = [];

/** Configure the process-wide suppression author allowlist (Issue #3941). */
export function setSuppressionAuthorAllowlist(
  authors: readonly string[],
): void {
  configuredAuthorAllowlist = [...authors];
}

/** Clear the configured allowlist. Test-only helper. */
export function _resetSuppressionAuthorAllowlist(): void {
  configuredAuthorAllowlist = [];
}

/** Split the marker trailer into its `author`, `expiry` and reason parts. */
function parseTrailer(
  trailer: string,
): { author?: string; expiry?: string; reason: string } {
  const author = AUTHOR_FIELD.exec(trailer)?.[1];
  const expiry = EXPIRY_FIELD.exec(trailer)?.[1];
  const reason = trailer
    .replace(AUTHOR_FIELD, " ")
    .replace(EXPIRY_FIELD, " ")
    .replace(/^[\s—:-]+/, "")
    .trim();
  return {
    ...(author ? { author } : {}),
    ...(expiry ? { expiry } : {}),
    reason,
  };
}

/**
 * Apply the governance policy to one parsed marker.
 *
 * @returns The rejection reason, or `null` when the marker is honoured.
 */
function rejectionReason(
  parts: { author?: string; expiry?: string; reason: string },
  policy: SuppressionPolicy,
): string | null {
  if (!parts.author) {
    return "missing author — add `author=<github-login>`";
  }
  // Issue #3941: the `author=` field is free text until it is checked
  // against an allowlist, so no allowlist at all means no verifiable
  // author — fail closed rather than accepting attribution theatre.
  const allowed = policy.allowedAuthors && policy.allowedAuthors.length > 0
    ? policy.allowedAuthors
    : configuredAuthorAllowlist;
  if (allowed.length === 0) {
    return "no suppression author allowlist is configured — the author " +
      "cannot be verified, so the marker is rejected";
  }
  if (!allowed.some((a) => a.toLowerCase() === parts.author?.toLowerCase())) {
    return `author ${parts.author} is not authorised to suppress findings`;
  }
  if (!parts.expiry) {
    return "missing expiry — add `expires=<YYYY-MM-DD>`";
  }
  if (!isCalendarDate(parts.expiry)) {
    return `malformed expiry ${parts.expiry} — expected YYYY-MM-DD`;
  }
  if (parts.expiry < (policy.today ?? todayUtc())) {
    return `expired on ${parts.expiry}`;
  }
  if (parts.reason.length === 0) {
    return "missing reason — explain why the finding is being waived";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-run registry (Issue #3712)
// ---------------------------------------------------------------------------

/** Every marker parsed this process, in first-seen order. */
const registry: SuppressionRecord[] = [];
/** Dedup key set so re-scanning a file does not double-report a marker. */
const registryKeys = new Set<string>();

/** Stable identity of a marker for dedup purposes. */
function registryKey(record: SuppressionRecord): string {
  return `${record.file ?? ""}:${record.line}:${record.id}`;
}

/** Every suppression marker parsed so far this run, in first-seen order. */
export function recordedSuppressions(): readonly SuppressionRecord[] {
  return registry;
}

/** Clear the run registry. Used by tests and by long-lived processes. */
export function resetSuppressionRegistry(): void {
  registry.length = 0;
  registryKeys.clear();
}

/** Render one record as `SEC-… file:line (author, expires …)`. */
function formatRecord(record: SuppressionRecord): string {
  const where = `${record.file ?? "<unknown>"}:${record.line}`;
  const who = record.author ?? "no author";
  const when = record.expiry ?? "no expiry";
  return `${record.id} ${where} (${who}, expires ${when})`;
}

/**
 * Render the one-line suppression report for a scan run.
 *
 * Every scan report carries this so an active waiver is visible in the
 * run's own output rather than only in the source it silences.
 *
 * @param records - Records to report on (default: the run registry)
 * @returns The report, or `""` when no marker was seen at all
 */
export function renderSuppressionSummary(
  records: readonly SuppressionRecord[] = registry,
): string {
  if (records.length === 0) return "";
  const active = records.filter((r) => r.valid);
  const rejected = records.filter((r) => !r.valid);
  const parts: string[] = [];
  if (active.length > 0) {
    parts.push(
      `Active suppressions (${active.length}): ${
        active.map(formatRecord).join("; ")
      }.`,
    );
  }
  if (rejected.length > 0) {
    parts.push(
      `Rejected suppressions (${rejected.length}): ${
        rejected
          .map((r) => `${formatRecord(r)} — ${r.invalidReason ?? "invalid"}`)
          .join("; ")
      }.`,
    );
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `fileContent` for suppression comments matching the language's
 * comment markers. Returns one record per recognised suppression, in
 * source order. Each record carries its `family` so callers can
 * filter to the scanner that issued the finding, and a `valid` verdict
 * from the governance policy (Issue #3712) — a marker that fails the
 * policy is still returned and reported, but never suppresses.
 *
 * Unknown languages return an empty array — without a known comment
 * syntax we cannot tell a real suppression from coincidental text. Lines
 * longer than {@link MAX_SUPPRESSION_LINE_CHARS} are skipped unparsed
 * (Issue #3942).
 */
export function findSuppressions(
  fileContent: string,
  language: SupportedLanguage,
  policy: SuppressionPolicy = {},
): SuppressionRecord[] {
  if (language === "unknown") {
    return [];
  }

  const supportsSlash = SLASH_LANGS.has(language);
  const supportsHash = HASH_LANGS.has(language);
  const supportsBlock = BLOCK_LANGS.has(language);

  const records: SuppressionRecord[] = [];
  const lines = fileContent.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;

    // Over-long lines are skipped unparsed (Issue #3942) — see
    // MAX_SUPPRESSION_LINE_CHARS. Skipping only ever loses a waiver, so a
    // finding stays visible rather than being silently suppressed.
    if (line.length > MAX_SUPPRESSION_LINE_CHARS) continue;

    const hit = matchLine(line, {
      supportsSlash,
      supportsHash,
      supportsBlock,
    });
    if (hit) {
      const parts = parseTrailer(hit.reason);
      const rejected = rejectionReason(parts, policy);
      const record: SuppressionRecord = {
        id: hit.id,
        line: lineNumber,
        reason: parts.reason,
        family: hit.family,
        ...(parts.author ? { author: parts.author } : {}),
        ...(parts.expiry ? { expiry: parts.expiry } : {}),
        ...(policy.file ? { file: policy.file } : {}),
        valid: rejected === null,
        ...(rejected ? { invalidReason: rejected } : {}),
      };
      records.push(record);
      const key = registryKey(record);
      if (!registryKeys.has(key)) {
        registryKeys.add(key);
        registry.push(record);
      }
    }
  }

  return records;
}

interface LineCapabilities {
  supportsSlash: boolean;
  supportsHash: boolean;
  supportsBlock: boolean;
}

interface LineHit {
  id: string;
  reason: string;
  family: FindingFamily;
}

/** Em-dash / `--` / `-` separator between the id and the reason text. */
const DASH_SEPARATOR = /^\s*(?:—|--|-)\s*/;
/** Whitespace-only separator between the id and the reason text. */
const SPACE_SEPARATOR = /^\s+/;

/**
 * Match a `/* keyword: <id> — reason *\/` block marker on one line.
 *
 * The prefix (up to and including the id) is matched by regex; the closing
 * `*\/` is then located with `indexOf` and the reason is what lies between,
 * minus one leading separator. Splitting it this way keeps every step linear
 * in the line length — the single all-in-one pattern this replaced backtracked
 * cubically on an unterminated marker (Issue #3942).
 *
 * @returns The hit, or `null` when the line carries no terminated marker.
 */
function matchBlock(line: string, patterns: FamilyPatterns): LineHit | null {
  const m = patterns.blockPrefix.exec(line);
  if (!m) return null;
  const afterId = m.index + m[0].length;
  // A block marker must be closed on the same line, exactly as before.
  const close = line.indexOf("*/", afterId);
  if (close === -1) return null;
  const reason = line
    .slice(afterId, close)
    .replace(DASH_SEPARATOR, "")
    .replace(SPACE_SEPARATOR, "")
    .trim();
  return { id: m[1] ?? "", reason, family: patterns.family };
}

function matchLine(line: string, caps: LineCapabilities): LineHit | null {
  for (const patterns of ALL_PATTERNS) {
    // Block comments are checked first because `/* ... */` may appear on a
    // line that also contains other punctuation.
    if (caps.supportsBlock) {
      const block = matchBlock(line, patterns);
      if (block) return block;
    }
    if (caps.supportsSlash) {
      const e = patterns.slashEslint.exec(line);
      if (e) {
        return {
          id: e[1] ?? "",
          reason: (e[2] ?? "").trim(),
          family: patterns.family,
        };
      }
      const g = patterns.slashGeneric.exec(line);
      if (g) {
        return {
          id: g[1] ?? "",
          reason: (g[2] ?? "").trim(),
          family: patterns.family,
        };
      }
    }
    if (caps.supportsHash) {
      const n = patterns.hashNoqa.exec(line);
      if (n) {
        return {
          id: n[1] ?? "",
          reason: (n[2] ?? "").trim(),
          family: patterns.family,
        };
      }
      const g = patterns.hashGeneric.exec(line);
      if (g) {
        return {
          id: g[1] ?? "",
          reason: (g[2] ?? "").trim(),
          family: patterns.family,
        };
      }
    }
  }
  return null;
}

/**
 * Does any suppression in `suppressions` apply to a finding with ID
 * `findingId` on line `findingLine`?
 *
 * A suppression applies when it sits on the same line as the finding,
 * or on the line immediately above it — consistent with how
 * `eslint-disable-next-line` and similar pragmas work.
 *
 * Family separation is implicit: the `SEC-` and `BP-` ID prefixes are
 * disjoint, so a finding ID will only match suppressions in its own
 * family. Callers that want defence-in-depth can pre-filter
 * `suppressions` with {@link filterByFamily} before calling this.
 *
 * Only records that passed the governance policy (`valid: true`) can
 * suppress (Issue #3712) — an unattributed, unexplained, expired, or
 * never-expiring marker leaves its finding visible.
 */
export function isSuppressed(
  findingId: string,
  suppressions: SuppressionRecord[],
  findingLine: number,
): boolean {
  for (const s of suppressions) {
    if (!s.valid) continue;
    if (s.id !== findingId) continue;
    if (s.line === findingLine || s.line === findingLine - 1) {
      return true;
    }
  }
  return false;
}

/**
 * Return only the suppressions belonging to `family`. Useful for
 * passing a single scanner's suppressions to {@link isSuppressed}.
 */
export function filterByFamily(
  suppressions: SuppressionRecord[],
  family: FindingFamily,
): SuppressionRecord[] {
  return suppressions.filter((s) => s.family === family);
}
