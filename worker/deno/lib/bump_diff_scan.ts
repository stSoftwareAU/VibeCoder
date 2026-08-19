/**
 * Fail-closed scanning of a dependency-bump diff (Issue #3951).
 *
 * The release-age audit (`bump_age_audit.ts`) can only embargo what it
 * can see. Its first parser recognised exactly two shapes — an `npm:`/
 * `jsr:` specifier and a `package.json` range — and both required the
 * version to start with a **digit**. Everything else parsed to `[]`, and
 * an empty parse was reported as `ok: true`, i.e. "the quarantine was
 * honoured". A repo-supplied `bump-deps.sh` could therefore adopt a
 * five-minute-old release through a range (`jsr:@std/yaml@^1.9.9`), a
 * lockfile, or any non-JS ecosystem with **zero** embargo.
 *
 * This module separates the two questions the audit needs answered:
 *
 *  1. **What did the bump introduce that can be age-verified?** —
 *     `specifiers`, exactly as before plus range and lockfile forms.
 *  2. **What did the bump introduce that cannot?** — `unverifiable`,
 *     every added line that is dependency-shaped but whose release age
 *     this worker has no way to resolve (an open-ended range, a tag, a
 *     foreign ecosystem's manifest).
 *
 * The audit refuses the bump on (2) rather than passing it. Silence is
 * never treated as compliance (Issue #3234).
 *
 * Pure — no I/O, no clock — so it unit-tests exhaustively.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

/**
 * Registry whose publish times the age audit can resolve.
 *
 * `unknown` is a lockfile entry that names a package and version but not
 * the registry it came from (a bare `"@std/yaml@1.9.9"` key in
 * `deno.lock`); the audit resolves those by trying JSR then npm.
 */
export type BumpRegistry = "npm" | "jsr" | "unknown";

/** An external `name@version` a bump introduced. */
export interface BumpedSpecifier {
  registry: BumpRegistry;
  /** Package name, e.g. `chalk` or `@std/assert`. */
  name: string;
  /** Exact version the bump pinned, range prefixes stripped. */
  version: string;
}

/**
 * An added line that is dependency-shaped but whose release age cannot
 * be verified. Each one blocks the bump — the audit fails closed.
 */
export interface UnverifiableBumpLine {
  /** Repo-relative path of the file the line belongs to. */
  file: string;
  /** The added line, trimmed and truncated for messages. */
  line: string;
  /** Why the line could not be verified. */
  reason: string;
}

/** Outcome of scanning one bump diff. */
export interface BumpDiffScan {
  /** Age-verifiable `name@version` pairs, deduplicated in first-seen order. */
  specifiers: BumpedSpecifier[];
  /** Dependency-shaped lines the scanner refuses to pass unchecked. */
  unverifiable: UnverifiableBumpLine[];
}

// =============================================================================
// Line shapes
// =============================================================================

/**
 * `npm:`/`jsr:` specifier. The version text is captured verbatim — any
 * range, tag or wildcard included — and vetted by {@link pinnedVersion}
 * afterwards, so an unrecognised form is refused rather than skipped.
 */
const SPECIFIER_RE =
  /\b(npm|jsr):((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)@([^"'\s,;)\]}]+)/g;

/** A `"name": "value"` pair in a `package.json`. */
const PACKAGE_JSON_PAIR_RE =
  /"((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)"\s*:\s*"([^"]*)"/g;

/** A quoted `"name@version"` lockfile entry (`deno.lock`, `package-lock.json`). */
const QUOTED_ENTRY_RE = /"((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)@([^"]+)"/g;

/** A bare `name@range:` lockfile entry key (`yarn.lock`, `pnpm-lock.yaml`). */
const BARE_ENTRY_RE =
  /^\s*\/?((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)@([^:,\s]+)\s*[:,]/;

/** A resolved npm tarball URL (`package-lock.json`, `yarn.lock`). */
const RESOLVED_TARBALL_RE =
  /https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)\/-\/[A-Za-z0-9._-]+-(\d[A-Za-z0-9.+-]*)\.tgz/g;

/**
 * Range prefixes that still pin a concrete floor version whose release
 * age is meaningful. `>`/`>=`/`*`/`x`/`latest` are deliberately absent:
 * they name no release, so they are refused rather than guessed at.
 */
const PINNING_RANGE_PREFIX_RE = /^[\^~=v]+/;

/** A concrete release version, e.g. `1.9.9`, `18`, `2.0.0-rc.1`. */
const CONCRETE_VERSION_RE = /^\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.-]+)?$/;

/** A registry alias prefix on a lockfile version (`chalk@npm:5.6.2`). */
const ALIAS_PREFIX_RE = /^(?:npm|jsr):/;

/**
 * A value that is trying to be a version range — used to decide whether
 * an unpinnable `package.json` value is a dependency worth refusing or
 * ordinary metadata (`"license": "MIT"`) worth ignoring.
 */
const RANGE_LOOKING_RE = /^[\s~^>=<]*[\dxX*]|^(?:latest|next)$/;

/**
 * `package.json` keys that carry a version but are not a dependency on
 * a published release: the package's own identity and the `engines`
 * runtime floors.
 */
