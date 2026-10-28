/**
 * Issue #4432 (PR #4457 review) — check 43 of the Rust best-practices bucket
 * flags glob imports. Its first wording exempted only a `pub use` re-export
 * of a prelude, so an ordinary consumer import such as
 * `use rayon::prelude::*;` would have been filed as a `Glob import` finding,
 * although clippy's `wildcard_imports` (the check's named confirmation)
 * allows any glob import from a module named `prelude`. The issue's agreed
 * scope excluded preludes outright.
 *
 * This test pins the exemption as the issue agreed it, so a later edit cannot
 * narrow it back to re-exports only.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test(
  "prompts/best_practices/buckets/rust.md Google Rust Style Guide learnings exempts every glob import from a prelude module (Issue #4432)",
  async () => {
    assertPins(
      section(
        await readRepoDoc("prompts/best_practices/buckets/rust.md"),
        "Google Rust Style Guide learnings",
      ),
      [
        "Do not flag a glob import from a module named `prelude`",
        "whether a consumer import (`use rayon::prelude::*;`",
        "clippy allows both. Flag every other `use …::*;`",
      ],
    );
  },
);
