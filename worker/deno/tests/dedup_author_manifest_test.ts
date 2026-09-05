/**
 * Tests for the shrink-only dedup-author manifest (Issue #1097).
 *
 * Two layers, both behavioural — every assertion calls a real exported
 * function with real inputs:
 *
 *   1. the scanner and the audit, driven against literal source text,
 *      including the **verbatim argv from the unfixed code** #1095 replaced
 *      and the verified argv it replaced it with;
 *   2. the conformance layer, which scans the live source tree and holds
 *      the manifest to the cap in both directions — an unverified search
 *      that is not listed fails, and a listed entry that is no longer
 *      unverified fails too.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  auditDedupManifest,
  DEDUP_SCAN_DIRS,
  type DedupSearchSite,
  fieldListRequestsAuthor,
  scanContentForDedupSearches,
  scanDirectoriesForDedupSearches,
  UNVERIFIED_DEDUP_MANIFEST,
  UNVERIFIED_DEDUP_SITE_CAP,
  type UnverifiedDedupEntry,
} from "../lib/dedup_author_manifest.ts";

/** Repo root, derived from this file's own location. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/**
 * The argv `run_failure_issue.ts` carried **before** #1095 — a body-marker
 * dedup search that never asked who wrote the match.
 */
const UNFIXED_ARGV = [
  "const raw = await ghCommandFn([",
  '  "issue",',
  '  "list",',
  '  "--repo",',
  "  repo,",
  '  "--state",',
  '  "open",',
  '  "--search",',
  '  `"${RUN_FAILURE_MARKER_PREFIX}:${failureClass}" in:body`,',
  '  "--json",',
  '  "number,body",',
  '  "--limit",',
  '  "20",',
  "]);",
].join("\n");

/** The same argv after #1095 — the shared field list carries the author. */
const FIXED_ARGV = UNFIXED_ARGV.replace(
  '  "number,body",',
  "  ALERT_DEDUP_JSON_FIELDS,",
);

// ---------------------------------------------------------------------------
// Scanner behaviour
// ---------------------------------------------------------------------------

Deno.test("scanContentForDedupSearches - flags the pre-#1095 unverified argv", () => {
  const sites = scanContentForDedupSearches(
    UNFIXED_ARGV,
    "worker/deno/lib/run_failure_issue.ts",
  );
  assertEquals(sites.length, 1);
  const site = sites[0]!;
  assertEquals(site.authorVerified, false);
  assertEquals(site.subcommand, "issue");
  assertEquals(site.jsonFields, "number,body");
  assertEquals(site.file, "worker/deno/lib/run_failure_issue.ts");
});

