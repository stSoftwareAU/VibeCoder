/**
 * Tests for the native manifest merge-conflict rules (Issue #464, part of #456).
 *
 * The rules under test resolve a version-only conflict inside a dependency
 * region — `[dependencies]` and friends in `Cargo.toml`, `require` in `go.mod`
 * — by taking the higher semver per dependency key. Everything else falls
 * through to the AI fallback as `unresolved`: a changed `features` list, a Go
 * pseudo-version or `+incompatible` build tag, and any hunk touching a
 * non-dependency line.
 *
 * The fixtures embed conflict markers at column 0, which is exactly what the CI
 * "Check for merge conflict markers" step looks for; that step honours the
 * sentinel below to exempt this file, and prints the exemption. Nothing here is
 * an unresolved conflict.
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
  cargoTomlRule,
  goModRule,
  nativeManifestRules,
} from "../lib/dependency_conflict_native.ts";

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
    throw new Error(`expected resolved to defer, got:\n${outcome.text}`);
  }
  return outcome.reason;
}

/** A `Cargo.toml` whose `[dependencies]` conflicts on one entry. */
function cargoConflict(ours: string, theirs: string): string {
  return `[package]
name = "vibe"
version = "0.1.0"

[dependencies]
anyhow = "1.0.86"
<<<<<<< HEAD
${ours}
=======
${theirs}
>>>>>>> origin/main
tokio = "1.38.0"
`;
}

/** The expected resolution of `cargoConflict`, carrying `winner`. */
function cargoResolved(winner: string): string {
  return `[package]
name = "vibe"
version = "0.1.0"

[dependencies]
anyhow = "1.0.86"
${winner}
tokio = "1.38.0"
`;
}

/** A `go.mod` whose `require` block conflicts on one module. */
function goModConflict(ours: string, theirs: string): string {
  return `module github.com/stSoftwareAU/vibe

go 1.22

require (
	github.com/google/uuid v1.6.0
<<<<<<< HEAD
	${ours}
=======
	${theirs}
>>>>>>> origin/main
)
`;
}

/** The expected resolution of `goModConflict`, carrying `winner`. */
function goModResolved(winner: string): string {
  return `module github.com/stSoftwareAU/vibe

go 1.22

require (
	github.com/google/uuid v1.6.0
	${winner}
)
`;
}

// ---------------------------------------------------------------------------
// Cargo.toml — short form
// ---------------------------------------------------------------------------

Deno.test("cargoTomlRule - short-form conflict resolves to the higher version", () => {
  assertEquals(
    resolvedText(
      cargoTomlRule,
      cargoConflict(`serde = "1.0.195"`, `serde = "1.0.200"`),
    ),
    cargoResolved(`serde = "1.0.200"`),
  );
});

Deno.test("cargoTomlRule - higher version wins when it is on ours", () => {
  assertEquals(
    resolvedText(
      cargoTomlRule,
      cargoConflict(`serde = "1.0.200"`, `serde = "1.0.195"`),
    ),
    cargoResolved(`serde = "1.0.200"`),
  );
});

Deno.test("cargoTomlRule - versions are ordered numerically, not lexically", () => {
  assertEquals(
    resolvedText(
      cargoTomlRule,
      cargoConflict(`serde = "1.9.0"`, `serde = "1.10.0"`),
    ),
    cargoResolved(`serde = "1.10.0"`),
  );
});

Deno.test("cargoTomlRule - a caret range keeps its prefix", () => {
  assertEquals(
    resolvedText(
      cargoTomlRule,
      cargoConflict(`serde = "^1.0.195"`, `serde = "^1.0.200"`),
    ),
    cargoResolved(`serde = "^1.0.200"`),
  );
});

Deno.test("cargoTomlRule - a changed range prefix defers", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      cargoConflict(`serde = "^1.0.195"`, `serde = "~1.0.200"`),
    ),
    "range prefix changed",
  );
});

Deno.test("cargoTomlRule - each side's own bump is kept", () => {
  const text = `[dependencies]
<<<<<<< HEAD
anyhow = "1.0.90"
serde = "1.0.195"
=======
anyhow = "1.0.86"
serde = "1.0.200"
>>>>>>> origin/main
`;
  assertEquals(
    resolvedText(cargoTomlRule, text),
    `[dependencies]
anyhow = "1.0.90"
serde = "1.0.200"
`,
  );
});

