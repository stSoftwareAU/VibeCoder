/**
 * Issue #3234 — `flat()` accepts only a `DocSection`, so a whole-file drift
 * pin (`flat(wholeDoc)` instead of `flat(section(wholeDoc, title))`) is a
 * `deno check` error rather than a silently-too-broad test
 * (CODING-STANDARDS.md § Documentation-drift tests, condition 1).
 *
 * The `@ts-expect-error` lines below are the contract: delete the brand from
 * `flat()`'s parameter and this file stops type-checking with "Unused
 * '@ts-expect-error' directive".
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  excerpt,
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

Deno.test("flat(section()) reads the section-scoped drift-test rule", async () => {
  const doc = await readRepoDoc("CODING-STANDARDS.md");
  const text = flat(section(doc, "Documentation-drift tests"));
  assertStringIncludes(text, "Section-scoped");
});

Deno.test("flat() rejects a whole file, a raw slice, but accepts excerpt()", async () => {
  const doc = await readRepoDoc("CODING-STANDARDS.md");

  // @ts-expect-error — a whole file is not a DocSection (Issue #3234)
  const _wholeFile = () => flat(doc);

  const rawSlice: string = section(doc, "Documentation-drift tests").slice(
    0,
    10,
  );
  // @ts-expect-error — a raw string slice loses the DocSection brand (Issue #3234)
  const _rawSlice = () => flat(rawSlice);

  const excerpted = flat(
    excerpt(section(doc, "Documentation-drift tests"), 0, 50),
  );
  assertEquals(typeof excerpted, "string");
});

Deno.test("flatWholeFile() compiles on a whole file and collapses whitespace", async () => {
  const doc = await readRepoDoc("CODING-STANDARDS.md");
  const flattened = flatWholeFile(doc);
  assertEquals(flattened.includes("\n"), false);
});
