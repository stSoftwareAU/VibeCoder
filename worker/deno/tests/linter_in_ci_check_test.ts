/**
 * Tests for linter_in_ci_check.ts — standard-linter-in-CI helper.
 *
 * Issue #2145: Best-practices idle task — linter-in-CI check helper.
 *
 * Each supported language gets a positive fixture (linter configured +
 * invoked) and a negative fixture (linter absent). The shared cases at
 * the bottom cover workflows-folder-missing and config-present-but-no-CI
 * invocation.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  checkLinterInCI,
  type LinterCheckLanguage,
} from "../lib/linter_in_ci_check.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a temp repo, populate it via `files`, run `fn`, then clean up. */
async function withTempRepo(
  files: Record<string, string>,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "linter_in_ci_check_" });
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

// ---------------------------------------------------------------------------
// Rust — cargo clippy
// ---------------------------------------------------------------------------

Deno.test("rust — cargo clippy + cargo check invoked in CI is configured", async () => {
  // Issue #2177: both the linter gate AND a compile gate must be wired
  // into CI for the bucket to count as configured.
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: cargo check --all-targets",
        "      - run: cargo clippy --all-targets -- -D warnings",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "rust");
      assertEquals(r.configured, true);
      assertEquals(r.linter, "cargo clippy");
      assertStringIncludes(r.details, "cargo clippy");
      assertEquals(r.gates, { linter: true, compile: true });
    },
  );
});

Deno.test("rust — no cargo clippy invocation is not configured", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: cargo test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "rust");
      assertEquals(r.configured, false);
      assertEquals(r.linter, "cargo clippy");
      assertStringIncludes(r.details.toLowerCase(), "clippy");
    },
  );
});

// ---------------------------------------------------------------------------
// TypeScript — ESLint
// ---------------------------------------------------------------------------

Deno.test("typescript — ESLint config + ESLint CI + compile gate is configured", async () => {
  // Issue #2177: linter and compile gates must both be present.
  await withTempRepo(
    {
      "package.json": '{"name":"x"}',
      "eslint.config.js": "export default [];\n",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npx eslint .",
        "      - run: deno check **/*.ts",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, true);
      assertEquals(r.linter, "ESLint");
      assertEquals(r.gates, { linter: true, compile: true });
    },
  );
});

Deno.test("typescript — ESLint config absent is not configured", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x"}',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npx eslint .",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, false);
      assertStringIncludes(r.details.toLowerCase(), "eslint");
    },
  );
});

// ---------------------------------------------------------------------------
// TypeScript / React — Deno's built-in linter (`deno lint`)
//
// Deno-based repos use `deno lint` (+ `deno check`) instead of ESLint + tsc.
// `deno lint` ships sensible defaults, so no config file is required.
// ---------------------------------------------------------------------------

Deno.test("typescript — deno lint + deno check invoked in CI is configured", async () => {
  await withTempRepo(
    {
      "deno.json": "{}",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: deno lint",
        "      - run: deno check mod.ts",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, true);
      assertEquals(r.linter, "deno lint");
      assertEquals(r.gates, { linter: true, compile: true });
    },
  );
});

Deno.test(
  "typescript #2880 — a quality.yml-style Deno workflow satisfies both gates",
  async () => {
    // Regression for the NEAT-AI false BP-LINTER-typescript finding: a
    // `quality.yml` running `deno lint` AND `deno check` must satisfy both
    // gates once the workflow files are actually loaded. The original bug
    // was an empty workflow load from the wrong path, not a matching bug.
    await withTempRepo(
      {
        "deno.json": "{}",
        ".github/workflows/quality.yml": [
          "name: Quality",
          "on:",
          "  pull_request:",
          "  push:",
          "    branches: [Develop]",
          "jobs:",
          "  quality:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - run: deno check **/*.ts",
          "      - run: deno lint",
        ].join("\n"),
      },
      async (tmp) => {
        const r = await checkLinterInCI(tmp, "typescript");
        assertEquals(r.configured, true);
        assertEquals(r.gates, { linter: true, compile: true });
      },
    );
  },
);

