/**
 * Tests for `lib/bump_age_audit.ts` (Issue #3659).
 *
 * The quarantine window used to be advisory: the worker exported
 * `VIBE_BUMP_QUARANTINE_HOURS` into a repo-supplied `bump-deps.sh` and
 * never checked that the script honoured it. These tests cover the
 * verification that closes that gap — parsing the versions a bump
 * actually introduced, and blocking the ones published inside the window.
 *
 * Issue #3951 closed the second half: the parser recognised only
 * digit-anchored pins, and everything it did not recognise — ranges,
 * lockfiles, every non-JS ecosystem, an unreadable diff — parsed to `[]`
 * and was reported as `ok: true`. The fail-closed cases at the end of
 * this file are the regression guard for that silent pass.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  auditBumpDiff,
  auditBumpedSpecifiers,
  type BumpAgeDeps,
  type BumpedSpecifier,
  defaultBumpAgeDeps,
  evaluateSpecifierAge,
  fetchCratesPublishTime,
  parseBumpedSpecifiers,
  scanBumpDiff,
  unreadableBumpAgeAudit,
} from "../lib/bump_age_audit.ts";
import { pinnedVersion } from "../lib/bump_diff_scan.ts";

const NOW = new Date("2026-08-02T12:00:00Z");

/** Deps whose publish times come from a fixed lookup table. */
function makeDeps(
  times: Record<string, string | undefined>,
  onFetch?: (key: string) => void,
): BumpAgeDeps {
  return {
    fetchPublishTime: (spec: BumpedSpecifier) => {
      const key = `${spec.registry}:${spec.name}@${spec.version}`;
      onFetch?.(key);
      return Promise.resolve(times[key]);
    },
    now: () => NOW,
  };
}

/** Hours before {@link NOW}, as an ISO timestamp. */
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

// =============================================================================
// parseBumpedSpecifiers
// =============================================================================

Deno.test("parseBumpedSpecifiers - reads npm and jsr specifiers from added lines", () => {
  const diff = `diff --git a/deno.json b/deno.json
--- a/deno.json
+++ b/deno.json
@@ -1,4 +1,4 @@
   "imports": {
-    "@std/assert": "jsr:@std/assert@1.0.0",
+    "@std/assert": "jsr:@std/assert@1.0.14",
+    "chalk": "npm:chalk@5.6.2"
   }
`;
  assertEquals(parseBumpedSpecifiers(diff), [
    { registry: "jsr", name: "@std/assert", version: "1.0.14" },
    { registry: "npm", name: "chalk", version: "5.6.2" },
  ]);
});

Deno.test("parseBumpedSpecifiers - ignores removed and context lines", () => {
  const diff = `--- a/deno.json
+++ b/deno.json
-    "chalk": "npm:chalk@4.0.0",
     "kleur": "npm:kleur@3.0.0",
`;
  assertEquals(parseBumpedSpecifiers(diff), []);
});

Deno.test("parseBumpedSpecifiers - ignores the +++ file header", () => {
  // The header line starts with `+` but is not an added content line.
  const diff = `--- a/npm:pkg@1.0.0
+++ b/npm:pkg@1.0.0
`;
  assertEquals(parseBumpedSpecifiers(diff), []);
});

Deno.test("parseBumpedSpecifiers - reads package.json dependency ranges", () => {
  const diff = `--- a/package.json
+++ b/package.json
   "dependencies": {
+    "left-pad": "^1.3.0",
+    "@types/node": "~22.5.1"
   }
`;
  assertEquals(parseBumpedSpecifiers(diff), [
    { registry: "npm", name: "left-pad", version: "1.3.0" },
    { registry: "npm", name: "@types/node", version: "22.5.1" },
  ]);
});

Deno.test("parseBumpedSpecifiers - ignores package.json metadata keys", () => {
  // `"version"` and `"name"` are the package's own identity, not deps.
  const diff = `--- a/package.json
+++ b/package.json
+  "name": "1.2.3",
+  "version": "9.9.9",
`;
  assertEquals(parseBumpedSpecifiers(diff), []);
});

Deno.test("parseBumpedSpecifiers - only applies the JSON heuristic inside package.json", () => {
  const diff = `--- a/config.json
+++ b/config.json
+  "left-pad": "^1.3.0",
`;
  assertEquals(parseBumpedSpecifiers(diff), []);
});

