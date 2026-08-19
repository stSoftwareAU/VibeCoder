/**
 * GitHub Actions latest-major + EOL runtime catalogue (Issue #2217).
 *
 * Single source of truth for "current latest major version" of common
 * GitHub Actions and for end-of-life language runtime versions. Consumed
 * by the best-practices `github-actions` bucket rules (sister issues
 * #2207 and the EOL-runtime follow-on) to flag deprecated or stale usage
 * in `.github/workflows/*.yml` files.
 *
 * Data lives in code (not in the Markdown bucket guide) so it is typed,
 * testable, and refactorable when versions roll over. The render helpers
 * produce Markdown tables that the bucket guide inlines via placeholder
 * substitution in `assembleBestPracticesPrompt`.
 *
 * Australian English throughout (behaviour, organisation, recognised).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Deprecation metadata for a {@link ActionCatalogueEntry} (Issue #2232).
 *
 * Present when the action has been archived, retired, or otherwise
 * marked end-of-life by its owner. Downstream checks (the duplicate-
 * and-obsolete sibling sub-issue under #2207) consume this block to
 * flag workflows that still reference deprecated third-party actions.
 */
export interface ActionDeprecation {
  /**
   * Authoritative explanation of why the action is deprecated.
   * Required when the `deprecated` block is present. Australian
   * English prose — cite the archived-repo banner or the upstream
   * announcement so a reviewer can verify the entry.
   */
  reason: string;
  /**
   * Optional `<owner>/<action>` or `gh ...` command that replaces
   * the deprecated action. Surfaced in the Markdown render so
   * workflow authors have a clear migration target.
   */
  replacement?: string;
  /**
   * Optional ISO-8601 date (`YYYY-MM-DD`) the upstream repository was
   * archived or the action was withdrawn. Used purely for sorting and
   * display — does not gate the deprecation itself.
   */
  archivedDate?: string;
}

/** Catalogue entry for a single GitHub Action. */
export interface ActionCatalogueEntry {
  /** Current latest major version, e.g. `4` for `actions/checkout@v4`. */
  latestMajor: number;
  /** Optional short note (Australian English in any prose). */
  note?: string;
  /**
   * Optional deprecation block (Issue #2232). Present when the whole
   * action has been archived/retired by its owner. Downstream checks
   * use this to flag workflows that still reference the action.
   */
  deprecated?: ActionDeprecation;
}

