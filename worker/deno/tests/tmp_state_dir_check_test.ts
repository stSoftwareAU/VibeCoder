/**
 * Quality-gate check: no worker state directory is composed by raw
 * `TMPDIR`/`/tmp` interpolation (Issue #1242, SEC-1215-06).
 *
 * Issue #1215 moved the three file-backed caches onto `sharedTmpStateDir()`,
 * but five further state directories kept building their path by hand — the
 * label cache, the Playwright MCP config, the audit journal, the repo failure
 * counters and the browser profile. The helper alone cannot keep the class
 * fixed, so this check fails the build on a new raw interpolation.
 *
 * The scanning functions are pure, so these tests drive them with literal
 * file content rather than by grepping the tree.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  scanContentForSharedTmpPath,
  scanDirectoriesForSharedTmpPath,
  TMP_STATE_DIR_ALLOWLIST,
} from "../lib/tmp_state_dir_check.ts";

/** Repo-relative path used for content-level cases. */
const FILE = "worker/deno/lib/example.ts";

Deno.test("tmp state dir check - flags an inline TMPDIR read composing a child path", () => {
  const content = [
    "const cacheDir = deps.cacheDir ??",
    '  `${Deno.env.get("TMPDIR") ?? "/tmp"}/vibe-label-cache`;',
  ].join("\n");

  const violations = scanContentForSharedTmpPath(content, FILE);

  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.file, FILE);
  assertEquals(violations[0]?.line, 2);
});

Deno.test("tmp state dir check - flags a tmp root held in a local variable", () => {
  const content = [
    'const tmp = env("TMPDIR") ?? "/tmp";',
    "return `${tmp}/vibe-audit`;",
  ].join("\n");

  const violations = scanContentForSharedTmpPath(content, FILE);

  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
});

Deno.test("tmp state dir check - flags a tmp root reached through a method call", () => {
  const content = [
    'const tmp = env("TMPDIR", lookup) ?? env("TEMP", lookup) ??',
    '  env("TMP", lookup) ?? "/tmp";',
    'return `${tmp.replace(/[\\\\/]+$/, "")}/vibe-playwright-mcp`;',
  ].join("\n");

  const violations = scanContentForSharedTmpPath(content, FILE);

  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 3);
});

Deno.test("tmp state dir check - flags an interpolation split across lines", () => {
  const content = [
    "const repoFailureFile = `${",
    '  env("TMPDIR") ?? "/tmp"',
    "}/vibe-repo-failures-${Deno.pid}`;",
  ].join("\n");

  const violations = scanContentForSharedTmpPath(content, FILE);

  assertEquals(violations.length, 1);
  // Reported where the path segment lands, so the message points at the name.
  assertEquals(violations[0]?.line, 3);
});

Deno.test("tmp state dir check - flags a fixed /tmp literal naming a state dir", () => {
  const withConstant = "return `/tmp/${BROWSER_PROFILE_DIR_NAME}`;";
  const withName = 'const dir = "/tmp/vibe-playwright-profile";';

  assertEquals(scanContentForSharedTmpPath(withConstant, FILE).length, 1);
  assertEquals(scanContentForSharedTmpPath(withName, FILE).length, 1);
});

Deno.test("tmp state dir check - accepts the shared helper", () => {
  const content = [
    'import { sharedTmpStateDir } from "./private_cache_dir.ts";',
    'const dir = sharedTmpStateDir("vibe-label-cache", lookup);',
    "await ensurePrivateDir(dir);",
  ].join("\n");

  assertEquals(scanContentForSharedTmpPath(content, FILE), []);
});

Deno.test("tmp state dir check - a bare tmp root with no child segment is not a state dir", () => {
  const content = [
    'const tmp = Deno.env.get("TMPDIR") ?? "/tmp";',
    "return tmp.replace(/\\/+$/, '');",
  ].join("\n");

  assertEquals(scanContentForSharedTmpPath(content, FILE), []);
});

Deno.test("tmp state dir check - prose describing the fault is not a violation", () => {
  const content = [
    "/**",
    " * The old default was `${TMPDIR}/vibe-audit` — one path for every",
    " * account on the host.",
    " */",
    'const dir = sharedTmpStateDir("vibe-audit");',
    "// return `${tmp}/vibe-audit`;",
  ].join("\n");

  assertEquals(scanContentForSharedTmpPath(content, FILE), []);
});

Deno.test("tmp state dir check - the helper's own module is allowlisted", () => {
  assert(TMP_STATE_DIR_ALLOWLIST.has("worker/deno/lib/private_cache_dir.ts"));
});

Deno.test("tmp state dir check - scans a directory tree and skips test files", async () => {
  const root = await Deno.makeTempDir({ prefix: "tmp-state-dir-check-" });
  try {
    await Deno.mkdir(`${root}/worker/deno/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/worker/deno/lib/offender.ts`,
      'const dir = `${Deno.env.get("TMPDIR")}/vibe-thing`;\n',
    );
    await Deno.writeTextFile(
      `${root}/worker/deno/lib/offender_test.ts`,
      'const dir = `${Deno.env.get("TMPDIR")}/vibe-fixture`;\n',
    );
    await Deno.writeTextFile(
      `${root}/worker/deno/lib/clean.ts`,
      'const dir = sharedTmpStateDir("vibe-thing");\n',
    );

    const result = await scanDirectoriesForSharedTmpPath(root, [
      "worker/deno/lib",
    ]);

    assertEquals(result.filesScanned, 2);
    assertEquals(result.violations.length, 1);
    assertEquals(result.violations[0]?.file, "worker/deno/lib/offender.ts");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("tmp state dir check - the production tree is clean", async () => {
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );

  const result = await scanDirectoriesForSharedTmpPath(repoRoot, [
    "worker/deno/lib",
    "worker/deno/commands",
    "worker/deno/setup",
  ]);

  assertEquals(
    result.violations.map((v) => `${v.file}:${v.line}: ${v.text}`),
    [],
  );
  assert(result.filesScanned > 0, "expected files to be scanned");
});
