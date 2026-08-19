/**
 * Native ecosystem orphan-detector pre-filer (Issue #2907, parent #2902).
 *
 * Deterministic, heavily unit-tested native scanner that emits
 * high-confidence orphan / unmaintained findings **before** the LLM phase
 * of the `orphan-deps` idle-task template. It mirrors the
 * `github-actions-audit` native pre-filers
 * (`action_pin_scanner.ts`, `run_injection_scanner.ts`,
 * `workflow_permissions_scanner.ts`, …): the decidable core is reproducible
 * and cheap, and the LLM is reserved for judgement (ambiguous abandonment
 * calls, transitive reasoning, replacement suggestions the scanner cannot
 * derive deterministically). Pre-filing the unambiguous cases keeps the
 * filed findings corroborated and low-noise.
 *
 * Scope (Issue #2907): **Deno/JSR + npm first.** Cargo and GitHub Actions
 * are **explicitly deferred** to follow-ups — when a manifest for a deferred
 * ecosystem is present the scanner records it in `deferred` and calls
 * `logFn` so the deferral is never a silent skip (no silent caps).
 *
 * Network sanctioning is **not** this module's job. The scanner is the
 * deterministic decision core; the actual registry/source-host metadata is
 * supplied by an injected {@link OrphanMetadataProvider}. The sanctioned,
 * allow-listed, gated metadata helper is delivered by the network-sanction
 * sub-issue (#2906) and wired in as the production provider; here the
 * default is a safe null provider so the module never reaches the network on
 * its own and tests stay offline.
 *
 * Detection signals (mirroring `prompts/orphan_deps/`):
 *   - `ORPHAN-DEPRECATED` — registry `deprecated` flag set, or the
 *     package/version is yanked (`severity:high`, strong signal).
 *   - `ORPHAN-ARCHIVED`   — the declared source repository is archived
 *     (`severity:high`, strong signal).
 *   - `ORPHAN-STALE`      — no publish within the staleness threshold
 *     (default 24 months) and no stronger signal (`severity:low`, weak).
 *
 * Each finding carries a stable `BP-<12 hex>` id computed via the shared
 * recipe `{ repo, "orphan-deps", check-class-prefix, dependency }` so its id
 * never collides with another scan's findings, and is added to the LLM
 * phase's known-open list so the prompt does not re-emit it.
 *
 * Findings are **issue-only** — the orphan-deps scan never raises a PR.
 *
 * Australian English spelling used throughout (behaviour, organisation,
 * authorised).
 */

import { makeStableId } from "./workflow_scan_common.ts";
import {
  filterByFamily,
  findSuppressions,
  isSuppressed,
} from "./suppression_comments.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discriminator baked into every stable id (collision-proofs the recipe). */
export const ORPHAN_DEPS_DISCRIMINATOR = "orphan-deps";

/** Default staleness threshold: no publish within 24 months. */
export const DEFAULT_STALE_MONTHS = 24;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Ecosystems this pre-filer handles natively (Deno/JSR + npm first). */
export type OrphanEcosystem = "npm" | "jsr";

/** Ecosystems explicitly deferred to follow-ups by Issue #2907. */
export type DeferredEcosystem = "cargo" | "github-actions";

/** The check-class prefix — also the stable-id prefix component. */
export type OrphanSignal =
  | "ORPHAN-DEPRECATED"
  | "ORPHAN-ARCHIVED"
  | "ORPHAN-STALE";

/** Severity band attached as exactly one `severity:<level>` label. */
export type OrphanSeverity = "high" | "medium" | "low";

/** A manifest/lockfile already read into memory (path + raw text). */
export interface ManifestFile {
  /** Repo-relative path, e.g. `package.json` or `deno.json`. */
  path: string;
  /** Full file contents. */
  rawText: string;
}

/** A single declared direct dependency extracted from a manifest. */
export interface OrphanDependency {
  /** Which ecosystem declared it. */
  ecosystem: OrphanEcosystem;
  /** Package name (`chalk`, `@scope/pkg`, `@std/assert`). */
  name: string;
  /** Declared/resolved version or range, or `null` when absent. */
  version: string | null;
  /** Manifest the dependency was declared in. */
  manifestPath: string;
  /** 1-based line of the declaration (for evidence + suppression). */
  line: number;
}

