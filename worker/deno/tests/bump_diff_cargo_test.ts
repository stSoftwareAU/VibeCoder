/**
 * Cargo (crates.io) coverage for the release-age bump scanner
 * (`lib/bump_diff_scan.ts` + `lib/bump_diff_cargo.ts`, stSoftwareAU/NEAT-AI-scorer#627).
 *
 * `Cargo.toml`/`Cargo.lock` were classified as a foreign manifest, so every
 * versioned added line was refused as unverifiable and **every** crates.io
 * bump in a managed Rust repository was rejected wholesale — the repo then
 * sat on stale dependencies indefinitely, which is the worse supply-chain
 * outcome. These tests drive the real scanner over real `git diff` output
 * shapes and assert the crate/version pairs it now resolves, and the shapes
 * it still refuses.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { classifyBumpFile, scanBumpDiff } from "../lib/bump_diff_scan.ts";

const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";

// =============================================================================
// Classification
// =============================================================================

Deno.test("classifyBumpFile - Cargo manifests are cargo, not foreign", () => {
  assertEquals(classifyBumpFile("Cargo.lock"), {
    kind: "cargo",
    manifest: "lock",
  });
  assertEquals(classifyBumpFile("Cargo.toml"), {
    kind: "cargo",
    manifest: "toml",
  });
  assertEquals(classifyBumpFile("rust_scorer/Cargo.toml"), {
    kind: "cargo",
    manifest: "toml",
  });
});

// =============================================================================
// Cargo.lock
// =============================================================================

Deno.test("scanBumpDiff - a Cargo.lock version bump resolves to a crates.io specifier", () => {
  const diff = `diff --git a/Cargo.lock b/Cargo.lock
--- a/Cargo.lock
+++ b/Cargo.lock
@@ -12,9 +12,9 @@
 [[package]]
 name = "anyhow"
-version = "1.0.98"
+version = "1.0.99"
 source = "${REGISTRY}"
-checksum = "aaaa"
+checksum = "bbbb"
 
 [[package]]
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "anyhow", version: "1.0.99" },
  ]);
  assertEquals(scanBumpDiff(diff).unverifiable, []);
});

Deno.test("scanBumpDiff - a newly added Cargo.lock package is resolved", () => {
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -30,6 +30,13 @@
 
+[[package]]
+name = "libc"
+version = "0.2.176"
+source = "${REGISTRY}"
+checksum = "cccc"
+
 [[package]]
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "libc", version: "0.2.176" },
  ]);
});

Deno.test("scanBumpDiff - several Cargo.lock bumps in one diff are all collected", () => {
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -12,7 +12,7 @@
 [[package]]
 name = "anyhow"
-version = "1.0.98"
+version = "1.0.99"
 source = "${REGISTRY}"
@@ -40,7 +40,7 @@
 [[package]]
 name = "serde"
-version = "1.0.228"
+version = "1.0.229"
 source = "${REGISTRY}"
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "anyhow", version: "1.0.99" },
    { registry: "crates", name: "serde", version: "1.0.229" },
  ]);
});

Deno.test("scanBumpDiff - a source-less Cargo.lock package is a workspace member, not a release", () => {
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -80,7 +80,7 @@
 [[package]]
 name = "rust_scorer"
-version = "0.4.0"
+version = "0.5.0"
 dependencies = [
  "anyhow",
 ]
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - a git-sourced Cargo.lock package is refused, not guessed", () => {
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -80,7 +80,7 @@
 [[package]]
 name = "evil"
-version = "0.1.0"
+version = "0.2.0"
 source = "git+https://github.com/evil/evil?branch=main#deadbeef"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable.length, 1);
  assertStringIncludes(scan.unverifiable[0]!.reason, "evil@0.2.0");
  assertStringIncludes(scan.unverifiable[0]!.reason, "git+https");
});

Deno.test("scanBumpDiff - an alternate-registry Cargo.lock package is refused", () => {
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -80,7 +80,7 @@
 [[package]]
 name = "internal-thing"
-version = "0.1.0"
+version = "0.2.0"
 source = "sparse+https://crates.evil.example/index/"
`;
  assertEquals(scanBumpDiff(diff).unverifiable.length, 1);
});

Deno.test("scanBumpDiff - a truncated Cargo.lock block still gets its age checked", () => {
  // The hunk ends immediately after the version line, so no `source` key is
  // visible. The name/version pair is still concrete, so it is resolved
  // rather than skipped: an unknown crate becomes an indeterminate verdict,
  // never a silent pass.
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -12,3 +12,3 @@
 [[package]]
 name = "anyhow"
-version = "1.0.98"
+version = "1.0.99"
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "anyhow", version: "1.0.99" },
  ]);
});

Deno.test("scanBumpDiff - Cargo.lock block state does not leak across hunks", () => {
  // `serde`'s name line is in the first hunk; the second hunk's added
  // version belongs to whatever block it sits in, which the scanner cannot
  // see. It must not be attributed to `serde`.
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -12,3 +12,3 @@
 [[package]]
 name = "serde"
 source = "${REGISTRY}"
@@ -90,2 +90,2 @@
-version = "1.0.0"
+version = "2.0.0"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable.length, 1);
  assertStringIncludes(scan.unverifiable[0]!.reason, "no package name");
});

Deno.test("scanBumpDiff - a Cargo.lock lockfile-format line is not a dependency", () => {
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -1,5 +1,5 @@
 # This file is automatically @generated by Cargo.
 # It is not intended for manual editing.
-version = 3
+version = 4
 
 [[package]]
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - a removed Cargo.lock version never refuses a bump", () => {
  const diff = `--- a/Cargo.lock
+++ b/Cargo.lock
@@ -12,4 +12,3 @@
 [[package]]
 name = "anyhow"
-version = "1.0.98"
 source = "${REGISTRY}"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

// =============================================================================
// Cargo.toml
// =============================================================================

Deno.test("scanBumpDiff - a Cargo.toml dependency string pins a crates.io release", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,3 +10,3 @@
 [dependencies]
-serde = "1.0.228"
+serde = "1.0.229"
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "serde", version: "1.0.229" },
  ]);
});

Deno.test("scanBumpDiff - Cargo.toml inline tables, dev and build sections are read", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,6 +10,6 @@
 [dependencies]
-serde = { version = "1.0.228", features = ["derive"] }
+serde = { version = "1.0.229", features = ["derive"] }
 [dev-dependencies]
+criterion = "0.7.0"
 [build-dependencies]
+cc = "1.2.42"
 [target.'cfg(unix)'.dependencies]
+nix = "0.30.1"
 [workspace.dependencies]
+wgpu = "27.0.1"
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "serde", version: "1.0.229" },
    { registry: "crates", name: "criterion", version: "0.7.0" },
    { registry: "crates", name: "cc", version: "1.2.42" },
    { registry: "crates", name: "nix", version: "0.30.1" },
    { registry: "crates", name: "wgpu", version: "27.0.1" },
  ]);
});

Deno.test("scanBumpDiff - a [dependencies.name] sub-table names the crate", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,3 +10,3 @@
 [dependencies.tokio]
-version = "1.47.0"
+version = "1.48.0"
 features = ["full"]
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "tokio", version: "1.48.0" },
  ]);
});

Deno.test("scanBumpDiff - the crate's own [package] version is not a dependency", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -1,6 +1,6 @@
 [package]
 name = "rust_scorer"
-version = "0.4.0"
+version = "0.5.0"
 edition = "2024"
-rust-version = "1.89"
+rust-version = "1.90"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - profile and lint settings are not dependencies", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -20,4 +20,4 @@
 [profile.release]
-opt-level = 2
+opt-level = 3
-lto = "thin"
+lto = "fat"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - a path or workspace Cargo.toml dependency names no release", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,3 +10,3 @@
 [dependencies]
+neat-core = { path = "../../NEAT-AI-core/neat-core" }
+serde = { workspace = true }
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - a git Cargo.toml dependency is refused", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,3 +10,3 @@
 [dependencies]
+evil = { git = "https://github.com/evil/evil", branch = "main" }
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable.length, 1);
  assertStringIncludes(scan.unverifiable[0]!.reason, "evil");
});

Deno.test("scanBumpDiff - an open-ended Cargo.toml requirement is refused, not guessed", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,3 +10,3 @@
 [dependencies]
-serde = "1.0.228"
+serde = "*"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable.length, 1);
  assertStringIncludes(scan.unverifiable[0]!.reason, "does not pin");
});

Deno.test("scanBumpDiff - a caret requirement pins the floor release", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,3 +10,3 @@
 [dependencies]
+serde = "^1.0.229"
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "serde", version: "1.0.229" },
  ]);
});

Deno.test("scanBumpDiff - a Cargo.toml dependency with no visible section header is still checked", () => {
  // A -U3 hunk in a long `[dependencies]` table need not include the header.
  // The pair is concrete, so it is age-checked rather than passed by silence.
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -30,3 +30,3 @@
 rayon = "1.11.0"
-serde = "1.0.228"
+serde = "1.0.229"
 thiserror = "2.0.17"
`;
  assertEquals(scanBumpDiff(diff).specifiers, [
    { registry: "crates", name: "serde", version: "1.0.229" },
  ]);
});

Deno.test("scanBumpDiff - TOML dotted keys name the crate, not the property", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,4 +10,4 @@
 [dependencies]
+serde.version = "1.0.229"
+serde.features = ["derive"]
+neat-core.workspace = true
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, [
    { registry: "crates", name: "serde", version: "1.0.229" },
  ]);
  assertEquals(scan.unverifiable, []);
});

Deno.test("scanBumpDiff - a dotted git key is refused", () => {
  const diff = `--- a/Cargo.toml
+++ b/Cargo.toml
@@ -10,3 +10,3 @@
 [dependencies]
+evil.git = "https://github.com/evil/evil"
`;
  const scan = scanBumpDiff(diff);
  assertEquals(scan.specifiers, []);
  assertEquals(scan.unverifiable.length, 1);
  assertStringIncludes(scan.unverifiable[0]!.reason, "evil");
});
