/**
 * Tests for the deterministic merge-conflict core (Issue #462).
 *
 * Covers the three pieces the later per-ecosystem rules build on: the
 * conflict-hunk parser (which must round-trip byte-for-byte), the dependency
 * specifier version comparator, and the rule-registry seam.
 *
 * The module under test is pure — no git, no network, no file I/O — so every
 * behaviour is exercised directly with literal inputs.
 *
 * The fixtures below embed real conflict markers at column 0, which is exactly
 * what the "Check for merge conflict markers" CI step looks for. That step
 * honours the sentinel on the next line to exempt this file, and prints the
 * exemption; nothing here is an unresolved conflict.
 *
 * vibe-allow-conflict-markers
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  applyHunkChoices,
  compareDependencySpecifiers,
  type ConflictHunk,
  type ConflictSegment,
  createManifestRuleRegistry,
  type ManifestRule,
  parseConflictSegments,
  parseDependencySpecifier,
  renderConflictSegments,
} from "../lib/dependency_conflict_rules.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse, asserting success, and return the segments. */
function parseOk(text: string): ConflictSegment[] {
  const result = parseConflictSegments(text);
  if (!result.ok) {
    throw new Error(`expected parse to succeed, got: ${result.error}`);
  }
  return result.value;
}

/** The conflict hunks of a parse, in order. */
function hunksOf(segments: readonly ConflictSegment[]): ConflictHunk[] {
  return segments.filter((s): s is ConflictHunk => s.kind === "conflict");
}

const NO_CONFLICT = `{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.18"
  }
}
`;

const ONE_CONFLICT = `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/fs": "jsr:@std/fs@^1.2.0"
>>>>>>> origin/main
  }
}
`;

const DIFF3_CONFLICT = `line one
<<<<<<< ours
alpha
||||||| merged common ancestors
base line
=======
beta
>>>>>>> theirs
line two
`;

const TWO_CONFLICTS = `head
<<<<<<< HEAD
a1
=======
a2
>>>>>>> branch
middle
<<<<<<< HEAD
b1
=======
b2
>>>>>>> branch
tail
`;

// ---------------------------------------------------------------------------
// Hunk parser — round-tripping
// ---------------------------------------------------------------------------

Deno.test("parseConflictSegments - round-trips a file with no conflicts", () => {
  const segments = parseOk(NO_CONFLICT);
  assertEquals(hunksOf(segments).length, 0);
  assertEquals(renderConflictSegments(segments), NO_CONFLICT);
});

Deno.test("parseConflictSegments - round-trips a single conflict byte-for-byte", () => {
  const segments = parseOk(ONE_CONFLICT);
  assertEquals(hunksOf(segments).length, 1);
  assertEquals(renderConflictSegments(segments), ONE_CONFLICT);
});

Deno.test("parseConflictSegments - round-trips several conflicts byte-for-byte", () => {
  const segments = parseOk(TWO_CONFLICTS);
  assertEquals(hunksOf(segments).length, 2);
  assertEquals(renderConflictSegments(segments), TWO_CONFLICTS);
});

Deno.test("parseConflictSegments - round-trips a diff3 hunk with a base section", () => {
  const segments = parseOk(DIFF3_CONFLICT);
  const [hunk] = hunksOf(segments);
  assertEquals(hunk?.base, "base line\n");
  assertEquals(renderConflictSegments(segments), DIFF3_CONFLICT);
});

Deno.test("parseConflictSegments - round-trips a file with no trailing newline", () => {
  const text = "a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\nz";
  assertEquals(renderConflictSegments(parseOk(text)), text);
});

Deno.test("parseConflictSegments - round-trips CRLF line endings", () => {
  const text = "a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\nz\r\n";
  assertEquals(renderConflictSegments(parseOk(text)), text);
});

Deno.test("parseConflictSegments - round-trips the empty file", () => {
  const segments = parseOk("");
  assertEquals(renderConflictSegments(segments), "");
});

// ---------------------------------------------------------------------------
// Hunk parser — extracted content
// ---------------------------------------------------------------------------

Deno.test("parseConflictSegments - captures ours and theirs side text", () => {
  const [hunk] = hunksOf(parseOk(ONE_CONFLICT));
  assertEquals(hunk?.ours, '    "@std/fs": "jsr:@std/fs@^1.0.0"\n');
  assertEquals(hunk?.theirs, '    "@std/fs": "jsr:@std/fs@^1.2.0"\n');
  assertEquals(hunk?.base, null);
});

Deno.test("parseConflictSegments - preserves literal text around a hunk", () => {
  const segments = parseOk(DIFF3_CONFLICT);
  assertEquals(segments[0], { kind: "literal", text: "line one\n" });
  assertEquals(segments[2], { kind: "literal", text: "line two\n" });
});

Deno.test("parseConflictSegments - an empty side is preserved as empty text", () => {
  const text = "<<<<<<< HEAD\n=======\nnew\n>>>>>>> b\n";
  const [hunk] = hunksOf(parseOk(text));
  assertEquals(hunk?.ours, "");
  assertEquals(hunk?.theirs, "new\n");
  assertEquals(renderConflictSegments(parseOk(text)), text);
});

