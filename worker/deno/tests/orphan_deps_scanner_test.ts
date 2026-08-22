/**
 * Tests for orphan_deps_scanner.ts — native ecosystem orphan-detector
 * pre-filer (Issue #2907, parent #2902).
 *
 * Every test exercises the real scanner against in-memory `ManifestFile`
 * fixtures with a stubbed {@link OrphanMetadataProvider} — no filesystem,
 * no network, no package install. Mirrors `action_pin_scanner_test.ts`.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  _resetSuppressionCommitAuthors as _clearSuppressionCommitAuthors,
  recordedSuppressions,
  renderSuppressionSummary,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
  setSuppressionCommitAuthors as _setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyManifest,
  classifyOrphan,
  extractReplacement,
  type ManifestFile,
  monthsBetween,
  nullOrphanMetadataProvider,
  type OrphanDependency,
  type OrphanMetadata,
  type OrphanMetadataProvider,
  parseDenoManifest,
  parseDenoSpecifier,
  parseNpmManifest,
  scanOrphanDeps,
  stripJsonc,
} from "../lib/orphan_deps_scanner.ts";

// A fixed clock so staleness tests are deterministic.
const NOW = new Date("2026-06-18T00:00:00.000Z");

/** Build a metadata provider from a name → metadata lookup table. */
function provider(
  table: Record<string, OrphanMetadata>,
): OrphanMetadataProvider {
  return {
    fetch: (dep: OrphanDependency) => Promise.resolve(table[dep.name] ?? null),
  };
}

function pkgJson(deps: Record<string, string>): string {
  return JSON.stringify({ name: "fixture", dependencies: deps }, null, 2);
}

// ---------------------------------------------------------------------------
// classifyManifest
// ---------------------------------------------------------------------------

Deno.test("classifyManifest - recognises native, deferred, and unknown files", () => {
  assertEquals(classifyManifest("package.json"), "npm");
  assertEquals(classifyManifest("sub/dir/package.json"), "npm");
  assertEquals(classifyManifest("deno.json"), "deno");
  assertEquals(classifyManifest("deno.jsonc"), "deno");
  assertEquals(classifyManifest("Cargo.toml"), "cargo");
  assertEquals(classifyManifest("Cargo.lock"), "cargo");
  assertEquals(classifyManifest(".github/workflows/ci.yml"), "github-actions");
  assertEquals(classifyManifest("README.md"), null);
  assertEquals(classifyManifest("src/main.ts"), null);
});

// ---------------------------------------------------------------------------
// parseDenoSpecifier
// ---------------------------------------------------------------------------

Deno.test("parseDenoSpecifier - parses npm and jsr specifiers", () => {
  assertEquals(parseDenoSpecifier("npm:chalk@5"), {
    ecosystem: "npm",
    name: "chalk",
    version: "5",
  });
  assertEquals(parseDenoSpecifier("npm:@scope/pkg@1.2.3"), {
    ecosystem: "npm",
    name: "@scope/pkg",
    version: "1.2.3",
  });
  assertEquals(parseDenoSpecifier("jsr:@std/assert@^1.0.0"), {
    ecosystem: "jsr",
    name: "@std/assert",
    version: "^1.0.0",
  });
  // No version pin.
  assertEquals(parseDenoSpecifier("npm:left-pad"), {
    ecosystem: "npm",
    name: "left-pad",
    version: null,
  });
  // Not an npm:/jsr: specifier.
  assertEquals(parseDenoSpecifier("https://deno.land/x/foo/mod.ts"), null);
  assertEquals(parseDenoSpecifier(""), null);
});

// ---------------------------------------------------------------------------
// stripJsonc
// ---------------------------------------------------------------------------

Deno.test("stripJsonc - strips comments while preserving strings", () => {
  const jsonc = `{
  // a line comment
  "imports": {
    "chalk": "npm:chalk@5", /* block */
    "url": "https://example.com" // not a comment inside the string
  },
}`;
  const parsed = JSON.parse(stripJsonc(jsonc));
  assertEquals(parsed.imports.chalk, "npm:chalk@5");
  assertEquals(parsed.imports.url, "https://example.com");
});

// ---------------------------------------------------------------------------
// parseNpmManifest / parseDenoManifest
// ---------------------------------------------------------------------------

