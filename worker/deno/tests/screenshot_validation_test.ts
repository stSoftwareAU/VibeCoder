/**
 * Tests for screenshot_validation.ts — screenshot evidence validation
 * in the PR completion phase (Issue #1185).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  detectUiChanges,
  isUiSourceFile,
  isVersionBumpOnly,
  validateScreenshotEvidence,
} from "../lib/screenshot_validation.ts";

// --- detectUiChanges ---

Deno.test("screenshot_validation - detectUiChanges returns true for CSS files", () => {
  const result = detectUiChanges([
    "src/app.css",
    "lib/utils.ts",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for template files", () => {
  const result = detectUiChanges([
    "src/index.html",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for component files", () => {
  const result = detectUiChanges([
    "src/Button.tsx",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for various UI file extensions", () => {
  for (
    const ext of ["css", "scss", "html", "tsx", "jsx", "vue", "svelte"]
  ) {
    assertEquals(
      detectUiChanges([`src/file.${ext}`]),
      true,
      `expected .${ext} to be detected as a UI file`,
    );
  }
});

Deno.test("screenshot_validation - detectUiChanges returns true for SCSS/LESS files", () => {
  assertEquals(detectUiChanges(["theme.scss"]), true);
  assertEquals(detectUiChanges(["theme.less"]), true);
  assertEquals(detectUiChanges(["theme.sass"]), true);
});

Deno.test("screenshot_validation - detectUiChanges returns false for pure backend", () => {
  const result = detectUiChanges([
    "src/db.ts",
    "lib/query.ts",
  ]);
  assertEquals(result, false);
});

Deno.test("screenshot_validation - detectUiChanges returns false with no signals", () => {
  const result = detectUiChanges([
    "config.ts",
  ]);
  assertEquals(result, false);
});

// --- Issue #2959: changed files are the only signal — labels and summary
// wording are deliberately ignored. A `lang:design` label or a
// keyword-laden summary used to demand a screenshot of a change with no
// browser surface at all.

Deno.test("screenshot_validation #2959 - detectUiChanges returns false for a non-UI file regardless of label (issue labelled lang:design)", () => {
  assertEquals(detectUiChanges(["worker/deno/lib/foo.ts"]), false);
  const result = validateScreenshotEvidence({
    prSummaryContent: "Refactored the completion phase helpers.",
    changedFiles: ["worker/deno/lib/foo.ts"],
    repo: "owner/repo",
    issueNumber: 1,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, false);
});

Deno.test("screenshot_validation #2959 - detectUiChanges returns false for an empty changed-file list regardless of summary wording", () => {
  assertEquals(detectUiChanges([]), false);
  const result = validateScreenshotEvidence({
    prSummaryContent:
      "Updated the button colour, visual layout and modal dialog",
    changedFiles: [],
    repo: "owner/repo",
    issueNumber: 1,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, false);
});

Deno.test("screenshot_validation #2959 - non-UI file extensions are not a UI change despite a keyword-laden summary", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "button colour visual modal",
    changedFiles: ["src/a.ts", "engine/b.rs", "README.md"],
    repo: "owner/repo",
    issueNumber: 1,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, false);
});

Deno.test("screenshot_validation #2959 - a label alone, with no UI file changed, is not a UI change", () => {
  // Previously a `ui`/`frontend` label alone was enough; now only the
  // changed files decide. issueLabels is no longer even an input.
  const result = validateScreenshotEvidence({
    prSummaryContent: "Refactored code",
    changedFiles: ["src/utils.ts"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, false);
});

Deno.test("screenshot_validation #2959 - summary keywords alone, with no UI file changed, are not a UI change", () => {
  // Previously two distinct UI keywords in the summary were enough to flag
  // a UI change on their own; now the changed files alone decide.
  const result = validateScreenshotEvidence({
    prSummaryContent: "Changed the modal dialog behaviour and button colour",
    changedFiles: ["src/modal.ts"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, false);
});

// --- validateScreenshotEvidence ---

Deno.test("screenshot_validation - validates successfully for non-UI changes", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Fixed a backend bug.",
    changedFiles: ["src/db.ts"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, false);
});

Deno.test("screenshot_validation - validates successfully when skip_screenshot_check is true", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Updated the button styling.",
    changedFiles: ["src/Button.tsx"],
    repo: "owner/repo",
    issueNumber: 42,
    skipScreenshotCheck: true,
  });
  assertEquals(result.valid, true);
  assertEquals(result.skipped, true);
});

Deno.test("screenshot_validation - fails for UI change without screenshots", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Updated the button styling.",
    changedFiles: ["src/Button.tsx"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, false);
  assertEquals(result.isUiChange, true);
  assertEquals(typeof result.failureMessage === "string", true);
  assertEquals(result.failureMessage!.includes("screenshot"), true);
});

Deno.test("screenshot_validation - passes for UI change with screenshot in summary", () => {
  const content = "Updated button ![Screenshot](docs/evidence/button.png)";
  const result = validateScreenshotEvidence({
    prSummaryContent: content,
    changedFiles: ["src/Button.tsx"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, true);
});

Deno.test("screenshot_validation - detects UI change from changed files only", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Minor update",
    changedFiles: ["src/styles/theme.css"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, false);
  assertEquals(result.isUiChange, true);
});

// --- Former #1296/#1909 keyword-heuristic cases, folded into one negative
// test now that keyword content plays no part in detection (Issue #2959).

Deno.test("screenshot_validation #2959 - UI-flavoured words in the summary never make a non-UI-file change a UI change", () => {
  assertEquals(
    detectUiChanges(["src/engine.ts"]),
    false,
    "negated-context 'visual' wording is moot — only files decide",
  );
  assertEquals(
    detectUiChanges(["src/logger.ts"]),
    false,
    "'color' in a non-UI context is moot — only files decide",
  );
  assertEquals(
    detectUiChanges([]),
    false,
    "genuine UI keyword usage with no changed files is not a UI change",
  );
  assertEquals(
    detectUiChanges(["src/engine.ts"]),
    false,
    "a single chart keyword is moot — only files decide",
  );
});

Deno.test("screenshot_validation - failure message includes retry instructions", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Updated CSS colours",
    changedFiles: ["src/theme.css"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, false);
  assertEquals(result.failureMessage!.includes("Playwright MCP"), true);
  assertEquals(result.failureMessage!.includes("browser_navigate"), true);
  assertEquals(
    result.failureMessage!.includes("browser_take_screenshot"),
    true,
  );
});

// --- Issue #1909: a changed file is required to carry a UI ---

Deno.test("screenshot_validation #1909 - a Rust-only change is not a UI change on two English words", () => {
  // NEAT-AI-Ockham#198's summary: graph colouring and visual inspection.
  const summary =
    "prune_neuron rewrites an IF left short a role. The color of each " +
    "role is preserved; visual inspection of the sweep confirms the repair.";
  assertEquals(
    detectUiChanges([
      "ockham/src/prune.rs",
      "ockham/src/repair.rs",
      "docs/archive/pr-summaries/pr-summary-198.md",
      "Cargo.lock",
    ]),
    false,
  );
  // The summary text plays no part — a validateScreenshotEvidence call with
  // the same summary and files confirms it is still not a UI change.
  const result = validateScreenshotEvidence({
    prSummaryContent: summary,
    changedFiles: [
      "ockham/src/prune.rs",
      "ockham/src/repair.rs",
      "docs/archive/pr-summaries/pr-summary-198.md",
      "Cargo.lock",
    ],
    repo: "owner/repo",
    issueNumber: 198,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, false);
});

Deno.test("screenshot_validation #1909 - a web source file changed is a UI change regardless of summary wording", () => {
  assertEquals(
    detectUiChanges(["src/toolbar.ts"]),
    false,
    ".ts is not a UI file extension — only files with a UI extension count",
  );
  assertEquals(
    detectUiChanges(["engine.rs", "web/index.html"]),
    true,
  );
});

// --- Issue #2300: a version bump in a UI file is not a UI change ---
//
// GRQ-health's update_version.sh stamps index.html, sw.js and dashboard.js
// on every change, so a backend PR there touched three UI files and the gate
// demanded a screenshot of run.sh (GRQ-health#211). These patches are the
// ones that run carried, verbatim.

const INDEX_HTML_BUMP = `diff --git a/docs/index.html b/docs/index.html
--- a/docs/index.html
+++ b/docs/index.html
@@ -40 +40 @@
-    <link href="./styles.css?v=1.1.28" rel="stylesheet">
+    <link href="./styles.css?v=1.1.30" rel="stylesheet">
@@ -146 +146 @@
-    <script src="./dashboard.js?v=1.1.28"></script>
+    <script src="./dashboard.js?v=1.1.30"></script>
@@ -153 +153 @@
-                navigator.serviceWorker.register('./sw.js?v=1.1.28')
+                navigator.serviceWorker.register('./sw.js?v=1.1.30')
`;

const SW_JS_BUMP = `--- a/docs/sw.js
+++ b/docs/sw.js
@@ -2 +2 @@
-// Version: 1.1.28
+// Version: 1.1.30
@@ -4,2 +4,2 @@
-const CACHE_NAME = 'grq-health-v1.1.28';
-const STATIC_CACHE_NAME = 'grq-health-static-v1.1.28';
+const CACHE_NAME = 'grq-health-v1.1.30';
+const STATIC_CACHE_NAME = 'grq-health-static-v1.1.30';
@@ -14 +14 @@
-  './dashboard.js?v=1.1.28',
+  './dashboard.js?v=1.1.30',
`;

Deno.test("screenshot_validation #2300 - isVersionBumpOnly accepts a cache-busting bump", () => {
  assertEquals(isVersionBumpOnly(INDEX_HTML_BUMP), true);
  assertEquals(isVersionBumpOnly(SW_JS_BUMP), true);
  assertEquals(
    isVersionBumpOnly(
      '-const VERSION = "1.1.28";\n+const VERSION = "1.1.30";\n',
    ),
    true,
  );
  assertEquals(
    isVersionBumpOnly("-  version: 2.0.0-rc.1\n+  version: 2.0.0\n"),
    true,
  );
});

Deno.test("screenshot_validation #2300 - isVersionBumpOnly refuses anything that is not a bump", () => {
  // A reworded line beside the bump.
  assertEquals(
    isVersionBumpOnly(
      '-    <link href="./styles.css?v=1.1.28" rel="stylesheet">\n' +
        '+    <link href="./dark.css?v=1.1.30" rel="stylesheet">\n',
    ),
    false,
  );
  // An added line with no partner.
  assertEquals(
    isVersionBumpOnly(
      '-const VERSION = "1.1.28";\n+const VERSION = "1.1.30";\n+const THEME = "dark";\n',
    ),
    false,
  );
  // A change with no version in it at all.
  assertEquals(
    isVersionBumpOnly("-  color: red;\n+  color: blue;\n"),
    false,
  );
  // Nothing changed.
  assertEquals(isVersionBumpOnly(""), false);
  // A version moved but the line changed too.
  assertEquals(
    isVersionBumpOnly("-  <h1>v1.1.28</h1>\n+  <h2>v1.1.30</h2>\n"),
    false,
  );
});

Deno.test("screenshot_validation #2300 - a backend change carrying a version bump is not a UI change", () => {
  const changed = [
    "run.sh",
    "helpers/compact-history.sh",
    "docs/index.html",
    "docs/sw.js",
    "docs/dashboard.js",
    "README.md",
  ];
  const bumpOnly = new Set([
    "docs/index.html",
    "docs/sw.js",
    "docs/dashboard.js",
  ]);
  const summary =
    "Backend/CLI change — there is no new web interface to screenshot. " +
    "Only a bounded log tail is published; html pages are cache-busted.";
  assertEquals(detectUiChanges(changed, bumpOnly), false);
  // Without the set the same change reads as UI, which is what failed the run.
  assertEquals(detectUiChanges(changed), true);

  const result = validateScreenshotEvidence({
    prSummaryContent: summary,
    changedFiles: changed,
    repo: "stSoftwareAU/GRQ-health",
    issueNumber: 211,
    versionBumpOnlyFiles: [...bumpOnly],
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, false);
});

Deno.test("screenshot_validation #2300 - a real UI edit beside a bump is still a UI change", () => {
  const changed = ["docs/index.html", "docs/styles.css"];
  const bumpOnly = new Set(["docs/index.html"]);
  assertEquals(
    detectUiChanges(changed, bumpOnly),
    true,
  );
  const result = validateScreenshotEvidence({
    prSummaryContent: "Restyled the header.",
    changedFiles: changed,
    repo: "owner/repo",
    issueNumber: 1,
    versionBumpOnlyFiles: ["docs/index.html"],
  });
  assertEquals(result.valid, false);
  assertEquals(result.isUiChange, true);
});

Deno.test("screenshot_validation #2300 - a bump-only change is not made a UI change by its summary", () => {
  const changed = ["docs/index.html", "docs/sw.js"];
  const bumpOnly = new Set(changed);
  assertEquals(
    detectUiChanges(changed, bumpOnly),
    false,
  );
});

Deno.test("screenshot_validation #2300 - isUiSourceFile", () => {
  assertEquals(isUiSourceFile("docs/index.html"), true);
  assertEquals(isUiSourceFile("src/App.tsx"), true);
  assertEquals(isUiSourceFile("docs/sw.js"), false);
  assertEquals(isUiSourceFile("run.sh"), false);
});