/**
 * Sanctioned metadata for one dependency. Every field is optional — the
 * provider returns only what it could resolve. A missing/`null` field is
 * treated as "no signal"; the scanner never asserts an unbacked claim.
 */
export interface OrphanMetadata {
  /** npm `deprecated` message (non-empty ⇒ deprecated). */
  deprecated?: string | null;
  /** ISO timestamp of the most recent publish, if known. */
  lastPublishIso?: string | null;
  /** True when the declared source repository is archived. */
  sourceArchived?: boolean | null;
  /** True when the package/version is yanked (JSR / crates). */
  yanked?: boolean | null;
  /** Declared source repository URL (cited in evidence). */
  sourceRepoUrl?: string | null;
}

/**
 * The sanctioned metadata helper, injected into the scanner. The production
 * implementation (the allow-listed, gated helper from #2906) performs the
 * read-only registry / source-host GETs; tests inject a stub so no real
 * network is touched. Implementations MUST NOT throw — return `null` when
 * metadata cannot be resolved.
 */
export interface OrphanMetadataProvider {
  fetch(dep: OrphanDependency): Promise<OrphanMetadata | null>;
}

/** A corroborated orphan-dependency finding ready to be filed. */
export interface OrphanDepsFinding {
  /** Stable `BP-<12 hex>` id (embedded as the `<!-- finding-id: … -->`). */
  findingId: string;
  /** The corroborating signal class. */
  signal: OrphanSignal;
  /** Severity band. */
  severity: OrphanSeverity;
  /** Ecosystem the dependency belongs to. */
  ecosystem: OrphanEcosystem;
  /** Dependency name. */
  dependency: string;
  /** Declared version/range, or `null`. */
  version: string | null;
  /** Manifest the dependency was declared in. */
  manifestPath: string;
  /** 1-based declaration line. */
  line: number;
  /** Issue title (carries the severity emoji + check-class prefix). */
  title: string;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Evidence` block (metadata citation + manifest line). */
  evidence: string;
  /**
   * Suggested maintained replacement when the scanner can derive it
   * deterministically (e.g. from the npm `deprecated` message), else
   * `null` — the slot is then populated by the LLM phase.
   */
  suggestedReplacement: string | null;
}

/** Options for {@link scanOrphanDeps}. */
export interface ScanOrphanDepsOptions {
  /** Target repo in `owner/repo` form (part of the stable-id recipe). */
  repo: string;
  /** Manifest/lockfiles already read into memory. */
  files: readonly ManifestFile[];
  /** Sanctioned metadata helper (injected; defaults to the null provider). */
  provider?: OrphanMetadataProvider;
  /** Stable ids suppressed by prior triage — skip these. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these. */
  knownOpenFindingIds?: Iterable<string>;
  /** Staleness threshold in months (default {@link DEFAULT_STALE_MONTHS}). */
  staleMonths?: number;
  /** Injected clock (default system time) — keeps staleness tests stable. */
  now?: () => Date;
  /** Optional logger for deferral notices (no silent caps). */
  logFn?: (message: string) => void;
}

/** Result of a scan: corroborated findings plus any deferred ecosystems. */
export interface OrphanDepsScanResult {
  /** Corroborated findings, sorted by stable id for deterministic output. */
  findings: OrphanDepsFinding[];
  /** Deferred ecosystems detected but not scanned (cargo, GitHub Actions). */
  deferred: DeferredEcosystem[];
}

// ---------------------------------------------------------------------------
// Null metadata provider (safe default — never touches the network)
// ---------------------------------------------------------------------------

/**
 * Default provider that resolves no metadata. Keeps the scanner offline by
 * default; the production sanctioned helper (#2906) replaces it at the
 * call-site. With this provider the scan emits zero findings.
 */
export const nullOrphanMetadataProvider: OrphanMetadataProvider = {
  fetch: () => Promise.resolve(null),
};

// ---------------------------------------------------------------------------
// Manifest classification
// ---------------------------------------------------------------------------

/**
 * Classify a manifest file by its basename. Returns the native ecosystem,
 * the deferred ecosystem, or `null` when the file is not a dependency
 * manifest the scanner recognises.
 *
 * Pure — no I/O.
 */
export function classifyManifest(
  path: string,
): "npm" | "deno" | DeferredEcosystem | null {
  const base = path.split("/").pop() ?? path;
  if (base === "package.json") return "npm";
  if (base === "deno.json" || base === "deno.jsonc") return "deno";
  if (base === "Cargo.toml" || base === "Cargo.lock") return "cargo";
  // GitHub Actions workflows live under `.github/workflows/`.
  if (/(^|\/)\.github\/workflows\/.+\.ya?ml$/.test(path)) {
    return "github-actions";
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSONC support (deno.jsonc may carry // and /* */ comments)
// ---------------------------------------------------------------------------

/**
 * Strip `//` line comments, `/* … *\/` block comments, and trailing commas
 * from a JSONC document, preserving string literals (so `"https://…"` and a
 * `//` inside a string are not mistaken for a comment). Returns plain JSON.
 *
 * Pure — no I/O.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      // Skip to end of line.
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // lands on the closing '/'
      continue;
    }
    out += ch;
  }
  // Drop trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// ---------------------------------------------------------------------------
