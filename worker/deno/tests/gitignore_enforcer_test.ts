/**
 * Tests for the .gitignore enforcer (Issue #1757, part of #1751).
 *
 * Verifies that `ensureGitignorePatterns()` idempotently appends the
 * canonical Vibe Coder safety patterns to a monitored repo's `.gitignore`,
 * with an explicit allowlist for `.gitignore`, `.github/`, and
 * `.markdownlint-cli2.jsonc`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  ensureGitignorePatterns,
  REQUIRED_GITIGNORE_PATTERNS,
  VIBE_CODER_BLOCK_MARKER,
} from "../lib/gitignore_enforcer.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "gitignore_enforcer_test_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function readGitignore(dir: string): Promise<string> {
  return await Deno.readTextFile(`${dir}/.gitignore`);
}

async function initGitRepo(dir: string): Promise<void> {
  const env = {
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  for (
    const args of [
      ["init", "-q"],
      ["config", "commit.gpgsign", "false"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "test"],
    ]
  ) {
    const cmd = new Deno.Command("git", { args, cwd: dir, env });
    const result = await cmd.output();
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed`);
    }
  }
}

async function gitCheckIgnore(dir: string, path: string): Promise<boolean> {
  const cmd = new Deno.Command("git", {
    args: ["check-ignore", "-q", path],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  // Exit 0 = ignored, 1 = not ignored, others = error.
  return result.code === 0;
}

// ---------------------------------------------------------------------------
// REQUIRED_GITIGNORE_PATTERNS — canonical pattern set
// ---------------------------------------------------------------------------

Deno.test("REQUIRED_GITIGNORE_PATTERNS - contains hidden-files defence in depth set", () => {
  const expected = [
    ".*",
    "!.gitignore",
    "!.github",
    "!.vscode",
    "!.markdownlint-cli2.jsonc",
    "!.gitattributes",
    ".config.json",
    ".config*.json",
    "*.secret.json",
    ".secrets/",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_rsa.*",
    "credentials.json",
    "service-account*.json",
  ];
  assertEquals([...REQUIRED_GITIGNORE_PATTERNS], expected);
});

Deno.test("ensureGitignorePatterns - ignores private key material (Issue #3660)", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    for (
      const path of [
        "server.pem",
        "certs/server.pem",
        "private.key",
        "cert.p12",
        "cert.pfx",
        "id_rsa",
        "id_rsa.pub",
        "credentials.json",
        "service-account-prod.json",
      ]
    ) {
      assert(
        await gitCheckIgnore(dir, path),
        `expected '${path}' to be ignored`,
      );
    }
  });
});

Deno.test("ensureGitignorePatterns - key patterns do not over-match ordinary files (Issue #3660)", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    for (
      const path of [
        "README.md",
        "src/keyboard.ts",
        "docs/keys.md",
        "package.json",
        "src/id_rsa_helper.ts",
      ]
    ) {
      assertEquals(
        await gitCheckIgnore(dir, path),
        false,
        `expected '${path}' not to be ignored`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path — empty .gitignore receives the full block
// ---------------------------------------------------------------------------

Deno.test("ensureGitignorePatterns - creates .gitignore when missing", async () => {
  await withTempDir(async (dir) => {
    const result = await ensureGitignorePatterns(dir);
    assert(
      result.ok,
      `expected ok, got: ${!result.ok && result.error.message}`,
    );
    assertEquals(result.value.added.length, REQUIRED_GITIGNORE_PATTERNS.length);
    assertEquals(result.value.existed.length, 0);

    const content = await readGitignore(dir);
    assert(content.includes(VIBE_CODER_BLOCK_MARKER));
    for (const pattern of REQUIRED_GITIGNORE_PATTERNS) {
      assert(content.includes(pattern), `missing pattern: ${pattern}`);
    }
  });
});

Deno.test("ensureGitignorePatterns - empty .gitignore gets the full block appended", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/.gitignore`, "");
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);
    assertEquals(result.value.added.length, REQUIRED_GITIGNORE_PATTERNS.length);
    const content = await readGitignore(dir);
    assert(content.includes(VIBE_CODER_BLOCK_MARKER));
  });
});

// ---------------------------------------------------------------------------
// Idempotency — running twice produces identical output
// ---------------------------------------------------------------------------

Deno.test("ensureGitignorePatterns - idempotent: running twice produces identical content", async () => {
  await withTempDir(async (dir) => {
    const first = await ensureGitignorePatterns(dir);
    assert(first.ok);
    const afterFirst = await readGitignore(dir);

    const second = await ensureGitignorePatterns(dir);
    assert(second.ok);
    const afterSecond = await readGitignore(dir);

    assertEquals(afterFirst, afterSecond);
    assertEquals(second.value.added.length, 0);
    assertEquals(
      second.value.existed.length,
      REQUIRED_GITIGNORE_PATTERNS.length,
    );
  });
});

Deno.test("ensureGitignorePatterns - no duplicate lines after multiple runs", async () => {
  await withTempDir(async (dir) => {
    await ensureGitignorePatterns(dir);
    await ensureGitignorePatterns(dir);
    await ensureGitignorePatterns(dir);
    const content = await readGitignore(dir);
    // Each canonical pattern must appear exactly once.
    for (const pattern of REQUIRED_GITIGNORE_PATTERNS) {
      const occurrences = content.split("\n").filter((line) =>
        line === pattern
      ).length;
      assertEquals(
        occurrences,
        1,
        `pattern '${pattern}' appears ${occurrences} time(s)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Existing patterns preserved
// ---------------------------------------------------------------------------

Deno.test("ensureGitignorePatterns - preserves pre-existing user content above and below", async () => {
  await withTempDir(async (dir) => {
    const original = [
      "# user header comment",
      "node_modules/",
      "dist/",
      "",
      "# another section",
      "*.log",
      "",
    ].join("\n");
    await Deno.writeTextFile(`${dir}/.gitignore`, original);

    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    const content = await readGitignore(dir);
    assert(content.startsWith(original), "user header not preserved verbatim");
    assert(content.includes("node_modules/"));
    assert(content.includes("dist/"));
    assert(content.includes("*.log"));
    assert(content.includes(VIBE_CODER_BLOCK_MARKER));
  });
});

Deno.test("ensureGitignorePatterns - already-present patterns counted as existed not added", async () => {
  await withTempDir(async (dir) => {
    // Pre-populate with two canonical patterns so they must be detected.
    await Deno.writeTextFile(`${dir}/.gitignore`, ".env\n.config.json\n");

    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    assert(result.value.existed.includes(".env"));
    assert(result.value.existed.includes(".config.json"));
    assert(!result.value.added.includes(".env"));
    assert(!result.value.added.includes(".config.json"));

    // The remaining patterns must have been added.
    const content = await readGitignore(dir);
    for (const pattern of REQUIRED_GITIGNORE_PATTERNS) {
      assert(content.includes(pattern), `missing pattern: ${pattern}`);
    }
    // No duplicate lines for the pre-existing entries.
    assertEquals(content.split("\n").filter((l) => l === ".env").length, 1);
    assertEquals(
      content.split("\n").filter((l) => l === ".config.json").length,
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Allowlist works — .github content remains tracked, .env stays ignored
// ---------------------------------------------------------------------------

Deno.test("ensureGitignorePatterns - .github/workflows/foo.yml is NOT ignored after enforcement", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    // Write the file inside the working tree so check-ignore can resolve it.
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/foo.yml`,
      "name: foo\n",
    );

    const ignored = await gitCheckIgnore(dir, ".github/workflows/foo.yml");
    assertEquals(
      ignored,
      false,
      ".github/workflows/foo.yml should remain tracked",
    );
  });
});

Deno.test("ensureGitignorePatterns - .env IS ignored after enforcement", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    await Deno.writeTextFile(`${dir}/.env`, "SECRET=1\n");
    const ignored = await gitCheckIgnore(dir, ".env");
    assertEquals(ignored, true, ".env should be ignored");
  });
});

Deno.test("ensureGitignorePatterns - .config.production.json IS ignored after enforcement", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    await Deno.writeTextFile(`${dir}/.config.production.json`, "{}\n");
    const ignored = await gitCheckIgnore(dir, ".config.production.json");
    assertEquals(ignored, true, ".config.production.json should be ignored");
  });
});

Deno.test("ensureGitignorePatterns - .gitignore itself is NOT ignored", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    const ignored = await gitCheckIgnore(dir, ".gitignore");
    assertEquals(ignored, false, ".gitignore must remain trackable");
  });
});

Deno.test("ensureGitignorePatterns - .vibecoder.json IS ignored (Issue #2626)", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    await Deno.writeTextFile(`${dir}/.vibecoder.json`, "{}\n");
    const ignored = await gitCheckIgnore(dir, ".vibecoder.json");
    assertEquals(
      ignored,
      true,
      ".vibecoder.json must be ignored — in-repo config was removed",
    );
  });
});

Deno.test("root .gitignore - does not re-allow .vibecoder.json (Issue #3168)", async () => {
  // Regression: the committed root .gitignore must not carry a stale
  // `!.vibecoder.json` re-allow rule. Issue #2626 removed the in-repo config
  // mechanism, so `.vibecoder.json` must once again be a forbidden hidden path.
  const rootGitignore = new URL("../../../.gitignore", import.meta.url);
  const contents = await Deno.readTextFile(rootGitignore);

  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    await Deno.writeTextFile(`${dir}/.gitignore`, contents);
    await Deno.writeTextFile(`${dir}/.vibecoder.json`, "{}\n");

    const ignored = await gitCheckIgnore(dir, ".vibecoder.json");
    assertEquals(
      ignored,
      true,
      "root .gitignore must ignore .vibecoder.json — the stale !.vibecoder.json re-allow rule must be removed",
    );
  });
});

Deno.test("root .gitignore - ignores private key material (Issue #3660)", async () => {
  // The `.*` rule covers hidden files only; these filenames are not hidden.
  const rootGitignore = new URL("../../../.gitignore", import.meta.url);
  const contents = await Deno.readTextFile(rootGitignore);

  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    await Deno.writeTextFile(`${dir}/.gitignore`, contents);

    for (
      const path of [
        "github-app.pem",
        "certs/server.pem",
        "private.key",
        "cert.p12",
        "cert.pfx",
        "id_rsa",
        "id_rsa.pub",
        "credentials.json",
        "service-account-prod.json",
      ]
    ) {
      assertEquals(
        await gitCheckIgnore(dir, path),
        true,
        `root .gitignore must ignore '${path}'`,
      );
    }

    // …without swallowing ordinary tracked files.
    for (const path of ["README.md", "src/keyboard.ts", "package.json"]) {
      assertEquals(
        await gitCheckIgnore(dir, path),
        false,
        `root .gitignore must not ignore '${path}'`,
      );
    }
  });
});

Deno.test("ensureGitignorePatterns - .markdownlint-cli2.jsonc is NOT ignored", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    await Deno.writeTextFile(`${dir}/.markdownlint-cli2.jsonc`, "{}\n");
    const ignored = await gitCheckIgnore(dir, ".markdownlint-cli2.jsonc");
    assertEquals(
      ignored,
      false,
      ".markdownlint-cli2.jsonc must remain trackable",
    );
  });
});

Deno.test("ensureGitignorePatterns - .gitattributes is NOT ignored", async () => {
  await withTempDir(async (dir) => {
    await initGitRepo(dir);
    const result = await ensureGitignorePatterns(dir);
    assert(result.ok);

    await Deno.writeTextFile(`${dir}/.gitattributes`, "* text=auto\n");
    const ignored = await gitCheckIgnore(dir, ".gitattributes");
    assertEquals(ignored, false, ".gitattributes must remain trackable");
  });
});
