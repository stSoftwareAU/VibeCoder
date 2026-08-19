/**
 * Tests for screenshot_validation.ts — screenshot evidence validation
 * in the PR completion phase (Issue #1185).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  detectUiChanges,
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
