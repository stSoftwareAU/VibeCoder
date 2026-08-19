/**
 * Tests for the `.gitattributes` enforcer (Issue #2339, part of #2332).
 *
 * Verifies that `ensureGitattributesPatterns()` idempotently appends the
 * canonical line-ending and binary-marker block to a monitored repo's
 * `.gitattributes`, preserving any pre-existing user rules verbatim.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  ensureGitattributesPatterns,
  REQUIRED_GITATTRIBUTES_LINES,
  VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER,
  VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER,
} from "../lib/gitignore_enforcer.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "gitattributes_enforcer_test_",
  });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function readGitattributes(dir: string): Promise<string> {
  return await Deno.readTextFile(`${dir}/.gitattributes`);
}

async function readGitattributesBytes(dir: string): Promise<Uint8Array> {
  return await Deno.readFile(`${dir}/.gitattributes`);
}

// ---------------------------------------------------------------------------
// REQUIRED_GITATTRIBUTES_LINES — canonical line set
// ---------------------------------------------------------------------------

Deno.test("REQUIRED_GITATTRIBUTES_LINES - contains text-auto, LF text, CRLF Windows, and binary markers", () => {
  const expected = [
    "* text=auto",
    "*.sh text eol=lf",
    "*.bash text eol=lf",
    "*.py text eol=lf",
    "*.yaml text eol=lf",
    "*.yml text eol=lf",
    "*.json text eol=lf",
    "*.bat text eol=crlf",
    "*.cmd text eol=crlf",
    "*.png binary",
    "*.jpg binary",
    "*.jpeg binary",
    "*.gif binary",
    "*.ico binary",
    "*.pdf binary",
    "*.zip binary",
    "*.gz binary",
    "*.tar binary",
    "*.woff binary",
    "*.woff2 binary",
    "*.ttf binary",
    "*.otf binary",
    "*.eot binary",
  ];
  assertEquals([...REQUIRED_GITATTRIBUTES_LINES], expected);
});

// ---------------------------------------------------------------------------
// Happy path — missing or empty file gets the full block
// ---------------------------------------------------------------------------

Deno.test("ensureGitattributesPatterns - creates .gitattributes when missing", async () => {
  await withTempDir(async (dir) => {
    const result = await ensureGitattributesPatterns(dir);
    assert(
      result.ok,
      `expected ok, got: ${!result.ok && result.error.message}`,
    );
    assertEquals(
      result.value.added.length,
      REQUIRED_GITATTRIBUTES_LINES.length,
    );
    assertEquals(result.value.existed.length, 0);

    const content = await readGitattributes(dir);
    assert(content.includes(VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER));
    assert(content.includes(VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER));
    for (const line of REQUIRED_GITATTRIBUTES_LINES) {
      assert(content.includes(line), `missing line: ${line}`);
    }
  });
});

Deno.test("ensureGitattributesPatterns - empty .gitattributes gets the full block appended", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/.gitattributes`, "");
    const result = await ensureGitattributesPatterns(dir);
    assert(result.ok);
    assertEquals(
      result.value.added.length,
      REQUIRED_GITATTRIBUTES_LINES.length,
    );
    const content = await readGitattributes(dir);
    assert(content.includes(VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER));
  });
});

// ---------------------------------------------------------------------------
// Idempotency — running twice/three times yields no duplicates
// ---------------------------------------------------------------------------

Deno.test("ensureGitattributesPatterns - idempotent: running twice produces identical content", async () => {
  await withTempDir(async (dir) => {
    const first = await ensureGitattributesPatterns(dir);
    assert(first.ok);
    const afterFirst = await readGitattributes(dir);

    const second = await ensureGitattributesPatterns(dir);
    assert(second.ok);
    const afterSecond = await readGitattributes(dir);

    assertEquals(afterFirst, afterSecond);
    assertEquals(second.value.added.length, 0);
    assertEquals(
      second.value.existed.length,
      REQUIRED_GITATTRIBUTES_LINES.length,
    );
  });
});

Deno.test("ensureGitattributesPatterns - no duplicate lines after three runs", async () => {
  await withTempDir(async (dir) => {
    await ensureGitattributesPatterns(dir);
    await ensureGitattributesPatterns(dir);
    await ensureGitattributesPatterns(dir);
    const content = await readGitattributes(dir);
    for (const line of REQUIRED_GITATTRIBUTES_LINES) {
      const occurrences = content.split("\n").filter((l) => l === line).length;
      assertEquals(
        occurrences,
        1,
        `line '${line}' appears ${occurrences} time(s)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Merge with existing custom rules — never clobber (#2332 Round 2 Q2)
// ---------------------------------------------------------------------------

Deno.test("ensureGitattributesPatterns - preserves pre-existing user rules verbatim above the block", async () => {
  await withTempDir(async (dir) => {
    const original = [
      "# project-specific attributes",
      "*.md text eol=lf",
      "*.rs text=auto",
      "Cargo.lock merge=binary",
      "",
    ].join("\n");
    await Deno.writeTextFile(`${dir}/.gitattributes`, original);

    const result = await ensureGitattributesPatterns(dir);
    assert(result.ok);

    const content = await readGitattributes(dir);
    assert(content.startsWith(original), "user rules not preserved verbatim");
    assert(content.includes("*.md text eol=lf"));
    assert(content.includes("*.rs text=auto"));
    assert(content.includes("Cargo.lock merge=binary"));
    assert(content.includes(VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER));
  });
});

// ---------------------------------------------------------------------------
// Partial overlap — only the missing canonical lines are appended
// ---------------------------------------------------------------------------

Deno.test("ensureGitattributesPatterns - partial overlap: only missing lines appended, present count as existed", async () => {
  await withTempDir(async (dir) => {
    // Pre-populate with two canonical lines.
    await Deno.writeTextFile(
      `${dir}/.gitattributes`,
      "* text=auto\n*.sh text eol=lf\n",
    );

    const result = await ensureGitattributesPatterns(dir);
    assert(result.ok);

    assert(result.value.existed.includes("* text=auto"));
    assert(result.value.existed.includes("*.sh text eol=lf"));
    assert(!result.value.added.includes("* text=auto"));
    assert(!result.value.added.includes("*.sh text eol=lf"));
    // The remaining canonical lines must have been added.
    assertEquals(
      result.value.added.length + result.value.existed.length,
      REQUIRED_GITATTRIBUTES_LINES.length,
    );

    const content = await readGitattributes(dir);
    for (const line of REQUIRED_GITATTRIBUTES_LINES) {
      assert(content.includes(line), `missing line: ${line}`);
    }
    // No duplicate lines for the pre-existing entries.
    assertEquals(
      content.split("\n").filter((l) => l === "* text=auto").length,
      1,
    );
    assertEquals(
      content.split("\n").filter((l) => l === "*.sh text eol=lf").length,
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Line-ending preservation — file written with LF on disk
// ---------------------------------------------------------------------------

Deno.test("ensureGitattributesPatterns - writes LF line endings on disk (no CRLF in canonical block)", async () => {
  await withTempDir(async (dir) => {
    const result = await ensureGitattributesPatterns(dir);
    assert(result.ok);
    const bytes = await readGitattributesBytes(dir);
    // No 0x0D (CR) byte anywhere — every line break must be a bare LF.
    for (let i = 0; i < bytes.length; i++) {
      assert(
        bytes[i] !== 0x0D,
        `CR byte found at offset ${i}; .gitattributes must be LF-only`,
      );
    }
  });
});

Deno.test(
  "ensureGitattributesPatterns - existing CRLF file: canonical lines detected via trimmed equality",
  async () => {
    await withTempDir(async (dir) => {
      // Some hosts (Windows checkouts) save with CRLF — the comparator must
      // still recognise canonical lines so we do not re-append them.
      await Deno.writeTextFile(
        `${dir}/.gitattributes`,
        "* text=auto\r\n*.sh text eol=lf\r\n",
      );
      const result = await ensureGitattributesPatterns(dir);
      assert(result.ok);
      assert(result.value.existed.includes("* text=auto"));
      assert(result.value.existed.includes("*.sh text eol=lf"));
      assert(!result.value.added.includes("* text=auto"));
    });
  },
);
