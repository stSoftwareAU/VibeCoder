/**
 * Tests for orphan_deps_finding_id.ts (Issue #2908, parent #2902).
 *
 * Coverage:
 *   - the stable finding-id recipe: deterministic, `BP-<12 hex>` shape,
 *     sensitive to repo / signal-class / package / ecosystem, and version
 *     suffixes normalised away;
 *   - discriminator disjointness: an orphan-deps id never collides with a
 *     `SEC-` (security-scan) id nor a `BP-` id from another scan family for
 *     the same package;
 *   - the known-open + suppression prune and 6-finding cap;
 *   - the in-source suppression-id collection (both marker keywords),
 *     its per-manifest comment grammar, and the file+line scoping the
 *     collected records carry (Issue #3947).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  _resetSuppressionAuthorAllowlist,
  recordedSuppressions,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
} from "../lib/suppression_comments.ts";
import {
  collectOrphanDepsSuppressedIds,
  collectOrphanDepsSuppressions,
  computeOrphanDepsFindingId,
  isOrphanDepsSuppressed,
  ORPHAN_DEPS_DISCRIMINATOR,
  ORPHAN_DEPS_FINDING_CAP,
  pruneAndCapOrphanDepsFindings,
} from "../lib/orphan_deps_finding_id.ts";
import { computeFindingId } from "../lib/security_finding_id.ts";
import { makeStableId } from "../lib/workflow_scan_common.ts";

// ---------------------------------------------------------------------------
// Finding-id recipe
// ---------------------------------------------------------------------------

Deno.test("computeOrphanDepsFindingId - BP-<12 hex> shape and determinism", async () => {
  const input = {
    repo: "acme/widget",
    signalClass: "ORPHAN-DEPRECATED",
    packageName: "left-pad",
    ecosystem: "npm",
  };
  const id = await computeOrphanDepsFindingId(input);
  assert(/^BP-[0-9a-f]{12}$/.test(id), `unexpected id shape: ${id}`);
  // Deterministic — same inputs, same id.
  assertEquals(await computeOrphanDepsFindingId(input), id);
  assertEquals(ORPHAN_DEPS_DISCRIMINATOR, "orphan-deps");
});

Deno.test("computeOrphanDepsFindingId - varies with every component", async () => {
  const base = {
    repo: "acme/widget",
    signalClass: "ORPHAN-DEPRECATED",
    packageName: "left-pad",
    ecosystem: "npm",
  };
  const id = await computeOrphanDepsFindingId(base);
  const diffRepo = await computeOrphanDepsFindingId({
    ...base,
    repo: "acme/x",
  });
  const diffClass = await computeOrphanDepsFindingId({
    ...base,
    signalClass: "ORPHAN-ARCHIVED",
  });
  const diffPkg = await computeOrphanDepsFindingId({
    ...base,
    packageName: "right-pad",
  });
  const diffEco = await computeOrphanDepsFindingId({
    ...base,
    ecosystem: "jsr",
  });
  const all = new Set([id, diffRepo, diffClass, diffPkg, diffEco]);
  assertEquals(all.size, 5, "every component must change the id");
});

Deno.test("computeOrphanDepsFindingId - normalises version suffixes and scope", async () => {
  const bare = await computeOrphanDepsFindingId({
    repo: "acme/widget",
    signalClass: "ORPHAN-STALE",
    packageName: "left-pad",
    ecosystem: "npm",
  });
  // `@1.2.3`, ` 1.2.3`, ` ^1` suffixes all normalise to the bare name.
  for (const variant of ["left-pad@1.2.3", "left-pad 1.2.3", "left-pad ^1"]) {
    assertEquals(
      await computeOrphanDepsFindingId({
        repo: "acme/widget",
        signalClass: "ORPHAN-STALE",
        packageName: variant,
        ecosystem: "npm",
      }),
      bare,
      `version suffix not normalised for "${variant}"`,
    );
  }
  // A scoped name keeps its leading @scope; only the version @ is dropped.
  const scoped = await computeOrphanDepsFindingId({
    repo: "acme/widget",
    signalClass: "ORPHAN-STALE",
    packageName: "@std/assert",
    ecosystem: "jsr",
  });
  const scopedVersioned = await computeOrphanDepsFindingId({
    repo: "acme/widget",
    signalClass: "ORPHAN-STALE",
    packageName: "@std/assert@1.0.0",
    ecosystem: "jsr",
  });
  assertEquals(scoped, scopedVersioned);
  // The ecosystem is case-insensitive.
  assertEquals(
    await computeOrphanDepsFindingId({
      repo: "acme/widget",
      signalClass: "ORPHAN-STALE",
      packageName: "left-pad",
      ecosystem: "NPM",
    }),
    bare,
  );
});

Deno.test("computeOrphanDepsFindingId - disjoint from SEC- and other BP- families", async () => {
  const repo = "acme/widget";
  const pkg = "left-pad";
  const orphanId = await computeOrphanDepsFindingId({
    repo,
    signalClass: "ORPHAN-DEPRECATED",
    packageName: pkg,
    ecosystem: "npm",
  });

  // Never collides with a security-scan SEC- id for the same package.
  const secId = await computeFindingId({
    repo,
    class: "ORPHAN-DEPRECATED",
    file: "package.json",
    snippet: pkg,
  });
  assert(orphanId !== secId, "orphan-deps id must differ from SEC- id");
  assert(!orphanId.startsWith("SEC-"));

  // Never collides with another scan family that shares the BP- space:
  // same parts, different discriminator → different hash.
  for (
    const discriminator of [
      "best-practices",
      "test-audit",
      "github-actions-audit",
      "supply-chain-readiness",
    ]
  ) {
    const otherFamilyId = await makeStableId([
      repo,
      discriminator,
      "ORPHAN-DEPRECATED",
      `npm:${pkg}`,
    ]);
    assert(
      orphanId !== otherFamilyId,
      `orphan-deps id collided with ${discriminator} id`,
    );
  }
});

// ---------------------------------------------------------------------------
// Prune + cap
// ---------------------------------------------------------------------------

Deno.test("pruneAndCapOrphanDepsFindings - drops known-open and suppressed ids", () => {
  const candidates = [
    { id: "BP-aaaaaaaaaaaa" },
    { id: "BP-bbbbbbbbbbbb" },
    { id: "BP-cccccccccccc" },
  ];
  const kept = pruneAndCapOrphanDepsFindings(candidates, {
    knownOpenIds: ["BP-aaaaaaaaaaaa"],
    suppressedIds: ["BP-bbbbbbbbbbbb"],
  });
  assertEquals(kept.map((c) => c.id), ["BP-cccccccccccc"]);
});

Deno.test("pruneAndCapOrphanDepsFindings - dedups repeated ids", () => {
  const candidates = [
    { id: "BP-aaaaaaaaaaaa" },
    { id: "BP-aaaaaaaaaaaa" },
    { id: "BP-bbbbbbbbbbbb" },
  ];
  const kept = pruneAndCapOrphanDepsFindings(candidates);
  assertEquals(kept.map((c) => c.id), ["BP-aaaaaaaaaaaa", "BP-bbbbbbbbbbbb"]);
});

Deno.test("pruneAndCapOrphanDepsFindings - orders by severity then caps at 6", () => {
  // 8 candidates, mixed severities — only the top 6 survive, high first.
  const candidates = [
    { id: "BP-low1", severity: "low" as const },
    { id: "BP-high1", severity: "high" as const },
    { id: "BP-med1", severity: "medium" as const },
    { id: "BP-low2", severity: "low" as const },
    { id: "BP-high2", severity: "high" as const },
    { id: "BP-med2", severity: "medium" as const },
    { id: "BP-low3", severity: "low" as const },
    { id: "BP-low4", severity: "low" as const },
  ];
  const kept = pruneAndCapOrphanDepsFindings(candidates);
  assertEquals(kept.length, ORPHAN_DEPS_FINDING_CAP);
  // high (input order) → medium (input order) → low (input order).
  assertEquals(kept.map((c) => c.id), [
    "BP-high1",
    "BP-high2",
    "BP-med1",
    "BP-med2",
    "BP-low1",
    "BP-low2",
  ]);
});

Deno.test("pruneAndCapOrphanDepsFindings - honours a custom cap", () => {
  const candidates = [
    { id: "BP-1" },
    { id: "BP-2" },
    { id: "BP-3" },
  ];
  assertEquals(
    pruneAndCapOrphanDepsFindings(candidates, { cap: 2 }).map((c) => c.id),
    ["BP-1", "BP-2"],
  );
});

// ---------------------------------------------------------------------------
// In-source suppression collection
// ---------------------------------------------------------------------------

// Issue #3941: collection honours governance, so these tests use fully
// governed markers and an explicit author allowlist.
const GOVERNED_POLICY = { allowedAuthors: ["nigel"] } as const;
const TRAILER = "author=nigel expires=2099-12-31 reviewed";

Deno.test("collectOrphanDepsSuppressedIds - parses both marker keywords", () => {
  const jsoncManifest = [
    "{",
    `  // best-practice-ignore: BP-aaaaaaaaaaaa — ${TRAILER}`,
    '  "imports": {',
    `    // orphan-deps-ignore: BP-bbbbbbbbbbbb — ${TRAILER}`,
    '    "left-pad": "npm:left-pad@1.3.0"',
    "  }",
    "}",
  ].join("\n");
  const ids = collectOrphanDepsSuppressedIds([jsoncManifest], GOVERNED_POLICY);
  assertEquals(ids.sort(), ["BP-aaaaaaaaaaaa", "BP-bbbbbbbbbbbb"]);
});

Deno.test("collectOrphanDepsSuppressedIds - parses hash-comment (TOML) markers", () => {
  const cargoToml = [
    "[dependencies]",
    `# orphan-deps-ignore: BP-cccccccccccc — ${TRAILER}`,
    'serde = "1.0"',
  ].join("\n");
  assertEquals(collectOrphanDepsSuppressedIds([cargoToml], GOVERNED_POLICY), [
    "BP-cccccccccccc",
  ]);
});

Deno.test("collectOrphanDepsSuppressedIds - ignores SEC- ids and dedups across files", () => {
  const a = `// best-practice-ignore: BP-dddddddddddd — ${TRAILER}`;
  const b = `# best-practice-ignore: BP-dddddddddddd — ${TRAILER}`;
  const sec = `// security-scan-ignore: SEC-abcdef012345 — ${TRAILER}`;
  const ids = collectOrphanDepsSuppressedIds([a, b, sec], GOVERNED_POLICY);
  assertEquals(ids, ["BP-dddddddddddd"]);
});

Deno.test("collectOrphanDepsSuppressedIds - empty when no markers present", () => {
  assertEquals(
    collectOrphanDepsSuppressedIds(['{ "name": "x" }'], GOVERNED_POLICY),
    [],
  );
});

// ---------------------------------------------------------------------------
// Issue #3941 — collection must honour the governance verdict
// ---------------------------------------------------------------------------

Deno.test("collectOrphanDepsSuppressedIds - an ungoverned marker is never collected (Issue #3941)", () => {
  // The exact trigger from the finding: no author, expiry or reason.
  const deno = "// orphan-deps-ignore: BP-aaaaaaaaaaaa";
  assertEquals(collectOrphanDepsSuppressedIds([deno], GOVERNED_POLICY), []);
});

Deno.test("collectOrphanDepsSuppressedIds - an expired marker is never collected (Issue #3941)", () => {
  const cargo =
    "# best-practice-ignore: BP-bbbbbbbbbbbb — author=nigel expires=2001-01-01 long gone";
  assertEquals(collectOrphanDepsSuppressedIds([cargo], GOVERNED_POLICY), []);
});

Deno.test("collectOrphanDepsSuppressedIds - an unallowlisted author is never collected (Issue #3941)", () => {
  const cargo =
    "# best-practice-ignore: BP-eeeeeeeeeeee — author=mallory expires=2099-12-31 trust me";
  assertEquals(collectOrphanDepsSuppressedIds([cargo], GOVERNED_POLICY), []);
});

Deno.test("collectOrphanDepsSuppressedIds - records the manifest file against each marker (Issue #3941)", () => {
  resetSuppressionRegistry();
  collectOrphanDepsSuppressedIds(
    [{
      text: `// orphan-deps-ignore: BP-ffffffffffff — ${TRAILER}`,
      file: "deno.jsonc",
    }],
    GOVERNED_POLICY,
  );
  const record = recordedSuppressions().find((r) => r.id === "BP-ffffffffffff");
  assertEquals(record?.file, "deno.jsonc");
  resetSuppressionRegistry();
});

// ---------------------------------------------------------------------------
// Comment-grammar anchoring and file+line scoping (Issue #3947)
// ---------------------------------------------------------------------------

/** The ids a grammar-aware collection yields, in declaration order. */
function collectedIds(
  manifests: Parameters<typeof collectOrphanDepsSuppressions>[0],
): string[] {
  return collectOrphanDepsSuppressions(manifests).map((s) => s.id);
}