Deno.test("scanContentForDedupSearches - accepts the shape #1095 landed", () => {
  const sites = scanContentForDedupSearches(
    FIXED_ARGV,
    "worker/deno/lib/run_failure_issue.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]?.authorVerified, true);
  assertEquals(sites[0]?.jsonFields, "ALERT_DEDUP_JSON_FIELDS");
});

Deno.test("scanContentForDedupSearches - a literal author field verifies", () => {
  const sites = scanContentForDedupSearches(
    [
      "await gh([",
      '  "issue", "list", "--repo", repo,',
      '  "--search", `"${MARKER}" in:body`,',
      '  "--json", "number,body,author",',
      "]);",
    ].join("\n"),
    "lib/example.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]?.authorVerified, true);
});

Deno.test("scanContentForDedupSearches - an interpolated shared field list verifies", () => {
  const sites = scanContentForDedupSearches(
    [
      "await gh([",
      '  "issue", "list",',
      '  "--search", `"${MARKER}" in:body`,',
      '  "--json", `${ALERT_DEDUP_JSON_FIELDS},labels`,',
      "]);",
    ].join("\n"),
    "lib/example.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]?.authorVerified, true);
});

Deno.test("scanContentForDedupSearches - a search with no --json cannot be verified", () => {
  const sites = scanContentForDedupSearches(
    [
      "await gh([",
      '  "issue", "list", "--search", `"${MARKER}" in:body`, "--limit", "5",',
      "]);",
    ].join("\n"),
    "lib/example.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]?.jsonFields, null);
  assertEquals(sites[0]?.authorVerified, false);
});

Deno.test("scanContentForDedupSearches - resolves a search hoisted into a const", () => {
  const sites = scanContentForDedupSearches(
    [
      "const search = `in:title (#${issueNumber})`;",
      "await gh([",
      '  "pr", "list", "--search", search, "--json", "number,title",',
      "]);",
    ].join("\n"),
    "lib/example.ts",
  );
  assertEquals(sites.length, 1);
  assertEquals(sites[0]?.subcommand, "pr");
  assertEquals(sites[0]?.authorVerified, false);
});

Deno.test("scanContentForDedupSearches - ignores prose and non-marker searches", () => {
  const sites = scanContentForDedupSearches(
    [
      "/** Dedup by `in:body` marker — see alert_dedup_authors.ts. */",
      "// legacy: --search '\"${MARKER}\" in:title'",
      "await gh([",
      '  "issue", "list", "--search", "label:bug", "--json", "number",',
      "]);",
    ].join("\n"),
    "lib/example.ts",
  );
  assertEquals(sites, []);
});

Deno.test("fieldListRequestsAuthor - literal, interpolated and absent", () => {
  assertEquals(fieldListRequestsAuthor("number,body,author"), true);
  assertEquals(
    fieldListRequestsAuthor("${ALERT_DEDUP_JSON_FIELDS},labels"),
    true,
  );
  assertEquals(fieldListRequestsAuthor("number,title"), false);
  assertEquals(fieldListRequestsAuthor("number,authorAssociation"), false);
  assertEquals(fieldListRequestsAuthor("${SOME_OTHER_FIELDS}"), false);
});

// ---------------------------------------------------------------------------
// Audit behaviour — both directions
// ---------------------------------------------------------------------------

/** Build a site for the audit tests without re-parsing source. */
function site(
  file: string,
  search: string,
  authorVerified: boolean,
): DedupSearchSite {
  return {
    file,
    line: 1,
    subcommand: "issue",
    search,
    jsonFields: authorVerified ? "author" : "number",
    authorVerified,
  };
}

const ENTRY: UnverifiedDedupEntry = {
  file: "lib/legacy.ts",
  search: '"${MARKER}" in:body',
  reason: "queued behind the escalation sites",
};

Deno.test("auditDedupManifest - an unlisted unverified search is reported", () => {
  const audit = auditDedupManifest(
    [site("lib/fresh.ts", '"${NEW}" in:body', false)],
    [ENTRY],
  );
  assertEquals(audit.unlisted.map((s) => s.file), ["lib/fresh.ts"]);
  assertEquals(audit.stale.map((e) => e.file), ["lib/legacy.ts"]);
});

Deno.test("auditDedupManifest - a listed unverified search is not reported", () => {
  const audit = auditDedupManifest(
    [site(ENTRY.file, ENTRY.search, false)],
    [ENTRY],
  );
  assertEquals(audit.unlisted, []);
  assertEquals(audit.stale, []);
});

Deno.test("auditDedupManifest - a fixed site makes its entry stale", () => {
  const audit = auditDedupManifest(
    [site(ENTRY.file, ENTRY.search, true)],
    [ENTRY],
  );
  assertEquals(audit.unlisted, []);
  assertEquals(audit.stale.map((e) => e.file), ["lib/legacy.ts"]);
});

Deno.test("auditDedupManifest - a verified search is never reported", () => {
  const audit = auditDedupManifest(
    [site("lib/fixed.ts", '"${MARKER}" in:body', true)],
    [],
  );
  assertEquals(audit.unlisted, []);
  assertEquals(audit.stale, []);
});

// ---------------------------------------------------------------------------
// Conformance over the live source tree
// ---------------------------------------------------------------------------

Deno.test("dedup manifest - every unverified search in the tree is listed", async () => {
  const sites = await scanDirectoriesForDedupSearches(
    REPO_ROOT,
    DEDUP_SCAN_DIRS,
  );
  assert(sites.length > 0, "the scanner found no dedup searches at all");

  const { unlisted } = auditDedupManifest(sites, UNVERIFIED_DEDUP_MANIFEST);
  assertEquals(
    unlisted.map((s) => `${s.file}:${s.line} ${s.search}`),
    [],
    "A dedup search keyed on an untrusted marker does not request `author`. " +
      "Request it (ALERT_DEDUP_JSON_FIELDS / ALERT_DEDUP_TITLE_JSON_FIELDS) " +
      "and verify the match with selectFleetAuthoredMatches. The manifest is " +
      "shrink-only — do not add an entry for a new site.",
  );
});

Deno.test("dedup manifest - no entry outlives the site it describes", async () => {
  const sites = await scanDirectoriesForDedupSearches(
    REPO_ROOT,
    DEDUP_SCAN_DIRS,
  );
  const { stale } = auditDedupManifest(sites, UNVERIFIED_DEDUP_MANIFEST);
  assertEquals(
    stale.map((e) => `${e.file} ${e.search}`),
    [],
    "A manifest entry no longer matches an unverified dedup search — the " +
      "site was fixed or moved. Delete the entry and lower " +
      "UNVERIFIED_DEDUP_SITE_CAP to match.",
  );
});

Deno.test("dedup manifest - the cap matches the manifest and may only fall", () => {
  assertEquals(
    UNVERIFIED_DEDUP_MANIFEST.length,
    UNVERIFIED_DEDUP_SITE_CAP,
    "UNVERIFIED_DEDUP_SITE_CAP must equal the manifest length. Lowering it " +
      "records a site fixed; raising it is never correct.",
  );
});

Deno.test("dedup manifest - every entry states a reason and a real path", () => {
  for (const entry of UNVERIFIED_DEDUP_MANIFEST) {
    assert(
      entry.file.startsWith("worker/deno/"),
      `manifest path outside the scanned tree: ${entry.file}`,
    );
    assert(
      entry.reason.trim().length >= 40,
      `manifest entry needs a stated reason: ${entry.file}`,
    );
  }
});

Deno.test("dedup manifest - the sites fixed by #1095 stay verified", async () => {
  const fixedByIssue1095 = [
    "worker/deno/lib/run_failure_issue.ts",
    "worker/deno/lib/idle_inversion_streak.ts",
    "worker/deno/lib/bump_script_failure_streak.ts",
    "worker/deno/lib/pr_branch_update_failure_streak.ts",
    "worker/deno/lib/idle_starvation_escalation.ts",
  ];
  const sites = await scanDirectoriesForDedupSearches(
    REPO_ROOT,
    DEDUP_SCAN_DIRS,
  );
  for (const file of fixedByIssue1095) {
    const found = sites.filter((s) => s.file === file);
    assertEquals(found.length, 1, `no dedup search found in ${file}`);
    assertEquals(
      found[0]?.authorVerified,
      true,
      `${file} stopped requesting the author on its dedup search`,
    );
  }
});
