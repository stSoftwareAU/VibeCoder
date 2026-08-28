/**
 * Tests for dependency_conflict_decisions.ts (Issue #466, part of #456).
 *
 * The decision extractor is what makes an automated version pick auditable on
 * the PR: it says which dependency changed, what each side carried, and which
 * value the rules kept. Every test drives it through a real rule resolution so
 * the extractor can never drift from what the rules actually wrote.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 *
 * The fixtures embed conflict markers at column 0, which is exactly what the CI
 * "Check for merge conflict markers" step looks for; that step honours the
 * sentinel below to exempt this file, and prints the exemption. Nothing here is
 * an unresolved conflict.
 *
 * vibe-allow-conflict-markers
 */

import { assert, assertEquals } from "@std/assert";
import { parseConflictSegments } from "../lib/dependency_conflict_rules.ts";
import { denoJsonRule } from "../lib/dependency_conflict_json.ts";
import { cargoTomlRule } from "../lib/dependency_conflict_native.ts";
import {
  type DependencyDecision,
  extractDependencyDecisions,
  parseDependencyEntryLine,
} from "../lib/dependency_conflict_decisions.ts";

/** Resolve `text` with `rule`, then extract the decisions it made. */
function decisionsFor(
  rule: { resolve: (segments: never) => unknown },
  text: string,
): DependencyDecision[] | null {
  const parsed = parseConflictSegments(text);
  assert(parsed.ok, "the fixture must parse");
  const outcome = (rule as unknown as {
    resolve: (
      s: readonly unknown[],
    ) => { kind: string; text?: string };
  }).resolve(parsed.value);
  assertEquals(outcome.kind, "resolved");
  return extractDependencyDecisions(parsed.value, outcome.text ?? "");
}

/** Find the decision for a key, failing the test when it is absent. */
function decisionFor(
  decisions: DependencyDecision[] | null,
  key: string,
): DependencyDecision {
  assert(decisions !== null, "decisions must be attributable");
  const found = decisions.find((d) => d.key === key);
  assert(found, `no decision for ${key}: ${JSON.stringify(decisions)}`);
  return found;
}

// ---------------------------------------------------------------------------
// Entry-line parsing
// ---------------------------------------------------------------------------

Deno.test("parseDependencyEntryLine - a JSON map entry with a trailing comma", () => {
  assertEquals(
    parseDependencyEntryLine('    "@std/fs": "jsr:@std/fs@^1.2.0",'),
    {
      key: "@std/fs",
      value: "jsr:@std/fs@^1.2.0",
    },
  );
});

Deno.test("parseDependencyEntryLine - a JSON map entry without a comma", () => {
  assertEquals(parseDependencyEntryLine('  "@std/fs": "jsr:@std/fs@^1.2.0"'), {
    key: "@std/fs",
    value: "jsr:@std/fs@^1.2.0",
  });
});

Deno.test("parseDependencyEntryLine - a Cargo short-form entry", () => {
  assertEquals(parseDependencyEntryLine('serde = "1.0.200"'), {
    key: "serde",
    value: "1.0.200",
  });
});

Deno.test("parseDependencyEntryLine - a Cargo inline table reports its version", () => {
  assertEquals(
    parseDependencyEntryLine(
      'serde = { version = "1.0.200", features = ["derive"] }',
    ),
    { key: "serde", value: "1.0.200" },
  );
});

Deno.test("parseDependencyEntryLine - a go.mod require line", () => {
  assertEquals(parseDependencyEntryLine("\tgithub.com/pkg/errors v0.9.1"), {
    key: "github.com/pkg/errors",
    value: "v0.9.1",
  });
});

Deno.test("parseDependencyEntryLine - a line that is not an entry", () => {
  assertEquals(parseDependencyEntryLine("  }"), null);
  assertEquals(parseDependencyEntryLine(""), null);
  assertEquals(parseDependencyEntryLine("// a comment"), null);
});

// ---------------------------------------------------------------------------
// Decisions from a real rule resolution
// ---------------------------------------------------------------------------

