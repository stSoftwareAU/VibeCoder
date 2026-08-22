/**
 * Tests for the RustSec-derived bug-class checks added to the `rust`
 * best-practices bucket guide (Issue 3552 — "Learn from Trail of Bits
 * rust-review for our Rust best practices").
 *
 * Deliberately narrow: the guide is prose the LLM reads, so pinning its
 * wording would repeat the anti-pattern Issue 3115 removed. What is
 * load-bearing — and what these tests assert — is:
 *
 *   - every adopted bug-class cluster is actually present in the guide,
 *     so a cluster cannot silently disappear on a reword;
 *   - the capability gates are stated, because an ungated cluster would
 *     have the scan speculate about code the crate does not contain;
 *   - the FFI cluster is gated on real FFI markers (`extern "C"`,
 *     `#[no_mangle]`), never applied repo-wide;
 *   - the analyser assist degrades loudly — a failed `cargo` run must
 *     fall back to static evidence, never read as "clean";
 *   - the whole guide, new sections included, still reaches the wrapper
 *     body through the real consumer path.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertStringIncludes } from "@std/assert";

import { assembleBestPracticesPrompt } from "../lib/idle_task_templates/best_practices_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

function readRustBucket(): Promise<string> {
  return Deno.readTextFile(`${PROMPTS_DIR}/best_practices/buckets/rust.md`);
}

/**
 * The bug-class clusters adopted from the RustSec-derived catalogue.
 * Each entry is a phrase the guide must name so the cluster is actually
 * reviewed; the wording around it is free to change.
 */
const CLUSTERS: readonly string[] = [
  "unsafe boundary",
  "memory safety",
  "panic",
  "recursion",
  "error-handling",
  "logic correctness",
  "concurrency",
  "async",
  "ffi",
  "layout",
  "path",
  "resource",
  "pointer",
  "static hygiene",
  // Issue #310 — toolchain 1.96–1.98 learnings.
  "runtime symbol definitions",
  "standard-library supersessions",
];

Deno.test("buckets/rust.md - names every adopted bug-class cluster", async () => {
  const body = (await readRustBucket()).toLowerCase();
  const missing = CLUSTERS.filter((c) => !body.includes(c));
  assert(
    missing.length === 0,
    `rust bucket guide is missing bug-class clusters: ${missing.join(", ")}`,
  );
});

Deno.test("buckets/rust.md - states each capability gate", async () => {
  const body = await readRustBucket();
  const gates = [
    "has_unsafe",
    "has_ffi",
    "has_concurrency",
    "has_async",
    "has_packed_repr",
    "has_fs_io",
    // Issue #310: the repr(transparent) cluster is gated, not repo-wide.
    "has_transparent_repr",
  ];
  const missing = gates.filter((g) => !body.includes(g));
  assert(
    missing.length === 0,
    `rust bucket guide is missing capability gates: ${missing.join(", ")}`,
  );
});

Deno.test(
  "buckets/rust.md - gates FFI checks on real FFI markers, not the whole repo",
  async () => {
    const body = await readRustBucket();
    assertStringIncludes(body, 'extern "C"');
    assertStringIncludes(body, "#[no_mangle]");
    assert(
      /never\s+repo-wide|not\s+repo-wide/i.test(body),
      "rust bucket guide must state that FFI checks are not applied repo-wide",
    );
  },
);

Deno.test(
  "buckets/rust.md - analyser assist falls back to static evidence, never to 'clean'",
  async () => {
    const body = await readRustBucket();
    // The relaxation: cargo may assist where the checkout builds offline.
    assertStringIncludes(body, "cargo clippy");
    assertStringIncludes(body, "cargo check");
    // Fail-loud: a failed analyser run is not a pass.
    const lower = body.toLowerCase();
    assert(
      lower.includes("fall back") || lower.includes("falls back"),
      "rust bucket guide must state the static-evidence fallback",
    );
    assert(
      /never.{0,80}clean/is.test(body),
      "rust bucket guide must forbid reading a failed analyser run as clean",
    );
  },
);

