/**
 * Regression tests for the setup CLI's config reader failing loud (Issue #1294).
 *
 * `loadExistingConfig` caught every read and parse error and returned `{}`, so
 * a truncated or hand-broken `.config.json` was not a failure — setup rewrites
 * the file from scratch, so the operator's `service_accounts`, `repos`,
 * `repo_config` and narrowed `authorized_commenters` were dropped and
 * `mergeNonInteractive` repopulated the trusted-bot list from
 * `DEFAULT_TRUSTED_INPUT_BOTS`.
 *
 * Every test here calls the real loader with a broken file and asserts the
 * throw — they fail against the unfixed code, which returned `{}`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadExistingConfig, type SetupConfig } from "../setup/config_setup.ts";

/** Write `content` to a throwaway `.config.json` and run `body` against it. */
async function withConfigFile(
  content: string,
  body: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    await Deno.writeTextFile(configPath, content);
    await body(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("loadExistingConfig - throws on truncated JSON rather than resetting to defaults", async () => {
  // The exact partial write named in Issue #1294.
  await withConfigFile('{"repos":', async (configPath) => {
    const error = await assertRejects(
      () => loadExistingConfig(configPath),
      Error,
    );
    assert(
      error.message.includes(configPath),
      `expected the path in: ${error.message}`,
    );
    assert(
      error.message.includes("invalid JSON"),
      `expected the parse failure named in: ${error.message}`,
    );
  });
});

Deno.test("loadExistingConfig - throws on a hand-edited file that is not JSON at all", async () => {
  await withConfigFile("repos = org/repo\n", async (configPath) => {
    await assertRejects(() => loadExistingConfig(configPath), Error);
  });
});

Deno.test("loadExistingConfig - throws when the file is a JSON array, not an object", async () => {
  await withConfigFile('["org/repo"]', async (configPath) => {
    const error = await assertRejects(
      () => loadExistingConfig(configPath),
      Error,
    );
    assert(
      error.message.includes("not a JSON object"),
      `expected the shape failure named in: ${error.message}`,
    );
  });
});

Deno.test("loadExistingConfig - throws on an unreadable file rather than returning {}", async () => {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  try {
    await Deno.writeTextFile(configPath, '{"repos":["org/repo"]}');
    await Deno.chmod(configPath, 0o000);
    // Root ignores the mode bits, so only assert the refusal when the read
    // really is denied.
    let readable = true;
    try {
      await Deno.readTextFile(configPath);
    } catch {
      readable = false;
    }
    if (!readable) {
      const error = await assertRejects(
        () => loadExistingConfig(configPath),
        Error,
      );
      assert(
        error.message.includes(configPath),
        `expected the path in: ${error.message}`,
      );
    }
  } finally {
    await Deno.chmod(configPath, 0o600).catch(() => {});
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadExistingConfig - a missing file is still {} ", async () => {
  const config = await loadExistingConfig("/nonexistent/path/.config.json");
  assertEquals(config, {});
});

Deno.test("loadExistingConfig - a valid config still loads, security lists intact", async () => {
  const operatorConfig: SetupConfig = {
    repos: ["org/repo"],
    service_accounts: ["vibe-bot"],
    authorized_commenters: ["operator"],
  };
  await withConfigFile(
    JSON.stringify(operatorConfig),
    async (configPath) => {
      const config = await loadExistingConfig(configPath);
      assertEquals(config.service_accounts, ["vibe-bot"]);
      assertEquals(config.authorized_commenters, ["operator"]);
      assertEquals(config.repos, ["org/repo"]);
    },
  );
});
