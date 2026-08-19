/**
 * Tests for language_detector.ts — repository language detection.
 *
 * Issue #1391: Create language detection library for repository language analysis.
 */

import { assertEquals } from "@std/assert";
import {
  type CommandOutput,
  detectRepoLanguages,
  type LanguageDetectorOptions,
} from "../lib/language_detector.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock runner that returns predefined results per command key. */
function mockRunner(
  responses: Record<string, CommandOutput>,
): (cmd: string[]) => Promise<CommandOutput> {
  return (cmd: string[]): Promise<CommandOutput> => {
    const joined = cmd.join(" ");

    // Match on the API path fragment to find the right response.
    for (const [key, value] of Object.entries(responses)) {
      if (joined.includes(key)) {
        return Promise.resolve(value);
      }
    }

    // Default: empty success
    return Promise.resolve({ success: true, stdout: "[]", stderr: "" });
  };
}

function ok(stdout: string): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): CommandOutput {
  return { success: false, stdout: "", stderr };
}

/** Convenience to build a root-contents response from file names. */
function contentsResponse(names: string[]): CommandOutput {
  const items = names.map((n) => ({ name: n, type: "file" }));
  return ok(JSON.stringify(items));
}

// ---------------------------------------------------------------------------
// Detection of individual languages via marker files
// ---------------------------------------------------------------------------

