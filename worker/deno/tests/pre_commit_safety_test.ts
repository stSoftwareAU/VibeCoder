/**
 * Tests for the pre-commit safety gate (Issue #1758, part of #1751).
 *
 * Verifies that `inspectStagedFiles()` and `assertSafeToCommit()` refuse
 * to commit hidden or secret-bearing files staged via `git add`, and
 * that allowlisted hidden paths (from #1757's REQUIRED_GITIGNORE_PATTERNS)
 * pass through unharmed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  ALLOWED_HIDDEN_PATHS,
  assertSafeToCommit,
  classifyStagedPath,
  FORBIDDEN_STAGED_PATTERNS,
  inspectStagedFiles,
} from "../lib/pre_commit_safety.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function makeRepo(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "commit.gpgsign", "false"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "test"], dir);
  return dir;
}

async function stageFile(
  dir: string,
  relativePath: string,
  content = "x\n",
): Promise<void> {
  const fullPath = `${dir}/${relativePath}`;
  const lastSlash = fullPath.lastIndexOf("/");
  if (lastSlash > -1) {
    await Deno.mkdir(fullPath.slice(0, lastSlash), { recursive: true });
  }
  await Deno.writeTextFile(fullPath, content);
  // Use -f so .gitignore (if present) does not block the test from
  // staging — the safety gate is the layer being tested, not gitignore.
  await runGit(["add", "-f", "--", relativePath], dir);
}

// --- pure classification tests (no git required) ----------------------

Deno.test("classifyStagedPath - .env is a violation", () => {
  assertEquals(classifyStagedPath(".env"), "violation");
});

Deno.test("classifyStagedPath - .env.production is a violation", () => {
  assertEquals(classifyStagedPath(".env.production"), "violation");
});

Deno.test("classifyStagedPath - .env.local is a violation", () => {
  assertEquals(classifyStagedPath(".env.local"), "violation");
});

Deno.test("classifyStagedPath - .config.json is a violation", () => {
  assertEquals(classifyStagedPath(".config.json"), "violation");
});

Deno.test("classifyStagedPath - .config.local.json is a violation", () => {
  assertEquals(classifyStagedPath(".config.local.json"), "violation");
});

Deno.test("classifyStagedPath - foo.secret.json is a violation", () => {
  assertEquals(classifyStagedPath("foo.secret.json"), "violation");
});

Deno.test("classifyStagedPath - api-key.secret.json is a violation", () => {
  assertEquals(classifyStagedPath("api-key.secret.json"), "violation");
});

Deno.test("classifyStagedPath - .secrets/anything is a violation", () => {
  assertEquals(classifyStagedPath(".secrets/api.key"), "violation");
});

Deno.test("classifyStagedPath - hidden top-level file is a violation", () => {
  assertEquals(classifyStagedPath(".aws"), "violation");
  assertEquals(classifyStagedPath(".npmrc"), "violation");
  assertEquals(classifyStagedPath(".ssh/id_rsa"), "violation");
});

Deno.test("classifyStagedPath - .gitignore is allowed", () => {
  assertEquals(classifyStagedPath(".gitignore"), "safe");
});

Deno.test("classifyStagedPath - .github/workflows/ci.yml is allowed", () => {
  assertEquals(classifyStagedPath(".github/workflows/ci.yml"), "safe");
});

Deno.test("classifyStagedPath - .vibecoder.json is a violation (Issue #2626)", () => {
  // In-repo config was removed; the worker must no longer stage it.
  assertEquals(classifyStagedPath(".vibecoder.json"), "violation");
});

Deno.test("classifyStagedPath - .markdownlint-cli2.jsonc is allowed", () => {
  assertEquals(classifyStagedPath(".markdownlint-cli2.jsonc"), "safe");
});

Deno.test("classifyStagedPath - .gitattributes is allowed", () => {
  assertEquals(classifyStagedPath(".gitattributes"), "safe");
});

Deno.test("classifyStagedPath - private key material is a violation (Issue #3660)", () => {
  for (
    const path of [
      "server.pem",
      "certs/server.pem",
      "private.key",
      "deploy/cert.p12",
      "deploy/cert.pfx",
      "id_rsa",
      "id_rsa.pub",
      "keys/id_rsa",
      "credentials.json",
      "config/credentials.json",
      "service-account.json",
      "service-account-prod.json",
    ]
  ) {
    assertEquals(
      classifyStagedPath(path),
      "violation",
      `expected '${path}' to be a violation`,
    );
  }
});

Deno.test("classifyStagedPath - key patterns do not over-match ordinary files (Issue #3660)", () => {
  for (
    const path of [
      "src/keyboard.ts",
      "docs/keys.md",
      "src/id_rsa_helper.ts",
      "package.json",
      "worker/deno/lib/pem_parser.ts",
    ]
  ) {
    assertEquals(
      classifyStagedPath(path),
      "safe",
      `expected '${path}' to be safe`,
    );
  }
});

Deno.test("classifyStagedPath - regular source file is safe", () => {
  assertEquals(classifyStagedPath("src/foo.ts"), "safe");
  assertEquals(classifyStagedPath("worker/deno/lib/foo.ts"), "safe");
  assertEquals(classifyStagedPath("README.md"), "safe");
});

Deno.test("classifyStagedPath - secrets/ (no leading dot) is safe", () => {
  // The forbidden pattern is .secrets/ (hidden); a plain secrets/ dir
  // is not a hidden path — leave classification to project policy.
  assertEquals(classifyStagedPath("secrets/api-key.json"), "safe");
});

Deno.test("FORBIDDEN_STAGED_PATTERNS - exposes regexps for direct inspection", () => {
  assert(FORBIDDEN_STAGED_PATTERNS.length >= 4);
  assert(FORBIDDEN_STAGED_PATTERNS.some((re) => re.test(".env")));
});

Deno.test("ALLOWED_HIDDEN_PATHS - derived from REQUIRED_GITIGNORE_PATTERNS", () => {
  assert(ALLOWED_HIDDEN_PATHS.includes(".gitignore"));
  assert(ALLOWED_HIDDEN_PATHS.includes(".github"));
  assert(ALLOWED_HIDDEN_PATHS.includes(".vscode"));
  assert(!ALLOWED_HIDDEN_PATHS.includes(".vibecoder.json"));
  assert(ALLOWED_HIDDEN_PATHS.includes(".markdownlint-cli2.jsonc"));
  assert(ALLOWED_HIDDEN_PATHS.includes(".gitattributes"));
});

// --- integration tests against a real git repo ------------------------

Deno.test("inspectStagedFiles - .env staged is reported as a violation", async () => {
  const dir = await makeRepo("pre_commit_env_");
  try {
    await stageFile(dir, ".env", "SECRET=abc\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, [".env"]);
      assertEquals(result.value.safe, []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - .env.production staged is a violation", async () => {
  const dir = await makeRepo("pre_commit_env_prod_");
  try {
    await stageFile(dir, ".env.production", "PROD=1\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, [".env.production"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - api-key.secret.json staged is a violation", async () => {
  const dir = await makeRepo("pre_commit_secret_");
  try {
    await stageFile(dir, "secrets/api-key.secret.json", "{}\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, ["secrets/api-key.secret.json"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - force-added private key is a violation (Issue #3660)", async () => {
  const dir = await makeRepo("pre_commit_pem_");
  try {
    await stageFile(
      dir,
      "certs/github-app.pem",
      "-----BEGIN RSA PRIVATE KEY-----\n",
    );
    await stageFile(dir, "src/foo.ts", "export const x = 1;\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, ["certs/github-app.pem"]);
      assertEquals(result.value.safe, ["src/foo.ts"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertSafeToCommit - refuses a staged credentials.json (Issue #3660)", async () => {
  const dir = await makeRepo("pre_commit_creds_");
  try {
    await stageFile(dir, "credentials.json", '{"token":"x"}\n');
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok);
    if (!result.ok) {
      assert(result.error.message.includes("credentials.json"));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - .github/workflows/ci.yml is allowed", async () => {
  const dir = await makeRepo("pre_commit_github_");
  try {
    await stageFile(dir, ".github/workflows/ci.yml", "on: push\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, []);
      assertEquals(result.value.safe, [".github/workflows/ci.yml"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - .markdownlint-cli2.jsonc is allowed", async () => {
  const dir = await makeRepo("pre_commit_mdlint_");
  try {
    await stageFile(dir, ".markdownlint-cli2.jsonc", "{}\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, []);
      assertEquals(result.value.safe, [".markdownlint-cli2.jsonc"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - .gitattributes is allowed", async () => {
  const dir = await makeRepo("pre_commit_gitattributes_");
  try {
    await stageFile(dir, ".gitattributes", "* text=auto\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, []);
      assertEquals(result.value.safe, [".gitattributes"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - regular source file is allowed", async () => {
  const dir = await makeRepo("pre_commit_safe_");
  try {
    await stageFile(dir, "src/foo.ts", "export const x = 1;\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, []);
      assertEquals(result.value.safe, ["src/foo.ts"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - mixed safe and unsafe — all unsafe reported", async () => {
  const dir = await makeRepo("pre_commit_mixed_");
  try {
    await stageFile(dir, "src/foo.ts", "ok\n");
    await stageFile(dir, ".env", "SECRET=1\n");
    await stageFile(dir, ".env.staging", "SECRET=2\n");
    await stageFile(dir, "README.md", "# project\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(
        result.value.violations.sort(),
        [".env", ".env.staging"].sort(),
      );
      assertEquals(
        result.value.safe.sort(),
        ["README.md", "src/foo.ts"].sort(),
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - empty stage returns Ok with empty arrays", async () => {
  const dir = await makeRepo("pre_commit_empty_");
  try {
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, []);
      assertEquals(result.value.safe, []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertSafeToCommit - returns Ok when no violations", async () => {
  const dir = await makeRepo("pre_commit_assert_ok_");
  try {
    await stageFile(dir, "src/foo.ts", "ok\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(
      result.ok,
      `expected ok, got: ${!result.ok ? result.error.message : ""}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertSafeToCommit - returns Err listing every violation", async () => {
  const dir = await makeRepo("pre_commit_assert_err_");
  try {
    await stageFile(dir, ".env", "X=1\n");
    await stageFile(dir, "secrets.secret.json", "{}\n");
    const result = await assertSafeToCommit({ cwd: dir });
    assert(!result.ok);
    if (!result.ok) {
      const msg = result.error.message;
      assert(msg.includes(".env"), `expected .env in error, got: ${msg}`);
      assert(
        msg.includes("secrets.secret.json"),
        `expected secrets.secret.json in error, got: ${msg}`,
      );
      assert(
        msg.toLowerCase().includes("git reset"),
        "error should hint at `git reset` recovery",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertSafeToCommit - empty stage returns Ok (no-op)", async () => {
  const dir = await makeRepo("pre_commit_assert_empty_");
  try {
    const result = await assertSafeToCommit({ cwd: dir });
    assert(result.ok);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("inspectStagedFiles - paths with spaces are decoded correctly via -z", async () => {
  // git diff --cached --name-only -z separates entries with NUL.
  // Without -z, whitespace in filenames could split incorrectly.
  const dir = await makeRepo("pre_commit_spaces_");
  try {
    await stageFile(dir, "src/file with space.ts", "ok\n");
    await stageFile(dir, ".env", "X=1\n");
    const result = await inspectStagedFiles({ cwd: dir });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.violations, [".env"]);
      assertEquals(result.value.safe, ["src/file with space.ts"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