Deno.test("parseNpmManifest - extracts direct deps across blocks with line numbers", () => {
  const raw = JSON.stringify(
    {
      name: "fixture",
      dependencies: { chalk: "^5.0.0" },
      devDependencies: { typescript: "^5.4.0" },
    },
    null,
    2,
  );
  const deps = parseNpmManifest({ path: "package.json", rawText: raw });
  assertEquals(deps.length, 2);
  const chalk = deps.find((d) => d.name === "chalk")!;
  assertEquals(chalk.ecosystem, "npm");
  assertEquals(chalk.version, "^5.0.0");
  assertEquals(chalk.manifestPath, "package.json");
  assert(chalk.line > 0);
});

Deno.test("parseNpmManifest - malformed JSON yields no deps (no throw)", () => {
  assertEquals(
    parseNpmManifest({ path: "package.json", rawText: "{ not json" }),
    [],
  );
});

Deno.test("parseDenoManifest - extracts npm/jsr imports from deno.jsonc", () => {
  const raw = `{
  // dependencies
  "imports": {
    "chalk": "npm:chalk@5",
    "@std/assert": "jsr:@std/assert@^1.0.0",
    "local": "./src/local.ts"
  }
}`;
  const deps = parseDenoManifest({ path: "deno.jsonc", rawText: raw });
  // The `./src/local.ts` entry is not an npm:/jsr: specifier — excluded.
  assertEquals(deps.length, 2);
  assert(deps.some((d) => d.name === "chalk" && d.ecosystem === "npm"));
  assert(deps.some((d) => d.name === "@std/assert" && d.ecosystem === "jsr"));
});

// ---------------------------------------------------------------------------
// monthsBetween / extractReplacement
// ---------------------------------------------------------------------------

Deno.test("monthsBetween - whole calendar months, clamped at zero", () => {
  assertEquals(
    monthsBetween(new Date("2024-06-18"), new Date("2026-06-18")),
    24,
  );
  assertEquals(
    monthsBetween(new Date("2026-01-01"), new Date("2026-06-18")),
    5,
  );
  // Future publish → 0, never negative.
  assertEquals(
    monthsBetween(new Date("2027-01-01"), new Date("2026-06-18")),
    0,
  );
});

Deno.test("extractReplacement - pulls the package name from deprecated prose", () => {
  assertEquals(
    extractReplacement(
      "This package is deprecated, use `string-width` instead",
    ),
    "string-width",
  );
  assertEquals(
    extractReplacement("Replaced by @scope/new-pkg"),
    "@scope/new-pkg",
  );
  assertEquals(extractReplacement("No longer maintained."), null);
});

// ---------------------------------------------------------------------------
// classifyOrphan (pure)
// ---------------------------------------------------------------------------

const sampleDep: OrphanDependency = {
  ecosystem: "npm",
  name: "left-pad",
  version: "1.0.0",
  manifestPath: "package.json",
  line: 5,
};

Deno.test("classifyOrphan - null metadata yields nothing", () => {
  assertEquals(
    classifyOrphan(sampleDep, null, { now: NOW, staleMonths: 24 }),
    null,
  );
});

Deno.test("classifyOrphan - deprecated outranks archived and stale", () => {
  const result = classifyOrphan(
    sampleDep,
    {
      deprecated: "use `left-pad-2` instead",
      sourceArchived: true,
      lastPublishIso: "2018-01-01",
    },
    { now: NOW, staleMonths: 24 },
  )!;
  assertEquals(result.signal, "ORPHAN-DEPRECATED");
  assertEquals(result.severity, "high");
  assertEquals(result.suggestedReplacement, "left-pad-2");
});

// ---------------------------------------------------------------------------
// scanOrphanDeps — acceptance-criteria coverage
// ---------------------------------------------------------------------------

Deno.test("scanOrphanDeps - clean fixture emits no findings", async () => {
  const files: ManifestFile[] = [
    { path: "package.json", rawText: pkgJson({ chalk: "^5.0.0" }) },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({
      chalk: { lastPublishIso: "2026-05-01", deprecated: null },
    }),
    now: () => NOW,
  });
  assertEquals(result.findings, []);
});

Deno.test("scanOrphanDeps - deprecated npm dep emits one high finding with stable id", async () => {
  const files: ManifestFile[] = [
    { path: "package.json", rawText: pkgJson({ "left-pad": "^1.0.0" }) },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({
      "left-pad": { deprecated: "use `String.prototype.padStart` instead" },
    }),
    now: () => NOW,
  });
  assertEquals(result.findings.length, 1);
  const f = result.findings[0]!;
  assertEquals(f.signal, "ORPHAN-DEPRECATED");
  assertEquals(f.severity, "high");
  assertEquals(f.dependency, "left-pad");
  assert(f.findingId.startsWith("BP-"));
  assertEquals(f.suggestedReplacement, "String.prototype.padStart");
  assert(f.title.includes("ORPHAN-DEPRECATED"));
  assert(f.evidence.includes("package.json"));
});