// Specifier parsing (Deno import map values)
// ---------------------------------------------------------------------------

/**
 * Parse a Deno import-map specifier value into `{ ecosystem, name, version }`,
 * or `null` when it is not an `npm:` / `jsr:` specifier this scanner handles.
 *
 * Examples:
 *   `npm:chalk@5`            → { npm,  chalk,        5 }
 *   `npm:@scope/pkg@1.2.3`   → { npm,  @scope/pkg,   1.2.3 }
 *   `jsr:@std/assert@^1.0.0` → { jsr,  @std/assert,  ^1.0.0 }
 *   `https://deno.land/x/y`  → null (not an npm:/jsr: specifier)
 *
 * Pure — no I/O.
 */
export function parseDenoSpecifier(
  value: string,
): { ecosystem: OrphanEcosystem; name: string; version: string | null } | null {
  const trimmed = value.trim();
  let ecosystem: OrphanEcosystem;
  let rest: string;
  if (trimmed.startsWith("npm:")) {
    ecosystem = "npm";
    rest = trimmed.slice(4);
  } else if (trimmed.startsWith("jsr:")) {
    ecosystem = "jsr";
    rest = trimmed.slice(4);
  } else {
    return null;
  }
  if (rest.length === 0) return null;

  // Scoped names start with `@`; the version `@` is the one *after* the
  // name, so for `@scope/name@ver` we search from the first slash onward.
  const scoped = rest.startsWith("@");
  const searchFrom = scoped ? rest.indexOf("/") : 0;
  if (scoped && searchFrom < 0) {
    // `@scope` with no `/name` — malformed, treat the whole thing as name.
    return { ecosystem, name: rest, version: null };
  }
  const at = rest.indexOf("@", searchFrom + 1);
  if (at < 0) {
    return { ecosystem, name: rest, version: null };
  }
  const name = rest.slice(0, at);
  const version = rest.slice(at + 1);
  if (name.length === 0) return null;
  return { ecosystem, name, version: version.length > 0 ? version : null };
}

// ---------------------------------------------------------------------------
// Manifest parsers
// ---------------------------------------------------------------------------

/** Find the 1-based line of the first `"key"` occurrence (default 1). */
function findKeyLine(rawText: string, key: string): number {
  const needle = `"${key}"`;
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).includes(needle)) return i + 1;
  }
  return 1;
}

/** The dependency blocks an npm `package.json` declares directly. */
const NPM_DEP_BLOCKS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * Parse the declared direct dependencies from an npm `package.json`.
 * Returns `[]` on malformed JSON (never throws).
 *
 * Pure — no I/O.
 */
export function parseNpmManifest(file: ManifestFile): OrphanDependency[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.rawText);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;

  const deps: OrphanDependency[] = [];
  const seen = new Set<string>();
  for (const block of NPM_DEP_BLOCKS) {
    const value = obj[block];
    if (value === null || typeof value !== "object") continue;
    for (
      const [name, ver] of Object.entries(value as Record<string, unknown>)
    ) {
      if (seen.has(name)) continue;
      seen.add(name);
      deps.push({
        ecosystem: "npm",
        name,
        version: typeof ver === "string" ? ver : null,
        manifestPath: file.path,
        line: findKeyLine(file.rawText, name),
      });
    }
  }
  return deps;
}