Deno.test("parseBumpedSpecifiers - deduplicates repeated specifiers", () => {
  const diff = `--- a/deno.json
+++ b/deno.json
+    "chalk": "npm:chalk@5.6.2",
+    "chalk-again": "npm:chalk@5.6.2"
`;
  assertEquals(parseBumpedSpecifiers(diff), [
    { registry: "npm", name: "chalk", version: "5.6.2" },
  ]);
});

Deno.test("parseBumpedSpecifiers - handles an empty diff", () => {
  assertEquals(parseBumpedSpecifiers(""), []);
});

// =============================================================================
// evaluateSpecifierAge
// =============================================================================

const CHALK: BumpedSpecifier = {
  registry: "npm",
  name: "chalk",
  version: "5.6.2",
};

Deno.test("evaluateSpecifierAge - a version older than the window is eligible", () => {
  const verdict = evaluateSpecifierAge(CHALK, hoursAgo(30), 24, NOW);
  assertEquals(verdict.eligible, true);
  assertEquals(verdict.indeterminate, false);
});

Deno.test("evaluateSpecifierAge - a version inside the window is blocked", () => {
  const verdict = evaluateSpecifierAge(CHALK, hoursAgo(2), 24, NOW);
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, false);
  assertStringIncludes(verdict.reason, "24h quarantine");
});

Deno.test("evaluateSpecifierAge - exactly at the window is eligible", () => {
  const verdict = evaluateSpecifierAge(CHALK, hoursAgo(24), 24, NOW);
  assertEquals(verdict.eligible, true);
});

Deno.test("evaluateSpecifierAge - an unknown publish time is indeterminate", () => {
  const verdict = evaluateSpecifierAge(CHALK, undefined, 24, NOW);
  assertEquals(verdict.indeterminate, true);
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.ageHours, null);
});

Deno.test("evaluateSpecifierAge - an unparseable publish time is indeterminate", () => {
  const verdict = evaluateSpecifierAge(CHALK, "not-a-date", 24, NOW);
  assertEquals(verdict.indeterminate, true);
  assertEquals(verdict.ageHours, null);
});

// =============================================================================
// auditBumpedSpecifiers
// =============================================================================

Deno.test("auditBumpedSpecifiers - blocks a dependency published inside the window", async () => {
  const result = await auditBumpedSpecifiers(
    [CHALK],
    24,
    makeDeps({ "npm:chalk@5.6.2": hoursAgo(1) }),
  );
  assertEquals(result.ok, false);
  assertEquals(result.blocked.length, 1);
  assertStringIncludes(result.reason, "chalk@5.6.2");
  assertStringIncludes(result.reason, "24h");
});

Deno.test("auditBumpedSpecifiers - passes a dependency older than the window", async () => {
  const result = await auditBumpedSpecifiers(
    [CHALK],
    24,
    makeDeps({ "npm:chalk@5.6.2": hoursAgo(72) }),
  );
  assertEquals(result.ok, true);
  assertEquals(result.blocked.length, 0);
  assertEquals(result.reason, "");
});

Deno.test("auditBumpedSpecifiers - an unverifiable age does not block", async () => {
  // Fail-open, matching `npm_package_age.ts`: an offline host must not
  // turn every bump into a rejection. The verdict is still reported.
  const result = await auditBumpedSpecifiers([CHALK], 24, makeDeps({}));
  assertEquals(result.ok, true);
  assertEquals(result.indeterminate.length, 1);
});

Deno.test("auditBumpedSpecifiers - internal @stsoftware packages bypass the window", async () => {
  const fetched: string[] = [];
  const internal: BumpedSpecifier = {
    registry: "jsr",
    name: "@stsoftware/vibe",
    version: "1.0.0",
  };
  const result = await auditBumpedSpecifiers(
    [internal],
    24,
    makeDeps({}, (key) => fetched.push(key)),
  );
  assertEquals(result.ok, true);
  assertEquals(result.blocked.length, 0);
  assertEquals(result.indeterminate.length, 0);
  // Internal deps update at 0h (Issue #1613) — no registry lookup at all.
  assertEquals(fetched, []);
});

Deno.test("auditBumpedSpecifiers - a fetch that throws is indeterminate, not fatal", async () => {
  const result = await auditBumpedSpecifiers([CHALK], 24, {
    fetchPublishTime: () => Promise.reject(new Error("network down")),
    now: () => NOW,
  });
  assertEquals(result.ok, true);
  assertEquals(result.indeterminate.length, 1);
});