Deno.test("cargoTomlRule - a dependency added on one side only is kept", () => {
  const text = `[dependencies]
<<<<<<< HEAD
anyhow = "1.0.86"
serde = "1.0.200"
=======
anyhow = "1.0.86"
clap = "4.5.4"
serde = "1.0.195"
>>>>>>> origin/main
`;
  assertEquals(
    resolvedText(cargoTomlRule, text),
    `[dependencies]
anyhow = "1.0.86"
clap = "4.5.4"
serde = "1.0.200"
`,
  );
});

Deno.test("cargoTomlRule - resolves dev-, build- and target-scoped dependency tables", () => {
  const text = `[dev-dependencies]
<<<<<<< HEAD
criterion = "0.5.1"
=======
criterion = "0.5.4"
>>>>>>> origin/main

[build-dependencies]
<<<<<<< HEAD
cc = "1.0.90"
=======
cc = "1.0.99"
>>>>>>> origin/main

[target.'cfg(unix)'.dependencies]
<<<<<<< HEAD
nix = "0.29.0"
=======
nix = "0.28.0"
>>>>>>> origin/main
`;
  assertEquals(
    resolvedText(cargoTomlRule, text),
    `[dev-dependencies]
criterion = "0.5.4"

[build-dependencies]
cc = "1.0.99"

[target.'cfg(unix)'.dependencies]
nix = "0.29.0"
`,
  );
});

// ---------------------------------------------------------------------------
// Cargo.toml — table form
// ---------------------------------------------------------------------------

Deno.test("cargoTomlRule - table-form conflict differing only in version resolves", () => {
  assertEquals(
    resolvedText(
      cargoTomlRule,
      cargoConflict(
        `serde = { version = "1.0.195", features = ["derive"] }`,
        `serde = { version = "1.0.200", features = ["derive"] }`,
      ),
    ),
    cargoResolved(`serde = { version = "1.0.200", features = ["derive"] }`),
  );
});

Deno.test("cargoTomlRule - table-form conflict changing features defers", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      cargoConflict(
        `serde = { version = "1.0.195", features = ["derive"] }`,
        `serde = { version = "1.0.200", features = ["derive", "rc"] }`,
      ),
    ),
    "changes more than the version",
  );
});

Deno.test("cargoTomlRule - table-form conflict changing default-features defers", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      cargoConflict(
        `serde = { version = "1.0.195", default-features = false }`,
        `serde = { version = "1.0.200", default-features = true }`,
      ),
    ),
    "changes more than the version",
  );
});

Deno.test("cargoTomlRule - switching between short and table form defers", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      cargoConflict(
        `serde = "1.0.195"`,
        `serde = { version = "1.0.200", features = ["derive"] }`,
      ),
    ),
    "changes more than the version",
  );
});

Deno.test("cargoTomlRule - a path or git dependency with no version defers", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      cargoConflict(
        `serde = { git = "https://example.com/serde", branch = "main" }`,
        `serde = { git = "https://example.com/serde", branch = "next" }`,
      ),
    ),
    "more than dependency entries",
  );
});

// ---------------------------------------------------------------------------
// Cargo.toml — non-dependency regions defer
// ---------------------------------------------------------------------------

Deno.test("cargoTomlRule - a conflict in a features block defers", () => {
  const reason = unresolvedReason(
    cargoTomlRule,
    `[dependencies]
serde = "1.0.195"

[features]
<<<<<<< HEAD
default = ["fast"]
=======
default = ["safe"]
>>>>>>> origin/main
`,
  );
  assertStringIncludes(reason, "not inside a dependency table");
  assertStringIncludes(reason, "features");
});

Deno.test("cargoTomlRule - a conflict in the package table defers", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      `[package]
<<<<<<< HEAD
version = "0.2.0"
=======
version = "0.3.0"
>>>>>>> origin/main
`,
    ),
    "not inside a dependency table",
  );
});

Deno.test("cargoTomlRule - a hunk running into a table header defers", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      `[dependencies]
<<<<<<< HEAD
serde = "1.0.195"

[features]
default = ["fast"]
=======
serde = "1.0.200"

[features]
default = ["safe"]
>>>>>>> origin/main
`,
    ),
    "more than dependency entries",
  );
});

