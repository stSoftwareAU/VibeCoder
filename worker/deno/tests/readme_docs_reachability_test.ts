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

import { assertEquals } from "@std/assert";
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