Deno.test("auditBumpedSpecifiers - reports every blocked dependency in the reason", async () => {
  const other: BumpedSpecifier = {
    registry: "jsr",
    name: "@std/assert",
    version: "1.0.14",
  };
  const result = await auditBumpedSpecifiers(
    [CHALK, other],
    24,
    makeDeps({
      "npm:chalk@5.6.2": hoursAgo(1),
      "jsr:@std/assert@1.0.14": hoursAgo(3),
    }),
  );
  assertEquals(result.ok, false);
  assertEquals(result.blocked.length, 2);
  assertStringIncludes(result.reason, "chalk@5.6.2");
  assertStringIncludes(result.reason, "@std/assert@1.0.14");
});

Deno.test("auditBumpedSpecifiers - no specifiers means nothing to verify", async () => {
  const result = await auditBumpedSpecifiers([], 24, makeDeps({}));
  assertEquals(result.ok, true);
  assertEquals(result.verdicts, []);
});

// =============================================================================
// Fail-closed scanning (Issue #3951)
//
// The parser recognised only digit-anchored `npm:`/`jsr:` pins and
// `package.json` ranges, and an empty parse was reported as `ok: true` —
// "the quarantine was honoured". Ranges, lockfiles and every non-JS
// ecosystem therefore adopted a five-minute-old release with no embargo.
// These cover the two halves of the fix: recognise more, and refuse what
// is still unrecognised instead of passing it.
// =============================================================================

Deno.test("pinnedVersion - bounded range prefixes normalise to the floor release", () => {
  assertEquals(pinnedVersion("^1.9.9"), "1.9.9");
  assertEquals(pinnedVersion("~1.2.3"), "1.2.3");
  assertEquals(pinnedVersion("=1.0.0"), "1.0.0");
  assertEquals(pinnedVersion("v2.0.0"), "2.0.0");
  assertEquals(pinnedVersion("1.0.0-rc.1"), "1.0.0-rc.1");
  assertEquals(pinnedVersion("18"), "18");
});

Deno.test("pinnedVersion - open-ended ranges and tags pin nothing", () => {
  // These name whatever the registry serves at install time, which is
  // precisely the evasion the embargo exists to stop.
  assertEquals(pinnedVersion(">=1.0.0"), null);
  assertEquals(pinnedVersion(">1.0.0"), null);
  assertEquals(pinnedVersion("*"), null);
  assertEquals(pinnedVersion("1.x"), null);
  assertEquals(pinnedVersion("latest"), null);
  assertEquals(pinnedVersion(""), null);
});

Deno.test("scanBumpDiff - a jsr range specifier is parsed, not skipped", () => {
  const diff = `--- a/deno.json
+++ b/deno.json
+    "@std/yaml": "jsr:@std/yaml@^1.9.9",
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, [
    { registry: "jsr", name: "@std/yaml", version: "1.9.9" },
  ]);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - an open-ended specifier is refused, never silently dropped", () => {
  const diff = `--- a/deno.json
+++ b/deno.json
+    "evil": "npm:evil@>=1.0.0",
+    "worse": "npm:worse@latest"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable.length, 2);
  assertStringIncludes(scan.unverifiable[0]!.reason, "npm:evil@>=1.0.0");
  assertEquals(scan.unverifiable[0]!.file, "deno.json");
});

Deno.test("scanBumpDiff - an open-ended package.json range is refused", () => {
  const diff = `--- a/package.json
+++ b/package.json
+    "evil": ">=1.0.0",
+    "wild": "*"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable.length, 2);
  assertStringIncludes(scan.unverifiable[0]!.reason, "evil");
});

Deno.test("scanBumpDiff - package.json metadata and prose are not dependency changes", () => {
  const diff = `--- a/package.json
+++ b/package.json
+  "name": "1.2.3",
+  "version": "9.9.9",
+  "license": "MIT",
+  "main": "index.js",
+  "node": ">=18"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - a deno.lock hunk yields the versions it introduced", () => {
  const diff = `--- a/deno.lock
+++ b/deno.lock
+    "jsr:@std/yaml@^1.9.9": "1.9.9",
+      "@std/yaml@1.9.9": {
+      "chalk@5.6.2_supports-color@8.1.1": {
`;
  const scan = scanBumpDiff(diff);
  // The bare `"@std/yaml@1.9.9"` entry is the same release the specifier
  // line names, so it is looked up once, under its known registry.
  assertEquals(scan.specifiers, [
    { registry: "jsr", name: "@std/yaml", version: "1.9.9" },
    { registry: "unknown", name: "chalk", version: "5.6.2" },
  ]);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - an unpinnable deno.lock entry is refused", () => {
  const diff = `--- a/deno.lock
+++ b/deno.lock
+      "evil@latest": {
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable.length, 1);
  assertStringIncludes(scan.unverifiable[0]!.reason, "evil@latest");
});

Deno.test("scanBumpDiff - npm lockfile entries are read from resolved tarballs and keys", () => {
  const diff = `--- a/package-lock.json
+++ b/package-lock.json
+      "resolved": "https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz",
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
+  /left-pad@1.3.0:
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "npm", name: "chalk", version: "5.6.2" },
    { registry: "npm", name: "left-pad", version: "1.3.0" },
  ]);
});

