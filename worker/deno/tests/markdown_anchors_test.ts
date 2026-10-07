/**
 * Regression tests for Issue #3424 — broken and inconsistent internal doc
 * anchors.
 *
 * Two layers:
 *   1. Unit tests for the GitHub slug algorithm against the exact headings the
 *      audit flagged (emoji leading-hyphen, em-dash/`+` double-hyphen, `/`
 *      removal, long issue-number slugs).
 *   2. Resolution tests that read each *referencing* doc and its *target* doc
 *      and assert every in-scope `#fragment` link resolves to a real heading.
 *      These fail against the pre-fix docs and pass after the anchors are
 *      corrected.
 *
 * Australian English spelling used throughout (behaviour, normalise, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { anchorSet, githubSlug } from "../lib/markdown_anchors.ts";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(repoPath(relative));
}

Deno.test("githubSlug - leading emoji yields a leading hyphen", () => {
  assertEquals(
    githubSlug("🥇 Issue selection priority"),
    "-issue-selection-priority",
  );
  assertEquals(
    githubSlug("📊 Work Prioritisation Order"),
    "-work-prioritisation-order",
  );
});

// A U+FE0F variation selector survives slugging, so the link form is
// percent-encoded (Issue #3292).
Deno.test("githubSlug - slashes drop and a variation selector survives", () => {
  assertEquals(
    githubSlug("🎚️ Model/effort precedence chain"),
    "️-modeleffort-precedence-chain",
  );
  assertEquals(
    encodeURIComponent(githubSlug("⚠️ Known Limitations")),
    "%EF%B8%8F-known-limitations",
  );
});

Deno.test("githubSlug - a space-padded em-dash collapses to a double hyphen", () => {
  assertEquals(
    githubSlug("Release-gating — never auto-release (Issue #2944)"),
    "release-gating--never-auto-release-issue-2944",
  );
});

Deno.test("githubSlug - full issue-number heading keeps every token", () => {
  assertEquals(
    githubSlug("Security scans (Issue #1933, #1944, simplified by #2023)"),
    "security-scans-issue-1933-1944-simplified-by-2023",
  );
});

// Connector punctuation (`\p{Pc}`, e.g. `_`) survives slugging because
// GitHub's `github-slugger` keeps it; ids observed from GitHub's rendered
// HTML via `gh api repos/stSoftwareAU/VibeCoder/contents/docs/CALLBACKS.md
// -H "Accept: application/vnd.github.html"` (Issue #3337).
Deno.test("githubSlug - connector punctuation (underscore) survives (Issue #3337)", () => {
  assertEquals(
    githubSlug("Host-level failures — `callbacks.host_failure`"),
    "host-level-failures--callbackshost_failure",
  );
  assertEquals(
    githubSlug("Migrating from `fleet_health_dir` / `fleet_health_repo`"),
    "migrating-from-fleet_health_dir--fleet_health_repo",
  );
});

// `_name_` is underscore emphasis at a word boundary, not connector
// punctuation — GitHub renders it as `<em>name</em>` and drops the
// delimiters. Id observed from GitHub's rendered HTML via `gh api
// repos/stSoftwareAU/VibeCoder/contents/docs/audits/security-sweep-1218-commands-cli.md
// -H "Accept: application/vnd.github.html"` (review on PR #3363, Issue
// #3337).
Deno.test("githubSlug - underscore emphasis delimiters drop, unlike connector-punctuation underscores (PR #3363)", () => {
  assertEquals(
    githubSlug(
      "SEC-1218-F5 — an unescaped shell variable _name_ in text that is `eval`'d",
    ),
    "sec-1218-f5--an-unescaped-shell-variable-name-in-text-that-is-evald",
  );
});

/**
 * In-scope anchor references: each link that the audit flagged, expressed as
 * the referencing file, the exact `target#fragment` string it must contain,
 * and the target doc whose headings the fragment must resolve against.
 */
const REFERENCES: Array<{
  source: string;
  link: string;
  target: string;
  fragment: string;
}> = [
  // Security-scans anchor — full slug (4 references).
  {
    source: "docs/SECURITY-SCAN.md",
    link: "../DESIGN-PRINCIPLES.md#security-scans",
    target: "DESIGN-PRINCIPLES.md",
    fragment: "security-scans",
  },
  {
    source: "docs/BEST-PRACTICES-SCAN.md",
    link: "../DESIGN-PRINCIPLES.md#security-scans",
    target: "DESIGN-PRINCIPLES.md",
    fragment: "security-scans",
  },
  // Model/effort precedence chain — renamed heading + emoji slug, the emoji
  // keeps its U+FE0F variation selector so the link is percent-encoded
  // (Issue #3292).
  {
    source: "docs/MODEL-AND-CACHING.md",
    link: "#%EF%B8%8F-modeleffort-precedence-chain",
    target: "docs/MODEL-AND-CACHING.md",
    fragment: "️-modeleffort-precedence-chain",
  },
  // Issue selection priority — emoji leading-hyphen convention.
  {
    source: "docs/CONFIGURATION.md",
    link: "workflows/issue-processing.md#-issue-selection-priority",
    target: "docs/workflows/issue-processing.md",
    fragment: "-issue-selection-priority",
  },
  // Work prioritisation order — emoji leading-hyphen convention.
  {
    source: "README.md",
    link: "docs/USAGE.md#-work-prioritisation-order",
    target: "docs/USAGE.md",
    fragment: "-work-prioritisation-order",
  },
  {
    source: "docs/USAGE.md",
    link: "#-work-prioritisation-order",
    target: "docs/USAGE.md",
    fragment: "-work-prioritisation-order",
  },
  // Cross-repo release-gating — em-dash double hyphen.
  {
    source: "docs/CROSS-REPO-FIX.md",
    link: "#release-gating--never-auto-release",
    target: "docs/CROSS-REPO-FIX.md",
    fragment: "release-gating--never-auto-release",
  },
];

Deno.test("anchors - every in-scope fragment resolves to a real heading", async () => {
  for (const ref of REFERENCES) {
    const anchors = anchorSet(await read(ref.target));
    assert(
      anchors.has(ref.fragment),
      `${ref.target} has no heading with anchor #${ref.fragment} ` +
        `(referenced from ${ref.source})`,
    );
  }
});
