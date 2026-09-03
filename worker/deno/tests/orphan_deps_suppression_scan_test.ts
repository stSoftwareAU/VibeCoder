/**
 * Tests for orphan_deps_suppression_scan.ts (Issue #2908, parent #2902).
 *
 * The module reads a bounded manifest allow-list under the cloned repo and
 * returns the `BP-` suppression ids declared in them. A `readTextFileFn`
 * stub keeps the tests off disk.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  collectInSourceSuppressedIds,
  collectInSourceSuppressions,
  MAX_MANIFEST_SCAN_CHARS,
  ORPHAN_DEPS_MANIFEST_FILES,
  ORPHAN_DEPS_MANIFESTS,
} from "../lib/orphan_deps_suppression_scan.ts";
import {
  _resetSuppressionAuthorAllowlist,
  recordedSuppressions,
  renderSuppressionSummary,
  resetSuppressionRegistry,
  setSuppressionAuthorAllowlist,
} from "../lib/suppression_comments.ts";

Deno.test("collectInSourceSuppressedIds - reads governed markers from manifest allow-list", async () => {
  _resetSuppressionAuthorAllowlist();
  setSuppressionAuthorAllowlist(["nigel"]);
  try {
    const files: Record<string, string> = {
      "/repo/deno.jsonc":
        "{\n  // orphan-deps-ignore: BP-aaaaaaaaaaaa — author=nigel expires=2099-12-31 finished lib\n}",
      "/repo/Cargo.toml":
        '[dependencies]\n# best-practice-ignore: BP-bbbbbbbbbbbb — author=nigel expires=2099-12-31 archived\nserde = "1.0"',
    };
    const read = (path: string): Promise<string> => {
      const text = files[path];
      if (text === undefined) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(text);
    };

    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: read,
    });
    assertEquals(ids.sort(), ["BP-aaaaaaaaaaaa", "BP-bbbbbbbbbbbb"]);
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("collectInSourceSuppressedIds - ungoverned and expired markers are rejected (Issue #3941)", async () => {
  // The exact trigger table from the finding: a bare marker in deno.json and
  // an expired mallory marker in Cargo.toml were both handed to Claude as
  // suppressed while the run report said they were rejected.
  _resetSuppressionAuthorAllowlist();
  setSuppressionAuthorAllowlist(["nigel"]);
  try {
    const files: Record<string, string> = {
      "/repo/deno.json": "{\n  // orphan-deps-ignore: BP-aaaaaaaaaaaa\n}",
      "/repo/Cargo.toml":
        '[dependencies]\n# best-practice-ignore: BP-bbbbbbbbbbbb — author=mallory expires=2001-01-01 long gone\nserde = "1.0"',
    };
    const read = (path: string): Promise<string> => {
      const text = files[path];
      if (text === undefined) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(text);
    };

    const ids = await collectInSourceSuppressedIds("/repo", {
      readTextFileFn: read,
    });
    assertEquals(ids, [], "rejected markers must never reach the prompt");
  } finally {
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("collectInSourceSuppressedIds - the registry names the manifest a marker lives in (Issue #3941)", async () => {
  _resetSuppressionAuthorAllowlist();
  setSuppressionAuthorAllowlist(["nigel"]);
  resetSuppressionRegistry();
  try {
    const read = (path: string): Promise<string> =>
      path === "/repo/deno.jsonc"
        ? Promise.resolve(
          "{\n  // orphan-deps-ignore: BP-cccccccccccc — author=nigel expires=2099-12-31 ok\n}",
        )
        : Promise.reject(new Error("ENOENT"));

    await collectInSourceSuppressedIds("/repo", { readTextFileFn: read });
    const record = recordedSuppressions().find((r) =>
      r.id === "BP-cccccccccccc"
    );
    assertEquals(record?.file, "deno.jsonc");
  } finally {
    resetSuppressionRegistry();
    _resetSuppressionAuthorAllowlist();
  }
});

Deno.test("collectInSourceSuppressedIds - missing manifests yield no ids", async () => {
  const read = (): Promise<string> => Promise.reject(new Error("ENOENT"));
  const ids = await collectInSourceSuppressedIds("/repo", {
    readTextFileFn: read,
  });
  assertEquals(ids, []);
});

Deno.test("collectInSourceSuppressedIds - a read error never throws", async () => {
  const read = (): Promise<string> =>
    Promise.reject(new Deno.errors.PermissionDenied("no read"));
  const ids = await collectInSourceSuppressedIds("/repo", {
    readTextFileFn: read,
  });
  assertEquals(ids, []);
});

// ---------------------------------------------------------------------------
// Comment-grammar scoping (Issue #3947)
// ---------------------------------------------------------------------------

Deno.test("collectInSourceSuppressedIds - a marker in a package.json string value does not suppress", async () => {
  const packageJson = JSON.stringify(
    {
      name: "demo",
      scripts: {
        build:
          "echo # orphan-deps-ignore: BP-aaaaaaaaaaaa — author=mallory expires=2999-01-01 sneaky && build",
      },
    },
    null,
    2,
  );
  const read = (path: string): Promise<string> =>
    path.endsWith("/package.json")
      ? Promise.resolve(packageJson)
      : Promise.reject(new Error("ENOENT"));

  assertEquals(
    await collectInSourceSuppressedIds("/repo", { readTextFileFn: read }),
    [],
  );
});

Deno.test("collectInSourceSuppressedIds - a marker in a yarn.lock header comment does not suppress", async () => {
  const yarnLock = [
    "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.",
    "# orphan-deps-ignore: BP-bbbbbbbbbbbb — author=mallory expires=2999-01-01 sneaky",
    "",
    'left-pad@^1.3.0:\n  version "1.3.0"',
  ].join("\n");
  const read = (path: string): Promise<string> =>
    path.endsWith("/yarn.lock")
      ? Promise.resolve(yarnLock)
      : Promise.reject(new Error("ENOENT"));

  assertEquals(
    await collectInSourceSuppressedIds("/repo", { readTextFileFn: read }),
    [],
  );
});

Deno.test("collectInSourceSuppressedIds - non-commentable manifests are never read", async () => {
  const readPaths: string[] = [];
  const read = (path: string): Promise<string> => {
    readPaths.push(path);
    return Promise.reject(new Error("ENOENT"));
  };

  await collectInSourceSuppressedIds("/repo", { readTextFileFn: read });

  for (
    const name of [
      "deno.lock",
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "Cargo.lock",
    ]
  ) {
    assert(
      !readPaths.includes(`/repo/${name}`),
      `${name} has no comment grammar and must not be scanned`,
    );
  }
  assertEquals(readPaths, [
    "/repo/deno.json",
    "/repo/deno.jsonc",
    "/repo/Cargo.toml",
  ]);
});

Deno.test("collectInSourceSuppressions - records carry the declaring file and line", async () => {
  const files: Record<string, string> = {
    "/repo/deno.jsonc": [
      "{",
      '  "imports": {',
      "    // orphan-deps-ignore: BP-aaaaaaaaaaaa — author=nigel expires=2999-01-01 finished lib",
      '    "left-pad": "npm:left-pad@1.3.0"',
      "  }",
      "}",
    ].join("\n"),
    "/repo/Cargo.toml": [
      "[dependencies]",
      "# best-practice-ignore: BP-bbbbbbbbbbbb — author=nigel expires=2999-01-01 archived",
      'serde = "1.0"',
    ].join("\n"),
  };
  const read = (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(text);
  };

  const records = await collectInSourceSuppressions("/repo", {
    readTextFileFn: read,
  });
  assertEquals(
    records.map((r) => ({ id: r.id, file: r.file, line: r.line })),
    [
      { id: "BP-aaaaaaaaaaaa", file: "deno.jsonc", line: 3 },
      { id: "BP-bbbbbbbbbbbb", file: "Cargo.toml", line: 2 },
    ],
  );
});

Deno.test("collectInSourceSuppressions - same id and line in two manifests registers both records", async () => {
  // Identically-positioned markers for one finding id, declared in two
  // different manifests. Both must survive the process registry's
  // file:line:id dedup key — otherwise an ungoverned duplicate hides
  // behind a governed one (Issue #3948).
  const marker =
    "// orphan-deps-ignore: BP-aaaaaaaaaaaa — author=nigel expires=2999-01-01 finished lib";
  const files: Record<string, string> = {
    "/repo/deno.json": ["{", `  ${marker}`, "}"].join("\n"),
    "/repo/deno.jsonc": ["{", `  ${marker}`, "}"].join("\n"),
  };
  const read = (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(text);
  };

  resetSuppressionRegistry();
  const records = await collectInSourceSuppressions("/repo", {
    readTextFileFn: read,
  });
  assertEquals(
    records.map((r) => ({ id: r.id, file: r.file, line: r.line })),
    [
      { id: "BP-aaaaaaaaaaaa", file: "deno.json", line: 2 },
      { id: "BP-aaaaaaaaaaaa", file: "deno.jsonc", line: 2 },
    ],
  );

  const registered = recordedSuppressions();
  assertEquals(registered.length, 2);
  assertEquals(registered.map((r) => r.file), ["deno.json", "deno.jsonc"]);

  const report = renderSuppressionSummary();
  assertStringIncludes(report, "deno.json:2");
  assertStringIncludes(report, "deno.jsonc:2");
  assert(
    !report.includes("<unknown>"),
    `report must name each manifest, got: ${report}`,
  );
  resetSuppressionRegistry();
});

Deno.test("collectInSourceSuppressedIds - a marker inside a Cargo.toml string value does not suppress", async () => {
  const cargoToml = [
    "[package]",
    'description = "# orphan-deps-ignore: BP-cccccccccccc — author=mallory expires=2999-01-01 sneaky"',
  ].join("\n");
  const read = (path: string): Promise<string> =>
    path.endsWith("/Cargo.toml")
      ? Promise.resolve(cargoToml)
      : Promise.reject(new Error("ENOENT"));

  assertEquals(
    await collectInSourceSuppressedIds("/repo", { readTextFileFn: read }),
    [],
  );
});

Deno.test("ORPHAN_DEPS_MANIFESTS - strict-JSON and generated lockfiles declare no comment grammar", () => {
  const grammarOf = (name: string) =>
    ORPHAN_DEPS_MANIFESTS.find((m) => m.name === name)?.grammar;

  for (
    const name of [
      "deno.lock",
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "Cargo.lock",
    ]
  ) {
    assertEquals(grammarOf(name), "none", `${name} must declare no grammar`);
  }
  assertEquals(grammarOf("deno.json"), "slash");
  assertEquals(grammarOf("deno.jsonc"), "slash");
  assertEquals(grammarOf("Cargo.toml"), "hash");
});

Deno.test("collectInSourceSuppressedIds - manifest allow-list covers the core ecosystems", () => {
  // The inventory surface the prompt's Phase 1 walks.
  for (
    const name of [
      "deno.json",
      "package.json",
      "Cargo.toml",
    ]
  ) {
    assert(
      ORPHAN_DEPS_MANIFEST_FILES.includes(name),
      `expected ${name} in the manifest allow-list`,
    );
  }
});

// ---------------------------------------------------------------------------
// Input caps (Issue #3942)
// ---------------------------------------------------------------------------

Deno.test("collectInSourceSuppressedIds - a marker past the manifest cap does not suppress", async () => {
  _resetSuppressionAuthorAllowlist();
  setSuppressionAuthorAllowlist(["nigel"]);
  resetSuppressionRegistry();
  try {
    const marker =
      "// orphan-deps-ignore: BP-aaaaaaaaaaaa — author=nigel expires=2099-12-31 padded\n";
    const files: Record<string, string> = {
      "/repo/deno.jsonc": "{\n" + "// filler\n".repeat(
        Math.ceil(MAX_MANIFEST_SCAN_CHARS / 10),
      ) + marker + "}",
    };
    const read = (path: string): Promise<string> => {
      const text = files[path];
      if (text === undefined) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(text);
    };

    // Unread text cannot waive anything — the fail-safe direction.
    assertEquals(
      await collectInSourceSuppressedIds("/repo", { readTextFileFn: read }),
      [],
    );
  } finally {
    _resetSuppressionAuthorAllowlist();
    resetSuppressionRegistry();
  }
});

Deno.test("collectInSourceSuppressedIds - a manifest of long unterminated block comments is bounded", async () => {
  _resetSuppressionAuthorAllowlist();
  setSuppressionAuthorAllowlist(["nigel"]);
  resetSuppressionRegistry();
  try {
    // The issue's trigger: a fork PR adding long lines that open a marker
    // comment and never close it. Pre-fix this was O(n³) per line.
    const hostile = Array.from(
      { length: 100 },
      () => "/* orphan-deps-ignore: BP-a" + " ".repeat(5_000),
    ).join("\n");
    const read = (path: string): Promise<string> =>
      path === "/repo/deno.jsonc"
        ? Promise.resolve(hostile)
        : Promise.reject(new Error("ENOENT"));

    const started = performance.now();
    assertEquals(
      await collectInSourceSuppressedIds("/repo", { readTextFileFn: read }),
      [],
    );
    const ms = performance.now() - started;
    assert(ms < 3_000, `took ${ms.toFixed(0)} ms, expected < 3000`);
  } finally {
    _resetSuppressionAuthorAllowlist();
    resetSuppressionRegistry();
  }
});