Deno.test("scanBumpDiff - non-JS ecosystem manifests are refused, not ignored", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["Gemfile", `gem "nokogiri", "1.99.0"`, "RubyGems"],
    ["go.mod", `\tgithub.com/evil/pkg v1.99.0`, "Go module"],
    ["requirements.txt", `evil==1.99.0`, "PyPI"],
  ];
  for (const [file, line, ecosystem] of cases) {
    const diff = `--- a/${file}\n+++ b/${file}\n+${line}\n`;
    const scan = scanBumpDiff(diff);
    assertEquals(scan.unverifiable.length, 1, `${file} must be refused`);
    assertEquals(scan.unverifiable[0]!.file, file);
    assertStringIncludes(scan.unverifiable[0]!.reason, ecosystem);
  }
});

/** A Cargo.lock hunk whose `serde` version moved, name and source as context. */
function cargoLockBump(version: string): string {
  return `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -8,7 +8,7 @@
 [[package]]
 name = "serde"
-version = "1.0.200"
+version = "${version}"
 source = "registry+https://github.com/rust-lang/crates.io-index"
-checksum = "abc"
+checksum = "def"
`;
}

Deno.test("scanBumpDiff - a Cargo.lock version bump is a crates.io specifier", () => {
  const scan = scanBumpDiff(cargoLockBump("1.0.210"));
  assertEquals(scan.specifiers, [
    { registry: "crates", name: "serde", version: "1.0.210" },
  ]);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - a Cargo.toml dependency pin is a crates.io specifier", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
+serde = "1.99.0"
+tokio = { version = "1.40.0", features = ["full"] }
+version = "0.2.0"
+name = "my-crate"
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "serde", version: "1.99.0" },
    { registry: "crates", name: "tokio", version: "1.40.0" },
  ]);
  assertEquals(scanBumpDiff(diff).unverifiable, []);
});

Deno.test("scanBumpDiff - a lookalike crates.io source is not recorded, and the real pin is age-checked", async () => {
  // The lookalike version differs from the real pin. A substring check for
  // "crates.io" would record 9.9.9 as well, and the young lookup below
  // would hold the bump back.
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
 [[package]]
 name = "serde"
-version = "1.0.200"
+version = "1.0.210"
 source = "registry+https://github.com/rust-lang/crates.io-index"
 [[package]]
 name = "libc"
-version = "0.2.160"
+version = "0.2.169"
 source = "sparse+https://index.crates.io/"
 [[package]]
 name = "host-lookalike"
-version = "9.9.8"
+version = "9.9.9"
 source = "registry+https://crates.io.evil.example/rust-lang/crates.io-index"
 [[package]]
 name = "path-lookalike"
-version = "8.8.7"
+version = "8.8.8"
 source = "registry+https://github.com/evil/crates.io-index"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, [
    { registry: "crates", name: "serde", version: "1.0.210" },
    { registry: "crates", name: "libc", version: "0.2.169" },
  ]);
  assertEquals(scan.unverifiable, []);

  const result = await auditBumpDiff(
    diff,
    24,
    makeDeps({
      "crates:serde@1.0.210": hoursAgo(72),
      "crates:libc@0.2.169": hoursAgo(72),
      "crates:host-lookalike@9.9.9": hoursAgo(0.1),
      "crates:path-lookalike@8.8.8": hoursAgo(0.1),
    }),
  );
  assertEquals(result.ok, true);
  assertEquals(result.blocked, []);
  assertEquals(result.unverifiable, []);
  assertEquals(
    result.verdicts.map((v) => `${v.specifier.name}@${v.specifier.version}`),
    ["serde@1.0.210", "libc@0.2.169"],
  );
});