/** Catalogue entry for a single language runtime. */
export interface EolRuntimeEntry {
  /** Human-readable runtime name, e.g. `"Node.js"`. */
  runtime: string;
  /**
   * Versions that are fully end-of-life — they no longer receive
   * security updates and must not be used. Strings rather than numbers
   * so we can capture identifiers like `"3.8"` for Python.
   */
  eolVersions: string[];
  /**
   * Versions scheduled to reach end-of-life within roughly the next
   * twelve months. Adopt the newer LTS before the date in `reasoning`.
   */
  eolSoonVersions: string[];
  /**
   * Authoritative justification — cite dates and upstream sources so a
   * reviewer can verify the entry without leaving the catalogue.
   * Australian English prose.
   */
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Data — GitHub Actions latest majors
// ---------------------------------------------------------------------------

/**
 * Mapping `<owner>/<action>` → catalogue entry.
 *
 * Seeded with the twelve actions named in #2217. Sources verified against
 * the upstream `Releases` page or the action's `README` (May 2026).
 *
 * Update procedure: when a new major lands upstream, bump `latestMajor`
 * here and re-run the best-practices scan on the affected repos.
 */
export const LATEST_ACTION_MAJORS: Readonly<
  Record<string, ActionCatalogueEntry>
> = Object.freeze({
  "actions/checkout": {
    latestMajor: 4,
    note: "v4 ships Node 20 runner; v3 EOL.",
  },
  "actions/setup-node": {
    latestMajor: 4,
    note: "v4 ships Node 20 runner; v3 EOL.",
  },
  "actions/setup-python": {
    latestMajor: 5,
    note: "v5 ships Node 20 runner; v4 deprecated.",
  },
  "actions/setup-java": {
    latestMajor: 4,
    note: "v4 ships Node 20 runner; v3 deprecated.",
  },
  "actions/setup-go": {
    latestMajor: 5,
    note: "v5 ships Node 20 runner; v4 deprecated.",
  },
  "actions/cache": {
    latestMajor: 4,
    note: "v4 ships Node 20 runner; v3 EOL.",
  },
  "actions/upload-artifact": {
    latestMajor: 4,
    note: "v4 stores artefacts immutably; v3 EOL Jan 2025.",
  },
  "actions/download-artifact": {
    latestMajor: 8,
    note: "v8 runs on the Node 24 runner; v5 and earlier ran on the " +
      "deprecated Node 20 runtime (Issue #2889).",
  },
  "github/codeql-action": {
    latestMajor: 3,
    note: "v3 ships Node 20 runner; v2 EOL.",
  },
  "docker/setup-buildx-action": {
    latestMajor: 3,
    note: "v3 ships Node 20 runner; v2 deprecated.",
  },
  "docker/login-action": {
    latestMajor: 3,
    note: "v3 ships Node 20 runner; v2 deprecated.",
  },
  "docker/build-push-action": {
    latestMajor: 6,
    note: "v6 ships Node 20 runner; v5 deprecated.",
  },
  // -------------------------------------------------------------------
  // Deprecated / archived actions (Issue #2232).
  //
  // These actions are recognised here so the duplicate-and-obsolete
  // check can flag workflows that still reference them. `latestMajor`
  // records the final shipped major; `deprecated.reason` cites the
  // archived-repo banner or the upstream deprecation announcement.
  // -------------------------------------------------------------------
  "actions/create-release": {
    latestMajor: 1,
    note: "Archived by GitHub in 2021; final release v1.",
    deprecated: {
      reason: "Repository archived by GitHub — no longer maintained and the " +
        "upload step relies on a deprecated REST endpoint that returns " +
        "incomplete release metadata.",
      replacement:
        "`softprops/action-gh-release` or `gh release create` from " +
        "the GitHub CLI",
      archivedDate: "2021-04-21",
    },
  },
  "actions/upload-release-asset": {
    latestMajor: 1,
    note: "Archived by GitHub in 2021; final release v1.",
    deprecated: {
      reason: "Repository archived alongside `actions/create-release` — both " +
        "depend on the same retired REST endpoint and receive no fixes.",
      replacement:
        "`softprops/action-gh-release` or `gh release upload` from " +
        "the GitHub CLI",
      archivedDate: "2021-04-21",
    },
  },
  "actions/setup-ruby": {
    latestMajor: 1,
    note: "Archived by GitHub; community-maintained fork ships current Ruby.",
    deprecated: {
      reason: "Repository archived — no longer ships new Ruby releases and " +
        "the README explicitly directs users to the community fork.",
      replacement: "`ruby/setup-ruby`",
      archivedDate: "2021-04-08",
    },
  },
});

// ---------------------------------------------------------------------------
// Data — EOL language runtimes
// ---------------------------------------------------------------------------

/**
 * End-of-life status for the four runtimes named in #2217.
 *
 * Dates cite the upstream support policy (nodejs.org, devguide.python.org,
 * adoptium.net, go.dev). Update when a runtime crosses an EOL boundary or
 * when the GitHub-hosted runner schedule changes.
 */
export const EOL_RUNTIMES: readonly EolRuntimeEntry[] = Object.freeze([
  {
    runtime: "Node.js",
    eolVersions: ["12", "14", "16", "18"],
    eolSoonVersions: ["20"],
    reasoning:
      "Node 18 reached end-of-life in April 2025 (nodejs.org release " +
      "schedule). Node 20 is scheduled for automatic upgrade to Node 24 " +
      "on GitHub-hosted runners on 2026-06-02 and full removal on " +
      "2026-09-16 — migrate to Node 22 LTS or Node 24 LTS before the " +
      "removal date to avoid surprise breakage.",
  },
  {
    runtime: "Python",
    eolVersions: ["2.7", "3.6", "3.7", "3.8"],
    eolSoonVersions: ["3.9"],
    reasoning:
      "Python 3.8 reached end-of-life in October 2024 (devguide.python.org). " +
      "Python 3.9 reaches end-of-life in October 2025. Use Python 3.11 or " +
      "newer for current workflows.",
  },
  {
    runtime: "Java",
    eolVersions: ["8", "11"],
    eolSoonVersions: ["17"],
    reasoning:
      "Java 8 and 11 are past their Eclipse Adoptium / Temurin community " +
      "support windows for non-paying users. Java 17 LTS receives free " +
      "security updates until at least September 2027; Java 21 LTS is the " +
      "current default. Prefer 17 or 21 for new workflows.",
  },
  {
    runtime: "Go",
    eolVersions: ["1.19", "1.20", "1.21"],
    eolSoonVersions: ["1.22"],
    reasoning:
      "Go's support policy (go.dev/doc/devel/release) maintains only the " +
      "two most recent major releases. Go 1.21 lost security support when " +
      "Go 1.23 released in August 2024; Go 1.22 will follow when Go 1.24 " +
      "ships. Pin to a Go 1.23+ minor for current workflows.",
  },
]);

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/** Escape pipe characters that would otherwise break a Markdown table cell. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * Format a {@link ActionDeprecation} block for a Markdown table cell.
 *
 * Returns an empty string when no deprecation is recorded so the cell
 * renders as blank — this is the convention pinned by the catalogue
 * tests. When a deprecation is present, the cell carries the reason
 * followed by `Use <replacement>.` when a replacement hint exists.
 *
 * Pure — no I/O.
 */
function formatDeprecatedCell(
  deprecation: ActionDeprecation | undefined,
): string {
  if (deprecation === undefined) return "";
  const parts: string[] = [deprecation.reason];
  if (deprecation.replacement !== undefined) {
    parts.push(`Use ${deprecation.replacement}.`);
  }
  return parts.join(" ");
}

/**
 * Render the actions-catalogue as a Markdown table. Rows are sorted by
 * action slug so the output is deterministic and diff-friendly.
 *
 * Columns:
 *   - `Action` — `owner/action` slug.
 *   - `Latest major` — current latest major version prefixed with `v`.
 *   - `Deprecated` — deprecation reason and optional replacement;
 *     blank when the action is still maintained (Issue #2232).
 *   - `Notes` — short prose, blank when no note is recorded.
 *
 * Pure — no I/O.
 */
export function renderActionsCatalogueTable(): string {
  const rows: string[] = [];
  rows.push("| Action | Latest major | Deprecated | Notes |");
  rows.push("| --- | --- | --- | --- |");
  const slugs = Object.keys(LATEST_ACTION_MAJORS).sort();
  for (const slug of slugs) {
    const entry = LATEST_ACTION_MAJORS[slug];
    if (entry === undefined) continue;
    const note = entry.note ?? "";
    const deprecated = formatDeprecatedCell(entry.deprecated);
    rows.push(
      `| \`${escapeCell(slug)}\` | v${entry.latestMajor} | ` +
        `${escapeCell(deprecated)} | ${escapeCell(note)} |`,
    );
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Deprecated-action lookup (Issue #2239)
// ---------------------------------------------------------------------------

/**
 * A single deprecated-action finding resolved from a workflow `uses:`
 * reference (Issue #2239).
 *
 * Produced by {@link describeDeprecatedActionUsage} when the referenced
 * action carries a `deprecated` block in the catalogue. The `message`
 * honours the bucket guide's concrete-consolidation output shape — it
 * names the call-site, the archived date and reason, and either the
 * replacement (when recorded) or an explicit removal recommendation.
 */
export interface DeprecatedActionUsage {
  /** The `<owner>/<action>` coordinate matched in the catalogue. */
  action: string;
  /** Stable finding id: `BP-OBSOLETE-STEP-<owner>-<action>`, lower-cased. */
  id: string;
  /** Catalogue deprecation reason. */
  reason: string;
  /** Catalogue replacement hint, when one is recorded. */
  replacement?: string;
  /** Catalogue archived date (`YYYY-MM-DD`), when recorded. */
  archivedDate?: string;
  /** Human-readable finding body honouring the bucket guide's output shape. */
  message: string;
}

/**
 * Extract the `<owner>/<action>` coordinate from a raw `uses:` reference.
 *
 * Strips the `@<ref>` pin and any deeper subpath (a reusable-workflow or
 * action subdirectory) so `owner/repo/path@v1` resolves to `owner/repo`.
 * Returns `null` for local references (`./.github/...`) and any value
 * with fewer than two path segments.
 *
 * Pure — no I/O.
 */
function actionCoordinate(usesRef: string): string | null {
  const trimmed = usesRef.trim();
  const at = trimmed.indexOf("@");
  const path = at >= 0 ? trimmed.slice(0, at) : trimmed;
  if (path.startsWith(".")) return null;
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  return `${segments[0]}/${segments[1]}`;
}

/**
 * Resolve a single workflow `uses:` reference against the deprecated
 * entries of the actions catalogue (Issue #2239).
 *
 * `usesRef` is the raw value of a `uses:` line, e.g.
 * `actions/create-release@v1`. `location` is the caller-formatted
 * call-site prefix echoed back in the finding (e.g.
 * `` `.github/workflows/ci.yml` job `build` step 4 ``).
 *
 * Returns `null` when the action is **absent** from the catalogue, or is
 * present but **not** deprecated — both cases are handled by the sibling
 * pin (#1) and stale-major (#17) checks, not this one. The `catalogue`
 * parameter defaults to {@link LATEST_ACTION_MAJORS} and exists so tests
 * can inject a fixture catalogue; this is a pure catalogue query, not a
 * workflow scanner.
 *
 * Pure — no I/O.
 */
export function describeDeprecatedActionUsage(
  usesRef: string,
  location: string,
  catalogue: Readonly<Record<string, ActionCatalogueEntry>> =
    LATEST_ACTION_MAJORS,
): DeprecatedActionUsage | null {
  const coordinate = actionCoordinate(usesRef);
  if (coordinate === null) return null;
  const entry = catalogue[coordinate];
  if (entry === undefined || entry.deprecated === undefined) return null;

  const dep = entry.deprecated;
  const id = `BP-OBSOLETE-STEP-${coordinate.replace("/", "-")}`.toLowerCase();

  let head = `${location} uses \`${usesRef.trim()}\``;
  if (dep.archivedDate !== undefined) {
    head += `, archived ${dep.archivedDate}`;
  }
  head += ` ("${dep.reason}").`;

  const tail = dep.replacement !== undefined
    ? `Migrate to ${dep.replacement}.`
    : "No replacement is recorded — remove the step or choose a " +
      "hand-picked alternative.";

  return {
    action: coordinate,
    id,
    reason: dep.reason,
    replacement: dep.replacement,
    archivedDate: dep.archivedDate,
    message: `${head} ${tail}`,
  };
}

/**
 * Render the EOL-runtime catalogue as a Markdown table. Rows preserve the
 * declaration order in {@link EOL_RUNTIMES} so the table reads in the
 * order operators expect (Node, Python, Java, Go).
 *
 * Columns:
 *   - `Runtime` — human-readable runtime name.
 *   - `EOL versions` — comma-separated list of fully-EOL versions.
 *   - `EOL soon` — comma-separated list of soon-to-be-EOL versions.
 *   - `Reasoning` — authoritative prose explaining the dates.
 *
 * Pure — no I/O.
 */
export function renderEolRuntimesTable(): string {
  const rows: string[] = [];
  rows.push("| Runtime | EOL versions | EOL soon | Reasoning |");
  rows.push("| --- | --- | --- | --- |");
  for (const entry of EOL_RUNTIMES) {
    const eol = entry.eolVersions.join(", ");
    const eolSoon = entry.eolSoonVersions.join(", ");
    rows.push(
      `| ${escapeCell(entry.runtime)} | ${escapeCell(eol)} | ` +
        `${escapeCell(eolSoon)} | ${escapeCell(entry.reasoning)} |`,
    );
  }
  return rows.join("\n");
}