const PACKAGE_JSON_SKIP_KEYS = new Set([
  "name",
  "version",
  "node",
  "npm",
  "yarn",
  "pnpm",
  "deno",
  "bun",
  "vscode",
]);

/** Lockfiles this scanner understands, and the registry their entries name. */
const LOCKFILES: Readonly<Record<string, BumpRegistry>> = {
  "deno.lock": "unknown",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "npm",
  "pnpm-lock.yaml": "npm",
};

/** Manifests of ecosystems whose release ages this worker cannot resolve. */
const FOREIGN_MANIFESTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Gemfile(\.lock)?$/, "RubyGems"],
  [/\.gemspec$/, "RubyGems"],
  [/^go\.(mod|sum)$/, "Go module"],
  [/^Cargo\.(toml|lock)$/, "crates.io"],
  [
    /^(?:requirements[A-Za-z0-9._-]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|pyproject\.toml|setup\.py)$/,
    "PyPI",
  ],
  [/^composer\.(json|lock)$/, "Packagist"],
  [/^(?:pom\.xml|build\.gradle(?:\.kts)?)$/, "Maven"],
  [/^pubspec\.(yaml|lock)$/, "pub.dev"],
  [/^mix\.(exs|lock)$/, "Hex"],
];

/**
 * A foreign-manifest line that mentions a version. Comments and prose
 * lines carry no version token and are left alone, so only lines that
 * actually move a dependency refuse the bump.
 */