Deno.test("typescript — deno lint without compile gate is not configured", async () => {
  await withTempRepo(
    {
      "deno.json": "{}",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno lint",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: true, compile: false });
    },
  );
});

Deno.test("react — deno lint + deno check invoked in CI is configured", async () => {
  await withTempRepo(
    {
      "deno.json": "{}",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno lint",
        "      - run: deno check **/*.ts",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "react");
      assertEquals(r.configured, true);
      assertEquals(r.linter, "deno lint");
      assertEquals(r.gates, { linter: true, compile: true });
    },
  );
});

// ---------------------------------------------------------------------------
// React — same as TypeScript
// ---------------------------------------------------------------------------

Deno.test("react — ESLint config + ESLint CI + tsc --noEmit is configured", async () => {
  // Issue #2177: linter and compile gates must both be present.
  await withTempRepo(
    {
      "package.json": '{"name":"x","dependencies":{"react":"^18"}}',
      ".eslintrc.json": '{"extends":["plugin:react/recommended"]}',
      ".github/workflows/lint.yml": [
        "name: Lint",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm run lint",
        "      - run: npx eslint src/",
        "      - run: npx tsc --noEmit",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "react");
      assertEquals(r.configured, true);
      assertEquals(r.linter, "ESLint");
      assertEquals(r.gates, { linter: true, compile: true });
    },
  );
});

Deno.test("react — workflow without eslint invocation is not configured", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x"}',
      ".eslintrc.json": "{}",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "react");
      assertEquals(r.configured, false);
    },
  );
});

// ---------------------------------------------------------------------------
// Java — Checkstyle / SpotBugs / PMD
// ---------------------------------------------------------------------------

Deno.test("java — Checkstyle config + invoked + mvn compile is configured", async () => {
  // Issue #2177: linter and compile gates must both be present.
  await withTempRepo(
    {
      "pom.xml": "<project/>",
      "checkstyle.xml": "<module/>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: mvn compile",
        "      - run: mvn checkstyle:check",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "java");
      assertEquals(r.configured, true);
      assertStringIncludes(r.linter.toLowerCase(), "checkstyle");
      assertEquals(r.gates, { linter: true, compile: true });
    },
  );
});

Deno.test("java — no checkstyle/spotbugs/pmd config is not configured", async () => {
  await withTempRepo(
    {
      "pom.xml": "<project/>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: mvn test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "java");
      assertEquals(r.configured, false);
    },
  );
});

// ---------------------------------------------------------------------------
// HTML — htmlhint / html-validate
// ---------------------------------------------------------------------------

Deno.test("html — htmlhint invoked in CI is configured", async () => {
  await withTempRepo(
    {
      "index.html": "<html></html>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npx htmlhint **/*.html",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "html");
      assertEquals(r.configured, true);
    },
  );
});

Deno.test("html — no htmlhint or html-validate invocation is not configured", async () => {
  await withTempRepo(
    {
      "index.html": "<html></html>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "html");
      assertEquals(r.configured, false);
    },
  );
});

// ---------------------------------------------------------------------------
// GitHub Actions — actionlint
// ---------------------------------------------------------------------------

Deno.test("github-actions — actionlint invoked in CI is configured", async () => {
  await withTempRepo(
    {
      ".github/workflows/lint.yml": [
        "name: Lint workflows",
        "on: [push]",
        "jobs:",
        "  actionlint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: rhysd/actionlint@v1",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "github-actions");
      assertEquals(r.configured, true);
      assertEquals(r.linter, "actionlint");
    },
  );
});

Deno.test("github-actions — no actionlint invocation is not configured", async () => {
  await withTempRepo(
    {
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo hi",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "github-actions");
      assertEquals(r.configured, false);
    },
  );
});

// ---------------------------------------------------------------------------
// AWS CloudFormation — cfn-lint
// ---------------------------------------------------------------------------

