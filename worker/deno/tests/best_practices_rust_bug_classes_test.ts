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
