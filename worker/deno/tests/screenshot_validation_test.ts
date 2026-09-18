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
  keywordFallbackApplies,
  validateScreenshotEvidence,
} from "../lib/screenshot_validation.ts";

// --- detectUiChanges ---

Deno.test("screenshot_validation - detectUiChanges returns true for CSS files", () => {
  const result = detectUiChanges("Updated styles", "enhancement", [
    "src/app.css",
    "lib/utils.ts",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for template files", () => {
  const result = detectUiChanges("Updated layout", "enhancement", [
    "src/index.html",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for component files", () => {
  const result = detectUiChanges("New component", "enhancement", [
    "src/Button.tsx",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for JSX files", () => {
  const result = detectUiChanges("Fixed render", "bug", [
    "src/App.jsx",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for Vue files", () => {
  const result = detectUiChanges("Vue fix", "bug", [
    "components/Header.vue",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for Svelte files", () => {
  const result = detectUiChanges("Svelte update", "bug", [
    "routes/+page.svelte",
  ]);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for SCSS/LESS files", () => {
  assertEquals(detectUiChanges("", "", ["theme.scss"]), true);
  assertEquals(detectUiChanges("", "", ["theme.less"]), true);
  assertEquals(detectUiChanges("", "", ["theme.sass"]), true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for UI labels", () => {
  const result = detectUiChanges("Fixed bug", "ui,bug", []);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for frontend label", () => {
  const result = detectUiChanges("Fixed bug", "frontend", []);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns true for UI keywords in summary", () => {
  const result = detectUiChanges("Updated button colour", "enhancement", []);
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns false for pure backend", () => {
  const result = detectUiChanges("Fixed database query", "bug", [
    "src/db.ts",
    "lib/query.ts",
  ]);
  assertEquals(result, false);
});

Deno.test("screenshot_validation - detectUiChanges returns false with no signals", () => {
  const result = detectUiChanges("Refactored config", "enhancement", [
    "config.ts",
  ]);
  assertEquals(result, false);
});

// --- validateScreenshotEvidence ---

Deno.test("screenshot_validation - validates successfully for non-UI changes", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Fixed a backend bug.",
    issueLabels: "bug,enhancement",
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
    issueLabels: "ui",
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
    issueLabels: "ui",
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
    issueLabels: "ui",
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
    issueLabels: "enhancement",
    changedFiles: ["src/styles/theme.css"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, false);
  assertEquals(result.isUiChange, true);
});

Deno.test("screenshot_validation - detects UI change from labels only", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Refactored code",
    issueLabels: "frontend,enhancement",
    changedFiles: ["src/utils.ts"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, false);
  assertEquals(result.isUiChange, true);
});

Deno.test("screenshot_validation - detects UI change from summary keywords", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Changed the modal dialog behaviour",
    issueLabels: "enhancement",
    changedFiles: ["src/modal.ts"],
    repo: "owner/repo",
    issueNumber: 42,
  });
  assertEquals(result.valid, false);
  assertEquals(result.isUiChange, true);
});

// --- Issue #1296: false positive detection fixes ---

Deno.test("screenshot_validation - detectUiChanges returns false when 'visual' appears in negated context", () => {
  const result = detectUiChanges(
    "No visual output changes were made. This is a performance issue.",
    "performance",
    ["src/engine.ts"],
  );
  assertEquals(result, false);
});

Deno.test("screenshot_validation - detectUiChanges returns false for 'color' in non-UI context", () => {
  const result = detectUiChanges(
    "Adjusted the color of terminal log output for better readability.",
    "enhancement",
    ["src/logger.ts"],
  );
  assertEquals(result, false);
});

Deno.test("screenshot_validation - detectUiChanges returns true for genuine UI keyword usage", () => {
  const result = detectUiChanges(
    "Updated the button colour and added a new modal dialog.",
    "enhancement",
    [],
  );
  assertEquals(result, true);
});

Deno.test("screenshot_validation - detectUiChanges returns false for performance PR with single chart keyword", () => {
  const result = detectUiChanges(
    "Performance results show 20% improvement. See the chart below.",
    "performance",
    ["src/engine.ts"],
  );
  assertEquals(result, false);
});

Deno.test("screenshot_validation - failure message includes retry instructions", () => {
  const result = validateScreenshotEvidence({
    prSummaryContent: "Updated CSS colours",
    issueLabels: "enhancement",
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

// --- Issue #1909: the keyword fallback needs a file that could carry a UI ---

Deno.test("screenshot_validation #1909 - a Rust-only change is not a UI change on two English words", () => {
  // NEAT-AI-Ockham#198's summary: graph colouring and visual inspection.
  const summary =
    "prune_neuron rewrites an IF left short a role. The color of each " +
    "role is preserved; visual inspection of the sweep confirms the repair.";
  assertEquals(
    detectUiChanges(summary, "enhancement", [
      "ockham/src/prune.rs",
      "ockham/src/repair.rs",
      "docs/archive/pr-summaries/pr-summary-198.md",
      "Cargo.lock",
    ]),
    false,
  );
});

Deno.test("screenshot_validation #1909 - the same words with a web source file changed are still a UI change", () => {
  const summary = "Changed the button color and the visual spacing.";
  assertEquals(
    detectUiChanges(summary, "enhancement", ["src/toolbar.ts"]),
    true,
  );
  assertEquals(
    detectUiChanges(summary, "enhancement", ["engine.rs", "web/index.html"]),
    true,
  );
});

Deno.test("screenshot_validation #1909 - with no changed-file information the keyword fallback still applies", () => {
  assertEquals(
    detectUiChanges("Changed the button color and visual spacing.", "bug", []),
    true,
  );
});

Deno.test("screenshot_validation #1909 - keywordFallbackApplies", () => {
  assertEquals(keywordFallbackApplies([]), true);
  assertEquals(
    keywordFallbackApplies(["a.rs", "README.md", "Cargo.toml"]),
    false,
  );
  assertEquals(keywordFallbackApplies(["a.rs", "app.js"]), true);
  assertEquals(
    keywordFallbackApplies(["scripts/run.sh", "config.yaml"]),
    false,
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
  assertEquals(detectUiChanges(summary, "work-on", changed, bumpOnly), false);
  // Without the set the same change reads as UI, which is what failed the run.
  assertEquals(detectUiChanges(summary, "work-on", changed), true);

  const result = validateScreenshotEvidence({
    prSummaryContent: summary,
    issueLabels: "work-on",
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
    detectUiChanges("Restyled the header.", "", changed, bumpOnly),
    true,
  );
  const result = validateScreenshotEvidence({
    prSummaryContent: "Restyled the header.",
    issueLabels: "",
    changedFiles: changed,
    repo: "owner/repo",
    issueNumber: 1,
    versionBumpOnlyFiles: ["docs/index.html"],
  });
  assertEquals(result.valid, false);
  assertEquals(result.isUiChange, true);
});

Deno.test("screenshot_validation #2300 - a bump-only change is not made a UI change by its summary or by a label", () => {
  const changed = ["docs/index.html", "docs/sw.js"];
  const bumpOnly = new Set(changed);
  assertEquals(
    detectUiChanges(
      "Release 1.1.30: refreshed the html chart colour and font.",
      "release",
      changed,
      bumpOnly,
    ),
    false,
  );
  // An explicit UI label still wins: the label is the operator's word.
  assertEquals(detectUiChanges("Release", "ui", changed, bumpOnly), true);
});

Deno.test("screenshot_validation #2300 - isUiSourceFile", () => {
  assertEquals(isUiSourceFile("docs/index.html"), true);
  assertEquals(isUiSourceFile("src/App.tsx"), true);
  assertEquals(isUiSourceFile("docs/sw.js"), false);
  assertEquals(isUiSourceFile("run.sh"), false);
});