Deno.test("scanOrphanDeps - archived-source dep emits one high finding", async () => {
  const files: ManifestFile[] = [
    { path: "package.json", rawText: pkgJson({ "old-lib": "^2.0.0" }) },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({
      "old-lib": {
        sourceArchived: true,
        sourceRepoUrl: "https://github.com/acme/old-lib",
      },
    }),
    now: () => NOW,
  });
  assertEquals(result.findings.length, 1);
  const f = result.findings[0]!;
  assertEquals(f.signal, "ORPHAN-ARCHIVED");
  assertEquals(f.severity, "high");
  assert(f.evidence.includes("archived"));
  assert(f.evidence.includes("github.com/acme/old-lib"));
  // No deterministic replacement — left to the LLM phase.
  assertEquals(f.suggestedReplacement, null);
});

Deno.test("scanOrphanDeps - stale-last-publish dep emits one low finding", async () => {
  const files: ManifestFile[] = [
    { path: "package.json", rawText: pkgJson({ "quiet-lib": "^1.0.0" }) },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({
      // Published 30 months before NOW (> 24-month threshold).
      "quiet-lib": { lastPublishIso: "2023-12-18T00:00:00.000Z" },
    }),
    now: () => NOW,
  });
  assertEquals(result.findings.length, 1);
  const f = result.findings[0]!;
  assertEquals(f.signal, "ORPHAN-STALE");
  assertEquals(f.severity, "low");
  assert(f.evidence.includes("threshold 24 months"));
});

Deno.test("scanOrphanDeps - recently-published dep is NOT flagged stale", async () => {
  const files: ManifestFile[] = [
    { path: "package.json", rawText: pkgJson({ "fresh-lib": "^1.0.0" }) },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({
      "fresh-lib": { lastPublishIso: "2026-03-01T00:00:00.000Z" },
    }),
    now: () => NOW,
  });
  assertEquals(result.findings, []);
});

Deno.test("scanOrphanDeps - three distinct orphans yield one finding each, sorted by id", async () => {
  const files: ManifestFile[] = [
    {
      path: "package.json",
      rawText: pkgJson({
        "dep-deprecated": "^1.0.0",
        "dep-archived": "^1.0.0",
        "dep-stale": "^1.0.0",
        "dep-healthy": "^1.0.0",
      }),
    },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({
      "dep-deprecated": { deprecated: "abandoned" },
      "dep-archived": { sourceArchived: true },
      "dep-stale": { lastPublishIso: "2020-01-01" },
      "dep-healthy": { lastPublishIso: "2026-05-01" },
    }),
    now: () => NOW,
  });
  assertEquals(result.findings.length, 3);
  const ids = result.findings.map((f) => f.findingId);
  // Sorted ascending by stable id.
  assertEquals([...ids].sort(), ids);
});

Deno.test("scanOrphanDeps - JSR import is parsed and flagged", async () => {
  const files: ManifestFile[] = [
    {
      path: "deno.json",
      rawText: JSON.stringify(
        { imports: { "@acme/dead": "jsr:@acme/dead@^1.0.0" } },
        null,
        2,
      ),
    },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({ "@acme/dead": { yanked: true } }),
    now: () => NOW,
  });
  assertEquals(result.findings.length, 1);
  const f = result.findings[0]!;
  assertEquals(f.ecosystem, "jsr");
  assertEquals(f.signal, "ORPHAN-DEPRECATED");
});

Deno.test("scanOrphanDeps - knownOpen and suppressed ids are skipped", async () => {
  const files: ManifestFile[] = [
    { path: "package.json", rawText: pkgJson({ "left-pad": "^1.0.0" }) },
  ];
  const base = {
    repo: "org/repo",
    files,
    provider: provider({ "left-pad": { deprecated: "abandoned" } }),
    now: () => NOW,
  };
  // First, learn the id this finding gets.
  const first = await scanOrphanDeps(base);
  const id = first.findings[0]!.findingId;

  const known = await scanOrphanDeps({ ...base, knownOpenFindingIds: [id] });
  assertEquals(known.findings, []);

  const suppressed = await scanOrphanDeps({ ...base, suppressedIds: [id] });
  assertEquals(suppressed.findings, []);
});