Deno.test("collectOrphanDepsSuppressions - a `none` grammar manifest contributes nothing", () => {
  const packageJson =
    '{ "scripts": { "build": "echo # orphan-deps-ignore: BP-eeeeeeeeeeee — sneaky" } }';
  assertEquals(
    collectedIds([
      { file: "package.json", text: packageJson, grammar: "none" },
    ]),
    [],
  );
});

Deno.test("collectOrphanDepsSuppressions - a marker inside a string value is not a comment", () => {
  const cargoToml = [
    "[package]",
    'description = "# orphan-deps-ignore: BP-ffffffffffff — sneaky"',
    "[dependencies]",
    'serde = "1.0" # orphan-deps-ignore: BP-111111111111 — genuine trailing comment',
  ].join("\n");
  assertEquals(
    collectedIds([
      { file: "Cargo.toml", text: cargoToml, grammar: "hash" },
    ]),
    ["BP-111111111111"],
  );
});

Deno.test("collectOrphanDepsSuppressions - a slash marker inside a JSON string is not a comment", () => {
  const denoJson = [
    "{",
    '  "imports": {',
    '    "x": "https://example.com/x.ts // orphan-deps-ignore: BP-222222222222 — sneaky"',
    "  }",
    "}",
  ].join("\n");
  assertEquals(
    collectedIds([
      { file: "deno.json", text: denoJson, grammar: "slash" },
    ]),
    [],
  );
});

