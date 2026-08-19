/**
 * Tests for Issue #3598 — seven substantive documents were unreachable from
 * the README's Documentation table (the declared index into `docs/`).
 *
 * The end-state these tests pin:
 *
 *   - `docs/BASH-SYNTAX-AUDIT-SCAN.md`, `docs/CROSS-REPO-FIX.md`,
 *     `docs/OWASP-TOP-10-2025-COVERAGE-MATRIX.md`, and the
 *     `docs/security/README.md` index each have their own row in the README
 *     Documentation table, like every sibling operator manual.
 *   - The four `docs/security/` reports are reachable by following markdown
 *     links from the README (via the security index).
 *   - The OWASP matrix accounts for **every** registered idle-task template,
 *     so its inventory cannot silently go stale again — the count is checked
 *     against the live registry, not against hand-written prose.
 *
 * Reachability is computed by really walking the markdown link graph from
 * README.md, so the tests keep passing when a doc is linked by a different
 * (but genuine) route and fail the moment a document is orphaned again.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import "../lib/create_all_idle_task_wrappers.ts";
import { listTemplates } from "../lib/idle_task_template.ts";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

/**
 * Local markdown link targets of `file`, resolved to repo-relative paths.
 * External URLs, pure anchors, and non-markdown targets are ignored.
 */
function markdownLinks(file: string): string[] {
  const dir = file.includes("/")
    ? file.slice(0, file.lastIndexOf("/") + 1)
    : "";
  const targets: string[] = [];
  for (const match of read(file).matchAll(/\]\(([^)\s]+)/g)) {
    const raw = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    const withoutAnchor = raw.split("#")[0] ?? "";
    if (!withoutAnchor.endsWith(".md")) continue;
    const resolved = new URL(withoutAnchor, `file:///${dir}`).pathname
      .replace(/^\//, "");
    targets.push(decodeURIComponent(resolved));
  }
  return targets;
}

/** Every markdown file reachable from README.md by following local links. */
function reachableFromReadme(): Set<string> {
  const seen = new Set<string>(["README.md"]);
  const queue = ["README.md"];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let links: string[];
    try {
      links = markdownLinks(current);
    } catch {
      continue; // A missing target is covered by the dedicated link checker.
    }
    for (const link of links) {
      if (seen.has(link)) continue;
      seen.add(link);
      queue.push(link);
    }
  }
  return seen;
}

/** Rows of the README "📖 Documentation" table, as raw markdown lines. */
function documentationTableRows(): string[] {
  const lines = read("README.md").split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("## 📖 Documentation")
  );
  assert(start >= 0, "README must have a '📖 Documentation' section");
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("|")) rows.push(line);
  }
  assert(rows.length > 0, "Documentation section must contain a table");
  return rows;
}

// ---------------------------------------------------------------------------
// README Documentation table rows
// ---------------------------------------------------------------------------

const REQUIRED_TABLE_ENTRIES = [
  "docs/BASH-SYNTAX-AUDIT-SCAN.md",
  "docs/CROSS-REPO-FIX.md",
  "docs/OWASP-TOP-10-2025-COVERAGE-MATRIX.md",
  "docs/security/README.md",
];

for (const target of REQUIRED_TABLE_ENTRIES) {
  Deno.test(`README Documentation table links ${target}`, () => {
    const rows = documentationTableRows();
    const row = rows.find((line) => line.includes(`(${target})`));
    assert(row, `No README Documentation-table row links ${target}`);
    // The row must carry a description, not just a bare link.
    const cells = row.split("|").map((cell) => cell.trim());
    assert(
      cells.filter((cell) => cell.length > 0).length >= 2,
      `Documentation-table row for ${target} needs a description cell`,
    );
  });
}

// ---------------------------------------------------------------------------
// Reachability of the previously orphaned documents
// ---------------------------------------------------------------------------

const MUST_BE_REACHABLE = [
  "docs/BASH-SYNTAX-AUDIT-SCAN.md",
  "docs/CROSS-REPO-FIX.md",
  "docs/OWASP-TOP-10-2025-COVERAGE-MATRIX.md",
  "docs/security/README.md",
  "docs/security/cloudflare-security-audit-gap-analysis.md",
  "docs/security/ghostcommit-canary-tests.md",
  "docs/security/ghostcommit-image-injection-assessment.md",
  "docs/security/idle-task-scans-vs-anthropic-visa-harnesses-gap-analysis.md",
];

Deno.test("previously orphaned docs are reachable from the README", () => {
  const reachable = reachableFromReadme();
  const missing = MUST_BE_REACHABLE.filter((doc) => !reachable.has(doc));
  assertEquals(missing, [], "Documents unreachable from README.md");
});

Deno.test("the security index lists every docs/security report", () => {
  const indexed = new Set(
    markdownLinks("docs/security/README.md").map((link) =>
      link.replace(/^docs\/security\//, "")
    ),
  );
  const reports: string[] = [];
  for (const entry of Deno.readDirSync(repoPath("docs/security"))) {
    if (
      entry.isFile && entry.name.endsWith(".md") && entry.name !== "README.md"
    ) {
      reports.push(entry.name);
    }
  }
  const missing = reports.filter((name) => !indexed.has(name)).sort();
  assertEquals(missing, [], "docs/security/README.md must index every report");
});

// ---------------------------------------------------------------------------
// Cross-links requested by the finding
// ---------------------------------------------------------------------------

Deno.test("SECURITY-SCAN.md cites the #3535 harness gap analysis", () => {
  assert(
    markdownLinks("docs/SECURITY-SCAN.md").includes(
      "docs/security/idle-task-scans-vs-anthropic-visa-harnesses-gap-analysis.md",
    ),
    "docs/SECURITY-SCAN.md must link the #3535 gap analysis",
  );
});

Deno.test("SECURITY.md cites the GhostCommit threat-model pair", () => {
  const links = markdownLinks("SECURITY.md");
  for (
    const doc of [
      "docs/security/ghostcommit-image-injection-assessment.md",
      "docs/security/ghostcommit-canary-tests.md",
    ]
  ) {
    assert(links.includes(doc), `SECURITY.md must link ${doc}`);
  }
});

// ---------------------------------------------------------------------------
// OWASP matrix inventory freshness (drift test against the live registry)
// ---------------------------------------------------------------------------

Deno.test("OWASP matrix accounts for every registered idle-task template", () => {
  const matrix = read("docs/OWASP-TOP-10-2025-COVERAGE-MATRIX.md");
  const missing = listTemplates()
    .map((template) => template.name)
    .filter((name) => !matrix.includes(`\`${name.replace(/-/g, "_")}\``))
    .sort();
  assertEquals(
    missing,
    [],
    "Every registered template must appear in the OWASP matrix — either " +
      "scored in the matrix or listed as registered since the point-in-time " +
      "snapshot",
  );
});

Deno.test("OWASP matrix no longer claims to cover all templates", () => {
  const matrix = read("docs/OWASP-TOP-10-2025-COVERAGE-MATRIX.md");
  assert(
    !/all ten idle-task audit\s+templates/.test(matrix),
    "The stale 'all ten … templates' claim must be date-stamped instead",
  );
  assert(
    listTemplates().length > 10,
    "Registry has grown past ten — the matrix must say so explicitly",
  );
});
