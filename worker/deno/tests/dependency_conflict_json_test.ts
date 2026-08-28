/**
 * Tests for the JSON manifest merge-conflict rules (Issue #463, part of #456).
 *
 * The rules under test resolve a version-only conflict inside a dependency map
 * — `imports`/`scopes` in `deno.json`/`deno.jsonc`, and the four dependency
 * maps in `package.json` — by taking the higher semver per dependency key.
 * Everything else falls through to the AI fallback as `unresolved`.
 *
 * The fixtures are the real shape of `worker/deno/deno.json`'s `imports` map.
 * They embed conflict markers at column 0, which is exactly what the CI
 * "Check for merge conflict markers" step looks for; that step honours the
 * sentinel below to exempt this file, and prints the exemption. Nothing here
 * is an unresolved conflict.
 *
 * vibe-allow-conflict-markers
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ManifestRule,
  manifestRuleRegistry,
  parseConflictSegments,
  type RuleOutcome,
} from "../lib/dependency_conflict_rules.ts";
import {
  denoJsonRule,
  jsonManifestRules,
  packageJsonRule,
} from "../lib/dependency_conflict_json.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse `text`, asserting success, and run the rule over it. */
function resolveWith(rule: ManifestRule, text: string): RuleOutcome {
  const parsed = parseConflictSegments(text);
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.error}`);
  return rule.resolve(parsed.value);
}

/** Resolve, asserting the rule succeeded, and return the merged file text. */
function resolvedText(rule: ManifestRule, text: string): string {
  const outcome = resolveWith(rule, text);
  if (outcome.kind !== "resolved") {
    throw new Error(`expected resolved, got unresolved: ${outcome.reason}`);
  }
  assertEquals(
    /^(<{7}|={7}|>{7}|\|{7})/m.test(outcome.text),
    false,
    "resolved output must not contain conflict markers",
  );
  return outcome.text;
}

/** Resolve, asserting the rule deferred, and return the reason. */
function unresolvedReason(rule: ManifestRule, text: string): string {
  const outcome = resolveWith(rule, text);
  if (outcome.kind !== "unresolved") {
    throw new Error(`expected unresolved, got resolved:\n${outcome.text}`);
  }
  return outcome.reason;
}

/**
 * A `deno.json` whose `imports` map conflicts on one dependency.
 *
 * `ours` and `theirs` are the specifier each side carries for `@std/fs`.
 */
function denoImportsConflict(ours: string, theirs: string): string {
  return `{
  "name": "@vibe-coder/worker",
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.18",
<<<<<<< HEAD
    "@std/fs": "${ours}"
=======
    "@std/fs": "${theirs}"
>>>>>>> origin/main
  }
}
`;
}

/** The expected resolution of `denoImportsConflict`, carrying `winner`. */
function denoImportsResolved(winner: string): string {
  return `{
  "name": "@vibe-coder/worker",
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/fs": "${winner}"
  }
}
`;
}

// ---------------------------------------------------------------------------
// deno.json — the headline case
// ---------------------------------------------------------------------------

Deno.test("denoJsonRule - higher version wins when it is on theirs", () => {
  assertEquals(
    resolvedText(
      denoJsonRule,
      denoImportsConflict("jsr:@std/fs@^1.0.0", "jsr:@std/fs@^1.2.0"),
    ),
    denoImportsResolved("jsr:@std/fs@^1.2.0"),
  );
});

Deno.test("denoJsonRule - higher version wins when it is on ours", () => {
  assertEquals(
    resolvedText(
      denoJsonRule,
      denoImportsConflict("jsr:@std/fs@^1.2.0", "jsr:@std/fs@^1.0.0"),
    ),
    denoImportsResolved("jsr:@std/fs@^1.2.0"),
  );
});

Deno.test("denoJsonRule - keeps both bumps when each side bumps a different dependency", () => {
  const text = `{
  "imports": {
<<<<<<< HEAD
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/fs": "jsr:@std/fs@^1.2.0",
    "@std/path": "jsr:@std/path@^1.0.0"
=======
    "@std/assert": "jsr:@std/assert@^1.0.20",
    "@std/fs": "jsr:@std/fs@^1.0.0",
    "@std/path": "jsr:@std/path@^1.0.0"
>>>>>>> origin/main
  }
}
`;
  assertEquals(
    resolvedText(denoJsonRule, text),
    `{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.20",
    "@std/fs": "jsr:@std/fs@^1.2.0",
    "@std/path": "jsr:@std/path@^1.0.0"
  }
}
`,
  );
});

Deno.test("denoJsonRule - a dependency added on one side only is kept", () => {
  const text = `{
  "imports": {
<<<<<<< HEAD
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/fs": "jsr:@std/fs@^1.2.0"
=======
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/cli": "jsr:@std/cli@^1.0.6",
    "@std/fs": "jsr:@std/fs@^1.0.0"
>>>>>>> origin/main
  }
}
`;
  assertEquals(
    resolvedText(denoJsonRule, text),
    `{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/cli": "jsr:@std/cli@^1.0.6",
    "@std/fs": "jsr:@std/fs@^1.2.0"
  }
}
`,
  );
});

Deno.test("denoJsonRule - resolves a conflict inside a scopes map", () => {
  const text = `{
  "scopes": {
    "https://example.com/": {
<<<<<<< HEAD
      "@std/fs": "jsr:@std/fs@^1.0.0"
=======
      "@std/fs": "jsr:@std/fs@^1.2.0"
>>>>>>> origin/main
    }
  }
}
`;
  assertStringIncludes(
    resolvedText(denoJsonRule, text),
    `      "@std/fs": "jsr:@std/fs@^1.2.0"\n`,
  );
});

Deno.test("denoJsonRule - resolves every conflicting hunk in the file", () => {
  const text = `{
  "imports": {
<<<<<<< HEAD
    "@std/assert": "jsr:@std/assert@^1.0.20",
=======
    "@std/assert": "jsr:@std/assert@^1.0.18",
>>>>>>> origin/main
    "@std/cli": "jsr:@std/cli@^1.0.6",
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/fs": "jsr:@std/fs@^1.2.0"
>>>>>>> origin/main
  }
}
`;
  assertEquals(
    resolvedText(denoJsonRule, text),
    `{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.20",
    "@std/cli": "jsr:@std/cli@^1.0.6",
    "@std/fs": "jsr:@std/fs@^1.2.0"
  }
}
`,
  );
});

// ---------------------------------------------------------------------------
// deno.json — everything that is not a dependency version
// ---------------------------------------------------------------------------

Deno.test("denoJsonRule - a conflict in the tasks block is unresolved", () => {
  const text = `{
  "tasks": {
<<<<<<< HEAD
    "test": "deno test --allow-read"
=======
    "test": "deno test --allow-all"
>>>>>>> origin/main
  }
}
`;
  assertStringIncludes(unresolvedReason(denoJsonRule, text), "tasks");
});

Deno.test("denoJsonRule - a hunk mixing a tasks change and a dependency bump is unresolved", () => {
  const text = `{
  "tasks": {
<<<<<<< HEAD
    "test": "deno test --allow-read"
  },
  "imports": {
    "@std/fs": "jsr:@std/fs@^1.2.0"
=======
    "test": "deno test --allow-all"
  },
  "imports": {
    "@std/fs": "jsr:@std/fs@^1.0.0"
>>>>>>> origin/main
  }
}
`;
  const outcome = resolveWith(denoJsonRule, text);
  assertEquals(outcome.kind, "unresolved");
});

Deno.test("denoJsonRule - one undecidable dependency defers the whole file", () => {
  const text = `{
  "imports": {
<<<<<<< HEAD
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/assert": "jsr:@std/assert@^1.0.20",
    "@std/fs": "jsr:@std/fs@~1.2.0"
>>>>>>> origin/main
  }
}
`;
  assertStringIncludes(unresolvedReason(denoJsonRule, text), "@std/fs");
});

Deno.test("denoJsonRule - a pre-release on one side is unresolved", () => {
  const reason = unresolvedReason(
    denoJsonRule,
    denoImportsConflict("jsr:@std/fs@^1.0.0", "jsr:@std/fs@^1.2.0-rc.1"),
  );
  assertStringIncludes(reason, "pre-release");
});

Deno.test("denoJsonRule - an unparseable specifier is unresolved", () => {
  const reason = unresolvedReason(
    denoJsonRule,
    denoImportsConflict("jsr:@std/yaml@^1.0.12/parse", "jsr:@std/yaml@^1.1.0"),
  );
  assertStringIncludes(reason, "unparseable");
});

Deno.test("denoJsonRule - equal versions written differently are unresolved", () => {
  const reason = unresolvedReason(
    denoJsonRule,
    denoImportsConflict("jsr:@std/fs@1.2.0", "jsr:@std/fs@v1.2.0"),
  );
  assertStringIncludes(reason, "equal");
});

Deno.test("denoJsonRule - a non-entry line inside the hunk is unresolved", () => {
  const text = `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0",
    "@std/cli": { "version": "1.0.0" }
