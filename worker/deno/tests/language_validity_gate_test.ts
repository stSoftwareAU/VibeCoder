/**
 * Tests for language_validity_gate.ts — native language-validity CI-gate
 * detector (Issue #3237, part of #3223).
 *
 * Covers:
 *   - reused rust / typescript / java compile-gate detection still passes
 *     through unchanged (present when wired, flagged when missing);
 *   - net-new Python `py_compile` / `compileall` detection;
 *   - a multi-language repo returns correct per-language results;
 *   - a shell-only repo yields no language findings;
 *   - the language enumerator honours the shared React decision;
 *   - an incidental language below the main-language share threshold is not
 *     treated as a main language (Issue #3).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkLanguageValidityGates,
  detectValidityGateLanguages,
  type LanguageValidityResult,
  MAIN_LANGUAGE_MIN_SHARE,
  type ValidityGateLanguage,
} from "../lib/language_validity_gate.ts";
import type { RepoLanguages } from "../lib/language_detector.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a temp repo, populate it via `files`, run `fn`, then clean up. */
async function withTempRepo(
  files: Record<string, string>,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "language_validity_gate_" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = `${tmp}/${rel}`;
      const parent = full.substring(0, full.lastIndexOf("/"));
      await Deno.mkdir(parent, { recursive: true });
      await Deno.writeTextFile(full, content);
    }
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Minimal RepoLanguages with the given raw byte counts. */
function langs(
  raw: Record<string, number>,
  markers?: RepoLanguages["bestPracticesMarkers"],
): RepoLanguages {
  return {
    detected: [],
    primary: Object.keys(raw)[0] ?? "unknown",
    raw,
    ...(markers ? { bestPracticesMarkers: markers } : {}),
  };
}

/** Build a workflow file whose steps run the given commands. */
function workflow(...runLines: string[]): string {
  return [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...runLines.map((l) => `      - run: ${l}`),
  ].join("\n");
}

function byLang(
  results: LanguageValidityResult[],
  language: ValidityGateLanguage,
): LanguageValidityResult {
  const found = results.find((r) => r.language === language);
  if (!found) throw new Error(`no result for ${language}`);
  return found;
}

// ---------------------------------------------------------------------------
// Language enumeration
// ---------------------------------------------------------------------------

Deno.test("detectValidityGateLanguages — maps rust/ts/java/python from raw", () => {
  const result = detectValidityGateLanguages(
    langs({ Rust: 100, TypeScript: 200, Java: 50, Python: 30 }),
  );
  assertEquals(result.sort(), ["java", "python", "rust", "typescript"]);
});

Deno.test("detectValidityGateLanguages — React decision picks react over typescript", () => {
  const result = detectValidityGateLanguages(
    langs({ TypeScript: 200 }, {
      hasReactDependency: true,
      hasJsxFiles: true,
    }),
  );
  assertEquals(result, ["react"]);
});

Deno.test("detectValidityGateLanguages — TypeScript without React markers stays typescript", () => {
  const result = detectValidityGateLanguages(
    langs({ TypeScript: 200 }, { hasReactDependency: true }),
  );
  assertEquals(result, ["typescript"]);
});

Deno.test("detectValidityGateLanguages — shell-only repo yields no languages", () => {
  assertEquals(detectValidityGateLanguages(langs({ Shell: 500 })), []);
});

// ---------------------------------------------------------------------------
// Main-language share threshold (Issue #3)
// ---------------------------------------------------------------------------

Deno.test("detectValidityGateLanguages — incidental TypeScript in a Rust repo is not a main language", () => {
  // Real byte counts from stSoftwareAU/NEAT-AI-Lamarck: a Rust repo whose
  // only TypeScript is one fixture-generation script (0.1% of the repo).
  assertEquals(
    detectValidityGateLanguages(
      langs({ Rust: 1390142, Shell: 65940, TypeScript: 1407 }),
    ),
    ["rust"],
  );
});

Deno.test("detectValidityGateLanguages — language exactly on the share threshold is a main language", () => {
  const total = 10_000;
  const onThreshold = total * MAIN_LANGUAGE_MIN_SHARE;
  assertEquals(
    detectValidityGateLanguages(
      langs({ Rust: total - onThreshold, Python: onThreshold }),
    ).sort(),
    ["python", "rust"],
  );
});

