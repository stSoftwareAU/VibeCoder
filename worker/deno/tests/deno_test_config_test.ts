/**
 * Unit tests for the Deno project-config reader and the config-aware test rule
 * (Issue #4533): `deno.json` `test.include` / `test.exclude` decide what a Deno
 * test is, and `imports` resolves an alias to a local path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type DenoProjectConfig,
  EMPTY_PROJECT_CONFIG,
  isDenoTestPath,
  parseDenoProjectConfig,
  resolveImportSpecifier,
} from "../lib/deno_test_config.ts";

const parse = (text: string) => parseDenoProjectConfig(text, "deno.json");

// ---------------------------------------------------------------------------
// parseDenoProjectConfig
// ---------------------------------------------------------------------------

Deno.test("parseDenoProjectConfig - JSONC comments and trailing commas are accepted", () => {
  const c = parse(`// project settings
{
  /* the test rules */
  "test": { "include": ["test/**/*.ts",], },
  "imports": { "@neat/": "./src/NEAT/", },
}`);
  assertEquals(c.include, ["test/**/*.ts"]);
  assertEquals(c.exclude, []);
  assertEquals([...c.imports], [["@neat/", "./src/NEAT/"]]);
});

Deno.test("parseDenoProjectConfig - empty or whitespace-only text is an empty config", () => {
  for (const text of ["", "  \n\t", "{}"]) {
    const c = parse(text);
    assertEquals(c.include, []);
    assertEquals(c.exclude, []);
    assertEquals(c.imports.size, 0);
  }
});

Deno.test("parseDenoProjectConfig - invalid JSON throws naming the source", () => {
  assertThrows(
    () => parseDenoProjectConfig("{", "worker/deno/deno.json"),
    Error,
    "worker/deno/deno.json",
  );
});

Deno.test("parseDenoProjectConfig - a non-object top level throws naming the source", () => {
  for (const text of ["[]", '"x"', "null", "1"]) {
    assertThrows(() => parse(text), Error, "deno.json");
  }
});

Deno.test("parseDenoProjectConfig - a wrongly typed test.include throws naming the field", () => {
  assertThrows(
    () => parse('{"test":{"include":"test/**"}}'),
    Error,
    "test.include",
  );
});

Deno.test("parseDenoProjectConfig - a non-string test.exclude entry throws naming the field", () => {
  assertThrows(
    () => parse('{"test":{"exclude":[1]}}'),
    Error,
    "test.exclude",
  );
});

Deno.test("parseDenoProjectConfig - a non-object test or imports field throws naming it", () => {
  assertThrows(() => parse('{"test":"x"}'), Error, "test");
  assertThrows(() => parse('{"imports":[]}'), Error, "imports");
  assertThrows(() => parse('{"imports":{"@a/":1}}'), Error, "imports");
});

Deno.test("parseDenoProjectConfig - a negated include or exclude entry throws naming the entry", () => {
  assertThrows(
    () => parse('{"test":{"include":["!test/**"]}}'),
    Error,
    "!test/**",
  );
  assertThrows(
    () => parse('{"test":{"exclude":["!x.ts"]}}'),
    Error,
    "!x.ts",
  );
});

Deno.test("parseDenoProjectConfig - only local relative import targets are kept", () => {
  const c = parse(`{"imports":{
    "@std/assert": "jsr:@std/assert@1",
    "npm-x": "npm:x@1",
    "https-x": "https://example.com/x.ts",
    "@neat/": "./src/NEAT/",
    "@up/": "../up/"
  }}`);
  assertEquals([...c.imports.keys()].sort(), ["@neat/", "@up/"]);
  assertEquals(c.imports.get("@up/"), "../up/");
});

// ---------------------------------------------------------------------------
// isDenoTestPath
// ---------------------------------------------------------------------------

Deno.test("isDenoTestPath - the suffix rule applies with an empty config", () => {
  assert(isDenoTestPath("lib/a_test.ts", EMPTY_PROJECT_CONFIG));
  assert(isDenoTestPath("lib/a.test.ts", EMPTY_PROJECT_CONFIG));
  assertEquals(isDenoTestPath("test/a.ts", EMPTY_PROJECT_CONFIG), false);
});

Deno.test("isDenoTestPath - test/**/*.ts matches under test/ at any depth, not src/", () => {
  const c = parse('{"test":{"include":["test/**/*.ts"]}}');
  assert(isDenoTestPath("test/a.ts", c));
  assert(isDenoTestPath("test/ci/b.ts", c));
  assertEquals(isDenoTestPath("src/a.ts", c), false);
});

Deno.test("isDenoTestPath - exclude wins over include", () => {
  const c = parse(
    '{"test":{"include":["test/**/*.ts"],"exclude":["test/fixtures/**"]}}',
  );
  assert(isDenoTestPath("test/a.ts", c));
  assertEquals(isDenoTestPath("test/fixtures/c.ts", c), false);
});

Deno.test("isDenoTestPath - a bare directory entry matches everything beneath it", () => {
  const c = parse('{"test":{"include":["test"]}}');
  assert(isDenoTestPath("test/a.ts", c));
  assert(isDenoTestPath("test/ci/b.ts", c));
  assertEquals(isDenoTestPath("testing/a.ts", c), false);
  assertEquals(isDenoTestPath("src/a.ts", c), false);
});

Deno.test("isDenoTestPath - a ./ prefix and a trailing slash are ignored", () => {
  const c = parse('{"test":{"include":["./test/**/"]}}');
  assert(isDenoTestPath("test/a.ts", c));
  assertEquals(isDenoTestPath("src/a.ts", c), false);
});

Deno.test("isDenoTestPath - braces expand, and each alternative matches", () => {
  const c = parse('{"test":{"include":["{test,spec}/**/*.{ts,tsx}"]}}');
  assert(isDenoTestPath("test/a.ts", c));
  assert(isDenoTestPath("spec/ci/b.tsx", c));
  assertEquals(isDenoTestPath("lib/a.ts", c), false);
});

Deno.test("isDenoTestPath - a ? matches one character within a segment", () => {
  const c = parse('{"test":{"include":["test/?.ts"]}}');
  assert(isDenoTestPath("test/a.ts", c));
  assertEquals(isDenoTestPath("test/ab.ts", c), false);
});

Deno.test("isDenoTestPath - an exclude of a suffix-named test does not un-test it", () => {
  const c = parse(
    '{"test":{"include":["test/**"],"exclude":["test/a_test.ts"]}}',
  );
  assert(isDenoTestPath("test/a_test.ts", c));
  assertEquals(isDenoTestPath("test/b.ts", c), true);
});

Deno.test("isDenoTestPath - a hostile ** pattern is decided without blowing up", () => {
  const hostile = parse('{"test":{"include":["**/**/**/**/**/**/**/x"]}}');
  const deep = Array.from({ length: 60 }, () => "a").join("/");
  assertEquals(isDenoTestPath(`${deep}/y`, hostile), false);
  // The same pattern does match when the last segment is `x`, so the
  // negative above is a real decision and not a rejection of long paths.
  assert(isDenoTestPath(`${deep}/x`, hostile));
});

// ---------------------------------------------------------------------------
// resolveImportSpecifier
// ---------------------------------------------------------------------------

const withImports = (
  imports: Record<string, string>,
): DenoProjectConfig => parse(JSON.stringify({ imports }));

Deno.test("resolveImportSpecifier - a prefix key maps the rest of the specifier", () => {
  const c = withImports({ "@neat/": "./src/NEAT/" });
  assertEquals(
    resolveImportSpecifier("@neat/Neat.ts", c, ""),
    "src/NEAT/Neat.ts",
  );
});

Deno.test("resolveImportSpecifier - an exact key maps to its target", () => {
  const c = withImports({ "@x": "./lib/x.ts" });
  assertEquals(resolveImportSpecifier("@x", c, ""), "lib/x.ts");
  assertEquals(resolveImportSpecifier("@x/y", c, ""), null);
});

Deno.test("resolveImportSpecifier - the longest matching prefix key wins", () => {
  const c = withImports({ "@a/": "./a/", "@a/b/": "./ab/" });
  assertEquals(resolveImportSpecifier("@a/b/c.ts", c, ""), "ab/c.ts");
  assertEquals(resolveImportSpecifier("@a/c.ts", c, ""), "a/c.ts");
});

Deno.test("resolveImportSpecifier - a jsr: or npm: target resolves to nothing", () => {
  const c = withImports({
    "@std/assert": "jsr:@std/assert@1",
    "chalk": "npm:chalk@5",
  });
  assertEquals(resolveImportSpecifier("@std/assert", c, ""), null);
  assertEquals(resolveImportSpecifier("chalk", c, ""), null);
});

Deno.test("resolveImportSpecifier - the target is joined onto a nested config directory", () => {
  const c = withImports({ "@neat/": "./src/NEAT/" });
  assertEquals(
    resolveImportSpecifier("@neat/x.ts", c, "worker/deno"),
    "worker/deno/src/NEAT/x.ts",
  );
});

Deno.test("resolveImportSpecifier - an unmapped or relative specifier resolves to nothing", () => {
  const c = withImports({ "@neat/": "./src/NEAT/" });
  assertEquals(resolveImportSpecifier("@other/x.ts", c, ""), null);
  assertEquals(resolveImportSpecifier("./x.ts", c, ""), null);
});

Deno.test("resolveImportSpecifier - a target that climbs above the repository root resolves to nothing", () => {
  const c = withImports({ "@up/": "../../../" });
  assertEquals(resolveImportSpecifier("@up/x.ts", c, "worker/deno"), null);
  assertEquals(
    resolveImportSpecifier("@up/x.ts", withImports({ "@up/": "../" }), ""),
    null,
  );
});