/**
 * Parse the `npm:` / `jsr:` dependencies declared in a Deno manifest's
 * `imports` map (and `scopes` sub-maps). Returns `[]` on malformed
 * JSON/JSONC (never throws).
 *
 * Pure — no I/O.
 */
export function parseDenoManifest(file: ManifestFile): OrphanDependency[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(file.rawText));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;

  const deps: OrphanDependency[] = [];
  const seen = new Set<string>();

  const collectImports = (imports: unknown) => {
    if (imports === null || typeof imports !== "object") return;
    for (
      const [key, value] of Object.entries(imports as Record<string, unknown>)
    ) {
      if (typeof value !== "string") continue;
      const spec = parseDenoSpecifier(value);
      if (spec === null) continue;
      const dedupKey = `${spec.ecosystem}:${spec.name}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      deps.push({
        ecosystem: spec.ecosystem,
        name: spec.name,
        version: spec.version,
        manifestPath: file.path,
        // Cite the import-map key's line (the specifier value sits there).
        line: findKeyLine(file.rawText, key),
      });
    }
  };

  collectImports(obj["imports"]);
  // `scopes` is a map of prefix → import-map.
  const scopes = obj["scopes"];
  if (scopes !== null && typeof scopes === "object") {
    for (
      const scopeImports of Object.values(scopes as Record<string, unknown>)
    ) {
      collectImports(scopeImports);
    }
  }
  return deps;
}

// ---------------------------------------------------------------------------
// Staleness helper
// ---------------------------------------------------------------------------

/**
 * Whole-calendar-months between `then` and `now` (0 when `now` precedes
 * `then`). A partial final month does not count.
 *
 * Pure — no I/O.
 */
export function monthsBetween(then: Date, now: Date): number {
  let months = (now.getFullYear() - then.getFullYear()) * 12 +
    (now.getMonth() - then.getMonth());
  if (now.getDate() < then.getDate()) months -= 1;
  return months < 0 ? 0 : months;
}

// ---------------------------------------------------------------------------
// Replacement extraction
// ---------------------------------------------------------------------------

/** Patterns npm `deprecated` messages use to name a replacement. */
const REPLACEMENT_PATTERNS: readonly RegExp[] = [
  /\buse\s+`?([@\w][\w@./-]*)`?\s+instead\b/i,
  /\breplaced?\s+by\s+`?([@\w][\w@./-]*)`?/i,
  /\bmigrate\s+to\s+`?([@\w][\w@./-]*)`?/i,
];

/**
 * Best-effort extraction of a suggested replacement package from a
 * `deprecated` message. Returns the package name when a recognised pattern
 * matches, else `null` (the LLM phase then fills the slot).
 *
 * Pure — no I/O.
 */
export function extractReplacement(deprecatedMessage: string): string | null {
  for (const re of REPLACEMENT_PATTERNS) {
    const m = re.exec(deprecatedMessage);
    if (m && m[1]) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

const SEVERITY_EMOJI: Record<OrphanSeverity, string> = {
  high: "🔴",
  medium: "🟠",
  low: "🟡",
};

/** Outcome of classifying one dependency's metadata. */
interface ClassifiedOrphan {
  signal: OrphanSignal;
  severity: OrphanSeverity;
  whyItMatters: string;
  evidence: string;
  suggestedReplacement: string | null;
}

/**
 * Classify one dependency from its metadata, picking the single strongest
 * corroborated signal (deprecated/yanked → archived → stale). Returns `null`
 * when no signal is corroborated, so a maintained dependency yields nothing.
 *
 * Pure — no I/O.
 */
export function classifyOrphan(
  dep: OrphanDependency,
  md: OrphanMetadata | null,
  opts: { now: Date; staleMonths: number },
): ClassifiedOrphan | null {
  if (md === null) return null;

  const declaredAt = `Declared in \`${dep.manifestPath}\`:${dep.line}` +
    (dep.version
      ? ` as \`${dep.name}@${dep.version}\`.`
      : ` (\`${dep.name}\`).`);

  // 1. Deprecated / yanked — strongest signal.
  const deprecatedMsg = typeof md.deprecated === "string" &&
      md.deprecated.trim().length > 0
    ? md.deprecated.trim()
    : null;
  if (deprecatedMsg !== null || md.yanked === true) {
    const evidenceLead = deprecatedMsg !== null
      ? `Registry \`deprecated\`: "${deprecatedMsg}"`
      : "Registry reports the package/version as yanked.";
    return {
      signal: "ORPHAN-DEPRECATED",
      severity: "high",
      whyItMatters:
        `\`${dep.name}\` is marked deprecated / yanked by its registry. A ` +
        "deprecated package receives no further fixes — security or " +
        "otherwise — so depending on it accrues unpatched exposure.",
      evidence: `${evidenceLead}\n${declaredAt}`,
      suggestedReplacement: deprecatedMsg !== null
        ? extractReplacement(deprecatedMsg)
        : null,
    };
  }

  // 2. Archived source repository.
  if (md.sourceArchived === true) {
    const repo = md.sourceRepoUrl ? ` \`${md.sourceRepoUrl}\`` : "";
    return {
      signal: "ORPHAN-ARCHIVED",
      severity: "high",
      whyItMatters:
        `The source repository for \`${dep.name}\` is archived. An archived ` +
        "repository accepts no pull requests or issues, so no fix will ever " +
        "ship — the dependency is effectively frozen.",
      evidence: `Source repository${repo} is archived (\`archived: true\`).\n` +
        declaredAt,
      suggestedReplacement: null,
    };
  }

  // 3. Stale last-publish — weakest signal.
  if (typeof md.lastPublishIso === "string" && md.lastPublishIso.length > 0) {
    const publishedMs = Date.parse(md.lastPublishIso);
    if (!Number.isNaN(publishedMs)) {
      const months = monthsBetween(new Date(publishedMs), opts.now);
      if (months >= opts.staleMonths) {
        return {
          signal: "ORPHAN-STALE",
          severity: "low",
          whyItMatters:
            `\`${dep.name}\` has had no release in ${months} months ` +
            `(threshold ${opts.staleMonths} months). Staleness alone is a ` +
            "weak signal — a small, finished library can be legitimately " +
            "quiet — so verify before acting.",
          evidence:
            `Last published ${md.lastPublishIso} — ${months} months ago ` +
            `(threshold ${opts.staleMonths} months).\n${declaredAt}`,
          suggestedReplacement: null,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * Is `findingId` suppressed by an in-source `best-practice-ignore: BP-…`
 * marker on or directly above `line` in `rawText`? Manifests are JSON /
 * JSONC, so the slash + block comment forms apply (deno.jsonc supports
 * comments; package.json does not, so this is a no-op there).
 *
 * `filePath` is mandatory: every parsed marker lands in the run registry
 * keyed by file:line:id, so dropping it renders the waiver as `<unknown>`
 * in the run report and lets two markers in different manifests collide on
 * that key (Issue #3948).
 *
 * Pure — no I/O.
 */
export function isOrphanFindingSuppressed(
  rawText: string,
  line: number,
  findingId: string,
  filePath: string,
): boolean {
  const suppressions = filterByFamily(
    findSuppressions(rawText, "ts", { file: filePath }),
    "best-practices",
  );
  return isSuppressed(findingId, suppressions, line);
}

// ---------------------------------------------------------------------------
// Title builder
// ---------------------------------------------------------------------------

function buildTitle(
  signal: OrphanSignal,
  severity: OrphanSeverity,
  dependency: string,
): string {
  const emoji = SEVERITY_EMOJI[severity];
  const tail = signal === "ORPHAN-DEPRECATED"
    ? "is deprecated / yanked"
    : signal === "ORPHAN-ARCHIVED"
    ? "has an archived source repository"
    : "has had no release within the staleness threshold";
  return `${emoji} ${signal}: \`${dependency}\` ${tail}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Scan the supplied manifests and return one corroborated
 * {@link OrphanDepsFinding} per distinct unmaintained dependency (a single
 * strongest signal each), plus the list of deferred ecosystems detected.
 *
 * Behaviour:
 *   - Deno/JSR and npm manifests are parsed and scanned.
 *   - Cargo and GitHub Actions manifests are recorded in `deferred` and
 *     `logFn` is invoked — never silently skipped.
 *   - A dependency yields a finding only on a corroborated metadata signal;
 *     a `null`/empty metadata response yields nothing.
 *   - Findings whose stable id appears in `suppressedIds` /
 *     `knownOpenFindingIds`, or whose declaration line carries an in-source
 *     `best-practice-ignore: BP-…` marker, are dropped.
 *   - Findings are de-duplicated by stable id (same dependency + signal →
 *     one finding) and sorted by id for deterministic output.
 */
export async function scanOrphanDeps(
  opts: ScanOrphanDepsOptions,
): Promise<OrphanDepsScanResult> {
  const provider = opts.provider ?? nullOrphanMetadataProvider;
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  const staleMonths = opts.staleMonths ?? DEFAULT_STALE_MONTHS;
  const now = (opts.now ?? (() => new Date()))();
  const logFn = opts.logFn;

  // 1. Parse manifests; record deferred ecosystems (no silent caps).
  const deferredSet = new Set<DeferredEcosystem>();
  const dependencies: OrphanDependency[] = [];
  // Map manifest path → raw text for suppression lookups.
  const rawByPath = new Map<string, string>();
  for (const file of opts.files) {
    rawByPath.set(file.path, file.rawText);
    const kind = classifyManifest(file.path);
    if (kind === "npm") {
      dependencies.push(...parseNpmManifest(file));
    } else if (kind === "deno") {
      dependencies.push(...parseDenoManifest(file));
    } else if (kind === "cargo" || kind === "github-actions") {
      if (!deferredSet.has(kind)) {
        deferredSet.add(kind);
        logFn?.(
          `orphan-deps: deferring the ${kind} ecosystem to a follow-up ` +
            "(Issue #2907 scope: Deno/JSR + npm first); not scanned this run.",
        );
      }
    }
  }

  // 2. De-duplicate dependencies (same ecosystem + name) so the metadata
  //    helper is queried once each.
  const uniqueDeps = new Map<string, OrphanDependency>();
  for (const dep of dependencies) {
    const key = `${dep.ecosystem}:${dep.name}`;
    if (!uniqueDeps.has(key)) uniqueDeps.set(key, dep);
  }

  // 3. Classify each dependency against its sanctioned metadata.
  const byId = new Map<string, OrphanDepsFinding>();
  for (const dep of uniqueDeps.values()) {
    let md: OrphanMetadata | null;
    try {
      md = await provider.fetch(dep);
    } catch {
      // The provider contract forbids throwing, but be defensive: an
      // indeterminate lookup drops the candidate rather than asserting.
      md = null;
    }
    const classified = classifyOrphan(dep, md, { now, staleMonths });
    if (classified === null) continue;

    const findingId = await makeStableId([
      opts.repo,
      ORPHAN_DEPS_DISCRIMINATOR,
      classified.signal,
      dep.name,
    ]);

    // Skip ids already owned by prior triage or an open issue.
    if (suppressed.has(findingId) || knownOpen.has(findingId)) continue;

    // Honour in-source suppression markers near the declaration line.
    const raw = rawByPath.get(dep.manifestPath) ?? "";
    if (
      isOrphanFindingSuppressed(raw, dep.line, findingId, dep.manifestPath)
    ) continue;

    // De-duplicate by id (same dependency + signal across manifests).
    if (byId.has(findingId)) continue;

    byId.set(findingId, {
      findingId,
      signal: classified.signal,
      severity: classified.severity,
      ecosystem: dep.ecosystem,
      dependency: dep.name,
      version: dep.version,
      manifestPath: dep.manifestPath,
      line: dep.line,
      title: buildTitle(classified.signal, classified.severity, dep.name),
      whyItMatters: classified.whyItMatters,
      evidence: classified.evidence,
      suggestedReplacement: classified.suggestedReplacement,
    });
  }

  const findings = [...byId.values()].sort((a, b) =>
    a.findingId.localeCompare(b.findingId)
  );
  const deferred = [...deferredSet].sort();
  return { findings, deferred };
}