Deno.test("cargoTomlRule - a dependency sub-table defers", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      `[dependencies.serde]
<<<<<<< HEAD
version = "1.0.195"
=======
version = "1.0.200"
>>>>>>> origin/main
`,
    ),
    "not inside a dependency table",
  );
});

Deno.test("cargoTomlRule - a multi-line string in the file defers the whole file", () => {
  assertStringIncludes(
    unresolvedReason(
      cargoTomlRule,
      `[package]
description = """
[dependencies] is not a real table here
"""

[dependencies]
<<<<<<< HEAD
serde = "1.0.195"
=======
serde = "1.0.200"
>>>>>>> origin/main
`,
    ),
    "multi-line string",
  );
});

// ---------------------------------------------------------------------------
// go.mod
// ---------------------------------------------------------------------------

Deno.test("goModRule - require-block conflict resolves numerically, not lexically", () => {
  assertEquals(
    resolvedText(
      goModRule,
      goModConflict(
        "github.com/spf13/cobra v1.2.3",
        "github.com/spf13/cobra v1.10.0",
      ),
    ),
    goModResolved("github.com/spf13/cobra v1.10.0"),
  );
});

Deno.test("goModRule - higher version wins when it is on ours", () => {
  assertEquals(
    resolvedText(
      goModRule,
      goModConflict(
        "github.com/spf13/cobra v1.10.0",
        "github.com/spf13/cobra v1.2.3",
      ),
    ),
    goModResolved("github.com/spf13/cobra v1.10.0"),
  );
});

Deno.test("goModRule - an indirect marker is preserved with the winning line", () => {
  assertEquals(
    resolvedText(
      goModRule,
      goModConflict(
        "github.com/spf13/cobra v1.2.3 // indirect",
        "github.com/spf13/cobra v1.10.0 // indirect",
      ),
    ),
    goModResolved("github.com/spf13/cobra v1.10.0 // indirect"),
  );
});

Deno.test("goModRule - a changed indirect marker defers", () => {
  assertStringIncludes(
    unresolvedReason(
      goModRule,
      goModConflict(
        "github.com/spf13/cobra v1.2.3 // indirect",
        "github.com/spf13/cobra v1.10.0",
      ),
    ),
    "changes more than the version",
  );
});

Deno.test("goModRule - resolves a single-line require directive", () => {
  const text = `module github.com/stSoftwareAU/vibe

go 1.22

<<<<<<< HEAD
require github.com/spf13/cobra v1.2.3
=======
require github.com/spf13/cobra v1.10.0
>>>>>>> origin/main
`;
  assertEquals(
    resolvedText(goModRule, text),
    `module github.com/stSoftwareAU/vibe

go 1.22

require github.com/spf13/cobra v1.10.0
`,
  );
});

Deno.test("goModRule - each side's own bump is kept", () => {
  const text = `require (
<<<<<<< HEAD
	github.com/google/uuid v1.7.0
	github.com/spf13/cobra v1.2.3
=======
	github.com/google/uuid v1.6.0
	github.com/spf13/cobra v1.10.0
>>>>>>> origin/main
)
`;
  assertEquals(
    resolvedText(goModRule, text),
    `require (
	github.com/google/uuid v1.7.0
	github.com/spf13/cobra v1.10.0
)
`,
  );
});

Deno.test("goModRule - a module added on one side only is kept", () => {
  const text = `require (
<<<<<<< HEAD
	github.com/google/uuid v1.6.0
	github.com/spf13/cobra v1.10.0
=======
	github.com/google/uuid v1.6.0
	github.com/rs/zerolog v1.33.0
	github.com/spf13/cobra v1.2.3
>>>>>>> origin/main
)
`;
  assertEquals(
    resolvedText(goModRule, text),
    `require (
	github.com/google/uuid v1.6.0
	github.com/rs/zerolog v1.33.0
	github.com/spf13/cobra v1.10.0
)
`,
  );
});

Deno.test("goModRule - a pseudo-version on either side defers", () => {
  const pseudo = "github.com/spf13/cobra v0.0.0-20230101120000-abcdef123456";
  assertStringIncludes(
    unresolvedReason(
      goModRule,
      goModConflict("github.com/spf13/cobra v1.2.3", pseudo),
    ),
    "not a plain Go semver version",
  );
  assertStringIncludes(
    unresolvedReason(
      goModRule,
      goModConflict(pseudo, "github.com/spf13/cobra v1.2.3"),
    ),
    "not a plain Go semver version",
  );
});