=======
    "@std/fs": "jsr:@std/fs@^1.2.0",
    "@std/cli": "jsr:@std/cli@^1.0.6"
>>>>>>> origin/main
  }
}
`;
  const outcome = resolveWith(denoJsonRule, text);
  assertEquals(outcome.kind, "unresolved");
});

Deno.test("denoJsonRule - a side that deletes the whole block is unresolved", () => {
  const text = `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
>>>>>>> origin/main
  }
}
`;
  const outcome = resolveWith(denoJsonRule, text);
  assertEquals(outcome.kind, "unresolved");
});

Deno.test("denoJsonRule - reordered dependency keys are unresolved", () => {
  const text = `{
  "imports": {
<<<<<<< HEAD
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/fs": "jsr:@std/fs@^1.2.0",
    "@std/assert": "jsr:@std/assert@^1.0.18"
>>>>>>> origin/main
  }
}
`;
  const outcome = resolveWith(denoJsonRule, text);
  assertEquals(outcome.kind, "unresolved");
});

Deno.test("denoJsonRule - a conflict-free file is returned unchanged", () => {
  const text = `{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.18"
  }
}
`;
  assertEquals(resolvedText(denoJsonRule, text), text);
});

Deno.test("denoJsonRule - CRLF line endings survive the resolution", () => {
  const text = [
    "{",
    '  "imports": {',
    "<<<<<<< HEAD",
    '    "@std/fs": "jsr:@std/fs@^1.0.0"',
    "=======",
    '    "@std/fs": "jsr:@std/fs@^1.2.0"',
    ">>>>>>> origin/main",
    "  }",
    "}",
    "",
  ].join("\r\n");
  assertEquals(
    resolvedText(denoJsonRule, text),
    [
      "{",
      '  "imports": {',
      '    "@std/fs": "jsr:@std/fs@^1.2.0"',
      "  }",
      "}",
      "",
    ].join("\r\n"),
  );
});

// ---------------------------------------------------------------------------
// deno.jsonc — comments and formatting survive
// ---------------------------------------------------------------------------

Deno.test("denoJsonRule - a jsonc file keeps its comments and only the resolved line changes", () => {
  const text = `{
  // The worker's own dependencies — bumped by bump-deps.sh.
  "imports": {
    /* std assertions */
    "@std/assert": "jsr:@std/assert@^1.0.18",
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/fs": "jsr:@std/fs@^1.2.0"
>>>>>>> origin/main
  },
  // Comments after the conflict survive too.
  "lint": { "rules": { "exclude": ["require-await"] } }
}
`;
  assertEquals(
    resolvedText(denoJsonRule, text),
    `{
  // The worker's own dependencies — bumped by bump-deps.sh.
  "imports": {
    /* std assertions */
    "@std/assert": "jsr:@std/assert@^1.0.18",
    "@std/fs": "jsr:@std/fs@^1.2.0"
  },
  // Comments after the conflict survive too.
  "lint": { "rules": { "exclude": ["require-await"] } }
}
`,
  );
});

Deno.test("denoJsonRule - a conflict inside a jsonc comment block is unresolved", () => {
  const text = `{
  "imports": {
    "@std/fs": "jsr:@std/fs@^1.2.0"
  },
  /*
<<<<<<< HEAD
   ours note
=======
   theirs note
>>>>>>> origin/main
  */
  "lint": {}
}
`;
  const outcome = resolveWith(denoJsonRule, text);
  assertEquals(outcome.kind, "unresolved");
});

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

Deno.test("packageJsonRule - resolves dependencies and devDependencies", () => {
  const text = `{
  "name": "example",
  "dependencies": {
<<<<<<< HEAD
    "left-pad": "^1.3.0"
=======
    "left-pad": "^1.2.0"
>>>>>>> origin/main
  },
  "devDependencies": {
<<<<<<< HEAD
    "typescript": "~5.4.0"
=======
    "typescript": "~5.6.2"
>>>>>>> origin/main
  }
}
`;
  assertEquals(
    resolvedText(packageJsonRule, text),
    `{
  "name": "example",
  "dependencies": {
    "left-pad": "^1.3.0"
  },
  "devDependencies": {
    "typescript": "~5.6.2"
  }
}
`,
  );
});

Deno.test("packageJsonRule - resolves peerDependencies and optionalDependencies", () => {
  const text = `{
  "peerDependencies": {
<<<<<<< HEAD
    "react": "^18.2.0"
=======
    "react": "^18.3.1"
>>>>>>> origin/main
  },
  "optionalDependencies": {
<<<<<<< HEAD
    "fsevents": "^2.3.3"
=======
    "fsevents": "^2.3.2"
>>>>>>> origin/main
  }
}
`;
  const resolved = resolvedText(packageJsonRule, text);
  assertStringIncludes(resolved, `    "react": "^18.3.1"\n`);
  assertStringIncludes(resolved, `    "fsevents": "^2.3.3"\n`);
});

Deno.test("packageJsonRule - a conflict in the scripts block is unresolved", () => {
  const text = `{
  "scripts": {
<<<<<<< HEAD
    "build": "tsc -p ."
=======
    "build": "tsc --build"
>>>>>>> origin/main
  }
}
`;
  assertStringIncludes(unresolvedReason(packageJsonRule, text), "scripts");
});

Deno.test("packageJsonRule - a conflict on the version field is unresolved", () => {
  const text = `{
<<<<<<< HEAD
  "version": "1.3.0",
=======
  "version": "1.2.0",
>>>>>>> origin/main
  "dependencies": {}
}
`;
  const outcome = resolveWith(packageJsonRule, text);
  assertEquals(outcome.kind, "unresolved");
});

Deno.test("packageJsonRule - a trailing comma is added when a middle entry wins", () => {
  const text = `{
  "dependencies": {
<<<<<<< HEAD
    "left-pad": "^1.3.0"
=======
    "left-pad": "^1.2.0",
    "right-pad": "^2.0.0"
>>>>>>> origin/main
  }
}
`;
  assertEquals(
    resolvedText(packageJsonRule, text),
    `{
  "dependencies": {
    "left-pad": "^1.3.0",
    "right-pad": "^2.0.0"
  }
}
`,
  );
});

// ---------------------------------------------------------------------------
// Path matching and registration
// ---------------------------------------------------------------------------

Deno.test("denoJsonRule - matches deno.json and deno.jsonc anywhere in the tree", () => {
  assertEquals(denoJsonRule.matches("deno.json"), true);
  assertEquals(denoJsonRule.matches("worker/deno/deno.json"), true);
  assertEquals(denoJsonRule.matches("worker/deno/deno.jsonc"), true);
  assertEquals(denoJsonRule.matches("worker/deno/deno.lock"), false);
  assertEquals(denoJsonRule.matches("package.json"), false);
  assertEquals(denoJsonRule.matches("docs/deno.json.md"), false);
});

Deno.test("packageJsonRule - matches package.json but not the lock file", () => {
  assertEquals(packageJsonRule.matches("package.json"), true);
  assertEquals(packageJsonRule.matches("site/package.json"), true);
  assertEquals(packageJsonRule.matches("package-lock.json"), false);
  assertEquals(packageJsonRule.matches("site/package-lock.json"), false);
});

Deno.test("jsonManifestRules - are registered in the shared registry on import", () => {
  assertEquals(
    manifestRuleRegistry.find("worker/deno/deno.json"),
    denoJsonRule,
  );
  assertEquals(manifestRuleRegistry.find("deno.jsonc"), denoJsonRule);
  assertEquals(manifestRuleRegistry.find("site/package.json"), packageJsonRule);
  assertEquals(jsonManifestRules.length, 2);
});