Deno.test("scanOrphanDeps - in-source best-practice-ignore suppresses the finding", async () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    // Pre-compute the id so we can place a matching marker in a deno.jsonc.
    const repo = "org/repo";
    const probe = await scanOrphanDeps({
      repo,
      files: [{
        path: "deno.jsonc",
        rawText: `{ "imports": { "chalk": "npm:chalk@5" } }`,
      }],
      provider: provider({ chalk: { deprecated: "abandoned" } }),
      now: () => NOW,
    });
    const id = probe.findings[0]!.findingId;

    const rawText = `{
    "imports": {
      // best-practice-ignore: ${id} — author=nigel expires=2099-12-31 pinned by trusted mirror
      "chalk": "npm:chalk@5"
    }
  }`;
    const result = await scanOrphanDeps({
      repo,
      files: [{ path: "deno.jsonc", rawText }],
      provider: provider({ chalk: { deprecated: "abandoned" } }),
      now: () => NOW,
    });
    assertEquals(result.findings, []);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("scanOrphanDeps - a honoured marker is registered against its manifest (Issue #3948)", async () => {
  const repo = "org/repo";
  const probe = await scanOrphanDeps({
    repo,
    files: [{
      path: "deno.jsonc",
      rawText: `{ "imports": { "chalk": "npm:chalk@5" } }`,
    }],
    provider: provider({ chalk: { deprecated: "abandoned" } }),
    now: () => NOW,
  });
  const id = probe.findings[0]!.findingId;

  const rawText = `{
  "imports": {
    // best-practice-ignore: ${id} — author=nigel expires=2099-12-31 pinned by trusted mirror
    "chalk": "npm:chalk@5"
  }
}`;

  resetSuppressionRegistry();
  await scanOrphanDeps({
    repo,
    files: [{ path: "deno.jsonc", rawText }],
    provider: provider({ chalk: { deprecated: "abandoned" } }),
    now: () => NOW,
  });

  const registered = recordedSuppressions();
  assertEquals(registered.length, 1);
  assertEquals(registered[0]?.file, "deno.jsonc");

  const report = renderSuppressionSummary();
  assertStringIncludes(report, "deno.jsonc:3");
  assert(
    !report.includes("<unknown>"),
    `report must name the manifest, got: ${report}`,
  );
  resetSuppressionRegistry();
});

Deno.test("scanOrphanDeps - cargo and github-actions ecosystems are deferred, not silently skipped", async () => {
  const logged: string[] = [];
  const files: ManifestFile[] = [
    { path: "Cargo.toml", rawText: '[dependencies]\nserde = "1"\n' },
    { path: ".github/workflows/ci.yml", rawText: "on: push\n" },
    { path: "package.json", rawText: pkgJson({ chalk: "^5.0.0" }) },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({ chalk: { lastPublishIso: "2026-05-01" } }),
    now: () => NOW,
    logFn: (m) => logged.push(m),
  });
  assertEquals(result.deferred, ["cargo", "github-actions"]);
  assertEquals(logged.length, 2);
  assert(logged.some((m) => m.includes("cargo")));
  assert(logged.some((m) => m.includes("github-actions")));
});

Deno.test("scanOrphanDeps - default null provider emits nothing", async () => {
  const files: ManifestFile[] = [
    { path: "package.json", rawText: pkgJson({ chalk: "^5.0.0" }) },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    now: () => NOW,
  });
  assertEquals(result.findings, []);
  assertEquals(await nullOrphanMetadataProvider.fetch(sampleDep), null);
});

Deno.test("scanOrphanDeps - same dependency in two manifests yields one finding", async () => {
  const files: ManifestFile[] = [
    { path: "package.json", rawText: pkgJson({ "left-pad": "^1.0.0" }) },
    {
      path: "deno.json",
      rawText: JSON.stringify(
        { imports: { "left-pad": "npm:left-pad@1.0.0" } },
        null,
        2,
      ),
    },
  ];
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: provider({ "left-pad": { deprecated: "abandoned" } }),
    now: () => NOW,
  });
  assertEquals(result.findings.length, 1);
});

Deno.test("scanOrphanDeps - a throwing provider drops the candidate without aborting", async () => {
  const files: ManifestFile[] = [
    {
      path: "package.json",
      rawText: pkgJson({ "boom": "^1.0.0", "ok": "^1.0.0" }),
    },
  ];
  const throwing: OrphanMetadataProvider = {
    fetch: (dep) => {
      if (dep.name === "boom") throw new Error("network blip");
      return Promise.resolve({ deprecated: "abandoned" });
    },
  };
  const result = await scanOrphanDeps({
    repo: "org/repo",
    files,
    provider: throwing,
    now: () => NOW,
  });
  // `boom` dropped (threw), `ok` still flagged.
  assertEquals(result.findings.length, 1);
  assertEquals(result.findings[0]!.dependency, "ok");
});
