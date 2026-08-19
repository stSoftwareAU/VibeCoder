/**
 * Tests for the GitHub Actions latest-major + EOL runtime catalogue
 * (Issue #2217).
 *
 * Coverage:
 *   - every seeded action entry has a positive integer `latestMajor`
 *   - all twelve seeded actions from #2217 are present
 *   - the four seeded runtimes (Node, Python, Java, Go) are present with
 *     non-empty `runtime`, `reasoning`, and at least one `eolVersions`
 *     entry
 *   - `renderActionsCatalogueTable()` produces a Markdown table whose
 *     header row plus separator are well-formed and which contains
 *     `actions/checkout` paired with `v4`
 *   - `renderEolRuntimesTable()` produces a Markdown table containing
 *     each seeded runtime
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  type ActionCatalogueEntry,
  describeDeprecatedActionUsage,
  EOL_RUNTIMES,
  LATEST_ACTION_MAJORS,
  renderActionsCatalogueTable,
  renderEolRuntimesTable,
} from "../lib/github_actions_catalogue.ts";

// ---------------------------------------------------------------------------
// Catalogue contents
// ---------------------------------------------------------------------------

/** Actions named explicitly in the #2217 seed list. */
const SEEDED_ACTIONS = [
  "actions/checkout",
  "actions/setup-node",
  "actions/setup-python",
  "actions/setup-java",
  "actions/setup-go",
  "actions/cache",
  "actions/upload-artifact",
  "actions/download-artifact",
  "github/codeql-action",
  "docker/setup-buildx-action",
  "docker/login-action",
  "docker/build-push-action",
] as const;

Deno.test("LATEST_ACTION_MAJORS — all seeded actions present", () => {
  for (const slug of SEEDED_ACTIONS) {
    assert(
      slug in LATEST_ACTION_MAJORS,
      `missing seeded action entry for ${slug}`,
    );
  }
});

Deno.test("LATEST_ACTION_MAJORS — every entry has a positive integer latestMajor", () => {
  for (const [slug, entry] of Object.entries(LATEST_ACTION_MAJORS)) {
    assert(
      Number.isInteger(entry.latestMajor) && entry.latestMajor > 0,
      `${slug}: latestMajor must be a positive integer (got ${entry.latestMajor})`,
    );
  }
});

Deno.test("EOL_RUNTIMES — four seeded runtimes present with required fields", () => {
  const names = new Set(EOL_RUNTIMES.map((e) => e.runtime));
  for (const expected of ["Node.js", "Python", "Java", "Go"]) {
    assert(names.has(expected), `missing EOL runtime entry for ${expected}`);
  }
  for (const entry of EOL_RUNTIMES) {
    assert(entry.runtime.length > 0, "runtime must not be empty");
    assert(entry.reasoning.length > 0, `${entry.runtime}: reasoning empty`);
    assert(
      entry.eolVersions.length > 0,
      `${entry.runtime}: at least one EOL version required`,
    );
    // `eolSoonVersions` may be empty for a runtime with no near-term
    // transitions, but the field itself must be an array.
    assert(
      Array.isArray(entry.eolSoonVersions),
      `${entry.runtime}: eolSoonVersions must be an array`,
    );
  }
});

Deno.test("EOL_RUNTIMES — Node entry cites the 2026-09-16 runner removal", () => {
  const node = EOL_RUNTIMES.find((e) => e.runtime === "Node.js");
  assert(node !== undefined, "Node.js entry missing");
  assertStringIncludes(node.reasoning, "2026-09-16");
});

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

Deno.test("renderActionsCatalogueTable — well-formed Markdown table", () => {
  const table = renderActionsCatalogueTable();
  const lines = table.split("\n");
  assertEquals(lines[0], "| Action | Latest major | Deprecated | Notes |");
  assertEquals(lines[1], "| --- | --- | --- | --- |");
  // Every data row starts and ends with a pipe.
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    assert(
      line.startsWith("|") && line.endsWith("|"),
      `row ${i} malformed: ${line}`,
    );
  }
});

Deno.test("renderActionsCatalogueTable — contains actions/checkout @ v4", () => {
  const table = renderActionsCatalogueTable();
  assertStringIncludes(table, "`actions/checkout`");
  assertStringIncludes(table, "v4");
});

