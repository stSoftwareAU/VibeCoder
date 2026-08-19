/**
 * Tests for the @std/yaml import-map entries in worker/deno/deno.json.
 *
 * Issue #3053 — The root import map declared a bare `@std/yaml` specifier that
 * no source file imports; only the sub-path key `@std/yaml/parse` is actually
 * used. A declared dependency that no real code imports is dead weight in the
 * build graph (wider supply-chain surface, misleading audits), so the bare
 * entry was removed while the used sub-path key was kept.
 */

import { assertEquals, assertExists } from "@std/assert";

const denoJsonUrl = new URL("../deno.json", import.meta.url);

async function readImports(): Promise<Record<string, string>> {
  const text = await Deno.readTextFile(denoJsonUrl);
  const manifest = JSON.parse(text) as { imports?: Record<string, string> };
  return manifest.imports ?? {};
}

Deno.test("deno.json does not declare the dead bare @std/yaml import (Issue #3053)", async () => {
  const imports = await readImports();
  assertEquals(
    imports["@std/yaml"],
    undefined,
    "The bare `@std/yaml` import map entry is dead (no source imports it) and must not be re-introduced",
  );
});

Deno.test("deno.json keeps the used @std/yaml/parse sub-path import (Issue #3053)", async () => {
  const imports = await readImports();
  assertExists(
    imports["@std/yaml/parse"],
    "The `@std/yaml/parse` sub-path is imported by real code and must remain mapped",
  );
  assertEquals(
    imports["@std/yaml/parse"],
    "jsr:@std/yaml@^1.0.12/parse",
    "The `@std/yaml/parse` mapping must resolve the std/yaml parse sub-path",
  );
});