Deno.test("aws-cloudformation — cfn-lint invoked in CI is configured", async () => {
  await withTempRepo(
    {
      "template.yaml": "AWSTemplateFormatVersion: 2010-09-09",
      ".github/workflows/lint.yml": [
        "name: Lint",
        "on: [push]",
        "jobs:",
        "  cfn:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: cfn-lint template.yaml",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "aws-cloudformation");
      assertEquals(r.configured, true);
      assertEquals(r.linter, "cfn-lint");
    },
  );
});

Deno.test("aws-cloudformation — no cfn-lint invocation is not configured", async () => {
  await withTempRepo(
    {
      "template.yaml": "AWSTemplateFormatVersion: 2010-09-09",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: aws cloudformation validate-template --template-body file://template.yaml",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "aws-cloudformation");
      assertEquals(r.configured, false);
    },
  );
});

// ---------------------------------------------------------------------------
// Terraform — tflint OR (terraform validate + terraform fmt -check)
// ---------------------------------------------------------------------------

Deno.test("terraform — tflint invoked is configured", async () => {
  await withTempRepo(
    {
      "main.tf": "# empty",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: tflint --recursive",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "terraform");
      assertEquals(r.configured, true);
    },
  );
});

Deno.test("terraform — validate + fmt -check is configured", async () => {
  await withTempRepo(
    {
      "main.tf": "# empty",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: terraform fmt -check",
        "      - run: terraform validate",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "terraform");
      assertEquals(r.configured, true);
    },
  );
});

Deno.test("terraform — only validate (no fmt -check, no tflint) is not configured", async () => {
  await withTempRepo(
    {
      "main.tf": "# empty",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: terraform validate",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "terraform");
      assertEquals(r.configured, false);
    },
  );
});

// ---------------------------------------------------------------------------
// Shared edge cases
// ---------------------------------------------------------------------------

Deno.test("workflows folder missing is not configured (all languages)", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname="x"\n',
      "package.json": '{"name":"x"}',
      "eslint.config.js": "export default [];\n",
      "pom.xml": "<project/>",
      "checkstyle.xml": "<module/>",
      "index.html": "<html></html>",
      "template.yaml": "AWSTemplateFormatVersion: 2010-09-09",
      "main.tf": "# empty",
    },
    async (tmp) => {
      for (
        const lang of [
          "rust",
          "typescript",
          "react",
          "java",
          "html",
          "github-actions",
          "aws-cloudformation",
          "terraform",
        ] as const
      ) {
        const r = await checkLinterInCI(tmp, lang);
        assertEquals(
          r.configured,
          false,
          `${lang} should not be configured when workflows folder is missing`,
        );
        assertStringIncludes(r.details.toLowerCase(), "workflow");
        // Issue #2881: a zero-workflow load must be flagged so the
        // consumer can suppress the severity:high "missing gate" finding.
        assertEquals(
          r.workflowsLoaded,
          false,
          `${lang} should report workflowsLoaded=false when none were loaded`,
        );
      }
    },
  );
});

Deno.test("workflowsLoaded is not false when workflows are present but a gate is missing", async () => {
  // Issue #2881: the genuine "workflows present, gate truly missing" case
  // must NOT be flagged as a zero-workflow load — the consumer still files
  // severity:high for it.
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname="x"\n',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: cargo test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "rust");
      assertEquals(r.configured, false);
      // Workflows were loaded — the flag must be absent or true, never false.
      assertEquals(r.workflowsLoaded === false, false);
    },
  );
});

Deno.test("typescript — eslint config present but no CI invocation is not configured", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x"}',
      "eslint.config.js": "export default [];\n",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, false);
      assertStringIncludes(r.details.toLowerCase(), "ci");
    },
  );
});

Deno.test("java — config present but no CI invocation is not configured", async () => {
  await withTempRepo(
    {
      "pom.xml": "<project/>",
      "checkstyle.xml": "<module/>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: mvn test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "java");
      assertEquals(r.configured, false);
    },
  );
});