Deno.test("collectOrphanDepsSuppressions - records carry file, line and validity", () => {
  // Issue #3941: validity now also requires an allowlisted author.
  _resetSuppressionAuthorAllowlist();
  setSuppressionAuthorAllowlist(["nigel"]);
  try {
    const records = collectOrphanDepsSuppressions([
      {
        file: "Cargo.toml",
        text: [
          "[dependencies]",
          "# orphan-deps-ignore: BP-333333333333 — author=nigel expires=2999-01-01 archived",
          'serde = "1.0"',
          "# orphan-deps-ignore: BP-444444444444 — no governance fields",
          'left = "0.1"',
        ].join("\n"),
        grammar: "hash",
      },
    ]);
    assertEquals(records.length, 2);
    assertEquals(records[0], {
      id: "BP-333333333333",
      file: "Cargo.toml",
      line: 2,
      valid: true,
    });
    assertEquals(records[1]?.line, 4);
    assertEquals(records[1]?.valid, false);
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("isOrphanDepsSuppressed - honours only the declaring file and adjacent line", () => {
  _resetSuppressionAuthorAllowlist();
  setSuppressionAuthorAllowlist(["nigel"]);
  try {
    const suppressions = collectOrphanDepsSuppressions([
      {
        file: "Cargo.toml",
        text: [
          "[dependencies]",
          "# orphan-deps-ignore: BP-555555555555 — author=nigel expires=2999-01-01 archived",
          'serde = "1.0"',
        ].join("\n"),
        grammar: "hash",
      },
    ]);

    // Declaring line and the line immediately below it — suppressed.
    assert(
      isOrphanDepsSuppressed("BP-555555555555", suppressions, {
        file: "Cargo.toml",
        line: 3,
      }),
    );
    assert(
      isOrphanDepsSuppressed("BP-555555555555", suppressions, {
        file: "Cargo.toml",
        line: 2,
      }),
    );
    // Elsewhere in the same file — not suppressed.
    assert(
      !isOrphanDepsSuppressed("BP-555555555555", suppressions, {
        file: "Cargo.toml",
        line: 9,
      }),
    );
    // Same line number, different file — not suppressed.
    assert(
      !isOrphanDepsSuppressed("BP-555555555555", suppressions, {
        file: "deno.json",
        line: 3,
      }),
    );
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("isOrphanDepsSuppressed - an ungoverned marker never suppresses", () => {
  const suppressions = collectOrphanDepsSuppressions([
    {
      file: "Cargo.toml",
      text: "# orphan-deps-ignore: BP-666666666666 — no author or expiry",
      grammar: "hash",
    },
  ]);
  assertEquals(suppressions[0]?.valid, false);
  assert(
    !isOrphanDepsSuppressed("BP-666666666666", suppressions, {
      file: "Cargo.toml",
      line: 2,
    }),
  );
});