// Issue #2889: actions/download-artifact rolled to v8 (Node 24 runner);
// v5 and earlier ran on the deprecated Node 20 runtime. The catalogue is
// the source of truth the bucket guide inlines, so the rendered row must
// pair the action with its current major.
Deno.test("renderActionsCatalogueTable — actions/download-artifact @ v8 (Node 24)", () => {
  const entry = LATEST_ACTION_MAJORS["actions/download-artifact"];
  assert(entry !== undefined, "download-artifact entry missing");
  assertEquals(entry.latestMajor, 8);
  const table = renderActionsCatalogueTable();
  const row = table
    .split("\n")
    .find((line) => line.includes("`actions/download-artifact`"));
  assert(row !== undefined, "download-artifact row missing from table");
  assertStringIncludes(row, "| v8 |");
});

// ---------------------------------------------------------------------------
// Deprecated field (Issue #2232)
// ---------------------------------------------------------------------------

Deno.test("LATEST_ACTION_MAJORS — every deprecated block has a non-empty reason", () => {
  for (const [slug, entry] of Object.entries(LATEST_ACTION_MAJORS)) {
    if (entry.deprecated === undefined) continue;
    assert(
      typeof entry.deprecated.reason === "string" &&
        entry.deprecated.reason.length > 0,
      `${slug}: deprecated.reason must be a non-empty string`,
    );
    if (entry.deprecated.replacement !== undefined) {
      assert(
        typeof entry.deprecated.replacement === "string" &&
          entry.deprecated.replacement.length > 0,
        `${slug}: deprecated.replacement, when present, must be non-empty`,
      );
    }
    if (entry.deprecated.archivedDate !== undefined) {
      assert(
        /^\d{4}-\d{2}-\d{2}$/.test(entry.deprecated.archivedDate),
        `${slug}: deprecated.archivedDate must be YYYY-MM-DD (got ${entry.deprecated.archivedDate})`,
      );
    }
  }
});

Deno.test("LATEST_ACTION_MAJORS — at least one entry exercises the deprecated field", () => {
  const deprecatedSlugs = Object.entries(LATEST_ACTION_MAJORS)
    .filter(([_, entry]) => entry.deprecated !== undefined)
    .map(([slug]) => slug);
  assert(
    deprecatedSlugs.length >= 1,
    "expected at least one seeded deprecated entry, found none",
  );
});

Deno.test("renderActionsCatalogueTable — surfaces deprecated reason and replacement", () => {
  const table = renderActionsCatalogueTable();
  for (const [slug, entry] of Object.entries(LATEST_ACTION_MAJORS)) {
    if (entry.deprecated === undefined) continue;
    assertStringIncludes(
      table,
      entry.deprecated.reason,
      `expected ${slug}'s deprecation reason in rendered table`,
    );
    if (entry.deprecated.replacement !== undefined) {
      assertStringIncludes(
        table,
        entry.deprecated.replacement,
        `expected ${slug}'s replacement hint in rendered table`,
      );
    }
  }
});

Deno.test("renderActionsCatalogueTable — non-deprecated rows have a blank deprecated cell", () => {
  const table = renderActionsCatalogueTable();
  const lines = table.split("\n").slice(2); // skip header + separator
  for (const line of lines) {
    // A row looks like: | `slug` | v4 | <deprecated> | <notes> |
    // Split on `|` and trim — first segment is empty (leading pipe).
    const cells = line.split("|").map((c) => c.trim());
    // Expect 6 segments: ["", slug, latestMajor, deprecated, notes, ""].
    assertEquals(cells.length, 6, `unexpected column count in row: ${line}`);
    const slugCell = cells[1] ?? "";
    // Strip the backticks around the slug.
    const slug = slugCell.replace(/^`|`$/g, "");
    const entry = LATEST_ACTION_MAJORS[slug];
    if (entry === undefined) continue;
    const deprecatedCell = cells[3] ?? "";
    if (entry.deprecated === undefined) {
      assertEquals(
        deprecatedCell,
        "",
        `${slug}: expected blank deprecated cell, got "${deprecatedCell}"`,
      );
    } else {
      assert(
        deprecatedCell.length > 0,
        `${slug}: expected non-blank deprecated cell`,
      );
    }
  }
});

Deno.test("renderEolRuntimesTable — contains every seeded runtime", () => {
  const table = renderEolRuntimesTable();
  for (const expected of ["Node.js", "Python", "Java", "Go"]) {
    assertStringIncludes(table, expected);
  }
});

// ---------------------------------------------------------------------------
// Deprecated-action lookup (Issue #2239)
// ---------------------------------------------------------------------------

