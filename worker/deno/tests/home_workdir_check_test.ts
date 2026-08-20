/**
 * Tests for the host work-dir guard static check (Issue #135, parent #118).
 *
 * Behavioural tests against literal inputs for the pure scanning functions in
 * `lib/home_workdir_check.ts` — detection of every known construction shape,
 * comment tolerance, allowlist counting, and stale-allowlist reporting. The
 * scan of the real repository tree (the check that turns red if a HOME-derived
 * work-dir default is reintroduced) lives in `host_workdir_guard_test.ts`.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  HOME_WORKDIR_ALLOWLIST,
  scanContentForHomeWorkDir,
  scanDirectoriesForHomeWorkDir,
} from "../lib/home_workdir_check.ts";

// ---------------------------------------------------------------------------
// scanContentForHomeWorkDir — detection shapes
// ---------------------------------------------------------------------------

Deno.test("home_workdir_check - detects the env-get HOME fallback", () => {
  const content = [
    'const workDir = Deno.env.get("WORK_DIR") ??',
    '  `${Deno.env.get("HOME") ?? ""}/auto-issue-work`;',
  ].join("\n");
  const hits = scanContentForHomeWorkDir(content, "worker/deno/lib/x.ts");
  assertEquals(hits.length, 1);
  assertEquals(hits[0]?.line, 2);
});

Deno.test("home_workdir_check - detects the USERPROFILE fallback", () => {
  const content =
    'const d = `${env("HOME") ?? env("USERPROFILE") ?? "."}/auto-issue-work`;';
  const hits = scanContentForHomeWorkDir(content, "worker/deno/lib/x.ts");
  assertEquals(hits.length, 1);
});

Deno.test("home_workdir_check - detects a home variable interpolation", () => {
  const hits = scanContentForHomeWorkDir(
    "const workDir = `${home}/auto-issue-work`;",
    "worker/deno/lib/x.ts",
  );
  assertEquals(hits.length, 1);
});

Deno.test("home_workdir_check - detects a renamed-base interpolation", () => {
  // The base variable no longer mentions "home" at all — the interpolated
  // prefix shape still catches it.
  const hits = scanContentForHomeWorkDir(
    "const workDir = `${base}/auto-issue-work`;",
    "worker/deno/lib/x.ts",
  );
  assertEquals(hits.length, 1);
});

Deno.test("home_workdir_check - detects the joinPath spelling", () => {
  const hits = scanContentForHomeWorkDir(
    'const d = joinPath(home, "auto-issue-work", style);',
    "worker/deno/lib/x.ts",
  );
  assertEquals(hits.length, 1);
});

Deno.test("home_workdir_check - approval-state sibling is caught by the same prefix", () => {
  const hits = scanContentForHomeWorkDir(
    "const store = `${home}/auto-issue-work-approval-state`;",
    "worker/deno/lib/x.ts",
  );
  assertEquals(hits.length, 1);
});

// ---------------------------------------------------------------------------
// scanContentForHomeWorkDir — tolerance
// ---------------------------------------------------------------------------

Deno.test("home_workdir_check - ignores block comments", () => {
  const content = [
    "/**",
    ' * The old fallback was `${env("HOME")}/auto-issue-work` — removed',
    " * (Issue #131).",
    " */",
    'const d = env("WORK_DIR");',
  ].join("\n");
  assertEquals(
    scanContentForHomeWorkDir(content, "worker/deno/lib/x.ts"),
    [],
  );
});

Deno.test("home_workdir_check - ignores line comments", () => {
  const content =
    'const d = env("WORK_DIR"); // never `${home}/auto-issue-work` (Issue #118)';
  assertEquals(
    scanContentForHomeWorkDir(content, "worker/deno/lib/x.ts"),
    [],
  );
});

Deno.test("home_workdir_check - a plain WORK_DIR read is clean", () => {
  const content = [
    'const workDir = Deno.env.get("WORK_DIR");',
    "const cache = workDir ? `${workDir}/.vibe-cache` : undefined;",
  ].join("\n");
  assertEquals(
    scanContentForHomeWorkDir(content, "worker/deno/lib/x.ts"),
    [],
  );
});

// ---------------------------------------------------------------------------
// scanDirectoriesForHomeWorkDir — allowlist behaviour (fixture directories)
// ---------------------------------------------------------------------------

async function withFixtureTree(
  files: Record<string, string>,
  allowlist: ReadonlyMap<string, number>,
): Promise<
  { violations: number; stale: number; violationFiles: string[] }
> {
  const root = await Deno.makeTempDir({ prefix: "home_workdir_check_" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = `${root}/${rel}`;
      await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(abs, content);
    }
    const result = await scanDirectoriesForHomeWorkDir(
      root,
      ["src"],
      allowlist,
    );
    return {
      violations: result.violations.length,
      stale: result.staleAllowlist.length,
      violationFiles: result.violations.map((v) => v.file),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const FALLBACK_LINE =
  'const d = Deno.env.get("WORK_DIR") ?? `${Deno.env.get("HOME") ?? ""}/auto-issue-work`;\n';

Deno.test("home_workdir_check - a non-allowlisted file is a violation", async () => {
  const r = await withFixtureTree(
    { "src/bad.ts": FALLBACK_LINE },
    new Map(),
  );
  assertEquals(r.violations, 1);
  assertEquals(r.violationFiles, ["src/bad.ts"]);
});

Deno.test("home_workdir_check - an allowlisted file at its recorded count is clean", async () => {
  const r = await withFixtureTree(
    { "src/ok.ts": FALLBACK_LINE },
    new Map([["src/ok.ts", 1]]),
  );
  assertEquals(r.violations, 0);
  assertEquals(r.stale, 0);
});

Deno.test("home_workdir_check - an EXTRA construction in an allowlisted file is a violation", async () => {
  const r = await withFixtureTree(
    { "src/ok.ts": FALLBACK_LINE + FALLBACK_LINE },
    new Map([["src/ok.ts", 1]]),
  );
  // Both hits in the file are surfaced so the reviewer sees the candidates.
  assertEquals(r.violations, 2);
});

Deno.test("home_workdir_check - a stale allowlist entry is reported", async () => {
  const r = await withFixtureTree(
    { "src/clean.ts": 'const d = Deno.env.get("WORK_DIR");\n' },
    new Map([["src/clean.ts", 1]]),
  );
  assertEquals(r.violations, 0);
  assertEquals(r.stale, 1);
});

Deno.test("home_workdir_check - tests directories are skipped", async () => {
  const r = await withFixtureTree(
    { "src/tests/fixture.ts": FALLBACK_LINE },
    new Map(),
  );
  assertEquals(r.violations, 0);
});

// ---------------------------------------------------------------------------
// The real allowlist
// ---------------------------------------------------------------------------

Deno.test("home_workdir_check - real allowlist entries all live under worker/deno", () => {
  for (const [file, count] of HOME_WORKDIR_ALLOWLIST) {
    assertEquals(
      file.startsWith("worker/deno/"),
      true,
      `${file} is outside worker/deno`,
    );
    assertEquals(count > 0, true, `${file} allows a nonsensical count`);
  }
});