Deno.test("goModRule - an +incompatible version defers", () => {
  assertStringIncludes(
    unresolvedReason(
      goModRule,
      goModConflict(
        "github.com/spf13/cobra v2.1.0+incompatible",
        "github.com/spf13/cobra v2.2.0+incompatible",
      ),
    ),
    "not a plain Go semver version",
  );
});

Deno.test("goModRule - a version without the mandatory v prefix defers", () => {
  assertStringIncludes(
    unresolvedReason(
      goModRule,
      goModConflict(
        "github.com/spf13/cobra 1.2.3",
        "github.com/spf13/cobra 1.10.0",
      ),
    ),
    "not a plain Go semver version",
  );
});

Deno.test("goModRule - a conflict in a replace block defers", () => {
  assertStringIncludes(
    unresolvedReason(
      goModRule,
      `module github.com/stSoftwareAU/vibe

replace (
<<<<<<< HEAD
	github.com/spf13/cobra => ../cobra
=======
	github.com/spf13/cobra => ../vendor/cobra
>>>>>>> origin/main
)
`,
    ),
    "not inside a require directive",
  );
});

Deno.test("goModRule - a conflict on the go directive defers", () => {
  assertStringIncludes(
    unresolvedReason(
      goModRule,
      `module github.com/stSoftwareAU/vibe

<<<<<<< HEAD
go 1.22
=======
go 1.23
>>>>>>> origin/main
`,
    ),
    "more than require entries",
  );
});

Deno.test("goModRule - a hunk closing the require block defers", () => {
  assertStringIncludes(
    unresolvedReason(
      goModRule,
      `require (
<<<<<<< HEAD
	github.com/spf13/cobra v1.2.3
)
=======
	github.com/spf13/cobra v1.10.0
)
>>>>>>> origin/main
`,
    ),
    "more than require entries",
  );
});

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

Deno.test("native rules - a file with no conflicts round-trips byte for byte", () => {
  const text = `[dependencies]\nserde = "1.0.195"\n`;
  assertEquals(resolvedText(cargoTomlRule, text), text);
});

Deno.test("native rules - CRLF line endings are preserved", () => {
  const text = "[dependencies]\r\n<<<<<<< HEAD\r\n" +
    'serde = "1.0.195"\r\n=======\r\nserde = "1.0.200"\r\n' +
    ">>>>>>> origin/main\r\n";
  assertEquals(
    resolvedText(cargoTomlRule, text),
    '[dependencies]\r\nserde = "1.0.200"\r\n',
  );
});

Deno.test("native rules - one undecidable hunk defers the whole file", () => {
  const text = `[dependencies]
<<<<<<< HEAD
serde = "1.0.195"
=======
serde = "1.0.200"
>>>>>>> origin/main

[features]
<<<<<<< HEAD
default = ["fast"]
=======
default = ["safe"]
>>>>>>> origin/main
`;
  const outcome = resolveWith(cargoTomlRule, text);
  assertEquals(outcome.kind, "unresolved");
});

Deno.test("native rules - reasons name the rule and the hunk", () => {
  const reason = unresolvedReason(
    cargoTomlRule,
    `[features]
<<<<<<< HEAD
default = ["fast"]
=======
default = ["safe"]
>>>>>>> origin/main
`,
  );
  assertStringIncludes(reason, "Cargo.toml:");
  assertStringIncludes(reason, "hunk 1");
});

Deno.test("native rules - matching is on the basename, on both path separators", () => {
  assertEquals(cargoTomlRule.matches("Cargo.toml"), true);
  assertEquals(cargoTomlRule.matches("crates/core/Cargo.toml"), true);
  assertEquals(cargoTomlRule.matches("crates\\core\\Cargo.toml"), true);
  assertEquals(cargoTomlRule.matches("Cargo.lock"), false);
  assertEquals(goModRule.matches("go.mod"), true);
  assertEquals(goModRule.matches("service/go.mod"), true);
  assertEquals(goModRule.matches("go.sum"), false);
});

Deno.test("native rules - are registered in the shared registry", () => {
  assertEquals(manifestRuleRegistry.find("Cargo.toml"), cargoTomlRule);
  assertEquals(manifestRuleRegistry.find("service/go.mod"), goModRule);
  assertEquals(nativeManifestRules.length, 2);
});