Deno.test("detectValidityGateLanguages — language just under the share threshold is ignored", () => {
  const total = 10_000;
  const underThreshold = total * MAIN_LANGUAGE_MIN_SHARE - 1;
  assertEquals(
    detectValidityGateLanguages(
      langs({ Rust: total - underThreshold, Python: underThreshold }),
    ),
    ["rust"],
  );
});

Deno.test("detectValidityGateLanguages — incidental TypeScript with React markers is still ignored", () => {
  assertEquals(
    detectValidityGateLanguages(
      langs({ Java: 100_000, TypeScript: 100 }, {
        hasReactDependency: true,
        hasJsxFiles: true,
      }),
    ),
    ["java"],
  );
});

Deno.test("detectValidityGateLanguages — repo with no measured bytes yields no languages", () => {
  assertEquals(detectValidityGateLanguages(langs({})), []);
  assertEquals(detectValidityGateLanguages(langs({ TypeScript: 0 })), []);
});

// ---------------------------------------------------------------------------
// Rust — reused compile-gate detection
// ---------------------------------------------------------------------------

Deno.test("rust — cargo check invoked in CI is present", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      ".github/workflows/ci.yml": workflow("cargo check --all-targets"),
    },
    async (tmp) => {
      const results = await checkLanguageValidityGates(tmp, langs({ Rust: 1 }));
      assertEquals(results.length, 1);
      const rust = byLang(results, "rust");
      assertEquals(rust.present, true);
      assertEquals(rust.workflowsLoaded, true);
      assertStringIncludes(rust.details, "No action required");
    },
  );
});

Deno.test("rust — no compile gate is flagged with a suggested invocation", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      ".github/workflows/ci.yml": workflow("cargo clippy -- -D warnings"),
    },
    async (tmp) => {
      const rust = byLang(
        await checkLanguageValidityGates(tmp, langs({ Rust: 1 })),
        "rust",
      );
      assertEquals(rust.present, false);
      assertStringIncludes(rust.details, "cargo check");
      assertStringIncludes(rust.details, "basic-validity");
    },
  );
});

// ---------------------------------------------------------------------------
// TypeScript — reused compile-gate detection
// ---------------------------------------------------------------------------

Deno.test("typescript — deno check invoked in CI is present", async () => {
  await withTempRepo(
    {
      "deno.json": "{}",
      ".github/workflows/ci.yml": workflow("deno check **/*.ts"),
    },
    async (tmp) => {
      const ts = byLang(
        await checkLanguageValidityGates(tmp, langs({ TypeScript: 1 })),
        "typescript",
      );
      assertEquals(ts.present, true);
    },
  );
});

Deno.test("typescript — no compile gate flagged even when eslint runs", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x"}',
      ".github/workflows/ci.yml": workflow("npx eslint ."),
    },
    async (tmp) => {
      const ts = byLang(
        await checkLanguageValidityGates(tmp, langs({ TypeScript: 1 })),
        "typescript",
      );
      assertEquals(ts.present, false);
      assertStringIncludes(ts.details, "tsc --noEmit");
    },
  );
});

// ---------------------------------------------------------------------------
// Java — reused compile-gate detection
// ---------------------------------------------------------------------------

Deno.test("java — mvn compile invoked in CI is present", async () => {
  await withTempRepo(
    {
      "pom.xml": "<project></project>",
      ".github/workflows/ci.yml": workflow("mvn compile"),
    },
    async (tmp) => {
      const java = byLang(
        await checkLanguageValidityGates(tmp, langs({ Java: 1 })),
        "java",
      );
      assertEquals(java.present, true);
    },
  );
});

Deno.test("java — gradle compileJava also satisfies the gate", async () => {
  await withTempRepo(
    {
      "build.gradle": "",
      ".github/workflows/ci.yml": workflow("./gradlew compileJava"),
    },
    async (tmp) => {
      const java = byLang(
        await checkLanguageValidityGates(tmp, langs({ Java: 1 })),
        "java",
      );
      assertEquals(java.present, true);
    },
  );
});

Deno.test("java — no compile gate is flagged", async () => {
  await withTempRepo(
    {
      "pom.xml": "<project></project>",
      ".github/workflows/ci.yml": workflow("mvn test"),
    },
    async (tmp) => {
      const java = byLang(
        await checkLanguageValidityGates(tmp, langs({ Java: 1 })),
        "java",
      );
      assertEquals(java.present, false);
      assertStringIncludes(java.details, "gradle compileJava");
    },
  );
});