// ---------------------------------------------------------------------------
// Issue #2177 — compile/syntax gate detection
//
// For the four affected buckets (rust, typescript, react, java) the
// helper now treats the linter gate and the compile gate as TWO
// independent gates; `configured: true` only when both are present.
// ---------------------------------------------------------------------------

// ----- rust dual-gate ------------------------------------------------------

Deno.test("rust #2177 — only linter present (no compile) is not configured", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: cargo clippy --all-targets -- -D warnings",
        "      - run: cargo test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "rust");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: true, compile: false });
      assertStringIncludes(r.details.toLowerCase(), "no compile gate");
      assertStringIncludes(r.details, "#2175");
      assertStringIncludes(r.details, "cargo check");
    },
  );
});

Deno.test("rust #2177 — only compile present (no clippy) is not configured", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: cargo build --all-targets",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "rust");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: false, compile: true });
      assertStringIncludes(r.details.toLowerCase(), "no linter gate");
      assertStringIncludes(r.details, "cargo clippy");
    },
  );
});

Deno.test("rust #2177 — neither gate present names both missing", async () => {
  await withTempRepo(
    {
      "Cargo.toml": '[package]\nname = "x"\n',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: cargo test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "rust");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: false, compile: false });
      assertStringIncludes(
        r.details.toLowerCase(),
        "no linter and no compile gate",
      );
    },
  );
});

// ----- typescript dual-gate ------------------------------------------------

Deno.test("typescript #2177 — only linter present (no compile) is not configured", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x"}',
      "eslint.config.js": "export default [];\n",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npx eslint .",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: true, compile: false });
      assertStringIncludes(r.details.toLowerCase(), "no compile gate");
      assertStringIncludes(r.details, "deno check");
    },
  );
});

Deno.test("typescript #2177 — only compile present (no eslint) is not configured", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x"}',
      "eslint.config.js": "export default [];\n",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npx tsc --noEmit",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: false, compile: true });
      assertStringIncludes(r.details.toLowerCase(), "no linter gate");
      assertStringIncludes(r.details.toLowerCase(), "eslint");
    },
  );
});

Deno.test("typescript #2177 — neither gate present names both missing", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x"}',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: false, compile: false });
      assertStringIncludes(
        r.details.toLowerCase(),
        "no linter and no compile gate",
      );
    },
  );
});

// ----- react dual-gate -----------------------------------------------------

Deno.test("react #2177 — only linter present (no compile) is not configured", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x","dependencies":{"react":"^18"}}',
      ".eslintrc.json": "{}",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npx eslint src/",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "react");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: true, compile: false });
      assertStringIncludes(r.details.toLowerCase(), "no compile gate");
    },
  );
});

Deno.test("react #2177 — only compile present (no eslint) is not configured", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x","dependencies":{"react":"^18"}}',
      ".eslintrc.json": "{}",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: deno check src/main.ts",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "react");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: false, compile: true });
      assertStringIncludes(r.details.toLowerCase(), "no linter gate");
    },
  );
});

Deno.test("react #2177 — neither gate present names both missing", async () => {
  await withTempRepo(
    {
      "package.json": '{"name":"x","dependencies":{"react":"^18"}}',
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "react");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: false, compile: false });
      assertStringIncludes(
        r.details.toLowerCase(),
        "no linter and no compile gate",
      );
    },
  );
});

// ----- java dual-gate ------------------------------------------------------

Deno.test("java #2177 — only linter present (no compile) is not configured", async () => {
  await withTempRepo(
    {
      "pom.xml": "<project/>",
      "checkstyle.xml": "<module/>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: mvn checkstyle:check",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "java");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: true, compile: false });
      assertStringIncludes(r.details.toLowerCase(), "no compile gate");
      assertStringIncludes(r.details, "mvn compile");
    },
  );
});