/** Fixture catalogue: one deprecated entry that records a replacement. */
const FIXTURE_WITH_REPLACEMENT: Readonly<Record<string, ActionCatalogueEntry>> =
  {
    "acme/widget-action": {
      latestMajor: 2,
      deprecated: {
        reason: "repo archived; no future releases",
        replacement: "`acme-org/widget-action`",
        archivedDate: "2025-09-01",
      },
    },
  };

/** Fixture catalogue: one deprecated entry with no replacement recorded. */
const FIXTURE_NO_REPLACEMENT: Readonly<Record<string, ActionCatalogueEntry>> = {
  "legacy/foo-action": {
    latestMajor: 1,
    deprecated: {
      reason: "unmaintained",
      archivedDate: "2024-01-01",
    },
  },
};

/** Fixture catalogue: a maintained (non-deprecated) entry. */
const FIXTURE_MAINTAINED: Readonly<Record<string, ActionCatalogueEntry>> = {
  "actions/checkout": { latestMajor: 4, note: "current" },
};

Deno.test(
  "describeDeprecatedActionUsage — deprecated entry with replacement names the migration target",
  () => {
    const finding = describeDeprecatedActionUsage(
      "acme/widget-action@v2",
      "`.github/workflows/ci.yml` job `build` step 4",
      FIXTURE_WITH_REPLACEMENT,
    );
    assert(finding !== null, "expected a finding for a deprecated action");
    assertEquals(finding.action, "acme/widget-action");
    assertEquals(finding.id, "bp-obsolete-step-acme-widget-action");
    assertEquals(finding.archivedDate, "2025-09-01");
    assertEquals(finding.replacement, "`acme-org/widget-action`");
    // Message carries the call-site, archived date, reason, and replacement.
    assertStringIncludes(finding.message, ".github/workflows/ci.yml");
    assertStringIncludes(finding.message, "archived 2025-09-01");
    assertStringIncludes(finding.message, "repo archived; no future releases");
    assertStringIncludes(
      finding.message,
      "Migrate to `acme-org/widget-action`.",
    );
  },
);

Deno.test(
  "describeDeprecatedActionUsage — deprecated entry without replacement recommends removal",
  () => {
    const finding = describeDeprecatedActionUsage(
      "legacy/foo-action@v1",
      "`.github/workflows/release.yml` job `publish` step 3",
      FIXTURE_NO_REPLACEMENT,
    );
    assert(finding !== null, "expected a finding for a deprecated action");
    assertEquals(finding.replacement, undefined);
    // Must explicitly state no replacement and recommend removal — never a
    // bare "deprecated" notice.
    assertStringIncludes(finding.message, "No replacement is recorded");
    assertStringIncludes(finding.message, "remove the step");
    assert(
      !finding.message.includes("Migrate to"),
      "no-replacement finding must not suggest a migration target",
    );
  },
);

Deno.test(
  "describeDeprecatedActionUsage — non-deprecated catalogued action yields no finding",
  () => {
    const finding = describeDeprecatedActionUsage(
      "actions/checkout@v4",
      "`.github/workflows/ci.yml` job `build` step 1",
      FIXTURE_MAINTAINED,
    );
    assertEquals(finding, null);
  },
);

Deno.test(
  "describeDeprecatedActionUsage — action absent from the catalogue yields no finding",
  () => {
    const finding = describeDeprecatedActionUsage(
      "some-org/unknown-action@v1",
      "`.github/workflows/ci.yml` job `build` step 1",
      FIXTURE_WITH_REPLACEMENT,
    );
    assertEquals(finding, null);
  },
);

Deno.test(
  "describeDeprecatedActionUsage — local action reference yields no finding",
  () => {
    const finding = describeDeprecatedActionUsage(
      "./.github/actions/build",
      "`.github/workflows/ci.yml` job `build` step 1",
      FIXTURE_WITH_REPLACEMENT,
    );
    assertEquals(finding, null);
  },
);

Deno.test(
  "describeDeprecatedActionUsage — resolves the real catalogue's archived actions",
  () => {
    // Smoke-check against the production catalogue: actions/create-release
    // is a seeded deprecated entry (Issue #2232).
    const finding = describeDeprecatedActionUsage(
      "actions/create-release@v1",
      "`.github/workflows/release.yml` job `release` step 2",
    );
    assert(finding !== null, "expected a finding for actions/create-release");
    assertEquals(finding.id, "bp-obsolete-step-actions-create-release");
    assert(
      finding.replacement !== undefined,
      "actions/create-release records a replacement in the catalogue",
    );
    assertStringIncludes(finding.message, "Migrate to");
  },
);