Deno.test("scanBumpDiff - a git Cargo package is not a crates.io bump", () => {
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
 [[package]]
 name = "local-fork"
-version = "0.1.0"
+version = "0.2.0"
 source = "git+https://github.com/example/local-fork?rev=abc"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - a foreign manifest line with no version is not a dependency change", () => {
  const diff = `--- a/Gemfile
+++ b/Gemfile
+# Pin the gems the site build needs
`;
  assertEquals(scanBumpDiff(diff).unverifiable, []);
});

Deno.test("scanBumpDiff - removed lines never refuse a bump", () => {
  const diff = `--- a/Gemfile
+++ b/Gemfile
-gem "nokogiri", "1.99.0"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

// =============================================================================
// auditBumpDiff — the pass/fail decision
// =============================================================================

Deno.test("auditBumpDiff - a fresh release behind a range is blocked", async () => {
  const diff = `--- a/deno.json
+++ b/deno.json
+    "@std/yaml": "jsr:@std/yaml@^1.9.9",
`;
  const result = await auditBumpDiff(
    diff,
    24,
    makeDeps({ "jsr:@std/yaml@1.9.9": hoursAgo(0.1) }),
  );
  assertEquals(result.ok, false);
  assertEquals(result.blocked.length, 1);
  assertStringIncludes(result.reason, "@std/yaml@1.9.9");
});

Deno.test("auditBumpDiff - an aged release behind a range passes", async () => {
  const diff = `--- a/deno.json
+++ b/deno.json
+    "@std/yaml": "jsr:@std/yaml@^1.9.9",
`;
  const result = await auditBumpDiff(
    diff,
    24,
    makeDeps({ "jsr:@std/yaml@1.9.9": hoursAgo(72) }),
  );
  assertEquals(result.ok, true);
  assertEquals(result.verdicts.length, 1);
  assertEquals(result.unverifiable, []);
});

Deno.test("auditBumpDiff - a deno.lock hunk is never a zero-verdict pass", async () => {
  const diff = `--- a/deno.lock
+++ b/deno.lock
+    "jsr:@std/yaml@^1.9.9": "1.9.9",
+      "@std/yaml@1.9.9": {
`;
  const result = await auditBumpDiff(
    diff,
    24,
    makeDeps({ "jsr:@std/yaml@1.9.9": hoursAgo(0.1) }),
  );
  assertEquals(result.ok, false);
  assertEquals(result.verdicts.length, 1);
});

Deno.test("auditBumpDiff - a non-JS ecosystem bump is refused with nothing to age", async () => {
  const diff = `--- a/Gemfile
+++ b/Gemfile
+gem "nokogiri", "1.99.0"
`;
  const result = await auditBumpDiff(diff, 24, makeDeps({}));
  assertEquals(result.ok, false);
  assertEquals(result.blocked, []);
  assertEquals(result.unverifiable.length, 1);
  assertStringIncludes(result.reason, "RubyGems");
  assertStringIncludes(result.reason, "refused");
});

Deno.test("auditBumpDiff - an unrecognised dependency line blocks even beside a clean one", async () => {
  const diff = `--- a/deno.json
+++ b/deno.json
+    "chalk": "npm:chalk@5.6.2",
+    "evil": "npm:evil@>=1.0.0"
`;
  const result = await auditBumpDiff(
    diff,
    24,
    makeDeps({ "npm:chalk@5.6.2": hoursAgo(72) }),
  );
  assertEquals(result.ok, false);
  assertEquals(result.blocked, []);
  assertEquals(result.unverifiable.length, 1);
  assertStringIncludes(result.reason, "npm:evil@>=1.0.0");
});

Deno.test("auditBumpDiff - an unresolvable publish time still fails open", async () => {
  // Unchanged policy (Issue #3659): a registry that would not answer is
  // not the same as a dependency change the scanner never recognised.
  const diff = `--- a/deno.json
+++ b/deno.json
+    "chalk": "npm:chalk@5.6.2"
`;
  const result = await auditBumpDiff(diff, 24, makeDeps({}));
  assertEquals(result.ok, true);
  assertEquals(result.indeterminate.length, 1);
  assertEquals(result.unverifiable, []);
});

Deno.test("auditBumpDiff - a diff with no dependency changes passes", async () => {
  const diff = `--- a/README.md
+++ b/README.md
+Updated the documentation.
`;
  const result = await auditBumpDiff(diff, 24, makeDeps({}));
  assertEquals(result.ok, true);
  assertEquals(result.verdicts, []);
  assertEquals(result.unverifiable, []);
});

Deno.test("auditBumpDiff - a Cargo.lock bump older than the window passes", async () => {
  const result = await auditBumpDiff(
    cargoLockBump("1.0.210"),
    24,
    makeDeps({ "crates:serde@1.0.210": hoursAgo(72) }),
  );
  assertEquals(result.ok, true);
  assertEquals(result.blocked, []);
  assertEquals(result.indeterminate, []);
  assertEquals(result.unverifiable, []);
  assertEquals(result.verdicts.length, 1);
});

Deno.test("auditBumpDiff - a young Cargo.lock bump is held back like an npm bump", async () => {
  const cargo = await auditBumpDiff(
    cargoLockBump("1.0.210"),
    24,
    makeDeps({ "crates:serde@1.0.210": hoursAgo(0.1) }),
  );
  const npm = await auditBumpDiff(
    `--- a/package.json
+++ b/package.json
+    "serde": "1.0.210"
`,
    24,
    makeDeps({ "npm:serde@1.0.210": hoursAgo(0.1) }),
  );
  assertEquals(cargo.ok, false);
  assertEquals(cargo.unverifiable, []);
  assertEquals(cargo.blocked.length, 1);
  assertEquals(cargo.blocked[0]!.reason, npm.blocked[0]!.reason);
  assertStringIncludes(cargo.reason, "published inside the 24h quarantine");
  assertStringIncludes(cargo.reason, "serde@1.0.210 is only");
});

Deno.test("auditBumpDiff - an unreachable crates.io API defers the bump", async () => {
  const result = await auditBumpDiff(
    cargoLockBump("1.0.210"),
    24,
    makeDeps({}),
  );
  assertEquals(result.ok, false);
  assertEquals(result.blocked, []);
  assertEquals(result.unverifiable, []);
  assertEquals(result.indeterminate.length, 1);
  assertStringIncludes(result.reason, "deferred to the next cycle");
  assertStringIncludes(result.reason, "serde@1.0.210");
});

Deno.test("fetchCratesPublishTime - reads created_at and stays quiet when crates.io is unreachable", async () => {
  const created = await fetchCratesPublishTime(
    "serde",
    "1.0.210",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            version: { created_at: "2020-01-01T00:00:00Z" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  );
  assertEquals(created, "2020-01-01T00:00:00Z");

  const down = await fetchCratesPublishTime(
    "serde",
    "1.0.210",
    () => Promise.reject(new Error("offline")),
  );
  assertEquals(down, undefined);

  const http = await fetchCratesPublishTime(
    "serde",
    "1.0.210",
    () => Promise.resolve(new Response("nope", { status: 503 })),
  );
  assertEquals(http, undefined);
});

Deno.test("defaultBumpAgeDeps - a crates.io lookup uses created_at and does not throw when the API is down", async () => {
  const original = globalThis.fetch;
  const spec: BumpedSpecifier = {
    registry: "crates",
    name: "serde",
    version: "1.0.210",
  };
  try {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      assertStringIncludes(
        url,
        "https://crates.io/api/v1/crates/serde/1.0.210",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: { created_at: "2020-01-01T00:00:00Z" },
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    assertEquals(
      await defaultBumpAgeDeps().fetchPublishTime(spec),
      "2020-01-01T00:00:00Z",
    );

    globalThis.fetch = (() =>
      Promise.reject(new Error("offline"))) as typeof fetch;
    assertEquals(await defaultBumpAgeDeps().fetchPublishTime(spec), undefined);
  } finally {
    globalThis.fetch = original;
  }
});

// =============================================================================
// unreadableBumpAgeAudit
// =============================================================================

Deno.test("unreadableBumpAgeAudit - a diff that cannot be read is not ok", () => {
  const result = unreadableBumpAgeAudit("no HEAD");
  assertEquals(result.ok, false);
  assertEquals(result.unverifiable.length, 1);
  assertStringIncludes(result.reason, "could not be read");
  assertStringIncludes(result.reason, "no HEAD");
});