Deno.test("java #2177 — only compile present (no linter) is not configured", async () => {
  await withTempRepo(
    {
      "pom.xml": "<project/>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: mvn compile",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "java");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: false, compile: true });
      assertStringIncludes(r.details.toLowerCase(), "no linter gate");
    },
  );
});

Deno.test("java #2177 — gradle compileJava also satisfies the compile gate", async () => {
  await withTempRepo(
    {
      "build.gradle": "// empty",
      "checkstyle.xml": "<module/>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: ./gradlew compileJava",
        "      - run: ./gradlew checkstyleMain",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "java");
      assertEquals(r.configured, true);
      assertEquals(r.gates, { linter: true, compile: true });
    },
  );
});

Deno.test("java #2177 — neither gate present names both missing", async () => {
  await withTempRepo(
    {
      "pom.xml": "<project/>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: mvn test",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "java");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: false, compile: false });
      assertStringIncludes(
        r.details.toLowerCase(),
        "no linter and no compile gate",
      );
    },
  );
});

// ----- ESLint @typescript-eslint does NOT satisfy the compile gate --------

Deno.test("typescript #2177 — ESLint with @typescript-eslint does NOT count as a compile gate", async () => {
  // Even though @typescript-eslint performs incidental typechecking, the
  // gates must be detected independently — issue #2177 acceptance.
  await withTempRepo(
    {
      "package.json":
        '{"name":"x","devDependencies":{"@typescript-eslint/parser":"^7"}}',
      "eslint.config.js":
        "import tseslint from '@typescript-eslint/eslint-plugin';" +
        "export default [{plugins:{tseslint}}];\n",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npx eslint .",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "typescript");
      assertEquals(r.configured, false);
      assertEquals(r.gates, { linter: true, compile: false });
      assertStringIncludes(r.details.toLowerCase(), "no compile gate");
    },
  );
});

// ----- Skipped buckets retain their prior single-gate behaviour ----------

Deno.test("html #2177 — compile-gate change does not affect html bucket", async () => {
  // Regression: html bucket has no compile-gate concept; its existing
  // single-gate behaviour is preserved (Issue #2177 acceptance).
  await withTempRepo(
    {
      "index.html": "<html></html>",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npx htmlhint **/*.html",
      ].join("\n"),
    },
    async (tmp) => {
      const r = await checkLinterInCI(tmp, "html");
      assertEquals(r.configured, true);
      // No gates field for the non-affected buckets — gates remains
      // undefined to keep the legacy result shape intact.
      assertEquals(r.gates, undefined);
    },
  );
});

Deno.test("github-actions / cfn / terraform #2177 — gates field stays undefined", async () => {
  await withTempRepo(
    {
      "template.yaml": "AWSTemplateFormatVersion: 2010-09-09",
      "main.tf": "# empty",
      ".github/workflows/lint.yml": [
        "name: Lint",
        "on: [push]",
        "jobs:",
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: rhysd/actionlint@v1",
        "      - run: cfn-lint template.yaml",
        "      - run: tflint --recursive",
      ].join("\n"),
    },
    async (tmp) => {
      for (
        const lang of [
          "github-actions",
          "aws-cloudformation",
          "terraform",
        ] as const
      ) {
        const r = await checkLinterInCI(tmp, lang);
        assertEquals(r.configured, true, `${lang} should be configured`);
        assertEquals(
          r.gates,
          undefined,
          `${lang} must not expose a gates field`,
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Exhaustiveness guard (Issue #2533)
// ---------------------------------------------------------------------------

Deno.test(
  "checkLinterInCI — assertNever rejects an unknown language",
  async () => {
    // A value outside the closed LinterCheckLanguage union must hit the
    // assertNever default branch and throw rather than returning undefined.
    await withTempRepo({}, async (path) => {
      await assertRejects(
        () => checkLinterInCI(path, "cobol" as unknown as LinterCheckLanguage),
        Error,
        "Unreachable",
      );
    });
  },
);