Deno.test("parseConflictSegments - a separator outside a conflict is literal text", () => {
  // Markdown setext headings underline with '=======' — not a conflict marker.
  const text = "Title\n=======\n\nBody\n";
  const segments = parseOk(text);
  assertEquals(hunksOf(segments).length, 0);
  assertEquals(renderConflictSegments(segments), text);
});

// ---------------------------------------------------------------------------
// Hunk parser — fails loud on malformed input
// ---------------------------------------------------------------------------

Deno.test("parseConflictSegments - unterminated hunk is an error, not a silent pass", () => {
  const result = parseConflictSegments("<<<<<<< HEAD\nx\n=======\ny\n");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("line 1"), true);
});

Deno.test("parseConflictSegments - nested start marker is an error", () => {
  const result = parseConflictSegments(
    "<<<<<<< HEAD\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n",
  );
  assertEquals(result.ok, false);
});

Deno.test("parseConflictSegments - end marker before a separator is an error", () => {
  const result = parseConflictSegments("<<<<<<< HEAD\nx\n>>>>>>> b\n");
  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// applyHunkChoices
// ---------------------------------------------------------------------------

Deno.test("applyHunkChoices - replaces each hunk with the chosen side", () => {
  const segments = parseOk(TWO_CONFLICTS);
  assertEquals(
    applyHunkChoices(segments, ["ours", "theirs"]),
    "head\na1\nmiddle\nb2\ntail\n",
  );
});

Deno.test("applyHunkChoices - leaves a conflict-free file untouched", () => {
  assertEquals(applyHunkChoices(parseOk(NO_CONFLICT), []), NO_CONFLICT);
});

Deno.test("applyHunkChoices - throws when the choice count does not match", () => {
  const segments = parseOk(TWO_CONFLICTS);
  assertThrows(() => applyHunkChoices(segments, ["ours"]));
});

// ---------------------------------------------------------------------------
// Specifier parsing
// ---------------------------------------------------------------------------

Deno.test("parseDependencySpecifier - bare semver", () => {
  assertEquals(parseDependencySpecifier("1.2.3"), {
    packagePrefix: "",
    rangePrefix: "",
    version: [1, 2, 3],
    prerelease: false,
  });
});

Deno.test("parseDependencySpecifier - leading v is accepted", () => {
  assertEquals(parseDependencySpecifier("v1.2.3")?.version, [1, 2, 3]);
});

Deno.test("parseDependencySpecifier - range prefixes are captured, not normalised", () => {
  assertEquals(parseDependencySpecifier("^1.2.3")?.rangePrefix, "^");
  assertEquals(parseDependencySpecifier("~1.2.3")?.rangePrefix, "~");
  assertEquals(parseDependencySpecifier(">=1.2.3")?.rangePrefix, ">=");
});

Deno.test("parseDependencySpecifier - jsr registry specifier", () => {
  assertEquals(parseDependencySpecifier("jsr:@std/fs@^1.2.3"), {
    packagePrefix: "jsr:@std/fs@",
    rangePrefix: "^",
    version: [1, 2, 3],
    prerelease: false,
  });
});

Deno.test("parseDependencySpecifier - npm registry specifier", () => {
  assertEquals(parseDependencySpecifier("npm:pkg@~1.2.3"), {
    packagePrefix: "npm:pkg@",
    rangePrefix: "~",
    version: [1, 2, 3],
    prerelease: false,
  });
});

Deno.test("parseDependencySpecifier - sub-path export specifier", () => {
  const parsed = parseDependencySpecifier("jsr:@std/yaml@^1.0.12/parse");
  assertEquals(parsed, null);
});

Deno.test("parseDependencySpecifier - pre-release is parsed and flagged", () => {
  assertEquals(parseDependencySpecifier("1.2.3-beta.1")?.prerelease, true);
});

Deno.test("parseDependencySpecifier - unparseable shapes return null", () => {
  assertEquals(parseDependencySpecifier("1.2"), null);
  assertEquals(parseDependencySpecifier("latest"), null);
  assertEquals(parseDependencySpecifier(""), null);
  assertEquals(parseDependencySpecifier("1.2.3+build"), null);
});

// ---------------------------------------------------------------------------
// Version comparator
// ---------------------------------------------------------------------------

Deno.test("compareDependencySpecifiers - orders numerically, not lexically", () => {
  assertEquals(compareDependencySpecifiers("1.2.3", "1.10.0"), {
    kind: "higher",
    side: "theirs",
    specifier: "1.10.0",
  });
  assertEquals(compareDependencySpecifiers("2.1.170", "2.1.9"), {
    kind: "higher",
    side: "ours",
    specifier: "2.1.170",
  });
});

Deno.test("compareDependencySpecifiers - carries the range prefix through", () => {
  assertEquals(compareDependencySpecifiers("^1.2.3", "^1.3.0"), {
    kind: "higher",
    side: "theirs",
    specifier: "^1.3.0",
  });
});

Deno.test("compareDependencySpecifiers - compares jsr registry specifiers", () => {
  assertEquals(
    compareDependencySpecifiers("jsr:@std/fs@^1.0.0", "jsr:@std/fs@^1.2.0"),
    { kind: "higher", side: "theirs", specifier: "jsr:@std/fs@^1.2.0" },
  );
});

Deno.test("compareDependencySpecifiers - compares npm registry specifiers", () => {
  assertEquals(
    compareDependencySpecifiers("npm:pkg@~1.2.3", "npm:pkg@~1.1.9"),
    { kind: "higher", side: "ours", specifier: "npm:pkg@~1.2.3" },
  );
});

Deno.test("compareDependencySpecifiers - surrounding whitespace is ignored", () => {
  assertEquals(compareDependencySpecifiers("  ^1.2.3 ", "^1.3.0"), {
    kind: "higher",
    side: "theirs",
    specifier: "^1.3.0",
  });
});

Deno.test("compareDependencySpecifiers - a pre-release on either side is undecidable", () => {
  assertEquals(
    compareDependencySpecifiers("1.2.3", "1.3.0-beta.1").kind,
    "undecidable",
  );
  assertEquals(
    compareDependencySpecifiers("1.3.0-beta.1", "1.2.3").kind,
    "undecidable",
  );
});

Deno.test("compareDependencySpecifiers - equal versions are undecidable", () => {
  assertEquals(
    compareDependencySpecifiers("^1.2.3", "^1.2.3").kind,
    "undecidable",
  );
});

Deno.test("compareDependencySpecifiers - a range-prefix-only difference is undecidable", () => {
  const verdict = compareDependencySpecifiers("^1.2.3", "~1.2.3");
  assertEquals(verdict.kind, "undecidable");
  if (verdict.kind === "undecidable") {
    assertEquals(verdict.reason.includes("range prefix"), true);
  }
});

Deno.test("compareDependencySpecifiers - a range-prefix change with a bump is still undecidable", () => {
  assertEquals(
    compareDependencySpecifiers("^1.2.3", ">=1.3.0").kind,
    "undecidable",
  );
});

Deno.test("compareDependencySpecifiers - different packages are undecidable", () => {
  assertEquals(
    compareDependencySpecifiers("jsr:@std/fs@^1.0.0", "jsr:@std/path@^1.2.0")
      .kind,
    "undecidable",
  );
});

Deno.test("compareDependencySpecifiers - an unparseable side is undecidable", () => {
  assertEquals(
    compareDependencySpecifiers("latest", "1.2.3").kind,
    "undecidable",
  );
  assertEquals(
    compareDependencySpecifiers("1.2.3", "workspace:*").kind,
    "undecidable",
  );
});

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

/** A rule matching an exact basename, resolving every hunk to `theirs`. */
function fakeRule(name: string, basename: string): ManifestRule {
  return {
    name,
    matches: (path) => path === basename || path.endsWith(`/${basename}`),
    resolve: (segments) => ({
      kind: "resolved",
      text: applyHunkChoices(
        segments,
        segments.filter((s) => s.kind === "conflict").map(() => "theirs"),
      ),
    }),
  };
}

Deno.test("createManifestRuleRegistry - returns no rule for an unregistered path", () => {
  const registry = createManifestRuleRegistry([fakeRule("deno", "deno.json")]);
  assertEquals(registry.find("src/main.ts"), undefined);
});

Deno.test("createManifestRuleRegistry - finds a rule by path", () => {
  const rule = fakeRule("deno", "deno.json");
  const registry = createManifestRuleRegistry([rule]);
  assertEquals(registry.find("worker/deno/deno.json"), rule);
  assertEquals(registry.find("deno.json"), rule);
});

Deno.test("createManifestRuleRegistry - rules register after construction", () => {
  const registry = createManifestRuleRegistry();
  assertEquals(registry.find("package.json"), undefined);
  const rule = fakeRule("npm", "package.json");
  registry.register(rule);
  assertEquals(registry.find("package.json"), rule);
  assertEquals(registry.rules.length, 1);
});

Deno.test("createManifestRuleRegistry - the first matching rule wins", () => {
  const first = fakeRule("first", "deno.json");
  const second = fakeRule("second", "deno.json");
  const registry = createManifestRuleRegistry([first, second]);
  assertEquals(registry.find("deno.json"), first);
});

Deno.test("createManifestRuleRegistry - a duplicate rule name fails loud", () => {
  const registry = createManifestRuleRegistry([fakeRule("deno", "deno.json")]);
  assertThrows(() => registry.register(fakeRule("deno", "other.json")));
});

Deno.test("ManifestRule - a resolved outcome carries the full file text", () => {
  const registry = createManifestRuleRegistry([fakeRule("deno", "deno.json")]);
  const rule = registry.find("worker/deno/deno.json");
  const outcome = rule?.resolve(parseOk(ONE_CONFLICT));
  assertEquals(outcome?.kind, "resolved");
  if (outcome?.kind === "resolved") {
    assertEquals(outcome.text.includes("<<<<<<<"), false);
    assertEquals(outcome.text.includes("jsr:@std/fs@^1.2.0"), true);
  }
});