const FOREIGN_VERSION_RE = /(?:^|[^A-Za-z0-9_])v?\d+\.\d+|[=<>~^!]=?\s*["']?\d/;

/** Longest added-line excerpt quoted back in a refusal message. */
const MAX_QUOTED_LINE = 200;

// =============================================================================
// File classification
// =============================================================================

/** How a file in the diff should be read. */
export type ScannedFileKind =
  | { kind: "package-json" }
  | { kind: "lock"; registry: BumpRegistry }
  | { kind: "foreign"; ecosystem: string }
  | { kind: "other" };

/** Classify a repo-relative path by the dependency shapes it can carry. */
export function classifyBumpFile(path: string): ScannedFileKind {
  const base = path.split("/").pop() ?? path;
  if (base === "package.json") return { kind: "package-json" };
  const registry = LOCKFILES[base];
  if (registry) return { kind: "lock", registry };
  for (const [pattern, ecosystem] of FOREIGN_MANIFESTS) {
    if (pattern.test(base)) return { kind: "foreign", ecosystem };
  }
  return { kind: "other" };
}

/**
 * Reduce a version specification to the exact release whose age can be
 * checked, or `null` when it names no single release.
 *
 * `^1.9.9`/`~1.9.9`/`=1.9.9`/`v1.9.9` pin a floor inside a bounded range
 * and normalise to `1.9.9`. `>=1.0.0`, `*`, `1.x` and `latest` are
 * open-ended — they name whatever the registry serves at install time,
 * which is exactly the evasion the embargo exists to stop — so they
 * return `null` and the caller refuses them.
 */
export function pinnedVersion(raw: string): string | null {
  const trimmed = raw.trim().replace(ALIAS_PREFIX_RE, "");
  if (trimmed.length === 0) return null;
  const stripped = trimmed.replace(PINNING_RANGE_PREFIX_RE, "");
  return CONCRETE_VERSION_RE.test(stripped) ? stripped : null;
}

// =============================================================================
// Scanning
// =============================================================================

/** Collector callbacks threaded through the per-line scanners. */
interface Collector {
  add: (spec: BumpedSpecifier) => void;
  flag: (line: string, reason: string) => void;
}

/** Repo-relative path from a `+++ b/path` diff header. */
function diffPath(header: string): string {
  const raw = header.slice(4).trim().split(/\s+/)[0] ?? "";
  return raw.replace(/^[ab]\//, "");
}

/** Trim and truncate an added line for quoting in a message. */
function quoteLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > MAX_QUOTED_LINE
    ? `${trimmed.slice(0, MAX_QUOTED_LINE)}…`
    : trimmed;
}

/** `npm:`/`jsr:` specifiers — pinned ones collected, the rest refused. */
function scanSpecifiers(line: string, path: string, out: Collector): void {
  for (const match of line.matchAll(SPECIFIER_RE)) {
    const registry = match[1] as BumpRegistry;
    const name = match[2]!;
    const raw = match[3]!;
    const version = pinnedVersion(raw);
    if (version) {
      out.add({ registry, name, version });
      continue;
    }
    out.flag(
      line,
      `\`${registry}:${name}@${raw}\` in \`${path}\` does not pin a single ` +
        `release, so its publish time cannot be checked against the quarantine.`,
    );
  }
}

/** `"name": "range"` dependency entries inside a `package.json`. */
function scanPackageJson(line: string, path: string, out: Collector): void {
  for (const match of line.matchAll(PACKAGE_JSON_PAIR_RE)) {
    const name = match[1]!;
    const value = match[2]!;
    if (PACKAGE_JSON_SKIP_KEYS.has(name)) continue;
    // Already collected (or refused) by the `npm:`/`jsr:` pass.
    if (/\b(?:npm|jsr):/.test(value)) continue;
    const version = pinnedVersion(value);
    if (version) {
      out.add({ registry: "npm", name, version });
      continue;
    }
    if (!RANGE_LOOKING_RE.test(value.trim())) continue;
    out.flag(
      line,
      `\`"${name}": "${value}"\` in \`${path}\` does not pin a single ` +
        `release, so its publish time cannot be checked against the quarantine.`,
    );
  }
}

/** One `name@version` lockfile entry. */
function addLockEntry(
  name: string,
  raw: string,
  registry: BumpRegistry,
  line: string,
  path: string,
  out: Collector,
): void {
  // `deno.lock` suffixes npm entries with their resolved peers, e.g.
  // `chalk@5.6.2_supports-color@8.1.1`; the package's own version is the
  // part before the first underscore.
  const version = pinnedVersion(raw.split("_")[0]!);
  if (version) {
    out.add({ registry, name, version });
    return;
  }
  out.flag(
    line,
    `\`${name}@${raw}\` in \`${path}\` does not pin a single release, so ` +
      `its publish time cannot be checked against the quarantine.`,
  );
}

/** Lockfile entries: quoted keys, bare keys, and resolved tarball URLs. */
function scanLockfile(
  line: string,
  path: string,
  registry: BumpRegistry,
  out: Collector,
): void {
  for (const match of line.matchAll(QUOTED_ENTRY_RE)) {
    addLockEntry(match[1]!, match[2]!, registry, line, path, out);
  }
  const bare = BARE_ENTRY_RE.exec(line);
  if (bare) {
    addLockEntry(bare[1]!, bare[2]!, registry, line, path, out);
  }
  for (const match of line.matchAll(RESOLVED_TARBALL_RE)) {
    out.add({ registry: "npm", name: match[1]!, version: match[2]! });
  }
}

/** Route one added line to the scanners its file supports. */
function scanAddedLine(
  line: string,
  path: string,
  file: ScannedFileKind,
  out: Collector,
): void {
  if (file.kind === "foreign") {
    if (FOREIGN_VERSION_RE.test(line)) {
      out.flag(
        line,
        `\`${path}\` is a ${file.ecosystem} manifest. The release-age ` +
          `quarantine can only resolve npm and JSR publish times, so a ` +
          `${file.ecosystem} bump is refused rather than passed unchecked.`,
      );
    }
    return;
  }

  scanSpecifiers(line, path, out);
  if (file.kind === "package-json") {
    scanPackageJson(line, path, out);
  } else if (file.kind === "lock") {
    scanLockfile(line, path, file.registry, out);
  }
}

/**
 * Drop `unknown`-registry lockfile entries already covered by a concrete
 * one, so a `deno.lock` that names both `jsr:@std/yaml@^1.9.9` and
 * `"@std/yaml@1.9.9"` is looked up once.
 */
function dropRedundantUnknown(specs: BumpedSpecifier[]): BumpedSpecifier[] {
  const concrete = new Set(
    specs.filter((s) => s.registry !== "unknown").map((s) =>
      `${s.name}@${s.version}`
    ),
  );
  return specs.filter((s) =>
    s.registry !== "unknown" || !concrete.has(`${s.name}@${s.version}`)
  );
}

/**
 * Scan the added lines of a unified diff for dependency changes.
 *
 * Only added lines count — a removed `npm:chalk@4.0.0` is the version
 * being replaced, not the one landing. Every added line is either
 * recognised (a specifier), ignored (not dependency-shaped), or refused
 * (dependency-shaped but unverifiable). Nothing is passed by silence.
 */
export function scanBumpDiff(diff: string): BumpDiffScan {
  const seen = new Set<string>();
  const specifiers: BumpedSpecifier[] = [];
  const unverifiable: UnverifiableBumpLine[] = [];
  let path = "";
  let file: ScannedFileKind = { kind: "other" };

  const out: Collector = {
    add: (spec) => {
      const key = `${spec.registry}:${spec.name}@${spec.version}`;
      if (seen.has(key)) return;
      seen.add(key);
      specifiers.push(spec);
    },
    flag: (line, reason) => {
      unverifiable.push({ file: path, line: quoteLine(line), reason });
    },
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      path = diffPath(raw);
      file = classifyBumpFile(path);
      continue;
    }
    if (raw.startsWith("--- ") || !raw.startsWith("+")) continue;
    scanAddedLine(raw.slice(1), path, file, out);
  }

  return { specifiers: dropRedundantUnknown(specifiers), unverifiable };
}

/**
 * Extract the external `name@version` pairs a unified diff introduces.
 *
 * Convenience view over {@link scanBumpDiff} for callers that only need
 * the verifiable half. Callers making a pass/fail decision must use
 * `scanBumpDiff` (or `auditBumpDiff`) so the refused lines are honoured.
 */
export function parseBumpedSpecifiers(diff: string): BumpedSpecifier[] {
  return scanBumpDiff(diff).specifiers;
}