const DENO_JSON_BUMP = `{
  "imports": {
<<<<<<< HEAD
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/fs": "jsr:@std/fs@^1.2.0"
>>>>>>> origin/main
  }
}
`;

Deno.test("extractDependencyDecisions - names the bumped dependency and both sides", () => {
  const decisions = decisionsFor(denoJsonRule, DENO_JSON_BUMP);
  const bumped = decisionFor(decisions, "@std/fs");
  assertEquals(bumped.ours, "jsr:@std/fs@^1.0.0");
  assertEquals(bumped.theirs, "jsr:@std/fs@^1.2.0");
  assertEquals(bumped.kept, "jsr:@std/fs@^1.2.0");
});

Deno.test("extractDependencyDecisions - an unchanged dependency is not a decision", () => {
  const decisions = decisionsFor(denoJsonRule, DENO_JSON_BUMP);
  assert(decisions !== null);
  assertEquals(decisions.some((d) => d.key === "@std/assert"), false);
});

Deno.test("extractDependencyDecisions - reports the branch side when it is higher", () => {
  const decisions = decisionsFor(
    denoJsonRule,
    `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^2.0.0"
=======
    "@std/fs": "jsr:@std/fs@^1.2.0"
>>>>>>> origin/main
  }
}
`,
  );
  const bumped = decisionFor(decisions, "@std/fs");
  assertEquals(bumped.ours, "jsr:@std/fs@^2.0.0");
  assertEquals(bumped.theirs, "jsr:@std/fs@^1.2.0");
  assertEquals(bumped.kept, "jsr:@std/fs@^2.0.0");
});

Deno.test("extractDependencyDecisions - a dependency only the base added", () => {
  const decisions = decisionsFor(
    denoJsonRule,
    `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/fs": "jsr:@std/fs@^1.0.0",
    "@std/path": "jsr:@std/path@^1.1.0"
>>>>>>> origin/main
  }
}
`,
  );
  const added = decisionFor(decisions, "@std/path");
  assertEquals(added.ours, null);
  assertEquals(added.theirs, "jsr:@std/path@^1.1.0");
  assertEquals(added.kept, "jsr:@std/path@^1.1.0");
});

Deno.test("extractDependencyDecisions - covers every hunk in a multi-hunk file", () => {
  const decisions = decisionsFor(
    denoJsonRule,
    `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0",
=======
    "@std/fs": "jsr:@std/fs@^1.2.0",
>>>>>>> origin/main
    "@std/io": "jsr:@std/io@^0.225.0",
<<<<<<< HEAD
    "@std/path": "jsr:@std/path@^1.0.0"
=======
    "@std/path": "jsr:@std/path@^1.1.0"
>>>>>>> origin/main
  }
}
`,
  );
  assertEquals(decisionFor(decisions, "@std/fs").kept, "jsr:@std/fs@^1.2.0");
  assertEquals(
    decisionFor(decisions, "@std/path").kept,
    "jsr:@std/path@^1.1.0",
  );
});

Deno.test("extractDependencyDecisions - works for a Cargo.toml resolution", () => {
  const decisions = decisionsFor(
    cargoTomlRule,
    `[dependencies]
<<<<<<< HEAD
serde = "1.0.200"
=======
serde = "1.0.210"
>>>>>>> origin/main
`,
  );
  const bumped = decisionFor(decisions, "serde");
  assertEquals(bumped.ours, "1.0.200");
  assertEquals(bumped.theirs, "1.0.210");
  assertEquals(bumped.kept, "1.0.210");
});

Deno.test("extractDependencyDecisions - text that does not match the parse is unattributable", () => {
  // A resolved text the segments cannot explain must report "unknown" rather
  // than inventing a decision the reviewer would then trust.
  const parsed = parseConflictSegments(DENO_JSON_BUMP);
  assert(parsed.ok);
  assertEquals(
    extractDependencyDecisions(parsed.value, "something else entirely\n"),
    null,
  );
});
