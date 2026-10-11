/**
 * Tests for the deno fmt/lint scope filter (PR #3584 review).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { inDenoScope, parseDenoScope } from "../lib/deno_scope.ts";

const scope = (json: string) => {
  const parsed = parseDenoScope(json);
  assert(parsed !== null);
  return parsed;
};

Deno.test("inDenoScope: no include or exclude checks everything", () => {
  const c = scope("{}");
  assert(inDenoScope("README.md", c, "fmt"));
  assert(inDenoScope("a/b/c.ts", c, "lint"));
});

Deno.test("inDenoScope: a directory include admits only files under it", () => {
  const c = scope('{"fmt":{"include":["src/"]}}');
  assert(inDenoScope("src/a.ts", c, "fmt"));
  assert(inDenoScope("src/deep/a.ts", c, "fmt"));
  assert(!inDenoScope("README.md", c, "fmt"));
  assert(!inDenoScope("srcx/a.ts", c, "fmt"));
  // The include is per tool: lint has none here.
  assert(inDenoScope("README.md", c, "lint"));
});

Deno.test("inDenoScope: a file include and a glob include", () => {
  const c = scope('{"lint":{"include":["mod.ts","lib/**/*.ts"]}}');
  assert(inDenoScope("mod.ts", c, "lint"));
  assert(inDenoScope("lib/a.ts", c, "lint"));
  assert(inDenoScope("lib/x/y/a.ts", c, "lint"));
  assert(!inDenoScope("lib/a.md", c, "lint"));
  assert(!inDenoScope("other.ts", c, "lint"));
});

Deno.test("inDenoScope: top-level and per-tool exclude both apply", () => {
  const c = scope(
    '{"exclude":["vendor/","**/*.gen.ts"],"fmt":{"exclude":["docs"]}}',
  );
  assert(!inDenoScope("vendor/x.ts", c, "fmt"));
  assert(!inDenoScope("a/b.gen.ts", c, "lint"));
  assert(!inDenoScope("docs/a.md", c, "fmt"));
  assert(inDenoScope("docs/a.md", c, "lint"));
  assert(inDenoScope("src/a.ts", c, "fmt"));
});

Deno.test("inDenoScope: a negated exclude re-includes, last match wins", () => {
  const c = scope('{"exclude":["gen/","!gen/keep.ts"]}');
  assert(!inDenoScope("gen/drop.ts", c, "fmt"));
  assert(inDenoScope("gen/keep.ts", c, "fmt"));
});

Deno.test("inDenoScope: node_modules and .git are always out of scope", () => {
  const c = scope("{}");
  assert(!inDenoScope("node_modules/x/a.ts", c, "fmt"));
  assert(!inDenoScope("sub/node_modules/a.ts", c, "lint"));
  assert(!inDenoScope(".git/hooks/a.ts", c, "fmt"));
});

Deno.test("inDenoScope: brace globs and leading ./ are understood", () => {
  const c = scope('{"fmt":{"include":["./src/**/*.{ts,tsx}"]}}');
  assert(inDenoScope("src/a.ts", c, "fmt"));
  assert(inDenoScope("src/a/b.tsx", c, "fmt"));
  assert(!inDenoScope("src/a.json", c, "fmt"));
});

Deno.test("inDenoScope: an oversized pattern never matches (bounded cost)", () => {
  const c = scope(`{"fmt":{"include":["${"*".repeat(300)}"]}}`);
  // Uncompilable include: stays in scope rather than being guessed out.
  assert(inDenoScope("a.ts", c, "fmt"));
  // An oversized exclude never matches, so nothing is excluded by it.
  const e = scope(`{"exclude":["${"a".repeat(300)}"]}`);
  assert(inDenoScope(`${"a".repeat(300)}/x.ts`, e, "fmt"));
  const hostile = `{"exclude":["${"**/*/".repeat(40)}x"]}`;
  assert(inDenoScope(`${"a/".repeat(80)}b.ts`, scope(hostile), "fmt"));
});

Deno.test("parseDenoScope: jsonc comments parse; garbage is null", () => {
  const c = parseDenoScope('{ // keep\n "fmt": {"include": ["src/",],}, }');
  assertEquals(c?.fmt?.include, ["src/"]);
  assertEquals(parseDenoScope("{ not json"), null);
  assertEquals(parseDenoScope("[1]"), null);
});

Deno.test("inDenoScope: an empty include list or an unbalanced brace leaves files in scope", () => {
  assert(inDenoScope("README.md", scope('{"fmt":{"include":[]}}'), "fmt"));
  assert(inDenoScope("README.md", scope('{"fmt":{"include":[""]}}'), "fmt"));
  const broken = scope('{"fmt":{"include":["src/{a,b"]}}');
  assert(inDenoScope("README.md", broken, "fmt"));
  // The same include made legal does exclude the README.
  const legal = scope('{"fmt":{"include":["src/{a,b}"]}}');
  assert(!inDenoScope("README.md", legal, "fmt"));
  assert(inDenoScope("src/a/x.ts", legal, "fmt"));
});