// ---------------------------------------------------------------------------
// Python — net-new py_compile / compileall detection
// ---------------------------------------------------------------------------

Deno.test("python — python -m py_compile invoked in CI is present", async () => {
  await withTempRepo(
    {
      "requirements.txt": "",
      ".github/workflows/ci.yml": workflow("python -m py_compile app.py"),
    },
    async (tmp) => {
      const py = byLang(
        await checkLanguageValidityGates(tmp, langs({ Python: 1 })),
        "python",
      );
      assertEquals(py.present, true);
      assertStringIncludes(py.details, "No action required");
    },
  );
});

Deno.test("python — python -m compileall is accepted", async () => {
  await withTempRepo(
    {
      "requirements.txt": "",
      ".github/workflows/ci.yml": workflow("python3 -m compileall ."),
    },
    async (tmp) => {
      const py = byLang(
        await checkLanguageValidityGates(tmp, langs({ Python: 1 })),
        "python",
      );
      assertEquals(py.present, true);
    },
  );
});

Deno.test("python — bare py_compile invocation is accepted", async () => {
  await withTempRepo(
    {
      "requirements.txt": "",
      ".github/workflows/ci.yml": workflow(
        "find . -name '*.py' | xargs py_compile",
      ),
    },
    async (tmp) => {
      const py = byLang(
        await checkLanguageValidityGates(tmp, langs({ Python: 1 })),
        "python",
      );
      assertEquals(py.present, true);
    },
  );
});

Deno.test("python — no validity gate is flagged with a suggested invocation", async () => {
  await withTempRepo(
    {
      "requirements.txt": "",
      ".github/workflows/ci.yml": workflow("pytest"),
    },
    async (tmp) => {
      const py = byLang(
        await checkLanguageValidityGates(tmp, langs({ Python: 1 })),
        "python",
      );
      assertEquals(py.present, false);
      assertStringIncludes(py.details, "py_compile");
      assertStringIncludes(py.details, "compileall");
    },
  );
});

// ---------------------------------------------------------------------------
// Multi-language + shell-only + no-workflows
// ---------------------------------------------------------------------------

Deno.test("multi-language repo returns correct per-language results", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      "requirements.txt": "",
      ".github/workflows/ci.yml": workflow(
        "cargo check --all-targets",
        "pytest",
      ),
    },
    async (tmp) => {
      const results = await checkLanguageValidityGates(
        tmp,
        langs({ Rust: 100, Python: 40 }),
      );
      assertEquals(results.length, 2);
      assertEquals(byLang(results, "rust").present, true);
      assertEquals(byLang(results, "python").present, false);
    },
  );
});

Deno.test("Rust repo with an incidental .ts script yields no TypeScript finding", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      "scripts/generate_fixtures.ts": "console.log('fixtures');\n",
      ".github/workflows/ci.yml": workflow("cargo check --all-targets"),
    },
    async (tmp) => {
      const results = await checkLanguageValidityGates(
        tmp,
        langs({ Rust: 1390142, Shell: 65940, TypeScript: 1407 }),
      );
      assertEquals(results.map((r) => r.language), ["rust"]);
      assertEquals(byLang(results, "rust").present, true);
    },
  );
});

Deno.test("shell-only repo yields no language findings", async () => {
  await withTempRepo(
    {
      "script.sh": "#!/usr/bin/env bash\necho hi\n",
      ".github/workflows/ci.yml": workflow("shellcheck script.sh"),
    },
    async (tmp) => {
      const results = await checkLanguageValidityGates(
        tmp,
        langs({ Shell: 500 }),
      );
      assertEquals(results, []);
    },
  );
});

Deno.test("no workflows — fail-safe marks workflowsLoaded false, not present", async () => {
  await withTempRepo(
    { "Cargo.toml": '[package]\nname = "x"\n' },
    async (tmp) => {
      const rust = byLang(
        await checkLanguageValidityGates(tmp, langs({ Rust: 1 })),
        "rust",
      );
      assertEquals(rust.present, false);
      assertEquals(rust.workflowsLoaded, false);
      assertStringIncludes(rust.details, "No GitHub Actions workflows");
    },
  );
});