Deno.test(
  "buckets/rust.md - bug-class section reaches the assembled wrapper body",
  async () => {
    const guide = await readRustBucket();
    const out = assembleBestPracticesPrompt("Review {{BUCKET}}.", guide, {
      bucket: "rust",
      suppressedIds: [],
      knownOpenFindingIds: [],
    });

    assertStringIncludes(out, "## Bucket Guide — `rust` (inlined)");
    assertStringIncludes(out, guide.trim());
  },
);

// ===========================================================================
// Issue #310 — Rust 1.96–1.98 release-note learnings
// ===========================================================================

/**
 * Each cluster adopted from the 1.96/1.97/1.98 release notes, with the
 * capability gate it must state.
 *
 * Following this file's existing approach: assert the cluster is named and
 * its gate is stated, without pinning prose wording. A reword is free; a
 * silent deletion is not.
 */
const TOOLCHAIN_CLUSTERS: readonly { phrase: string; gate: string }[] = [
  { phrase: "runtime symbol definitions", gate: "has_ffi" },
  { phrase: "repr(transparent)", gate: "has_transparent_repr" },
  { phrase: "standard-library supersessions", gate: "Always applies" },
];

Deno.test("buckets/rust.md - names every 1.96-1.98 cluster with its gate (Issue #310)", async () => {
  const body = await readRustBucket();
  // Scope to the new section: `#[repr(transparent)]` also appears in the
  // capability-gate table, where the gate name precedes it rather than
  // following it, so a whole-file search would anchor on the wrong line.
  const start = body.indexOf("## Toolchain 1.96");
  assert(start > -1, "the 1.96-1.98 section must exist");
  const section = body.slice(start);

  for (const { phrase, gate } of TOOLCHAIN_CLUSTERS) {
    assertStringIncludes(section.toLowerCase(), phrase.toLowerCase());
    // The gate must appear in the same check paragraph, not merely
    // somewhere in the file — an ungated cluster makes the scan
    // speculate about code the crate does not contain.
    const at = section.toLowerCase().indexOf(phrase.toLowerCase());
    const paragraph = section.slice(at, at + 900);
    assert(
      paragraph.includes(gate),
      `cluster "${phrase}" must state its gate "${gate}" alongside it`,
    );
  }
});

Deno.test("buckets/rust.md - names the lints that a -D warnings gate now fails on (Issue #310)", async () => {
  // These are the reason a toolchain bump is a reviewable event: they fail
  // the build with no code change.
  const body = await readRustBucket();
  for (
    const lint of [
      "invalid_runtime_symbol_definitions",
      "suspicious_runtime_symbol_definitions",
      "c_void_returns",
    ]
  ) {
    assertStringIncludes(body, lint);
  }
});

Deno.test("buckets/rust.md - the 1.98 repr(transparent) tightening names all three newly non-trivial field kinds (Issue #310)", async () => {
  // Dropping any one of these would leave the check quietly incomplete —
  // it would pass a type that no longer compiles.
  const body = await readRustBucket();
  for (const kind of ["repr(C)", "private fields", "#[non_exhaustive]"]) {
    assertStringIncludes(body, kind);
  }
});

Deno.test("buckets/rust.md - the supersession cluster names its replacement APIs (Issue #310)", async () => {
  const body = await readRustBucket();
  for (
    const api of [
      "substr_range",
      "subslice_range",
      "strip_circumfix",
      "from_utf16le",
      "bit_width",
      "highest_one",
      "assert_matches!",
    ]
  ) {
    assertStringIncludes(body, api);
  }
});

Deno.test("buckets/rust.md - the new checks stay static-evidence only (Issue #310)", async () => {
  // The bucket's hard constraint: its checks grep the source tree. A new
  // cluster must not require cargo build/check/clippy to run.
  const body = await readRustBucket();
  const at = body.indexOf("## Toolchain 1.96");
  assert(at > -1, "the 1.96-1.98 section must exist");
  const section = body.slice(at);
  assertStringIncludes(section, "Static evidence only");
  for (const forbidden of ["cargo build", "cargo check", "cargo clippy"]) {
    assert(
      !section.includes(`run \`${forbidden}\``),
      `the 1.96-1.98 section must not require ${forbidden}`,
    );
  }
});
