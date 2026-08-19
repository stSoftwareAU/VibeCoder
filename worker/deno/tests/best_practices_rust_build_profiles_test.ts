/**
 * Tests for the Cargo build-profile checks added to the `rust`
 * best-practices bucket guide (Issue 4159 — "Rust build profiles: fastest
 * dev builds, fully optimised release builds").
 *
 * Deliberately narrow, following `best_practices_rust_bug_classes_test.ts`:
 * the guide is prose the LLM reads, so pinning its wording would repeat the
 * anti-pattern Issue 3115 removed. What is load-bearing — and what these
 * tests assert — is:
 *
 *   - the dev profile lever (`debug = "line-tables-only"`) is named, so the
 *     fastest-dev-build check cannot silently disappear on a reword;
 *   - the release trio (`opt-level = 3`, fat LTO, one codegen unit) is named
 *     together, because a partial release profile is the state the fleet was
 *     already in;
 *   - `-C target-cpu=native` carries its carve-outs (published crates,
 *     `wasm32`) and the stable-Cargo mechanism (`.cargo/config.toml` /
 *     `RUSTFLAGS`), so the scan cannot file it against a portable artefact;
 *   - the stable-only guardrail names the nightly levers it rejects
 *     (`-Zthreads`, Cranelift) — an ungated nightly suggestion would break
 *     the fleet's pinned-stable reproducibility policy;
 *   - the guide's own file scope covers `.cargo/config.toml`, otherwise the
 *     target-cpu check has no file it is allowed to read;
 *   - the new section reaches the wrapper body through the real consumer
 *     path.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertStringIncludes } from "@std/assert";

import { assembleBestPracticesPrompt } from "../lib/idle_task_templates/best_practices_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

function readRustBucket(): Promise<string> {
  return Deno.readTextFile(`${PROMPTS_DIR}/best_practices/buckets/rust.md`);
}

Deno.test("buckets/rust.md - names the fast dev-profile lever", async () => {
  const body = await readRustBucket();
  assertStringIncludes(body, "[profile.dev]");
  assertStringIncludes(body, "line-tables-only");
});

Deno.test(
  "buckets/rust.md - names the fully optimised release trio together",
  async () => {
    const body = await readRustBucket();
    const keys = [
      "[profile.release]",
      "opt-level = 3",
      'lto = "fat"',
      "codegen-units = 1",
    ];
    const missing = keys.filter((k) => !body.includes(k));
    assert(
      missing.length === 0,
      `rust bucket guide is missing release-profile settings: ${
        missing.join(", ")
      }`,
    );
  },
);

Deno.test(
  "buckets/rust.md - target-cpu=native carries its carve-outs and mechanism",
  async () => {
    const body = await readRustBucket();
    assertStringIncludes(body, "target-cpu=native");
    // Carve-outs: portable artefacts must not get the flag.
    const lower = body.toLowerCase();
    assert(
      lower.includes("published crate"),
      "target-cpu guidance must exclude published crates",
    );
    assert(
      lower.includes("wasm32"),
      "target-cpu guidance must exclude wasm32 targets",
    );
    // Mechanism: stable Cargo has no per-profile rustflags.
    assertStringIncludes(body, ".cargo/config.toml");
    assertStringIncludes(body, "RUSTFLAGS");
  },
);

Deno.test(
  "buckets/rust.md - build-profile guidance is stable-Rust only",
  async () => {
    const body = await readRustBucket();
    // The rejected nightly levers are named so the scan cannot file them.
    assertStringIncludes(body, "-Zthreads");
    assert(
      /cranelift/i.test(body),
      "guide must name the Cranelift backend as a rejected nightly lever",
    );
    assert(
      /(never|do not|don't)[^.]{0,160}nightly/is.test(body),
      "guide must forbid recommending a nightly toolchain",
    );
  },
);

Deno.test(
  "buckets/rust.md - profiles are scoped to the workspace root and never reach consumers",
  async () => {
    const body = (await readRustBucket()).toLowerCase();
    assert(
      body.includes("workspace root"),
      "guide must say profiles are read from the workspace root manifest",
    );
    assert(
      body.includes("consumer"),
      "guide must say a library's own profile never reaches its consumers",
    );
  },
);

Deno.test(
  "buckets/rust.md - file scope covers the Cargo build config",
  async () => {
    const body = await readRustBucket();
    assertStringIncludes(body, ".cargo/config.toml");
    // The scope statement itself, not just the check body, must allow it.
    const scopeLine = body
      .split("\n")
      .find((line) => /Apply these checks to/i.test(line));
    assert(
      scopeLine !== undefined,
      "guide must state which files the checks apply to",
    );
    const scopeParagraph = body.slice(
      body.indexOf(scopeLine!),
      body.indexOf(scopeLine!) + 300,
    );
    assert(
      scopeParagraph.includes(".cargo/config.toml"),
      "guide's file-scope statement must include .cargo/config.toml",
    );
  },
);

Deno.test(
  "buckets/rust.md - build-profile section reaches the assembled wrapper body",
  async () => {
    const guide = await readRustBucket();
    const out = assembleBestPracticesPrompt("Review {{BUCKET}}.", guide, {
      bucket: "rust",
      suppressedIds: [],
      knownOpenFindingIds: [],
    });

    assertStringIncludes(out, "## Bucket Guide — `rust` (inlined)");
    assertStringIncludes(out, "line-tables-only");
    assertStringIncludes(out, guide.trim());
  },
);
