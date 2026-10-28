/**
 * Issue #4432 (PR #4457 reviews) — the Google Rust Style Guide checks in the
 * Rust best-practices bucket must not file findings on code the guide itself
 * permits, or that the clippy lint they name as confirmation allows.
 *
 * - Check 43 (glob imports) first exempted only a `pub use` re-export of a
 *   prelude, so `use rayon::prelude::*;` would have been flagged, and it
 *   flagged public glob re-exports (`pub use submodule::*;`) too. Clippy's
 *   `wildcard_imports` allows both, and the guide permits the second.
 * - Check 48 (assertions with no message) flagged doctest examples, which are
 *   test code, outside the issue's "non-test code" scope.
 * - Check 49 (lock poisoning) accepted `PoisonError::into_inner` recovery,
 *   which the guide forbids ("never reach inside a poisoned mutex").
 *
 * These tests pin each correction so a later edit cannot quietly undo it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

async function googleGuideSection() {
  return section(
    await readRepoDoc("prompts/best_practices/buckets/rust.md"),
    "Google Rust Style Guide learnings",
  );
}

Deno.test(
  "prompts/best_practices/buckets/rust.md Google Rust Style Guide learnings exempts prelude globs and public glob re-exports (Issue #4432)",
  async () => {
    assertPins(await googleGuideSection(), [
      "Do not flag a glob import from a module named `prelude`",
      "whether a consumer import (`use rayon::prelude::*;`",
      "nor a public glob re-export (`pub use …::*;`, `pub(crate) use …::*;`)",
      "the guide permits `pub use submodule::*` for non-leaf modules",
      "Flag only the remaining private `use …::*;` imports",
    ]);
  },
);

Deno.test(
  "prompts/best_practices/buckets/rust.md Google Rust Style Guide learnings leaves doctest assertions alone (Issue #4432)",
  async () => {
    assertPins(await googleGuideSection(), [
      "`#[test]` functions, `tests/`, and doc-comment examples",
      "an assertion inside a `///` or `//!` code block is a doctest, which is test code",
    ]);
  },
);

Deno.test(
  "prompts/best_practices/buckets/rust.md Google Rust Style Guide learnings refuses poisoned-lock recovery (Issue #4432)",
  async () => {
    assertPins(await googleGuideSection(), [
      "Recovering through `PoisonError::into_inner` is not a policy this check accepts",
      "the guide says never to reach inside a poisoned mutex",
      "flag each call on a lock's `PoisonError`",
      "`Poisoned lock recovered in <file>`",
    ]);
  },
);