Deno.test("language_detector - detects Rust via Cargo.toml", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["Cargo.toml", "README.md"]),
      "/languages": ok(JSON.stringify({ Rust: 50000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const rust = result.value.detected.find((d) => d.language === "Rust");
  assertEquals(rust !== undefined, true);
  assertEquals(rust!.confidence, "marker");
  assertEquals(rust!.markerFile, "Cargo.toml");
  assertEquals(result.value.primary, "Rust");
});

Deno.test("language_detector - detects Deno via deno.json", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["deno.json", "package.json"]),
      "/languages": ok(JSON.stringify({ TypeScript: 80000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const deno = result.value.detected.find((d) => d.language === "Deno");
  assertEquals(deno !== undefined, true);
  assertEquals(deno!.confidence, "marker");
  assertEquals(deno!.markerFile, "deno.json");
});

Deno.test("language_detector - detects Deno via deno.jsonc", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["deno.jsonc"]),
      "/languages": ok(JSON.stringify({ TypeScript: 40000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const deno = result.value.detected.find((d) => d.language === "Deno");
  assertEquals(deno !== undefined, true);
  assertEquals(deno!.markerFile, "deno.jsonc");
});

Deno.test("language_detector - detects Node via package.json without deno.json", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["package.json", "index.js"]),
      "/languages": ok(JSON.stringify({ JavaScript: 60000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const node = result.value.detected.find((d) => d.language === "Node");
  assertEquals(node !== undefined, true);
  assertEquals(node!.confidence, "marker");
  assertEquals(node!.markerFile, "package.json");
});

Deno.test("language_detector - Deno takes precedence over Node when both deno.json and package.json present", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["deno.json", "package.json"]),
      "/languages": ok(JSON.stringify({ TypeScript: 90000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const deno = result.value.detected.find((d) => d.language === "Deno");
  const node = result.value.detected.find((d) => d.language === "Node");
  assertEquals(deno !== undefined, true);
  assertEquals(
    node,
    undefined,
    "Node should NOT be detected when deno.json is present",
  );
});

Deno.test("language_detector - detects Java via pom.xml", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["pom.xml", "src"]),
      "/languages": ok(JSON.stringify({ Java: 120000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const java = result.value.detected.find((d) => d.language === "Java");
  assertEquals(java !== undefined, true);
  assertEquals(java!.markerFile, "pom.xml");
});

Deno.test("language_detector - detects Java via build.gradle", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["build.gradle"]),
      "/languages": ok(JSON.stringify({ Java: 80000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const java = result.value.detected.find((d) => d.language === "Java");
  assertEquals(java !== undefined, true);
  assertEquals(java!.markerFile, "build.gradle");
});

Deno.test("language_detector - detects Java via build.gradle.kts", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["build.gradle.kts"]),
      "/languages": ok(JSON.stringify({ Kotlin: 50000, Java: 30000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const java = result.value.detected.find((d) => d.language === "Java");
  assertEquals(java !== undefined, true);
  assertEquals(java!.markerFile, "build.gradle.kts");
});

Deno.test("language_detector - detects Bash via .sh files in root", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["deploy.sh", "README.md"]),
      "/languages": ok(JSON.stringify({ Shell: 5000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const bash = result.value.detected.find((d) => d.language === "Bash");
  assertEquals(bash !== undefined, true);
  assertEquals(bash!.confidence, "marker");
});

Deno.test("language_detector - detects React/Web via index.html with css/js files", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["index.html", "style.css", "app.js"]),
      "/languages": ok(
        JSON.stringify({ HTML: 10000, CSS: 5000, JavaScript: 8000 }),
      ),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const web = result.value.detected.find((d) => d.language === "React/Web");
  assertEquals(web !== undefined, true);
  assertEquals(web!.confidence, "marker");
  assertEquals(web!.markerFile, "index.html");
});

Deno.test("language_detector - does NOT detect React/Web for index.html without css/js", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["index.html", "README.md"]),
      "/languages": ok(JSON.stringify({ HTML: 10000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const web = result.value.detected.find((d) => d.language === "React/Web");
  assertEquals(
    web,
    undefined,
    "React/Web requires index.html AND css/js files",
  );
});

// ---------------------------------------------------------------------------
// Multi-language repos
// ---------------------------------------------------------------------------

Deno.test("language_detector - detects multiple languages in a repo", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse([
        "Cargo.toml",
        "deno.json",
        "package.json",
        "deploy.sh",
      ]),
      "/languages": ok(JSON.stringify({ Rust: 80000, TypeScript: 40000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const languages = result.value.detected.map((d) => d.language);
  assertEquals(languages.includes("Rust"), true, "Should detect Rust");
  assertEquals(languages.includes("Deno"), true, "Should detect Deno");
  assertEquals(languages.includes("Bash"), true, "Should detect Bash");
  // Node should NOT appear because deno.json is present
  assertEquals(
    languages.includes("Node"),
    false,
    "Node should not appear with deno.json",
  );
});

// ---------------------------------------------------------------------------
// Primary language selection
// ---------------------------------------------------------------------------

Deno.test("language_detector - primary language is based on highest API byte count", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["Cargo.toml", "deno.json"]),
      "/languages": ok(JSON.stringify({ TypeScript: 90000, Rust: 50000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Primary should be determined by byte count from the API
  assertEquals(result.value.primary, "TypeScript");
});

Deno.test("language_detector - primary falls back to first detected when no API data", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["Cargo.toml"]),
      "/languages": ok(JSON.stringify({})),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.primary, "Rust");
});

// ---------------------------------------------------------------------------
// Fallback to API language data
// ---------------------------------------------------------------------------

Deno.test("language_detector - falls back to API languages when no markers found", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["README.md", "LICENSE"]),
      "/languages": ok(JSON.stringify({ Python: 60000, Go: 20000 })),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Should still have entries from the API with "api" confidence
  const python = result.value.detected.find((d) => d.language === "Python");
  assertEquals(python !== undefined, true);
  assertEquals(python!.confidence, "api");
  assertEquals(result.value.primary, "Python");
});

// ---------------------------------------------------------------------------
// Raw API data
// ---------------------------------------------------------------------------

Deno.test("language_detector - raw field contains API byte counts", async () => {
  const apiData = { TypeScript: 80000, Shell: 5000 };
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["deno.json"]),
      "/languages": ok(JSON.stringify(apiData)),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.raw, apiData);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

Deno.test("language_detector - returns error when contents API fails", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": fail("Not Found"),
      "/languages": ok(JSON.stringify({})),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, false);
  if (result.ok) return;

  assertEquals(result.error.includes("contents"), true);
});

Deno.test("language_detector - returns error when languages API fails", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["README.md"]),
      "/languages": fail("Forbidden"),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, false);
  if (result.ok) return;

  assertEquals(result.error.includes("languages"), true);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

Deno.test("language_detector - idempotent: same input produces same output", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse(["Cargo.toml", "deno.json"]),
      "/languages": ok(JSON.stringify({ Rust: 50000, TypeScript: 80000 })),
    }),
  };

  const r1 = await detectRepoLanguages("owner/repo", opts);
  const r2 = await detectRepoLanguages("owner/repo", opts);
  assertEquals(r1, r2);
});

// ---------------------------------------------------------------------------
// Empty / edge cases
// ---------------------------------------------------------------------------

Deno.test("language_detector - empty repo with no files and no API languages", async () => {
  const opts: LanguageDetectorOptions = {
    runCommand: mockRunner({
      "contents/": contentsResponse([]),
      "/languages": ok(JSON.stringify({})),
    }),
  };

  const result = await detectRepoLanguages("owner/repo", opts);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.detected.length, 0);
  assertEquals(result.value.primary, "unknown");
  assertEquals(result.value.raw, {});
});
